import "server-only";
import type { DbClient } from "@/lib/db/types";
import { adminClient } from "@/lib/db/admin";
import type { JobHandler, JobKind, JobRunSummary } from "./types";
import { getJobHandler } from "./registry";
import { claimDueJobs, markJobDead, markJobDone, requeueJob, reclaimStaleJobs } from "./store";

/**
 * The job runner — one pass over due jobs. Mirrors lib/graph/run: a module-level single-flight
 * guard so the interval poller and any on-demand caller can't process the same claimed rows
 * twice in one process. Claims due jobs, runs each kind's handler, and applies the terminal
 * transition: success → done; throw with attempts remaining → requeue with backoff; throw with
 * attempts exhausted (or no handler for the kind) → dead-letter. Never throws — failures are
 * recorded on the row and summarized for the tick log.
 */

let inFlight: Promise<JobRunSummary> | null = null;

export interface RunDueJobsOptions {
  db?: DbClient;
  limit?: number;
  /** Injected clock — tests advance it to exercise backoff/scheduling without sleeping. */
  now?: Date;
  /** Handler resolver override (tests). Defaults to the module registry. */
  getHandler?: (kind: JobKind) => JobHandler | undefined;
}

export async function runDueJobs(opts?: RunDueJobsOptions): Promise<JobRunSummary> {
  if (inFlight) return inFlight;
  inFlight = runDueJobsInner(opts);
  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}

async function runDueJobsInner(opts?: RunDueJobsOptions): Promise<JobRunSummary> {
  const db = opts?.db ?? adminClient();
  const now = opts?.now ?? new Date();
  const resolve = opts?.getHandler ?? getJobHandler;
  const summary: JobRunSummary = { claimed: 0, succeeded: 0, requeued: 0, dead: 0, reclaimed: 0, errors: [] };

  // Reclaim abandoned `running` jobs (worker vanished mid-run) BEFORE claiming, so a deploy/crash
  // can't silently strand a publish forever (audit #4). Safe because handlers are idempotent (#2).
  const reclaim = await reclaimStaleJobs(db, { now });
  summary.reclaimed = reclaim.reclaimed;
  summary.dead += reclaim.deadLettered; // a stale job past its attempts is dead-lettered by the reclaim

  const jobs = await claimDueJobs(db, { limit: opts?.limit, now });
  summary.claimed = jobs.length;

  for (const job of jobs) {
    const handler = resolve(job.kind);
    if (!handler) {
      // Retrying can't conjure a handler — permanent failure.
      await markJobDead(db, job.id, `no handler registered for kind "${job.kind}"`, now);
      summary.dead++;
      summary.errors.push(`${job.id} (${job.kind}): no handler`);
      continue;
    }
    try {
      await handler(job, db);
      await markJobDone(db, job.id, now);
      summary.succeeded++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (job.attempts >= job.max_attempts) {
        await markJobDead(db, job.id, msg, now);
        summary.dead++;
        summary.errors.push(`${job.id} (${job.kind}): dead after ${job.attempts} attempts — ${msg}`);
      } else {
        await requeueJob(db, job.id, job.attempts, msg, now);
        summary.requeued++;
      }
    }
  }
  return summary;
}
