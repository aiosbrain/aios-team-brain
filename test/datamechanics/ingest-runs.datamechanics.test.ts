import { describe, expect, it } from "vitest";
import { recordIngestRun, listRecentIngestRuns } from "@/lib/ingest/runs";
import { db, seedTeam } from "./helpers";

/**
 * Spec for the ingestion run log on real Postgres: recordIngestRun must persist a run's outcome
 * (counts + the actual error messages) and listRecentIngestRuns must return it — team runs PLUS
 * instance-wide scheduler aggregates (team_id null), newest first. This is the diagnosis surface
 * for silent import breakage. Derived from the product need, not the implementation.
 */

describe("ingest_runs log (real Postgres)", () => {
  it("persists a successful run and reads it back", async () => {
    const { teamId } = await seedTeam();
    await recordIngestRun(db(), {
      teamId,
      source: "github",
      trigger: "scheduler",
      ok: true,
      created: 3,
      updated: 1,
      unchanged: 5,
      meta: { integrations: 1 },
      startedAt: Date.now() - 1200,
    });
    const runs = await listRecentIngestRuns(db(), teamId);
    const gh = runs.find((r) => r.source === "github");
    expect(gh).toBeTruthy();
    expect(gh!.ok).toBe(true);
    expect(gh!.created).toBe(3);
    expect(gh!.error_count).toBe(0);
    expect(gh!.duration_ms).toBeGreaterThanOrEqual(1000);
  });

  it("derives ok=false and captures error text when a run has errors", async () => {
    const { teamId } = await seedTeam();
    await recordIngestRun(db(), {
      teamId,
      source: "scan",
      trigger: "merge",
      ok: true, // caller said ok, but errors are present → must be recorded false
      errors: ["httpx.ReadTimeout", "boom"],
      meta: { slug: "aios-team-brain" },
      startedAt: Date.now(),
    });
    const runs = await listRecentIngestRuns(db(), teamId);
    const scan = runs.find((r) => r.source === "scan");
    expect(scan).toBeTruthy();
    expect(scan!.ok).toBe(false);
    expect(scan!.error_count).toBe(2);
    expect(scan!.errors).toContain("httpx.ReadTimeout");
  });

  it("includes instance-wide (team_id null) scheduler aggregates for a team", async () => {
    const { teamId } = await seedTeam();
    await recordIngestRun(db(), {
      teamId: null,
      source: "slack",
      trigger: "scheduler",
      ok: true,
      meta: { integrations: 2, channels: 4 },
      startedAt: Date.now(),
    });
    const runs = await listRecentIngestRuns(db(), teamId);
    expect(runs.some((r) => r.source === "slack" && r.team_id === null)).toBe(true);
  });

  it("scopes out another team's per-team runs", async () => {
    const a = await seedTeam();
    const b = await seedTeam();
    await recordIngestRun(db(), { teamId: b.teamId, source: "linear", trigger: "manual", ok: true, startedAt: Date.now() });
    const aRuns = await listRecentIngestRuns(db(), a.teamId);
    expect(aRuns.some((r) => r.source === "linear" && r.team_id === b.teamId)).toBe(false);
  });
});
