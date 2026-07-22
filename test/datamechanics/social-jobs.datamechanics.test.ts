import { describe, expect, it } from "vitest";
import { enqueueJob, getJob, runDueJobs } from "@/lib/jobs";
import type { JobHandler } from "@/lib/jobs";
import { BASE_BACKOFF_MS } from "@/lib/jobs/backoff";
import { db, seedTeam } from "./helpers";

/**
 * Spec for the durable job/outbox on real Postgres (M0). Derived from the product need — work
 * that survives a redeploy and retries on failure — not from the implementation. Proves the
 * observable outcomes: a job runs and completes; a failing job is requeued with backoff and not
 * re-run until due; retries exhaust into a dead-letter; scheduling (`run_after`) is honored;
 * enqueue is idempotent by dedup key; and a kind with no handler is dead-lettered immediately.
 *
 * The clock is injected (`now`) so the backoff schedule is driven deterministically without
 * sleeping. Handlers are injected via `getHandler` so each case is isolated from the registry.
 */

const BASE = new Date("2026-07-10T12:00:00.000Z");
const at = (ms: number) => new Date(BASE.getTime() + ms);

function handlerMap(entries: Record<string, JobHandler>) {
  const m = new Map<string, JobHandler>(Object.entries(entries));
  return (kind: string) => m.get(kind);
}

