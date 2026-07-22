import type { GraphEvent } from "./learning";

/**
 * Group Layer-2 events into a WORK-time chronology for the timeline view. Events arrive newest-work-
 * first (recentEvents orders by `workTs`), so grouping by the date portion of each event's `at` and
 * sorting the day buckets descending yields "most recent work day first, events newest-first within".
 * Pure + unit-tested. The date is the `at` string's YYYY-MM-DD (work time, not extraction) — see
 * docs/design/arcs-work-time-chronology.md.
 */

export interface TimelineDay {
  /** YYYY-MM-DD of the work day. */
  date: string;
  events: GraphEvent[];
}

export function groupEventsByDay(events: GraphEvent[]): TimelineDay[] {
  const byDay = new Map<string, GraphEvent[]>();
  for (const e of events) {
    const date = (e.at ?? "").slice(0, 10) || "unknown";
    const arr = byDay.get(date);
    if (arr) arr.push(e);
    else byDay.set(date, [e]);
  }
  return [...byDay.entries()]
    .sort((a, b) => {
      // Newest work day first; the "unknown" (undated) bucket always sorts LAST, not lexically first.
      if (a[0] === b[0]) return 0;
      if (a[0] === "unknown") return 1;
      if (b[0] === "unknown") return -1;
      return a[0] < b[0] ? 1 : -1;
    })
    .map(([date, evs]) => ({ date, events: evs }));
}
