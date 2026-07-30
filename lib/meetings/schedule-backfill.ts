import "server-only";
import { isMeetingTranscript } from "./from-items";

/**
 * Run the meeting-notes backfill right after a meeting is pushed, instead of leaving it to the 30-minute
 * scheduler tick.
 *
 * The gap this closes: `aios push` writes the transcript to `items` and returns success, but the Meetings
 * page reads `meeting_notes` — a row only the backfill creates. So a just-pushed meeting was invisible for
 * up to `INGEST_POLL_MINUTES` (unset in prod ⇒ 30) with the CLI reporting success and the UI showing
 * nothing. Measured on 2026-07-30: pushed 06:02, notes appeared 06:13.
 *
 * Two properties matter, and both are the reason this isn't just `after(() => backfill())`:
 *
 * 1. **Coalescing.** `backfillMeetingNotesFromItems` scans every un-noted meeting transcript for the team,
 *    and each note it creates costs an LLM extraction. A Granola sync pushes meetings back-to-back (three
 *    in ~4 seconds on the run that prompted this), so a naive per-push call would start N overlapping
 *    full scans racing over the same rows — N× the model spend for one run's worth of work. Because any
 *    single run picks up everything ingested by the time it starts, **one queued run subsumes any number
 *    of pushes that arrive while a run is in flight**: at most one running + one queued per team.
 * 2. **Total isolation from the push.** This is post-response work; the runner swallows its own errors and
 *    nothing here is ever awaited by the request. A failing model must not turn a successful push into a
 *    500 — the scheduler remains the backstop either way.
 *
 * In-process state is the right scope: the brain is a single Railway service that already runs the poller
 * in-process (`lib/ingest/scheduler`). It is an optimisation, not a correctness mechanism — if a process
 * restarts mid-run, the next scheduler tick still creates the note.
 */

/** Does this push warrant an immediate backfill? Pure — the route's whole trigger condition. */
export function shouldScheduleMeetingBackfill(input: {
  kind: string;
  /** `frontmatter.source` of the pushed item. */
  source: unknown;
  status: "created" | "updated" | "unchanged";
}): boolean {
  // An unchanged re-push already has its note (or was already scanned) — re-running would pay for the
  // same extraction twice. `aios push` re-sends byte-identical files routinely, so this is the common case.
  if (input.status === "unchanged") return false;
  // Meeting sources only. `kind='transcript'` also covers Slack threads, and the Meetings page must never
  // fill up with chat threads — same rule `backfillMeetingNotesFromItems` applies when it scans.
  return isMeetingTranscript(input.kind, typeof input.source === "string" ? input.source : null);
}

export type BackfillRunner = (teamId: string) => Promise<unknown>;

export interface MeetingBackfillScheduler {
  /**
   * Request a backfill for this team. Never throws, never rejects.
   *
   * The returned promise resolves at team QUIESCENCE — when no run is in flight — which is at or after
   * the run covering this request. Under a sustained push stream it can therefore stay pending past the
   * caller's own run, since later pushes extend the chain. That is deliberate: `after()` awaits it, and
   * holding the request context until the team is actually idle is what stops a host that freezes after
   * the response from killing a run mid-extraction. The cost is a held closure, not correctness.
   */
  schedule(teamId: string): Promise<void>;
  /** Resolves once no run is in flight for this team. */
  idle(teamId: string): Promise<void>;
}

/**
 * Build a scheduler over `run`. A factory rather than module-level state so tests get an isolated
 * instance; the route uses the shared singleton below.
 */
export function createMeetingBackfillScheduler(run: BackfillRunner): MeetingBackfillScheduler {
  const inFlight = new Map<string, Promise<void>>();
  const queued = new Set<string>();

  function launch(teamId: string): void {
    // The promise is created and registered in ONE synchronous block. Registering after an await would
    // leave a window where a concurrent push sees no in-flight run and starts a second one — exactly the
    // overlap this exists to prevent.
    const p = (async () => {
      try {
        await run(teamId);
      } catch {
        // best-effort: the scheduler tick is the backstop
      }
    })();
    inFlight.set(teamId, p);
    void p.then(() => {
      inFlight.delete(teamId);
      // Deleting and relaunching in the same synchronous continuation keeps the invariant intact.
      if (queued.delete(teamId)) launch(teamId);
    });
  }

  /**
   * Resolves once this team has no run in flight. Following the chain is enough to also cover a queued
   * successor: `launch` registers its handoff `.then` before any caller awaits the same promise, so by
   * the time this loop resumes, `inFlight` already holds the successor (or nothing). That ordering is
   * why a `queued` check here would be redundant — queued always implies in-flight.
   */
  async function idle(teamId: string): Promise<void> {
    let p: Promise<void> | undefined;
    while ((p = inFlight.get(teamId))) await p;
  }

  return {
    schedule(teamId: string): Promise<void> {
      // A run is already coming that will see this item too — one trailing run is enough.
      if (inFlight.has(teamId)) queued.add(teamId);
      else launch(teamId);
      return idle(teamId);
    },
    idle,
  };
}

/** The shared instance the push route uses. Imports are lazy so the API route stays light. */
export const meetingBackfillScheduler = createMeetingBackfillScheduler(async (teamId) => {
  const { adminClient } = await import("@/lib/db/admin");
  const { resolveAnsweringKeys } = await import("@/lib/query/answering");
  const { backfillMeetingNotesFromItems } = await import("./from-items");
  const db = adminClient();
  const keys = await resolveAnsweringKeys(db, teamId);
  await backfillMeetingNotesFromItems(db, teamId, { keys });
});
