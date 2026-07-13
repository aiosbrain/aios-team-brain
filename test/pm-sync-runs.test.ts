import { describe, expect, it } from "vitest";
import { summarizeProjectionReports, computeProjectionHealth, PROJECTION_STALE_AFTER_HOURS } from "@/lib/pm-sync/runs";
import type { ProjectionReport } from "@/lib/pm-sync/project";
import type { IngestRunRow } from "@/lib/ingest/runs";

// Spec (AIO-357): the pure pieces of the projection run-observability surface — rolling a
// ProjectionReport[] up into a recordIngestRun-shaped summary, and deriving a health status from
// the last recorded run. Derived from the product need ("last-run + result, and whether stale"),
// not from reading the implementation.

const report = (over: Partial<ProjectionReport>): ProjectionReport => ({
  row_key: "P0",
  provider: "linear",
  status: "synced",
  ...over,
});

describe("summarizeProjectionReports", () => {
  it("counts synced rows and reports ok when nothing failed", () => {
    const summary = summarizeProjectionReports([
      report({ row_key: "A", status: "synced" }),
      report({ row_key: "B", status: "skipped" }),
    ]);
    expect(summary).toMatchObject({ ok: true, synced: 1, unchanged: 1, errors: [] });
  });

  it("treats failed/missing_integration/missing_parent/cycle as failures and captures error text", () => {
    const summary = summarizeProjectionReports([
      report({ row_key: "A", status: "synced" }),
      report({ row_key: "B", status: "failed", error: "linear down" }),
      report({ row_key: "C", status: "missing_integration", error: "linear integration is not enabled" }),
    ]);
    expect(summary.ok).toBe(false);
    expect(summary.synced).toBe(1);
    expect(summary.errors).toEqual(["B: linear down", "C: linear integration is not enabled"]);
  });

  it("is ok with zero reports (nothing to project)", () => {
    expect(summarizeProjectionReports([])).toMatchObject({ ok: true, synced: 0, unchanged: 0, errors: [] });
  });
});

const run = (over: Partial<IngestRunRow>): IngestRunRow => ({
  id: 1,
  team_id: "t1",
  source: "pm_sync",
  trigger: "manual",
  ok: true,
  created: 0,
  updated: 0,
  unchanged: 0,
  error_count: 0,
  errors: [],
  meta: {},
  started_at: new Date().toISOString(),
  finished_at: new Date().toISOString(),
  duration_ms: 10,
  ...over,
});

describe("computeProjectionHealth", () => {
  const NOW = new Date("2026-07-13T12:00:00Z").getTime();

  it("is never_run when no run has ever been recorded", () => {
    expect(computeProjectionHealth(null, NOW)).toEqual({ status: "never_run", lastRun: null, ageMs: null });
  });

  it("is ok for a recent successful run", () => {
    const r = run({ ok: true, finished_at: new Date(NOW - 5 * 60_000).toISOString() });
    expect(computeProjectionHealth(r, NOW).status).toBe("ok");
  });

  it("is failed when the last run recorded an error, regardless of age", () => {
    const r = run({ ok: false, finished_at: new Date(NOW - 60_000).toISOString() });
    expect(computeProjectionHealth(r, NOW).status).toBe("failed");
  });

  it(`is stale when the last successful run is older than ${PROJECTION_STALE_AFTER_HOURS}h`, () => {
    const r = run({ ok: true, finished_at: new Date(NOW - (PROJECTION_STALE_AFTER_HOURS + 1) * 60 * 60_000).toISOString() });
    const health = computeProjectionHealth(r, NOW);
    expect(health.status).toBe("stale");
    expect(health.ageMs).toBeGreaterThan(PROJECTION_STALE_AFTER_HOURS * 60 * 60_000);
  });

  it("is ok when the successful run is just under the staleness threshold", () => {
    const r = run({ ok: true, finished_at: new Date(NOW - (PROJECTION_STALE_AFTER_HOURS * 60 * 60_000 - 60_000)).toISOString() });
    expect(computeProjectionHealth(r, NOW).status).toBe("ok");
  });
});
