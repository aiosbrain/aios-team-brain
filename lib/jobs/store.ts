import "server-only";
import type { DbClient } from "@/lib/db/types";
import type { EnqueueJobInput, JobRow } from "./types";
import { nextRunAfter } from "./backoff";

/**
 * SINGLE WRITER for the `social_jobs` table (CLAUDE.md §2). Every insert/update to social_jobs
 * lives here — enqueue, claim, and the three terminal transitions (done / requeue / dead). The
 * runner (lib/jobs/run) composes these; nothing else writes the table. Guarded by
 * test/guards/single-writer-social-jobs.test.ts.
 *
 * No RLS: every write is team-scoped in app code. Claim is a conditional UPDATE (…WHERE
 * status='queued') so a row is handed to exactly one worker even without SELECT … FOR UPDATE;
 * under the poller's in-process single-flight guard there is no contention today.
 */

const COLS =
  "id, team_id, kind, payload, status, attempts, max_attempts, run_after, locked_at, last_error, dedup_key, created_at, updated_at";

export interface SocialJobsHealth {
  dead: number; // jobs that exhausted max_attempts and gave up (permanently failed)
  queued: number; // jobs waiting to run
  lastDeadError: string | null; // the most recent dead job's error, for an actionable banner
}

/**
 * Dead-letter / queue health for the Social admin surface. `social_jobs` already persists a `dead`
 * status + `last_error`, but nothing read it — a fully dead queue (images never generate, nothing
 * publishes) was invisible. Best-effort: zeros on any error so it never breaks the page render.
 */
export async function getSocialJobsHealth(db: DbClient, teamId: string): Promise<SocialJobsHealth> {
  try {
    const { data } = await db
      .from("social_jobs")
      .select("status, last_error, updated_at")
      .eq("team_id", teamId)
      .in("status", ["dead", "queued"]);
    const rows = (data ?? []) as { status: string; last_error: string | null; updated_at: string }[];
    const dead = rows.filter((r) => r.status === "dead");
    const lastDeadError =
      [...dead].sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1))[0]?.last_error ?? null;
    return { dead: dead.length, queued: rows.filter((r) => r.status === "queued").length, lastDeadError };
  } catch {
    return { dead: 0, queued: 0, lastDeadError: null };
  }
}

/**
 * Enqueue a job. Idempotent when `dedupKey` is set: a second enqueue for the same (team, key)
 * returns the existing job instead of creating a duplicate (the partial unique index is the
 * backstop; this pre-check is the common, race-free-under-single-flight path).
 */
export async function enqueueJob(db: DbClient, input: EnqueueJobInput): Promise<JobRow> {
  if (input.dedupKey) {
    const existing = await db
      .from("social_jobs")
      .select(COLS)
      .eq("team_id", input.teamId)
      .eq("dedup_key", input.dedupKey)
      .maybeSingle();
    if (existing.data) return existing.data as JobRow;
  }

  const row: Record<string, unknown> = {
    team_id: input.teamId,
    kind: input.kind,
    payload: input.payload ?? {},
  };
  if (input.runAfter) row.run_after = input.runAfter;
  if (typeof input.maxAttempts === "number") row.max_attempts = input.maxAttempts;
  if (input.dedupKey) row.dedup_key = input.dedupKey;

  const { data, error } = await db.from("social_jobs").insert(row).select(COLS).single();
  if (error || !data) throw new Error(`enqueueJob failed: ${error?.message ?? "no row returned"}`);
  return data as JobRow;
}

/**
 * Claim up to `limit` due jobs (status='queued' and run_after ≤ now), oldest first, marking each
 * running with an incremented attempt count. Returns the claimed rows. A row is claimed only if
 * the conditional UPDATE still matched status='queued', so a concurrent claimer never double-runs
 * it. `now` is injectable so tests drive the schedule deterministically without sleeping.
 */
export async function claimDueJobs(
  db: DbClient,
  opts?: { limit?: number; now?: Date }
): Promise<JobRow[]> {
  const now = opts?.now ?? new Date();
  const limit = opts?.limit ?? 10;

  const { data: due } = await db
    .from("social_jobs")
    .select("id, attempts")
    .eq("status", "queued")
    .lte("run_after", now.toISOString())
    .order("run_after", { ascending: true })
    .limit(limit);

  const claimed: JobRow[] = [];
  for (const cand of (due ?? []) as { id: string; attempts: number }[]) {
    const { data } = await db
      .from("social_jobs")
      .update({
        status: "running",
        attempts: cand.attempts + 1,
        locked_at: now,
        updated_at: now,
      })
      .eq("id", cand.id)
      .eq("status", "queued")
      .select(COLS);
    const rows = (data ?? []) as JobRow[];
    if (rows.length) claimed.push(rows[0]);
  }
  return claimed;
}

