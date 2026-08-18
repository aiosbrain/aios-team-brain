import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { INGEST_LEG_SOURCES, UNSCANNABLE_LEG_SOURCES } from "@/lib/ingest/leg-ledger";

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

/** The text of every `recordIngestRun(...)` argument list, paren-balanced (the calls span lines). */
function recordCallArgs(src: string): string[] {
  const out: string[] = [];
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
    out.push(src.slice(i + needle.length, j));
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

for (const file of files) {
  const src = readFileSync(file, "utf8");
  if (!src.includes("recordIngestRun(")) continue;
  const rel = file.slice(ROOT.length + 1);
  for (const args of recordCallArgs(src)) {
    const m = args.match(/\bsource:\s*([^,\n}]+)/);
    if (!m) continue;
    const expr = m[1].trim();
    const literal = expr.match(/^"([^"]+)"$/);
    if (literal) scanned.set(literal[1], rel);
    else if (consts.has(expr)) scanned.set(consts.get(expr)!, rel);
    else unresolved.push(`${rel}: source: ${expr}`);
  }
}

describe("guard: every ingest leg is declared before it can inherit a staleness threshold", () => {
  it("the scan is NON-VACUOUS — it finds real, known legs at their real call sites", () => {
    // Without this, every assertion below passes trivially when the parser breaks (a `recordIngestRun`
    // rename, a formatting change that splits `source:` across lines). A guard that reports zero
    // offenders because it matched nothing is worse than no guard.
    expect(scanned.size, `scanned sources: ${[...scanned.keys()].join(", ")}`).toBeGreaterThanOrEqual(10);
    for (const known of ["meeting_notes", "context_backfill_all", "auto_flip", "graph_health", "scan"]) {
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
      unresolved,
      "make the source a literal or a named string constant, or document it in UNSCANNABLE_LEG_SOURCES"
    ).toEqual(["lib/ingest/scheduler.ts: source: label", "lib/ingest/scheduler.ts: source: label"]);
  });

  // DELIBERATELY NOT HERE: "every declared leg has a threshold answer". That question has exactly one
  // owner — `test/pipeline-health-staleness.test.ts`, which walks this same ledger and knows which
  // legs are legitimately on the default. Asserting it in both places would mean two lists to keep in
  // step, and the second copy is always the one that rots.
});
