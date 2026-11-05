import { adminClient } from "@/lib/db/admin";
import { AttributionRepairPendingError } from "@/lib/access/authorization-epoch";
import { getCachedWorkTimeline, TimelineAuthorizationChangedError, type CachedTimeline } from "@/lib/dashboard/timeline-cache";
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
 *
 * The two EXPECTED unavailability errors (an identity-attribution repair in progress, or authorization
 * moving under both read attempts) degrade only this panel to a temporary notice — the same condition
 * the timeline routes answer with 503. No ledger is shown in that state (never stale evidence), and the
 * rest of the page keeps rendering because the error never reaches the segment boundary. Anything else
 * is unexpected and still throws.
 */

export async function TimelinePanel({
  teamId,
  teamSlug,
  tier,
  memberId,
}: {
  teamId: string;
  teamSlug: string;
  tier: "team" | "external";
  /** The viewing member — §5.8: an enforcing team serves their visibility variant, never the tier row. */
  memberId: string;
}) {
  // Payload only: this panel renders the ledger and has no freshness affordance today. Surfacing
  // `freshness.stale` here (a "last updated" line) is a UI change, deliberately not bundled with the
  // wire fix — see the PR's follow-ups.
  const read = await readTimeline(teamId, tier, memberId);
  if ("notice" in read) {
    return (
      <p role="status" className="rounded-lg border border-border-subtle px-4 py-6 text-center text-sm text-ink-tertiary">
        {read.notice}
      </p>
    );
  }
  const { days } = read.timeline;
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

/** The ledger, or the notice for an expected, retryable unavailability. Unexpected errors propagate. */
async function readTimeline(
  teamId: string,
  tier: "team" | "external",
  memberId: string,
): Promise<{ timeline: CachedTimeline } | { notice: string }> {
  try {
    return { timeline: await getCachedWorkTimeline(adminClient(), teamId, tier, memberId) };
  } catch (error) {
    const notice = unavailableNotice(error);
    if (notice === null) throw error;
    return { notice };
  }
}

/** The panel's copy for an expected, retryable unavailability; `null` for anything unexpected. */
function unavailableNotice(error: unknown): string | null {
  if (error instanceof AttributionRepairPendingError) {
    return "Timeline is temporarily unavailable while work attribution is being repaired. Refresh in a moment.";
  }
  if (error instanceof TimelineAuthorizationChangedError) {
    return "Timeline access changed while it was loading. Refresh to see the current view.";
  }
  return null;
}
