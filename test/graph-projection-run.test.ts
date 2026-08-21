import { describe, it, expect } from "vitest";
import { projectionRunInput } from "@/lib/graph/projection-run";
import type { GraphProjectionSummary } from "@/lib/graph/run";

// COMPLETE literal, no `as` shortcuts — this file is excluded from `tsc --noEmit` (tsconfig excludes
// test/), so a missing field would compile fine and silently exempt itself from the shape it claims
// to pin (PCCC-3 review: the literal had drifted six fields behind the interface).
const base: GraphProjectionSummary = {
  ok: true,
  configured: true,
  teams: 1,
  scanned: 12,
  projected: 5,
  episodes: 9,
  episodesByGroup: { acme_team: 6, acme_external: 3 },
  fanoutThrottled: 0,
  restrictionMovesPending: 0,
  skipped: 7,
  reconciled: 0,
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
  walkMs: 1234,
  reconcileMs: 56,
  errors: [],
};

describe("projectionRunInput", () => {
  it("maps a clean projection to an ok ingest_runs record under the graph_project source", () => {
    const run = projectionRunInput(base, "scheduler", 1000, 2000);
    expect(run.source).toBe("graph_project");
    expect(run.trigger).toBe("scheduler");
    expect(run.ok).toBe(true);
    expect(run.created).toBe(5); // projected → created
    expect(run.unchanged).toBe(7); // skipped → unchanged
    expect(run.errors).toEqual([]);
    expect(run.meta).toMatchObject({ scanned: 12, teams: 1, requeued: 0 });
    // The Phase C cost gate's denominator MUST reach the durable record — episodes per partition,
    // append-only via ingest_runs. This is the call-site pin (PCCC-3 Fable review Medium 1): the dm
    // tier proves projectItemsToGraph computes it; without this line, deleting the meta wiring in
    // lib/graph/projection-run.ts leaves every test green while the gate's substrate never lands.
    expect(run.meta).toMatchObject({
      episodes: 9,
      episodesByGroup: { acme_team: 6, acme_external: 3 },
      // Pinned at the CALL SITE (RECONCILE-1): this file is excluded from `tsc --noEmit`, so a field
      // missing from `base` compiles fine and silently exempts itself from the shape it claims to pin
      // — which is how the literal drifted six fields behind once before. Review caught it drifting
      // again in the very PR that added the field.
      partialItems: 0,
      partialDetail: { sample: [], elided: 0, namesElided: 0 },
      fanoutThrottled: 0,
      restrictionMovesPending: 0,
      // TICKFIT-2 — and it drifted a THIRD time in the PR that added these (Fable diff review M1).
      walkMs: 1234,
      reconcileMs: 56,
    });
    expect("probeFallbackPages" in (run.meta as Record<string, unknown>)).toBe(false); // omitted at 0
    expect(run.startedAt).toBe(1000);
    expect(run.finishedAt).toBe(2000);
  });

  it("marks the run NOT ok when any team errored — this is what turns the 422 red on the dashboard", () => {
    // The exact 2026-07 failure: nothing projected, a Graphiti 422 on every write.
    const summary: GraphProjectionSummary = {
      ...base,
      ok: false,
      projected: 0,
      skipped: 0,
      errors: ["aios: graphiti POST /messages → 422"],
    };
    const run = projectionRunInput(summary, "scheduler", 0, 10);
    expect(run.ok).toBe(false);
    expect(run.created).toBe(0);
    expect(run.errors).toEqual(["aios: graphiti POST /messages → 422"]);
  });
});
