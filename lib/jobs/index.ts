/**
 * Social Brain durable job/outbox (M0) — public surface.
 *
 * Enqueue work (`enqueueJob`), register a handler per kind (`registerJobHandler`), and let the
 * in-process poller (`startSocialJobsScheduler`, wired in instrumentation.ts) drain it with
 * retries + backoff + dead-lettering. `runDueJobs` is the one-pass runner the poller calls and
 * tests drive directly. Writes go through the single-writer store (lib/jobs/store); nothing else
 * writes `social_jobs`.
 */
export type {
  JobRow,
  JobStatus,
  JobKind,
  JobHandler,
  EnqueueJobInput,
  JobRunSummary,
} from "./types";
export { enqueueJob, getJob } from "./store";
export { registerJobHandler, getJobHandler } from "./registry";
export { runDueJobs } from "./run";
export { startSocialJobsScheduler } from "./scheduler";
