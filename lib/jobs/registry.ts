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