describe("social_jobs durable queue (real Postgres)", () => {
  it("runs a claimed job to completion", async () => {
    const { teamId } = await seedTeam();
    const job = await enqueueJob(db(), { teamId, kind: "noop", payload: { hi: 1 }, runAfter: BASE });

    let ran = 0;
    const summary = await runDueJobs({
      db: db(),
      now: BASE,
      getHandler: handlerMap({ noop: async () => { ran++; } }),
    });

    expect(summary).toMatchObject({ claimed: 1, succeeded: 1, requeued: 0, dead: 0 });
    expect(ran).toBe(1);
    const after = await getJob(db(), job.id);
    expect(after!.status).toBe("done");
    expect(after!.attempts).toBe(1);
    expect(after!.locked_at).toBeNull();
    expect(after!.last_error).toBeNull();
  });

  it("requeues a failing job with backoff and does not re-run it before run_after", async () => {
    const { teamId } = await seedTeam();
    const job = await enqueueJob(db(), { teamId, kind: "flaky", runAfter: BASE });

    const throwing = handlerMap({ flaky: async () => { throw new Error("provider 503"); } });

    // Round 1 at BASE: claimed, fails, requeued ~BASE+30s (not dead — attempts 1 < max 5).
    const r1 = await runDueJobs({ db: db(), now: BASE, getHandler: throwing });
    expect(r1).toMatchObject({ claimed: 1, succeeded: 0, requeued: 1, dead: 0 });
    const mid = await getJob(db(), job.id);
    expect(mid!.status).toBe("queued");
    expect(mid!.attempts).toBe(1);
    expect(mid!.last_error).toContain("provider 503");
    expect(new Date(mid!.run_after).getTime()).toBe(BASE.getTime() + BASE_BACKOFF_MS);

    // A tick BEFORE run_after claims nothing (backoff is respected).
    const early = await runDueJobs({ db: db(), now: at(BASE_BACKOFF_MS - 1_000), getHandler: throwing });
    expect(early.claimed).toBe(0);
    expect((await getJob(db(), job.id))!.attempts).toBe(1);

    // A tick AFTER run_after re-claims and re-runs it (attempts advances).
    const late = await runDueJobs({ db: db(), now: at(BASE_BACKOFF_MS + 1_000), getHandler: throwing });
    expect(late).toMatchObject({ claimed: 1, requeued: 1 });
    expect((await getJob(db(), job.id))!.attempts).toBe(2);
  });

  it("dead-letters a job once max_attempts is exhausted", async () => {
    const { teamId } = await seedTeam();
    const job = await enqueueJob(db(), { teamId, kind: "doomed", runAfter: BASE, maxAttempts: 2 });
    const throwing = handlerMap({ doomed: async () => { throw new Error("nope"); } });

    // Attempt 1 → requeue; advance past backoff; attempt 2 == max → dead.
    await runDueJobs({ db: db(), now: BASE, getHandler: throwing });
    const r2 = await runDueJobs({ db: db(), now: at(BASE_BACKOFF_MS + 1_000), getHandler: throwing });

    expect(r2).toMatchObject({ claimed: 1, dead: 1, requeued: 0 });
    const dead = await getJob(db(), job.id);
    expect(dead!.status).toBe("dead");
    expect(dead!.attempts).toBe(2);
    expect(dead!.last_error).toContain("nope");
  });

  it("does not claim a job scheduled for the future until it is due", async () => {
    const { teamId } = await seedTeam();
    await enqueueJob(db(), { teamId, kind: "later", runAfter: at(3_600_000) }); // +1h
    const noop = handlerMap({ later: async () => {} });

    const early = await runDueJobs({ db: db(), now: BASE, getHandler: noop });
    expect(early.claimed).toBe(0);

    const due = await runDueJobs({ db: db(), now: at(3_600_000 + 1_000), getHandler: noop });
    expect(due).toMatchObject({ claimed: 1, succeeded: 1 });
  });

  it("is idempotent by dedup key — a second enqueue returns the same job", async () => {
    const { teamId } = await seedTeam();
    const a = await enqueueJob(db(), { teamId, kind: "publish", dedupKey: "post-42", runAfter: BASE });
    const b = await enqueueJob(db(), { teamId, kind: "publish", dedupKey: "post-42", runAfter: BASE });
    expect(b.id).toBe(a.id);

    const { count } = await db()
      .from("social_jobs")
      .select("id", { count: "exact", head: true })
      .eq("team_id", teamId)
      .eq("dedup_key", "post-42");
    expect(count).toBe(1);
  });

  it("dead-letters a job whose kind has no registered handler", async () => {
    const { teamId } = await seedTeam();
    const job = await enqueueJob(db(), { teamId, kind: "unknown_kind", runAfter: BASE });

    const summary = await runDueJobs({ db: db(), now: BASE, getHandler: () => undefined });
    expect(summary).toMatchObject({ claimed: 1, dead: 1 });
    const dead = await getJob(db(), job.id);
    expect(dead!.status).toBe("dead");
    expect(dead!.last_error).toContain("no handler");
  });

  // audit #4: a worker that vanished mid-run (deploy/crash) leaves a job stuck 'running' forever.
  // The runner reclaims a stale-locked 'running' job back to the queue and re-runs it (safe because
  // handlers are idempotent, audit #2), or dead-letters it if its attempts are already exhausted.
  it("reclaims a stale 'running' job (worker vanished) and re-runs it in the same pass", async () => {
    const { teamId } = await seedTeam();
    const job = await enqueueJob(db(), { teamId, kind: "resumable", runAfter: BASE });
    // A worker claimed it (attempts 1) then vanished 10 minutes ago — well past the 5-min stale window.
    await db()
      .from("social_jobs")
      .update({ status: "running", attempts: 1, locked_at: at(-10 * 60_000).toISOString(), updated_at: at(-10 * 60_000).toISOString() })
      .eq("id", job.id);

    let ran = 0;
    const summary = await runDueJobs({ db: db(), now: BASE, getHandler: handlerMap({ resumable: async () => { ran++; } }) });
    expect(summary.reclaimed).toBe(1);
    expect(ran).toBe(1); // reclaimed → re-claimed → ran, all in one pass
    const after = await getJob(db(), job.id);
    expect(after!.status).toBe("done");
    expect(after!.attempts).toBe(2); // the vanished attempt (1) still counts; this run made it 2
  });

  it("dead-letters a stale 'running' job that already exhausted its attempts (never re-runs it)", async () => {
    const { teamId } = await seedTeam();
    const job = await enqueueJob(db(), { teamId, kind: "resumable", runAfter: BASE, maxAttempts: 3 });
    await db()
      .from("social_jobs")
      .update({ status: "running", attempts: 3, max_attempts: 3, locked_at: at(-10 * 60_000).toISOString() })
      .eq("id", job.id);

    let ran = 0;
    const summary = await runDueJobs({ db: db(), now: BASE, getHandler: handlerMap({ resumable: async () => { ran++; } }) });
    expect(summary.reclaimed).toBe(0); // not requeued
    expect(summary.dead).toBe(1); // surfaced in the tick summary (reclaim dead-letters count into `dead`)
    expect(ran).toBe(0);
    expect((await getJob(db(), job.id))!.status).toBe("dead");
  });

  it("does NOT reclaim a 'running' job still within its lock window", async () => {
    const { teamId } = await seedTeam();
    const job = await enqueueJob(db(), { teamId, kind: "resumable", runAfter: BASE });
    // Claimed only a minute ago — a live worker is presumably still on it; leave it alone.
    await db()
      .from("social_jobs")
      .update({ status: "running", attempts: 1, locked_at: at(-60_000).toISOString() })
      .eq("id", job.id);

    const summary = await runDueJobs({ db: db(), now: BASE, getHandler: handlerMap({ resumable: async () => {} }) });
    expect(summary.reclaimed).toBe(0);
    expect((await getJob(db(), job.id))!.status).toBe("running"); // untouched
  });
});
