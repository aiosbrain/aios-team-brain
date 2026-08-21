import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { projectionRunInput, shouldRecordProjectionRun, SLOW_WALK_RECORD_MS } from "@/lib/graph/projection-run";
import type { GraphProjectionSummary } from "@/lib/graph/run";

// TICKFIT-2 AC3 / D5 — the CALLER-GATE pin (Fable diff review H1: the gate shipped with zero tests
// behind it; a one-line revert to the old inline condition reddened nothing). Every clause of the
// recording gate is a SIGNAL; the two TICKFIT-2 clauses are what keep a permanently failing batched
// ledger read, or a slow quiet walk, from living only in ephemeral logs. And the predicate itself
// can be green and unwired (the "pin the call site, not just the function" lesson), so BOTH callers
// are pinned at the source level.

const quiet: GraphProjectionSummary = {
  ok: true,
  configured: true,
  teams: 1,
  scanned: 2826,
  projected: 0,
  episodes: 0,
  episodesByGroup: {},
  fanoutThrottled: 0,
  restrictionMovesPending: 0,
  skipped: 2826,
  reconciled: 4,
  requeued: 0,
  cleaned: 0,
  pendingCleanups: 0,
  saturatedGroups: 0,
  requeueThrottled: 0,
  partialItems: 0,
  partialDetail: { sample: [], elided: 0, namesElided: 0 },
  deepResolvedGroups: 0,
  lookupMismatchGroups: 0,
  deepRequeueHeld: 0,
  deepRequeueHeldByGroup: {},
  deepRequeueSample: [],
  deepRequeueElided: 0,
  deepRequeueEnabled: false,
  probeFallbackPages: 0,
  lockedOut: 0,
  unreachableGroups: 0,
  unreachableCleanupGroups: 0,
  emptyListingGroups: 0,
  requeueEligible: 0,
  watermarkAnchors: 0,
  walkMs: 0,
  reconcileMs: 0,
  errors: [],
};

