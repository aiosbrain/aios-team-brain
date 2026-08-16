import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * BUILD-FAILING GUARD: extraction health has exactly ONE assembler, and every surface uses it.
 *
 * WHY THIS EXISTS — it is not hypothetical, and it has now failed twice in the same place:
 *   1. The liveness leg (STALLPROBE-1) was added with an OPTIONAL field documented as "omitted ⇒
 *      pre-fix behaviour", and exactly one of the two call sites got wired. The one that was missed —
 *      `lib/query/retrieval-health.ts` — is the surface that produced the bug report. Every test
 *      passed and `tsc` passed.
 *   2. PCCC-3 changed the predicate's item count to `count(distinct …)` and left the card's own count
 *      on `count(*)`, so under per-project fan-out the number rendered and the number reasoned about
 *      diverge again.
 *
 * Both are the same defect: two assemblers of one verdict. STALLSCOPE-1 collapses them into
 * `readExtractionSignals`, which changes what this guard must pin. The OLD property ("every
 * `deriveGraphExtractionStalled(` call passes the liveness field") is now nearly vacuous — there is one
 * call, inside the producer — and it never covered the real failure anyway: a NEW surface that composes
 * its own verdict from raw Cypher never calls the predicate at all.
 *
 * So this pins three things instead:
 *   • the RAW SIGNAL READS appear in no production file but the producer's own — including via raw
 *     query text, which an import allowlist cannot see;
 *   • both health surfaces obtain the verdict THROUGH the producer, as a real call, by name;
 *   • the scan finds something (the vacuity check that reddens when a rename empties it).
 *
 * Known limit, stated rather than dressed up: a file that reconstructs these queries from concatenated
 * fragments evades the text scan. The non-vacuity fixture at the bottom of this file plants a third
 * assembler in the ordinary shape and asserts each signature catches it — an earlier version of this
 * comment claimed such a fixture lived in `test/graph-extraction-health.test.ts`, where it did not
 * exist at all. A guard whose comment attests to coverage it does not have is worse than no comment.
 */

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
/** Every tree `tsconfig` typechecks (`**\/*.ts` minus `test/`), not just `lib/` — a guard that quietly
 *  means something narrower than it claims is the failure mode this file exists to prevent. */
const SCANNED = ["lib", "app", "components", "scripts"];
const PRODUCER = path.join("lib", "graph", "extraction-health.ts");
/** The Learning panel legitimately reads `Episodic` for its own purposes; it makes no health verdict. */
const ALLOWED_EPISODIC_READERS = [PRODUCER, path.join("lib", "graph", "learning.ts")];

/** The raw reads the verdict rests on, as they appear in query text. */
const RAW_SIGNALS: { name: string; re: RegExp; allow: string[] }[] = [
  {
    // Node variables and a renamed edge alias both evaded the first version of this pattern
    // (`MATCH (a)-[f:RELATES_TO]->(b)` passed) — found by review executing the regex rather than
    // reading it. The alias and the node vars are now wildcards; only the label matters.
    name: "a RELATES_TO count (the team fact total)",
    re: /MATCH\s*\([^)]*\)\s*-\s*\[\s*\w*\s*:RELATES_TO\s*\]\s*->[^"'`]*count\(/i,
    // The offline measurement battery counts RELATES_TO for the dedupe-share study. It renders no
    // verdict, no alarm reads it, and it is not shipped in the app — exempted explicitly rather than
    // by narrowing the pattern until it stops seeing things (which is how the pattern missed
    // alias-renamed Cypher in the first place).
    allow: [PRODUCER, path.join("scripts", "graph-window-battery", "measure.ts")],
  },
  {
    name: "an Episodic max() (the liveness clock)",
    re: /MATCH\s*\(\w+:Episodic\)[^"'`]*max\(/i,
    allow: ALLOWED_EPISODIC_READERS,
  },
  {
    // Narrowed to the SIGNAL-BEARING aggregates rather than "any aggregate over graph_episodes": the
    // three quantities a second verdict would have to recompute (the item floor, the age-gate clock,
    // the push clock). A plain existence probe — `graphHasFacts`, "does this team have any projected
    // episodes at all" — is not an extraction verdict and is deliberately outside this. Note the
    // aggregates sit BEFORE the `from` in SQL; an earlier version of this pattern read in the other
    // order, matched nothing, and was caught by the vacuity check above rather than by luck.
    name: "a graph_episodes signal aggregate (the ledger read)",
    re: /(min\(first_seen_at|min\(projected_at|max\(projected_at|count\(distinct\s*\(source_table)[\s\S]*?from\s+graph_episodes/i,
    allow: [PRODUCER],
  },
];

/** Both surfaces that render extraction health, and the call each must make. */
const SURFACES = [
  {
    file: path.join("lib", "query", "retrieval-health.ts"),
    call: "readExtractionSignals(",
    uses: ["verdict.stalled", "verdict.cause", ".reason", ".note"],
  },
  {
    file: path.join("lib", "ingest", "pipeline-health.ts"),
    call: "getGraphExtractionHealth(",
    uses: ["stalled", "censusPolluted", "reason"],
  },
];

function tsFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return tsFiles(full);
    return (full.endsWith(".ts") || full.endsWith(".tsx")) && !full.endsWith(".d.ts") ? [full] : [];
  });
}

/** Source with comments removed — a guard satisfiable by a comment ABOUT the guard is the exact failure
 *  this repo hit three times in one week (a `Record<…>` anchor matching its own explanatory comment). */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

function productionFiles(): { rel: string; src: string }[] {
  return SCANNED.flatMap((d) => tsFiles(path.join(ROOT, d))).map((file) => ({
    rel: path.relative(ROOT, file),
    src: stripComments(readFileSync(file, "utf8")),
  }));
}

describe("guard: one producer assembles extraction health, and both surfaces use it", () => {
  const files = productionFiles();

  it("the scan sees the producer at all — a guard that matches nothing proves nothing", () => {
    const producer = files.find((f) => f.rel === PRODUCER);
    expect(producer, `${PRODUCER} is gone or moved — this guard is stale, not passing`).toBeDefined();
    // Each signature must match SOMEWHERE, or the pattern has drifted off the code it claims to cover.
    for (const sig of RAW_SIGNALS) {
      expect(sig.re.test(producer!.src), `no production code matches ${sig.name}`).toBe(true);
    }
  });

  for (const sig of RAW_SIGNALS) {
    it(`${sig.name} appears only in the producer`, () => {
      const offenders = files
        .filter((f) => !sig.allow.includes(f.rel) && sig.re.test(f.src))
        .map((f) => f.rel);
      expect(
        offenders,
        `these files assemble extraction signals themselves instead of calling readExtractionSignals, ` +
          `which is how one surface keeps a bug the other one fixed: ${offenders.join(", ")}`
      ).toEqual([]);
    });
  }

  for (const surface of SURFACES) {
    it(`${surface.file} obtains the verdict through the producer`, () => {
      const f = files.find((x) => x.rel === surface.file);
      expect(f, `${surface.file} is gone — the guard would pass vacuously`).toBeDefined();
      // A real call whose RESULT IS READ — not an import (an unused import satisfies "imports the
      // producer", and `noUnusedLocals` is not enabled) and not a call whose value is discarded, which
      // review pointed out the first version accepted. The call site itself is a ternary inside a
      // `Promise.all`, so pinning `await` directly before it would pin THIS spelling rather than the
      // property; what matters is that the returned reading is consumed.
      expect(f!.src, `${surface.file} no longer calls ${surface.call}`).toContain(surface.call);
      expect(
        surface.uses.some((u) => f!.src.includes(u)),
        `${surface.file} never reads any of ${surface.uses.join(", ")} — the call's result is discarded`
      ).toBe(true);
    });
  }
});

/**
 * NON-VACUITY: a planted third assembler must redden every signature.
 *
 * This fixture exists because its absence was itself a finding. The guard's header used to claim a
 * fixture like this lived in `test/graph-extraction-health.test.ts`; it did not exist anywhere, so the
 * spec's acceptance criterion ("a planted third assembler fixture fails the guard") was unmet while a
 * comment asserted coverage — the "never attest a surface that does not render" class. Running the
 * patterns against a planted file is also what surfaced that the RELATES_TO pattern let an
 * alias-renamed `MATCH (a)-[f:RELATES_TO]->(b)` straight through.
 *
 * It plants SOURCE TEXT rather than a file: writing into `lib/` from a test would race the other suites
 * and leave debris if the process died. The property under test is the pattern's discrimination, and
 * the patterns are the same objects the scan above uses.
 */
describe("guard non-vacuity: a planted third assembler is caught", () => {
  const PLANTED: { name: string; src: string }[] = [
    {
      name: "a verbatim copy of the fact read",
      src: `const rows = await runRead("MATCH ()-[r:RELATES_TO]->() WHERE r.group_id IN $g RETURN count(r) AS n");`,
    },
    {
      name: "the fact read with a renamed alias and node variables (the evasion review found)",
      src: `const rows = await runRead("MATCH (a)-[f:RELATES_TO]->(b) WHERE f.group_id IN $g RETURN count(f) AS n");`,
    },
    {
      name: "a second liveness clock",
      src: `const rows = await runRead("MATCH (x:Episodic) WHERE x.group_id IN $g RETURN toString(max(x.created_at)) AS at");`,
    },
    {
      name: "a re-derived age gate on the REFUTED clock (`projected_at`, which every re-push bumps)",
      src: `const res = await runSql("select min(projected_at) as t from graph_episodes where team_id = $1");`,
    },
    {
      name: "a re-derived item floor",
      src: `const res = await runSql("select count(distinct (source_table, source_id)) as n from graph_episodes where team_id = $1");`,
    },
  ];

  for (const planted of PLANTED) {
    it(`${planted.name} matches at least one signature`, () => {
      const hits = RAW_SIGNALS.filter((sig) => sig.re.test(planted.src)).map((s) => s.name);
      expect(
        hits,
        `a third assembler written as ${planted.name} would be invisible to this guard`
      ).not.toEqual([]);
    });
  }

  it("…and ordinary graph code is NOT caught (the guard must not be a blanket ban)", () => {
    // Over-blocking is how a guard gets worked around, and a worked-around guard is not a guard.
    const innocent = [
      `const res = await runSql("select count(*)::int as n from graph_episodes where team_id = $1");`, // graphHasFacts
      `const rows = await runRead("MATCH (ep:Episodic)-[:MENTIONS]->(e:Entity) RETURN e.name AS name");`, // learning
      `const rows = await runRead("MATCH (n:Entity {group_id: $g}) RETURN count(n) AS entities");`, // the census
    ];
    for (const src of innocent) {
      expect(
        RAW_SIGNALS.filter((sig) => sig.re.test(src)).map((s) => s.name),
        `this ordinary read would be flagged as a rogue assembler: ${src}`
      ).toEqual([]);
    }
  });
});
