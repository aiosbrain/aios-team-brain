import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { staleThresholdMs } from "@/lib/ingest/pipeline-health";
import { join } from "node:path";
import {
  BEAT_SCOPE_BY_SOURCE,
  INGEST_LEG_SOURCES,
  UNSCANNABLE_LEG_SOURCES,
  WRAPPER_RUN_SITES,
  type BeatScope,
} from "@/lib/ingest/leg-ledger";

/**
 * BANNERFLAP-2 (`docs/design/staleness-threshold-fit.md` §Decision 3). A leg absent from
 * `STALE_MS_BY_SOURCE` silently inherits the 3h staleness default, and that default has been wrong
 * SIX times — `auth_cleanup`, `doc_task_infer`, `arcs`, `dense`, then `meeting_notes` and
 * `context_backfill[_all]`. Every one of them was found by a human noticing a red banner on a healthy
 * job, which is not a detection mechanism.
 *
 * The sibling test in `test/pipeline-health-staleness.test.ts` walks a LITERAL list, so it can only
 * catch a KNOWN leg drifting onto the wrong bar — it would not have caught `auto_flip` and cannot
 * catch the leg someone adds next month. This one SCANS the `recordIngestRun` call sites, so a new
 * source has to be declared before it can ship.
 *
 * The scan is the whole value, so it is asserted non-vacuous below: a parser that matched nothing
 * would otherwise report zero offenders and read exactly like a clean bill of health.
 */

const ROOT = join(import.meta.dirname, "..", "..");
const SCAN_DIRS = ["lib", "app", "scripts"];

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sourceFiles(p, out);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

/** The text of every `recordIngestRun(...)` argument list, paren-balanced (the calls span lines),
 *  flagging the one that is the function's own declaration rather than a call. */
function recordCallArgs(src: string): { args: string; isDeclaration: boolean }[] {
  const out: { args: string; isDeclaration: boolean }[] = [];
  const needle = "recordIngestRun(";
  let i = src.indexOf(needle);
  while (i !== -1) {
    let depth = 0;
    let j = i + needle.length - 1;
    for (; j < src.length; j++) {
      if (src[j] === "(") depth++;
      else if (src[j] === ")") {
        depth--;
        if (depth === 0) break;
      }
    }
    out.push({
      args: src.slice(i + needle.length, j),
      isDeclaration: /\bfunction\s+$/.test(src.slice(Math.max(0, i - 24), i)),
    });
    i = src.indexOf(needle, j);
  }
  return out;
}

/** `const NAME = "value"` anywhere in the tree — resolves the sources passed as a named constant. */
function stringConstants(files: string[]): Map<string, string> {
  const consts = new Map<string, string>();
  for (const f of files) {
    for (const m of readFileSync(f, "utf8").matchAll(/\bconst\s+([A-Z][A-Z0-9_]*)\s*=\s*"([^"]+)"/g)) {
      consts.set(m[1], m[2]);
    }
  }
  return consts;
}

const files = SCAN_DIRS.flatMap((d) => sourceFiles(join(ROOT, d)));
const consts = stringConstants(files);

/** Every `source:` a `recordIngestRun` call site can write, with where it was found. */
const scanned = new Map<string, string>();
/** Call sites whose `source:` is neither a literal nor a resolvable constant. */
const unresolved: string[] = [];

/**
 * One scheduler-triggered call site, for AUDITFIX-24's partition cross-check.
 *
 * `teamId` semantics are part of the RULE, not an implementation detail, and getting them wrong
 * breaks the guard in both directions: an explicit `teamId: null` is how three instance-wide legs
 * are written (`context_backfill_all`, `pret3_sweep`, `pret4_materialize`), so a key-PRESENCE test
 * would fail all three — and would also let the mutation this check exists for through, since that
 * mutant writes `teamId: null`. Shorthand (`teamId,`) counts as passing one.
 */
type SchedulerSite = { source: string; rel: string; passesTeamId: boolean };
const schedulerSites: SchedulerSite[] = [];

function passesTeamId(args: string): boolean {
  const explicit = args.match(/\bteamId\s*:\s*([^,\n}]+)/);
  if (explicit) return explicit[1].trim() !== "null";
  return /\bteamId\s*[,\n]/.test(args);
}

