import { describe, expect, it } from "vitest";
import { db, seedTeam } from "./helpers";
import { recordIngestRun } from "@/lib/ingest/runs";
import { upsertIntegration, deleteIntegration, setIntegrationStatus } from "@/lib/integrations/manage";
import { getPipelineHealth } from "@/lib/ingest/pipeline-health";

/**
 * Spec (integration-deletion hygiene): a connector ingestion leg (slack/plane/linear/github) records
 * its LAST outcome to ingest_runs; when the integration is DELETED or DISABLED the scheduler stops
 * polling and records no new row, so that last row is frozen forever. If it was a failure (a timeout,
 * a since-revoked key), `distinct on (source)` keeps surfacing it and the loud pipeline banner cries
 * wolf about a source the team intentionally removed.
 *
 * The product rule: deleting/disabling an integration must stop us EXPECTING fresh syncs — the health
 * banner should no longer flag that leg — WITHOUT touching already-ingested data. A still-configured
 * integration that is genuinely failing must stay loud; non-connector legs are never suppressed.
 */

function auth(teamId: string, memberId: string) {
  return { teamId, memberId };
}

async function recordPlaneFailure(teamId: string): Promise<void> {
  await recordIngestRun(db(), {
    teamId,
    source: "plane",
    trigger: "scheduler",
    ok: false,
    errors: ['integration "aios-plane": The operation was aborted due to timeout'],
    meta: { integrations: 1 },
    startedAt: Date.now() - 1000,
  });
}

describe("pipeline health — orphaned connector integrations (data-mechanics)", () => {
  it("suppresses a frozen plane failure when NO plane integration is configured (deleted key)", async () => {
    const { teamId } = await seedTeam();
    await recordPlaneFailure(teamId); // a fossil failure the scheduler can never overwrite

    const health = await getPipelineHealth(teamId);
    expect(health.failing.some((l) => l.source === "plane")).toBe(false);
    expect(health.healthy).toBe(true);
  });

  it("STILL flags plane when an enabled plane integration exists and its last run failed", async () => {
    const seed = await seedTeam();
    await upsertIntegration(db(), auth(seed.teamId, seed.memberId), {
      type: "plane",
      name: "aios-plane",
      config: { workspaceSlug: "aios", projectId: "p1" },
    });
    await recordPlaneFailure(seed.teamId);

    const health = await getPipelineHealth(seed.teamId);
    const plane = health.failing.find((l) => l.source === "plane");
    expect(plane).toBeTruthy();
    expect(plane!.error).toContain("aborted due to timeout");
    expect(health.healthy).toBe(false);
  });

  it("suppresses the plane leg once its integration is DELETED (key removed, data kept)", async () => {
    const seed = await seedTeam();
    const { id } = await upsertIntegration(db(), auth(seed.teamId, seed.memberId), {
      type: "plane",
      name: "aios-plane",
      config: { workspaceSlug: "aios", projectId: "p1" },
    });
    await recordPlaneFailure(seed.teamId);
    // Sanity: it's loud while configured.
    expect((await getPipelineHealth(seed.teamId)).failing.some((l) => l.source === "plane")).toBe(true);

    await deleteIntegration(db(), auth(seed.teamId, seed.memberId), id);

    // The old failure row is untouched, but the banner no longer expects fresh plane syncs.
    const runs = await db()
      .from("ingest_runs")
      .select("source")
      .eq("team_id", seed.teamId)
      .eq("source", "plane");
    expect((runs.data ?? []).length).toBeGreaterThan(0); // ingested history is NOT removed
    expect((await getPipelineHealth(seed.teamId)).failing.some((l) => l.source === "plane")).toBe(false);
  });

  it("suppresses the plane leg when its integration is DISABLED (intentionally paused)", async () => {
    const seed = await seedTeam();
    const { id } = await upsertIntegration(db(), auth(seed.teamId, seed.memberId), {
      type: "plane",
      name: "aios-plane",
      config: { workspaceSlug: "aios", projectId: "p1" },
    });
    await recordPlaneFailure(seed.teamId);
    await setIntegrationStatus(db(), auth(seed.teamId, seed.memberId), id, "disabled");

    expect((await getPipelineHealth(seed.teamId)).failing.some((l) => l.source === "plane")).toBe(false);
  });

  it("never suppresses a non-connector leg (dense) — it isn't integration-scoped", async () => {
    const { teamId } = await seedTeam();
    await recordIngestRun(db(), {
      teamId,
      source: "dense",
      trigger: "scheduler",
      ok: false,
      errors: ["embedding backend down"],
      startedAt: Date.now() - 1000,
    });

    const health = await getPipelineHealth(teamId);
    expect(health.failing.some((l) => l.source === "dense")).toBe(true);
  });
});
