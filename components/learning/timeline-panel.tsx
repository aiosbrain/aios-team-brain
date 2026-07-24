import { adminClient } from "@/lib/db/admin";
import { getCachedWorkTimeline } from "@/lib/dashboard/timeline-cache";
import { WINDOW_DAYS, MAX_WINDOW_DAYS } from "@/lib/dashboard/work-timeline";
import { TimelineDays } from "@/components/dashboard/timeline-days";
import { TimelineLoadMore } from "@/components/dashboard/timeline-load-more";

/**
 * Timeline — the team's recent work as a human-readable day → person → work ledger over the last 7
 * days, where a person's evidence (GitHub commits, docs) nests UNDER the task it contributes to (linked
 * by issue key), with an "Other" bucket for evidence linked to no task. Reads the persisted layer
 * (`getCachedWorkTimeline` → `work_timeline_cache`, SWR), the same payload the CLI reads at
 * `GET /api/v1/timeline`. Each person renders via the shared `PersonWorkCard`, so the Home "Working on"
 * section (each person's most recent day) is IDENTICAL to a timeline day. A "Show earlier days" control
 * (`TimelineLoadMore`) expands the lookback on demand up to `MAX_WINDOW_DAYS`. Best-effort: an empty week
 * still offers the expansion (older work may exist beyond the default window). `adminClient` is safe
 * because `visibleItems`/`visibleTasks` apply the tier filter regardless.
 */

export async function TimelinePanel({
  teamId,
  teamSlug,
  tier,
}: {
  teamId: string;
  teamSlug: string;
  tier: "team" | "external";
}) {
  const days = await getCachedWorkTimeline(adminClient(), teamId, tier);
  const shownDates = days.map((d) => d.date);

  return (
    <div className="flex flex-col gap-6">
      {days.length === 0 ? (
        <p className="rounded-lg border border-border-subtle px-4 py-6 text-center text-sm text-ink-tertiary">
          No work in the last {WINDOW_DAYS} days — the timeline fills in as commits, tasks, and docs land.
          Look further back below.
        </p>
      ) : (
        <TimelineDays days={days} />
      )}

      <TimelineLoadMore
        teamSlug={teamSlug}
        shownDates={shownDates}
        initialWindow={WINDOW_DAYS}
        maxWindow={MAX_WINDOW_DAYS}
      />
    </div>
  );
}
