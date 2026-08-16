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

/**
 * TWO failures, not one — deliberately, since BANNERFLAP-1.
 *
 * This file is about ORPHAN SUPPRESSION: a connector whose integration was deleted must drop out of
 * the banner. Since a lone failure is now `unconfirmed` and absent from `failing` on its own, a
 * single-failure fixture would make every "suppressed" assertion here pass whether or not suppression
 * works at all — green for the wrong reason — while the "stays loud" assertions failed. Raising the
 * fixture above the confirmation threshold keeps the orphan rule the ONLY variable under test.
 */
async function recordPlaneFailure(teamId: string): Promise<void> {
  for (const ago of [2000, 1000]) {
    await recordIngestRun(db(), {
      teamId,
      source: "plane",
      trigger: "scheduler",
      ok: false,
      errors: ['integration "aios-plane": The operation was aborted due to timeout'],
      meta: { integrations: 1 },
      startedAt: Date.now() - ago,
      finishedAt: Date.now() - ago,
    });
  }
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
    // Two failures for the same reason as `recordPlaneFailure`: one would be `unconfirmed` and absent
    // from `failing`, so this test would fail for a reason that has nothing to do with suppression.
    for (const ago of [2000, 1000]) {
      await recordIngestRun(db(), {
        teamId,
        source: "dense",
        trigger: "scheduler",
        ok: false,
        errors: ["embedding backend down"],
        startedAt: Date.now() - ago,
        finishedAt: Date.now() - ago,
      });
    }

    const health = await getPipelineHealth(teamId);
    expect(health.failing.some((l) => l.source === "dense")).toBe(true);
  });
});
