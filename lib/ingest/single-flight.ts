/**
 * Single-flight for the ingest scheduler tick (TICKSTALL-1,
 * `docs/design/tick-stall-backfill-budget.md` §Decision 2).
 *
 * WHY. `setInterval(tick, intervalMs)` starts a new tick whether or not the last one finished. That
 * was survivable while every stage was fast; it stopped being survivable once `runContextBackfill`
 * joined the chain and began taking ~59 minutes against a 30-minute interval. Measured inside one
 * prod outage (2026-08-17 04:27→09:18 UTC): `slack` recorded 13 times in 4.85h where a 30-minute
 * interval predicts ~9.7 — that surplus IS the overlap, ticks stacking on each other.
 *
 * It is also a correctness PREREQUISITE, not just waste. TICKSTALL-1 gives the backfill a durable
 * resume cursor stored in `ingest_runs.meta`, and `recordIngestRun` is append-only, best-effort, and
 * swallows its own write failures (`lib/ingest/runs.ts`) — there is no compare-and-swap to build on.
 * With overlapping ticks, two passes read the same cursor, redo the same batch, and race their
 * "newest row" writes, and a stale pass finishing after a drain can RESURRECT a superseded cursor.
 * One pass in flight means the cursor has a single writer, which is what makes it sound at all.
 *
 * THE FAILURE MODE THIS MODULE MUST NOT HAVE: a flag that leaks `true`. A guard that fails to clear
 * wedges ingestion **permanently** — strictly worse than the overlap it replaces — so the reset lives
 * in `finally` and is pinned by its own test. That is the whole reason this is a module with a test
 * rather than two lines inlined in the scheduler.
 */

export interface SingleFlightResult {
  /** False when this call was skipped because another was already running. */
  ran: boolean;
}

/**
 * Wrap an async no-arg task so that a call arriving while a previous one is still running returns
 * immediately instead of running concurrently.
 *
 * Deliberately SKIP, not queue: the caller is a poller that will fire again in `INGEST_POLL_MINUTES`.
 * Queueing would rebuild the backlog this exists to prevent — a slow pass would leave a pile of
 * pending ticks that all run the moment it finishes.
 *
 * Errors propagate unchanged; the in-flight flag is cleared either way.
 */
export function singleFlight(task: () => Promise<void>): () => Promise<SingleFlightResult> {
  let inFlight = false;
  return async (): Promise<SingleFlightResult> => {
    if (inFlight) return { ran: false };
    inFlight = true;
    try {
      await task();
      return { ran: true };
    } finally {
      // `finally`, not the end of `try`: a throwing stage must not wedge the poller forever.
      inFlight = false;
    }
  };
}
