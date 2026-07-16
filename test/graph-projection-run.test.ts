import { describe, it, expect } from "vitest";
import { projectionRunInput } from "@/lib/graph/projection-run";
import type { GraphProjectionSummary } from "@/lib/graph/run";

const base: GraphProjectionSummary = {
  ok: true,
  configured: true,
  teams: 1,
  scanned: 12,
  projected: 5,
  skipped: 7,
  reconciled: 0,
  requeued: 0,
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