for (const file of files) {
  const src = readFileSync(file, "utf8");
  if (!src.includes("recordIngestRun(")) continue;
  const rel = file.slice(ROOT.length + 1);
  for (const { args, isDeclaration } of recordCallArgs(src)) {
    // The function's own `export async function recordIngestRun(...)` signature matches the needle
    // and is not a call site. Skipping it by SHAPE rather than by filename, so moving the writer
    // does not silently reopen the hole.
    if (isDeclaration) continue;
    const m = args.match(/\bsource:\s*([^,\n}]+)/);
    if (!m) {
      // Previously `continue` — which hid every wrapper-built row, including `graph_project`'s
      // SUCCESS-path scheduler site (`lib/graph/scheduler.ts`, built by `projectionRunInput`). Its
      // partition was verified only by the catch-path site, i.e. by coincidence. These now demand
      // the same accounting a source expression does.
      unresolved.push(`${rel}: argument built elsewhere`);
      continue;
    }
    const expr = m[1].trim();
    const literal = expr.match(/^"([^"]+)"$/);
    const source = literal ? literal[1] : consts.get(expr);
    if (source === undefined) {
      unresolved.push(`${rel}: source: ${expr}`);
      continue;
    }
    scanned.set(source, rel);
    if (/\btrigger:\s*"scheduler"/.test(args)) schedulerSites.push({ source, rel, passesTeamId: passesTeamId(args) });
  }
}

