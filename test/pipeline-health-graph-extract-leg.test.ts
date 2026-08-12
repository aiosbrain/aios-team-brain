import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The synthetic `graph_extract` leg must stay LOUD under BANNERFLAP-1.
 *
 * WHY THIS FILE EXISTS. `lib/ingest/pipeline-health` appends one leg that has NO `ingest_runs` rows at
 * all — it is synthesised from the Neo4j/ledger extraction probe, and it carries `at: ""` because it
 * is not a point-in-time failure. Run through the new confirmation classifier uniformly, it can never
 * accumulate a failure streak, so it would be `unconfirmed` FOREVER and drop silently out of the loud
 * banner — while every other test in this slice stayed green. Spec review found it before any code
 * was written; it is the single most likely way this change ships as a detection regression.
 *
 * It needs no second debounce: its own detector already requires a 6h lag budget, an episode floor,
 * and a census sample floor before it says anything at all.
 *
 * Source-level rather than behavioural because the leg is constructed inside `getPipelineHealth`
 * behind two IO calls (Postgres + Neo4j); the property to pin is "the literal that builds this leg
 * says confirmed", which no amount of stubbing states more directly.
 */

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = readFileSync(path.join(ROOT, "lib", "ingest", "pipeline-health.ts"), "utf8");

/** The object literal that appends the synthetic leg. */
function syntheticLeg(): string {
  const at = SRC.indexOf('source: "graph_extract"');
  expect(at, "the synthetic graph_extract leg is gone or was renamed").toBeGreaterThan(-1);
  return SRC.slice(at, SRC.indexOf("});", at));
}

describe("guard: the synthetic graph_extract leg bypasses failure confirmation", () => {
  it("is constructed as `confirmed`, never left to the classifier", () => {
    // The regression in one line: `failureClass: "unconfirmed"` (or omitting it and letting a default
    // apply) removes this leg from the banner permanently.
    expect(syntheticLeg()).toMatch(/failureClass:\s*"confirmed"/);
  });

  it("carries a null failingSince rather than a fabricated instant", () => {
    // The extraction lag boundary and the newest-episode time are both to hand and both would be a
    // made-up "since" for a condition that has no start time. An admitted unknown beats a number that
    // reads as a measurement — the same rule the extraction probe itself follows.
    expect(syntheticLeg()).toMatch(/failingSince:\s*null/);
  });

  it("the failing filter keys on the classification, so an exempt leg is included by construction", () => {
    // Pins the OTHER half: if the filter reverted to `!l.ok`, this leg would still be loud but every
    // unconfirmed leg would be loud too — the bug. If it keyed on something the synthetic leg lacks
    // (a streak length, a timestamp), this leg would go quiet.
    const filter = SRC.slice(SRC.indexOf("const failing = legs.filter"));
    expect(filter.slice(0, 300)).toContain('l.failureClass === "confirmed"');
    expect(filter.slice(0, 300)).toContain("l.stale");
  });
});