describe("shouldRecordProjectionRun — the one durable-visibility gate", () => {
  it("a quiet converged run records nothing (the no-silent-caps rule's other half: quiet rows stay quiet)", () => {
    expect(shouldRecordProjectionRun(quiet)).toBe(false);
  });

  it("a failing batched ledger read ALONE earns a durable row (D5 — never silent)", () => {
    expect(shouldRecordProjectionRun({ ...quiet, probeFallbackPages: 1 })).toBe(true);
  });

  it("a slow quiet walk ALONE earns a durable row — strictly past SLOW_WALK_RECORD_MS, not at it", () => {
    expect(shouldRecordProjectionRun({ ...quiet, walkMs: SLOW_WALK_RECORD_MS + 1 })).toBe(true);
    expect(shouldRecordProjectionRun({ ...quiet, walkMs: SLOW_WALK_RECORD_MS })).toBe(false);
  });

  it("a locked-out team ALONE earns a durable row (a deploy overlap once is expected; every run is a wedged holder)", () => {
    expect(shouldRecordProjectionRun({ ...quiet, lockedOut: 1 })).toBe(true);
  });

  it("the two stall signals both inline gates had dropped record on their own (Codex diff review M1)", () => {
    expect(shouldRecordProjectionRun({ ...quiet, fanoutThrottled: 1 })).toBe(true);
    expect(shouldRecordProjectionRun({ ...quiet, restrictionMovesPending: 1 })).toBe(true);
  });

  it("GRAPHSAT-1 D3: held re-queues ALWAYS record; a deep-resolved pass records only while re-queue is OFF (measurement mode is loud)", () => {
    expect(shouldRecordProjectionRun({ ...quiet, deepRequeueHeld: 1 })).toBe(true);
    expect(shouldRecordProjectionRun({ ...quiet, deepRequeueHeld: 1, deepRequeueEnabled: true })).toBe(true);
    expect(shouldRecordProjectionRun({ ...quiet, deepResolvedGroups: 1, deepRequeueEnabled: false })).toBe(true);
    expect(shouldRecordProjectionRun({ ...quiet, deepResolvedGroups: 1, deepRequeueEnabled: true })).toBe(false);
    // Fable diff review M1: a BROKEN lookup (missed REST-confirmed items) is always a signal.
    expect(shouldRecordProjectionRun({ ...quiet, lookupMismatchGroups: 1, deepRequeueEnabled: true })).toBe(true);
  });

  it("RECONULL-1: an unjudged group (listing failed), a failed cleanup listing, and an empty listing over mature rows each record ALONE", () => {
    expect(shouldRecordProjectionRun({ ...quiet, unreachableGroups: 1 })).toBe(true);
    expect(shouldRecordProjectionRun({ ...quiet, unreachableCleanupGroups: 1 })).toBe(true);
    expect(shouldRecordProjectionRun({ ...quiet, emptyListingGroups: 1 })).toBe(true);
    const q = projectionRunInput(quiet, "scheduler", 1, 2).meta as Record<string, unknown>;
    for (const k of ["unreachableGroups", "unreachableCleanupGroups", "emptyListingGroups"]) expect(k in q, k).toBe(false);
    expect(projectionRunInput({ ...quiet, unreachableGroups: 2, emptyListingGroups: 1 }, "scheduler", 1, 2).meta).toMatchObject({ unreachableGroups: 2, emptyListingGroups: 1 });
  });

  it("GRAPHSAT-2: rows proven lost record while the flag is OFF (waiting on a human); with the flag ON they are re-queued work, not a separate signal", () => {
    expect(shouldRecordProjectionRun({ ...quiet, requeueEligible: 1, deepRequeueEnabled: false })).toBe(true);
    expect(shouldRecordProjectionRun({ ...quiet, requeueEligible: 1, deepRequeueEnabled: true })).toBe(false);
    expect("requeueEligible" in (projectionRunInput(quiet, "scheduler", 1, 2).meta as Record<string, unknown>)).toBe(false);
    expect(projectionRunInput({ ...quiet, requeueEligible: 3 }, "scheduler", 1, 2).meta).toMatchObject({ requeueEligible: 3 });
  });

  it("GRAPHSAT-2: the watermark margin and first-push slack are positive finite defaults (env parse is resolvePositiveInt)", async () => {
    const { LANDED_WATERMARK_MARGIN_MS, FIRST_PUSH_SLACK_MS } = await import("@/lib/graph/reconcile");
    expect(LANDED_WATERMARK_MARGIN_MS).toBe(10 * 60_000);
    expect(FIRST_PUSH_SLACK_MS).toBe(60_000);
    expect(LANDED_WATERMARK_MARGIN_MS).toBeGreaterThan(FIRST_PUSH_SLACK_MS); // the proof's one inequality
    const { resolvePositiveInt } = await import("@/lib/util/env");
    expect(resolvePositiveInt(undefined, 600_000)).toBe(600_000);
    expect(resolvePositiveInt("0", 600_000)).toBe(600_000);
    expect(resolvePositiveInt("soon", 600_000)).toBe(600_000);
    expect(resolvePositiveInt("900000", 600_000)).toBe(900_000);
  });

  it("every pre-existing signal still records on its own", () => {
    for (const key of ["projected", "requeued", "cleaned", "pendingCleanups", "saturatedGroups", "requeueThrottled", "partialItems"] as const) {
      expect(shouldRecordProjectionRun({ ...quiet, [key]: 1 }), key).toBe(true);
    }
    expect(shouldRecordProjectionRun({ ...quiet, errors: ["boom"] })).toBe(true);
  });

  it("the meta carries walkMs/reconcileMs always, and probeFallbackPages only when non-zero (flat numbers — the runs panel Strings values)", () => {
    const q = projectionRunInput(quiet, "scheduler", 1, 2).meta as Record<string, unknown>;
    expect(q.walkMs).toBe(0);
    expect(q.reconcileMs).toBe(0);
    expect("probeFallbackPages" in q).toBe(false);
    const loud = projectionRunInput({ ...quiet, probeFallbackPages: 2, walkMs: 61_000, reconcileMs: 400 }, "scheduler", 1, 2).meta as Record<string, unknown>;
    expect(loud).toMatchObject({ probeFallbackPages: 2, walkMs: 61_000, reconcileMs: 400 });
    expect("lockedOut" in q).toBe(false);
    // GRAPHSAT-1: the measurement keys are ALWAYS present (a row is self-describing about its mode);
    // the per-group map + structured sample ride only when something is held.
    // (Fable diff review L3) like their siblings, the keys ride only when they say something.
    for (const k of ["deepResolvedGroups", "deepRequeueHeld", "deepRequeueEnabled", "lookupMismatchGroups", "deepRequeueSample"]) expect(k in q, k).toBe(false);
    const resolved = projectionRunInput({ ...quiet, deepResolvedGroups: 1 }, "scheduler", 1, 2).meta as Record<string, unknown>;
    expect(resolved).toMatchObject({ deepResolvedGroups: 1, deepRequeueEnabled: false }); // self-describing about its mode
    expect(projectionRunInput({ ...quiet, lookupMismatchGroups: 1 }, "scheduler", 1, 2).meta).toMatchObject({ lookupMismatchGroups: 1 });
    const held = projectionRunInput({ ...quiet, deepResolvedGroups: 1, deepRequeueHeld: 2, deepRequeueHeldByGroup: { g: 2 }, deepRequeueSample: [{ teamId: "t", groupId: "g", itemId: "i", projectedAt: "2020-01-01T00:00:00Z" }] }, "scheduler", 1, 2).meta as Record<string, unknown>;
    expect(held).toMatchObject({ deepRequeueHeld: 2, deepRequeueHeldByGroup: { g: 2 }, deepRequeueSample: [{ teamId: "t", groupId: "g", itemId: "i", projectedAt: "2020-01-01T00:00:00Z" }] });
    expect(projectionRunInput({ ...quiet, lockedOut: 1 }, "scheduler", 1, 2).meta).toMatchObject({ lockedOut: 1 });
  });

  it("a TEAM-SCOPED run (the admin button) is recorded under its team; the scheduler aggregate stays instance-wide (Codex diff review H2)", () => {
    expect(projectionRunInput(quiet, "manual", 1, 2, "team-a").teamId).toBe("team-a");
    expect(projectionRunInput(quiet, "scheduler", 1, 2).teamId).toBeUndefined();
    const action = readFileSync("app/t/[team]/admin/integrations/actions.ts", "utf8");
    expect(action).toMatch(/projectionRunInput\(s, "manual", startedAt, Date\.now\(\), ctx\.teamId\)/);
  });

  it("BOTH callers route through the shared gate — the scheduler tick and the admin button (call-site pin)", () => {
    const scheduler = readFileSync("lib/graph/scheduler.ts", "utf8");
    const action = readFileSync("app/t/[team]/admin/integrations/actions.ts", "utf8");
    expect(scheduler).toMatch(/if \(shouldRecordProjectionRun\(s\)\) \{\s*\n\s*await recordIngestRun\(/);
    expect(action).toMatch(/if \(shouldRecordProjectionRun\(s\)\) \{\s*\n\s*await recordIngestRun\(/);
    // And neither keeps an inline copy that could drift (the button's did, five signals behind).
    for (const src of [scheduler, action]) {
      expect(src).not.toMatch(/if \(s\.projected \|\| s\.errors\.length/);
    }
  });
});
