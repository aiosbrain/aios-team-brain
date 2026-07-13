import { describe, expect, it } from "vitest";
import { recordProjectionRun, listRecentProjectionRuns, getProjectionHealth } from "@/lib/pm-sync/runs";
import type { ProjectionReport } from "@/lib/pm-sync/project";
import { db, seedTeam } from "./helpers";

// Spec (AIO-357) on real Postgres: recordProjectionRun must persist a projection run into the
// shared `ingest_runs` log (reused, not a new table) and listRecentProjectionRuns/getProjectionHealth
// must read it back — team-scoped, newest-first, with the ok/error + counts an admin needs to
// diagnose "why didn't my task edit reach Linear".

const synced = (row_key: string): ProjectionReport => ({ row_key, provider: "linear", status: "synced" });
const failed = (row_key: string, error: string): ProjectionReport => ({ row_key, provider: "linear", status: "failed", error });

describe("pm-sync run log (real Postgres, reuses ingest_runs)", () => {
  it("persists a successful run and reads it back as the team's last projection run", async () => {
    const { teamId } = await seedTeam();
    await recordProjectionRun(db(), {
      teamId,
      provider: "linear",
      trigger: "manual",
      reports: [synced("P0"), synced("P1")],
      startedAt: Date.now() - 500,
    });

    const runs = await listRecentProjectionRuns(db(), teamId);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ source: "pm_sync", trigger: "manual", ok: true, created: 2, error_count: 0 });
    expect((runs[0].meta as { provider?: string }).provider).toBe("linear");

    const health = await getProjectionHealth(db(), teamId);
    expect(health.status).toBe("ok");
    expect(health.lastRun?.id).toBe(runs[0].id);
  });

  it("derives ok=false and captures error text when a row fails", async () => {
    const { teamId } = await seedTeam();
    await recordProjectionRun(db(), {
      teamId,
      provider: "linear",
      trigger: "api",
      reports: [synced("P0"), failed("P1", "linear down")],
      startedAt: Date.now(),
    });

    const runs = await listRecentProjectionRuns(db(), teamId);
    expect(runs[0]).toMatchObject({ ok: false, created: 1, error_count: 1 });
    expect(runs[0].errors).toContain("P1: linear down");

    const health = await getProjectionHealth(db(), teamId);
    expect(health.status).toBe("failed");
  });

  it("records a no-provider-configured run as a failure with the reason as the error", async () => {
    const { teamId } = await seedTeam();
    await recordProjectionRun(db(), {
      teamId,
      provider: null,
      trigger: "cli",
      reports: [],
      reason: "no enabled PM integration",
      startedAt: Date.now(),
    });

    const runs = await listRecentProjectionRuns(db(), teamId);
    expect(runs[0]).toMatchObject({ ok: false, trigger: "cli" });
    expect(runs[0].errors).toContain("no enabled PM integration");
  });

  it("is never_run for a team with no recorded projection runs", async () => {
    const { teamId } = await seedTeam();
    const health = await getProjectionHealth(db(), teamId);
    expect(health.status).toBe("never_run");
    expect(health.lastRun).toBeNull();
  });

  it("scopes runs to their own team", async () => {
    const a = await seedTeam();
    const b = await seedTeam();
    await recordProjectionRun(db(), { teamId: b.teamId, provider: "linear", trigger: "manual", reports: [synced("P0")], startedAt: Date.now() });

    const aRuns = await listRecentProjectionRuns(db(), a.teamId);
    expect(aRuns).toHaveLength(0);
    const aHealth = await getProjectionHealth(db(), a.teamId);
    expect(aHealth.status).toBe("never_run");
  });

  it("orders multiple runs newest-first", async () => {
    const { teamId } = await seedTeam();
    await recordProjectionRun(db(), { teamId, provider: "linear", trigger: "manual", reports: [synced("P0")], startedAt: Date.now() - 10_000, finishedAt: Date.now() - 9_000 });
    await recordProjectionRun(db(), { teamId, provider: "linear", trigger: "api", reports: [synced("P1")], startedAt: Date.now() - 1_000 });

    const runs = await listRecentProjectionRuns(db(), teamId);
    expect(runs.map((r) => r.trigger)).toEqual(["api", "manual"]);
  });
});
