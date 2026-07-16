import { describe, expect, it } from "vitest";
import { db, seedTeam } from "./helpers";
import { getSocialJobsHealth } from "@/lib/jobs/store";

// Spec (dead-letter visibility): social_jobs already persists a 'dead' status + last_error when a job
// exhausts its retries, but nothing read it — a fully dead queue (images never generate, nothing
// publishes) was invisible. getSocialJobsHealth surfaces the dead + queued counts for a dashboard banner.

async function insertJob(teamId: string, status: string, lastError?: string, updatedAt?: string) {
  const { error } = await db()
    .from("social_jobs")
    .insert({
      team_id: teamId,
      kind: "publish",
      status,
      last_error: lastError ?? null,
      updated_at: updatedAt ?? new Date().toISOString(),
    });
  if (error) throw new Error(`insert job: ${error.message}`);
}

describe("social jobs dead-letter health (data-mechanics)", () => {
  it("counts dead + queued jobs and surfaces the most recent dead error", async () => {
    const seed = await seedTeam();
    await insertJob(seed.teamId, "dead", "publish failed: 401", "2026-07-16T00:00:00Z");
    await insertJob(seed.teamId, "dead", "render timed out", "2026-07-16T01:00:00Z"); // newer
    await insertJob(seed.teamId, "queued");
    await insertJob(seed.teamId, "done"); // ignored

    const h = await getSocialJobsHealth(db(), seed.teamId);
    expect(h.dead).toBe(2);
    expect(h.queued).toBe(1);
    expect(h.lastDeadError).toBe("render timed out"); // most recent by updated_at
  });

  it("reports zeros for a healthy/empty queue", async () => {
    const seed = await seedTeam();
    const h = await getSocialJobsHealth(db(), seed.teamId);
    expect(h).toEqual({ dead: 0, queued: 0, lastDeadError: null });
  });

  it("is team-scoped — another team's dead jobs don't count", async () => {
    const mine = await seedTeam();
    const other = await seedTeam();
    await insertJob(other.teamId, "dead", "boom");
    expect((await getSocialJobsHealth(db(), mine.teamId)).dead).toBe(0);
  });
});
