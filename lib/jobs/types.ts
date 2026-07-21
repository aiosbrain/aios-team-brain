import type { DbClient } from "@/lib/db/types";

/**
 * Durable job/outbox types (M0). A job is one unit of async work the Social Brain must run
 * reliably across process restarts: media generation, provider polling, scheduled publishing,
 * publish/analytics retries. See postgres/schema.sql `social_jobs`.
 */

/** Lifecycle: queued → running → done, or queued → running → (requeue) → … → dead. */
export type JobStatus = "queued" | "running" | "done" | "dead";

/**
 * The `kind` string dispatches to a registered handler (lib/jobs/registry). It is an open
 * string (not a closed union) so later milestones add kinds without touching this file; the
 * kinds M0 anticipates are documented on the schema column.
 */
export type JobKind = string;

/** A row of `social_jobs`. timestamptz/date columns arrive as strings (see lib/db/pg/pool). */
export interface JobRow {
  id: string;
  team_id: string;
  kind: JobKind;
  payload: Record<string, unknown>;
  status: JobStatus;
  attempts: number;
  max_attempts: number;
  run_after: string;
  locked_at: string | null;
  last_error: string | null;
  dedup_key: string | null;
  created_at: string;
  updated_at: string;
}

/** Input to enqueue a job. `runAfter` schedules it for the future (e.g. "publish at 3pm"). */
export interface EnqueueJobInput {
  teamId: string;
  kind: JobKind;
  payload?: Record<string, unknown>;
  /** Earliest run time. Omit to run as soon as the poller next ticks. */
  runAfter?: Date;
  /** Max failed attempts before the job is dead-lettered (defaults to 5). */
  maxAttempts?: number;
  /** Idempotency key — a second enqueue with the same (team, key) returns the existing job. */
  dedupKey?: string;
}

/**
 * A handler runs one claimed job. It receives the job row and a db client. It should THROW to
 * signal a retryable failure (the runner requeues with backoff, or dead-letters once attempts
 * are exhausted); a normal return marks the job done. Handlers must be idempotent — a job may
 * run more than once (crash after side effect, before the row is marked done).
 */
export type JobHandler = (job: JobRow, db: DbClient) => Promise<void>;

/** Outcome of one runDueJobs pass — an observability summary, never throws. */
export interface JobRunSummary {
  claimed: number;
  succeeded: number;
  requeued: number;
  dead: number;
  /** Stale `running` jobs (worker vanished mid-run) returned to the queue this tick (audit #4). */
  reclaimed: number;
  /** Human-readable errors for the tick log; failures are recorded on the row, not thrown. */
  errors: string[];
}
