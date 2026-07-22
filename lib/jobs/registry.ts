import "server-only";
import type { JobHandler, JobKind } from "./types";

/**
 * The job-kind → handler registry. Later milestones register real handlers at module load
 * (`generate_image`, `poll_render`, `publish`, `collect_analytics`, …); M0 ships the registry
 * empty. The runner treats a job whose `kind` has no handler as a PERMANENT failure (retrying
 * can't help), dead-lettering it with a clear message rather than looping.
 */

const handlers = new Map<JobKind, JobHandler>();

/** Register the handler for a job kind. Throws on a duplicate to catch double-registration. */
/**
 * Register the handler for a job kind. IMPORTANT: handlers MUST be idempotent — the runner is
 * at-least-once (a job can run twice: a crash after a side effect but before `done`, or a stale-job
 * reclaim, audit #2/#4). A handler that isn't idempotent (e.g. an un-keyed external POST) is unsafe
 * to reclaim-and-rerun. Today's handlers qualify: `publish` (external_id short-circuit + idempotency
 * key) and `collect_analytics` (single-row upsert).
 */
export function registerJobHandler(kind: JobKind, handler: JobHandler): void {
  if (handlers.has(kind)) throw new Error(`job handler already registered for kind "${kind}"`);
  handlers.set(kind, handler);
}

export function getJobHandler(kind: JobKind): JobHandler | undefined {
  return handlers.get(kind);
}

/** Test-only: clear the registry so a suite can register isolated handlers. */
export function resetJobHandlers(): void {
  handlers.clear();
}
