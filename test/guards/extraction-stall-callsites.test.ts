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
 * fragments evades the text scan. `test/graph-extraction-health.test.ts` carries the fixture proving a
 * planted third assembler in the ordinary shape DOES redden this.
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
    name: "a RELATES_TO count (the team fact total)",
    re: /MATCH\s*\(\)-\[r:RELATES_TO\]->\(\)[^"'`]*count\(/i,
    allow: [PRODUCER],
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
    re: /(min\(first_seen_at|max\(projected_at|count\(distinct\s*\(source_table)[\s\S]*?from\s+graph_episodes/i,
    allow: [PRODUCER],
  },
];

/** Both surfaces that render extraction health, and the call each must make. */
const SURFACES = [
  { file: path.join("lib", "query", "retrieval-health.ts"), call: "readExtractionSignals(" },
  { file: path.join("lib", "ingest", "pipeline-health.ts"), call: "getGraphExtractionHealth(" },
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
      // A real CALL, not an import: an unused import satisfies "imports the producer" and
      // `noUnusedLocals` is not enabled, so the import alone proves nothing.
      expect(f!.src, `${surface.file} no longer calls ${surface.call}`).toContain(surface.call);
    });
  }
});
