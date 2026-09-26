"use client";

import { useEffect, useReducer, useRef } from "react";
import { ChevronDown, Loader2 } from "lucide-react";
import type { TimelineDay } from "@/lib/dashboard/timeline-group";
import { TimelineDays } from "@/components/dashboard/timeline-days";
import { timelineExpansionReducer } from "@/components/dashboard/timeline-expansion-state";

/**
 * Owns the SSR'd initial days and expands the Pulse Timeline on demand. A wider API response is a
 * complete fresh snapshot: replacing the rendered days also updates same-date evidence and corrections.
 * Client fetching keeps an uncached wider build off the home SSR path.
 */
export function TimelineLoadMore({
  teamSlug,
  initialDays,
  initialWindow,
  maxWindow,
}: {
  teamSlug: string;
  initialDays: TimelineDay[];
  initialWindow: number;
  maxWindow: number;
}) {
  const [{ days, windowDays, loading, failed }, dispatch] = useReducer(timelineExpansionReducer, {
    days: initialDays,
    windowDays: initialWindow,
    loading: false,
    failed: false,
    activeRequestId: null,
  });
  const inFlight = useRef(false);
  const requestId = useRef(0);
  const requestedWindow = useRef(initialWindow);
  const controller = useRef<AbortController | null>(null);

  const atCap = windowDays >= maxWindow;

  useEffect(() => () => {
    requestId.current += 1;
    controller.current?.abort();
  }, []);

  async function loadMore() {
    // The ref closes the gap before React renders the disabled button after a rapid second click.
    if (inFlight.current || requestedWindow.current >= maxWindow) return;
    inFlight.current = true;
    const id = ++requestId.current;
    const abort = new AbortController();
    controller.current = abort;
    const next = Math.min(requestedWindow.current + 7, maxWindow);
    dispatch({ type: "start", requestId: id });
    try {
      const res = await fetch(
        `/api/dashboard/timeline?team=${encodeURIComponent(teamSlug)}&days=${next}`,
        { signal: abort.signal }
      );
      if (!res.ok) throw new Error(String(res.status));
      const data: unknown = await res.json();
      if (!data || typeof data !== "object" || !("days" in data) || !Array.isArray(data.days)) {
        throw new Error("invalid timeline response");
      }
      if (requestId.current !== id || abort.signal.aborted) return;
      // The response is the entire requested window, including corrected recent dates.
      requestedWindow.current = next;
      dispatch({ type: "success", requestId: id, days: data.days as TimelineDay[], windowDays: next });
    } catch {
      if (requestId.current === id && !abort.signal.aborted) dispatch({ type: "failure", requestId: id });
    } finally {
      if (requestId.current === id) {
        inFlight.current = false;
        controller.current = null;
      }
    }
  }

  const showButton = !atCap;

  return (
    <>
      {days.length === 0 ? (
        <p className="rounded-lg border border-border-subtle px-4 py-6 text-center text-sm text-ink-tertiary">
          No work in the last {windowDays} days — the timeline fills in as commits, tasks, and docs land.
          Look further back below.
        </p>
      ) : (
        <TimelineDays days={days} />
      )}

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
