import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * GUARD: the graph pollution alarm (both machines) must have a SCHEDULED caller (AIO-693,
 * re-armed by ALARMFIX-1).
 *
 * The failure this traces to: the 2026-07-30 bad-extraction-model incident was detectable on every
 * surface that existed and still ran for four days, because every surface was a page render waiting
 * for a visit. The plan review's blocking finding on the alarm design was exactly that
 * `getGraphExtractionHealth` had no scheduled caller — so DELIVERY, not detection, is the feature.
 * The blindness meta-alarm doubles the stakes: its whole job is paging when the alarm can't judge,
 * and an unwired meta-alarm is that failure with extra steps.
 *
 * This pins the wiring, not the module: `runGraphHealthCheck` has its own unit tests, all of
 * which stay green if the one line calling it from the ingest tick is deleted — the
 * "14 tests over the selector, none over the argument that wires it" failure this repo has already
 * shipped once (#452's review catch, recorded as a standing lesson). Deleting the scheduler call
 * turns THIS red.
 */
describe("graph-health alarm wiring", () => {
  const scheduler = readFileSync(join(process.cwd(), "lib/ingest/scheduler.ts"), "utf8");

  it("the ingest scheduler tick invokes the graph-health check (pollution + blindness)", () => {
    expect(scheduler).toMatch(/runGraphHealthCheck\s*\(/);
    expect(scheduler).toContain("@/lib/graph/extraction-alert");
  });
});
