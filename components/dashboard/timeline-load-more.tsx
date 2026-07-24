"use client";

import { useState } from "react";
import { ChevronDown, Loader2 } from "lucide-react";
import type { TimelineDay } from "@/lib/dashboard/timeline-group";
import { TimelineDays } from "@/components/dashboard/timeline-days";

/**
 * "Show earlier days" — expands the Pulse Timeline beyond the SSR'd default window on demand. Each click
 * widens the lookback (+7 days, capped at `maxWindow`) and fetches the fuller ledger from
 * `/api/dashboard/timeline`, rendering ONLY days the server hasn't already shown (filtered by
 * `shownDates`, so no duplication and no dependency on count alignment between the cached SSR build and
 * this fresh one). Client-fetched so an uncached wider build never blocks the home SSR.
 */
export function TimelineLoadMore({
  teamSlug,
  shownDates,
  initialWindow,
  maxWindow,
}: {
  teamSlug: string;
  shownDates: string[];
  initialWindow: number;
  maxWindow: number;
}) {
  const [windowDays, setWindowDays] = useState(initialWindow);
  const [older, setOlder] = useState<TimelineDay[]>([]);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  const seen = new Set(shownDates);
  const atCap = windowDays >= maxWindow;

  async function loadMore() {
    if (loading || atCap) return;
    const next = Math.min(windowDays + 7, maxWindow);
    setLoading(true);
    setFailed(false);
    try {
      const res = await fetch(
        `/api/dashboard/timeline?team=${encodeURIComponent(teamSlug)}&days=${next}`
      );
      if (!res.ok) throw new Error(String(res.status));
      const data = (await res.json()) as { days: TimelineDay[] };
      // A wider window is a superset, so REPLACE (not append): `fresh` is every day up to `next` the server
      // hasn't already shown. Filtering by `shownDates` (not by count) means a gap week can't stop the
      // expansion early or hide older work — only the `maxWindow` cap ends it.
      const fresh = (data.days ?? []).filter((d) => !seen.has(d.date));
      setOlder(fresh);
      setWindowDays(next);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }

  const showButton = !atCap;

  return (
    <>
      {older.length > 0 && <TimelineDays days={older} />}

      {showButton && (
        <button
          type="button"
          onClick={loadMore}
          disabled={loading}
          className="mx-auto mt-1 flex items-center gap-1.5 rounded-lg border border-border-subtle px-3 py-1.5 text-xs font-medium text-ink-secondary transition hover:bg-surface-subtle hover:text-ink disabled:opacity-60"
        >
          {loading ? (
            <>
              <Loader2 className="size-3.5 animate-spin" /> loading earlier work…
            </>
          ) : (
            <>
              <ChevronDown className="size-3.5" /> Show earlier days
            </>
          )}
        </button>
      )}

      {failed && (
        <p className="mt-1 text-center text-xs text-ink-tertiary">
          Couldn&apos;t load earlier days — try again.
        </p>
      )}
    </>
  );
}