/** How long a `running` job may hold its lock before it's considered abandoned (worker vanished). */
const STALE_JOB_DEFAULT_MS = 5 * 60_000;
const STALE_JOB_ENV = Number(process.env.SOCIAL_JOB_STALE_MS);
// A garbage env value must not NaN-poison the reclaim (→ `new Date(NaN)` throws → every tick dies).
export const STALE_JOB_MS = Number.isFinite(STALE_JOB_ENV) && STALE_JOB_ENV > 0 ? STALE_JOB_ENV : STALE_JOB_DEFAULT_MS;

/**
 * Reclaim jobs stuck in `running` because their worker vanished mid-job — a redeploy (this repo
 * deploys on every merge to main) or crash between claim and terminal transition. Without this a
 * `publish`/`collect_analytics` job silently never completes (audit #4). Any `running` row whose
 * `locked_at` is older than `staleAfterMs` is returned to `queued` (re-claimable), or dead-lettered
 * if it already exhausted `max_attempts`.
 *
 * SAFE only because handlers are idempotent (audit #2 landed first): a reclaimed `publish` re-run
 * short-circuits on the persisted `external_id` / the provider idempotency key, so it never
 * double-posts. Each write is conditional on `status='running'` so it can't clobber a worker that is
 * just now finishing. `attempts` was already incremented at claim time, so the vanished try counts.
 */
export async function reclaimStaleJobs(
  db: DbClient,
  opts?: { now?: Date; staleAfterMs?: number }
): Promise<{ reclaimed: number; deadLettered: number }> {
  const now = opts?.now ?? new Date();
  const cutoff = new Date(now.getTime() - (opts?.staleAfterMs ?? STALE_JOB_MS)).toISOString();

  const { data } = await db
    .from("social_jobs")
    .select("id, attempts, max_attempts")
    .eq("status", "running")
    .lt("locked_at", cutoff);

  let reclaimed = 0;
  let deadLettered = 0;
  for (const j of (data ?? []) as { id: string; attempts: number; max_attempts: number }[]) {
    if (j.attempts >= j.max_attempts) {
      const { data: upd } = await db
        .from("social_jobs")
        .update({ status: "dead", locked_at: null, last_error: "reclaimed: worker vanished after exhausting attempts", updated_at: now })
        .eq("id", j.id)
        .eq("status", "running")
        .select("id");
      if (((upd ?? []) as unknown[]).length) deadLettered++;
    } else {
      const { data: upd } = await db
        .from("social_jobs")
        .update({ status: "queued", run_after: now, locked_at: null, last_error: "reclaimed: worker vanished mid-run — requeued", updated_at: now })
        .eq("id", j.id)
        .eq("status", "running")
        .select("id");
      if (((upd ?? []) as unknown[]).length) reclaimed++;
    }
  }
  return { reclaimed, deadLettered };
}

// Terminal transitions are guarded on `status='running'` so a resurrected worker that finishes AFTER
// its job was reclaimed can't clobber the reclaim's requeue/claim (overlapping old+new processes are
// real on a Railway redeploy — audit #4 review).

/** Mark a claimed job successfully completed. */
export async function markJobDone(db: DbClient, id: string, now = new Date()): Promise<void> {
  await db
    .from("social_jobs")
    .update({ status: "done", locked_at: null, last_error: null, updated_at: now })
    .eq("id", id)
    .eq("status", "running");
}

/**
 * A retryable failure: return the job to the queue with backoff and record the error. `attempts`
 * is the count already made (used to compute the delay), typically `job.attempts` after claim.
 */
export async function requeueJob(
  db: DbClient,
  id: string,
  attempts: number,
  error: string,
  now = new Date()
): Promise<void> {
  await db
    .from("social_jobs")
    .update({
      status: "queued",
      run_after: nextRunAfter(attempts, now),
      locked_at: null,
      last_error: error.slice(0, 2000),
      updated_at: now,
    })
    .eq("id", id)
    .eq("status", "running");
}

/** A terminal failure: retries exhausted (or a permanently-unhandleable job). */
export async function markJobDead(
  db: DbClient,
  id: string,
  error: string,
  now = new Date()
): Promise<void> {
  await db
    .from("social_jobs")
    .update({ status: "dead", locked_at: null, last_error: error.slice(0, 2000), updated_at: now })
    .eq("id", id)
    .eq("status", "running");
}

/** Read one job by id (reads are unrestricted; the caller applies team scoping). */
export async function getJob(db: DbClient, id: string): Promise<JobRow | null> {
  const { data } = await db.from("social_jobs").select(COLS).eq("id", id).maybeSingle();
  return (data as JobRow) ?? null;
}
