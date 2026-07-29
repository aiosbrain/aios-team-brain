import type { PersonDay, TaskGroup } from "@/lib/dashboard/timeline-group";
import { isActiveStatus, isOpenStatus } from "@/lib/tasks/activity-policy";

/**
 * Pulse SNAPSHOT sizing — the pure rules behind the bounded "one screen" header.
 *
 * The Pulse home used to be a *feed*: every band's height was proportional to how much data existed, so
 * the band that answers "what's happening" (up to `MAX_ARCS` = 12 narrative arcs, ~400 chars of prose
 * each) was also the tallest thing on the page and sat first. Measured on prod (6 arcs), the arcs band
 * alone was ~1,200px and the whole page ~2,700px — roughly three viewports before you'd seen everything.
 *
 * A dashboard snapshot is the opposite: total height is CONSTANT regardless of data volume. Every
 * above-the-fold band therefore shows "N with a link", never "all N". These caps are the mechanism, so
 * they live here as pure, testable values rather than as magic numbers inside JSX — the guard in
 * `test/pulse-digest.test.ts` is what keeps the first screen from silently growing back.
 */

/** Arcs shown in the snapshot band. 3 × ~90px ≈ 270px — the story, not the whole story. */
export const DIGEST_ARC_LIMIT = 3;

/** People shown in the snapshot roster. Bounded so a big team can't push the fold down. */
export const DIGEST_PEOPLE_LIMIT = 6;

/** A capped slice plus what it left behind, so the UI can offer "see all {total}". */
export interface Digest<T> {
  shown: T[];
  hidden: number;
  total: number;
}

/**
 * Cap a list for a snapshot band. `limit` is clamped at 0 so a bad caller can never produce a negative
 * `hidden` count (which would render as "see all -2"). Order is preserved — callers pass data already
 * sorted by whatever "most relevant" means for that band.
 */
export function digest<T>(items: readonly T[] | null | undefined, limit: number): Digest<T> {
  const all = items ?? [];
  const safeLimit = Math.max(0, Math.trunc(limit));
  return {
    shown: all.slice(0, safeLimit),
    hidden: Math.max(0, all.length - safeLimit),
    total: all.length,
  };
}

/**
 * Rank for the ONE task a compact person-row can headline: being-worked-now, then merely-open, then
 * everything else. Derived from `lib/tasks/activity-policy` rather than re-spelling a status list —
 * that module is the single answer to "is this task being worked on" (a local copy is exactly the drift
 * `test/guards/activity-policy-single-source.test.ts` fails the build over), and deriving means a newly
 * mapped provider status inherits the ordering instead of silently falling to the bottom.
 *
 * Within a tier there is deliberately no further precedence — `in_progress` vs `blocked` would be a new
 * policy distinction this module has no standing to invent, so ties fall back to the order the timeline
 * already produced, which is `evidenceCount` DESC then title (`groupTimeline` in `timeline-group`) —
 * i.e. the task that person put the most work into. NOT recency; don't build a caller that assumes it.
 */
function rankOf(status: string): number {
  if (isActiveStatus(status)) return 0;
  if (isOpenStatus(status)) return 1;
  return 2;
}

/**
 * The single task a person's snapshot row headlines — the most active one (see `rankOf`), ties broken by
 * the order `groupTimeline` already produced: `evidenceCount` DESC then title, i.e. the task they put the
 * most work into. NOT recency. Returns null when the person has no tasks at all, in which case the row
 * falls back to their counts/synopsis.
 */
export function headlineTask(person: PersonDay): TaskGroup | null {
  const tasks = person.tasks ?? [];
  if (!tasks.length) return null;
  return tasks.reduce((best, t) => (rankOf(t.status) < rankOf(best.status) ? t : best));
}