describe("guard: every ingest leg is declared before it can inherit a staleness threshold", () => {
  it("the scan is NON-VACUOUS — it finds real, known legs at their real call sites", () => {
    // Without this, every assertion below passes trivially when the parser breaks (a `recordIngestRun`
    // rename, a formatting change that splits `source:` across lines). A guard that reports zero
    // offenders because it matched nothing is worse than no guard.
    expect(scanned.size, `scanned sources: ${[...scanned.keys()].join(", ")}`).toBeGreaterThanOrEqual(10);
    // PRET-6: auto_flip retired (a HISTORICAL source now — its threshold row survives, its call site does not).
    for (const known of ["meeting_notes", "context_backfill_all", "pret4_materialize", "graph_health", "scan"]) {
      expect(scanned.has(known), `the scan must find ${known} — it is written by a real call site`).toBe(true);
    }
    // …and it must resolve the named-constant form, not just bare literals: `graph_health` is only
    // ever written as `GRAPH_HEALTH_SOURCE`, so finding it proves the constant resolution works.
    expect(scanned.get("graph_health")).toContain("extraction-alert");
  });

  it("every source a call site writes is DECLARED in the leg ledger", () => {
    const undeclared = [...scanned.entries()].filter(([s]) => !INGEST_LEG_SOURCES.includes(s));
    expect(
      undeclared.map(([s, where]) => `${s} (${where})`),
      "a new ingest leg must be added to lib/ingest/leg-ledger AND given a staleness threshold in " +
        "STALE_MS_BY_SOURCE — otherwise it silently inherits the 3h default, which has been wrong six times"
    ).toEqual([]);
  });

  it("every DECLARED source is still written by a call site (or documented as unscannable)", () => {
    // The reverse direction: a ledger that accumulates dead legs stops describing the system, and the
    // staleness test walks this same list, so a fossil there is a threshold nobody can reach.
    const orphaned = INGEST_LEG_SOURCES.filter(
      (s) => !scanned.has(s) && !(s in UNSCANNABLE_LEG_SOURCES)
    );
    expect(orphaned, "declared in the ledger but written by nothing — remove it or document why the scan cannot see it").toEqual([]);
  });

  it("no call site passes a source expression the scan cannot resolve", () => {
    // The hole this closes: a `source:` that is a parameter or a computed value is INVISIBLE to the
    // checks above, so an unresolved site would let a new leg through while the guard stayed green.
    // The four connector types genuinely arrive as `runImport`'s `label` parameter; anything else must
    // be made resolvable or declared in UNSCANNABLE_LEG_SOURCES with a reason.
    expect(
      unresolved.filter((u) => !u.includes("argument built elsewhere")).sort(),
      "make the source a literal or a named string constant, or document it in UNSCANNABLE_LEG_SOURCES"
    ).toEqual(["lib/ingest/scheduler.ts: source: label", "lib/ingest/scheduler.ts: source: label"]);
  });

  it("every WRAPPER-built call site is accounted for (AUDITFIX-24)", () => {
    // The sites that build the argument object elsewhere. They were dropped silently until
    // AUDITFIX-24 — which mattered because one of them is `graph_project`'s success-path SCHEDULER
    // write, so its declared instance-wide partition was verified only by the catch-path site
    // beside it. Each must now say what it writes, in WRAPPER_RUN_SITES.
    const wrapperFiles = [...new Set(unresolved.filter((u) => u.includes("argument built elsewhere")).map((u) => u.split(":")[0]))];
    expect(wrapperFiles.length, "the scan must still find wrapper sites — zero means the parser broke").toBeGreaterThanOrEqual(4);
    expect(
      wrapperFiles.filter((f) => !(f in WRAPPER_RUN_SITES)).sort(),
      "a recordIngestRun call whose argument is built elsewhere must be documented in WRAPPER_RUN_SITES"
    ).toEqual([]);
  });

  it("every DECLARED leg has a beat scope, and it MATCHES its scheduler writers (AUDITFIX-24)", () => {
    // Half one: the question is answered at all. A leg with no scope entry would fall to the
    // `beatScopeOf` default and be judged against a partition nobody chose.
    expect(
      INGEST_LEG_SOURCES.filter((s) => !(s in BEAT_SCOPE_BY_SOURCE)).sort(),
      "declare the beat scope in BEAT_SCOPE_BY_SOURCE — a leg without one silently inherits `global`"
    ).toEqual([]);
    expect(
      Object.keys(BEAT_SCOPE_BY_SOURCE).filter((s) => !INGEST_LEG_SOURCES.includes(s)).sort(),
      "a scope for a source no longer in the ledger — remove it, or the map stops describing the system"
    ).toEqual([]);

    // Half two, and the half that has teeth: the declaration must match what the poller WRITES.
    // UNIVERSAL, not "≥1 site agrees" — `meeting_notes` has two scheduler sites (success + failure),
    // so an existential rule is satisfied by the untouched one when the other flips partition. Two
    // review rounds let the existential form through; this is the mutation it could not redden.
    //
    // `access_bootstrap` is the ONE exception: declared `team` because its per-team row every tick is
    // its heartbeat, while it also writes instance-wide rows on the fleet-level failure / zero-teams /
    // throw paths. Those carry the VERDICT (AUDITFIX-22's AC5 depends on it), never the beat.
    const EXEMPT_DUAL_WRITER = "access_bootstrap";
    const wrong = schedulerSites
      .filter((site) => site.source !== EXEMPT_DUAL_WRITER)
      .filter((site) => {
        const scope: BeatScope | undefined = BEAT_SCOPE_BY_SOURCE[site.source];
        if (scope === "team") return !site.passesTeamId;
        if (scope === "global") return site.passesTeamId;
        return true; // `none` must have no scheduler site at all
      })
      .map((site) => `${site.source} (${site.rel}) declared ${BEAT_SCOPE_BY_SOURCE[site.source]}, writes ${site.passesTeamId ? "team-scoped" : "instance-wide"}`);
    expect(
      wrong.sort(),
      "a leg's declared beat scope must match EVERY scheduler call site that writes it — otherwise the " +
        "staleness clock reads a partition the poller never fills, and the leg silently stops aging"
    ).toEqual([]);
  });

  it("a `none` leg may not carry a finite staleness threshold (AUDITFIX-24)", () => {
    // A leg whose scope is `none` can never resolve a clock, so a finite bar on it is not a loose
    // alarm — it is silence by construction, dressed as a threshold somebody chose. The two rules
    // have to be checked together or each looks individually reasonable.
    const contradictory = Object.entries(BEAT_SCOPE_BY_SOURCE)
      .filter(([, scope]) => scope === "none")
      .filter(([source]) => staleThresholdMs(source) !== null)
      .map(([source]) => `${source} (scope none, threshold ${staleThresholdMs(source)}ms)`);
    expect(
      contradictory.sort(),
      "give it a real beat scope or set its STALE_MS_BY_SOURCE entry to null — a finite bar on a leg " +
        "with no resolvable clock can never fire, which is the quiet half of the BANNERFLAP family"
    ).toEqual([]);
  });

  it("the scheduler-site scan is NON-VACUOUS — it sees both partitions at real call sites", () => {
    // Without this the cross-check above is green whenever `trigger:` or `teamId:` parsing breaks,
    // which is the same failure the source scan already guards against one assertion up.
    const bySource = (s: string) => schedulerSites.filter((x) => x.source === s);
    expect(bySource("meeting_notes").length, "meeting_notes has scheduler sites").toBeGreaterThanOrEqual(2);
    expect(bySource("meeting_notes").every((x) => x.passesTeamId), "…and they are team-scoped").toBe(true);
    expect(bySource("auth_cleanup").length, "auth_cleanup has scheduler sites").toBeGreaterThanOrEqual(1);
    expect(bySource("auth_cleanup").every((x) => !x.passesTeamId), "…and they are instance-wide").toBe(true);
    // The `teamId: null` form must read as instance-wide, not as "a teamId is present" — three
    // global legs are written that way, and a key-presence test would fail all three.
    expect(bySource("context_backfill_all").every((x) => !x.passesTeamId), "explicit teamId: null is instance-wide").toBe(true);
  });

  // DELIBERATELY NOT HERE: "every declared leg has a threshold answer". That question has exactly one
  // owner — `test/pipeline-health-staleness.test.ts`, which walks this same ledger and knows which
  // legs are legitimately on the default. Asserting it in both places would mean two lists to keep in
  // step, and the second copy is always the one that rots.
});
