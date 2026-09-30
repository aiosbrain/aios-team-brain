import { createHash, randomUUID } from "node:crypto";
import { adminClient } from "@/lib/db/admin";
import { getCachedWorkTimeline } from "@/lib/dashboard/timeline-cache";
import { WINDOW_DAYS, MAX_WINDOW_DAYS } from "@/lib/dashboard/work-timeline";
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
  const { days } = await getCachedWorkTimeline(adminClient(), teamId, tier, memberId);
  // A router refresh merges Server Component props into mounted Client Components. Remount the owner
  // on every new server render: even an identical seven-day snapshot cannot authorize older days that
  // were fetched by client expansion before a revocation. Include the viewer and current authorized
  // days in a fixed-length key without exposing evidence in the key itself.
  const snapshotKey = createHash("sha256")
    .update(JSON.stringify([teamId, teamSlug, tier, memberId, days, randomUUID()]))
    .digest("hex");

  return (
    <div className="flex flex-col gap-6">
      <TimelineLoadMore
        key={snapshotKey}
        teamSlug={teamSlug}
        initialDays={days}
        initialWindow={WINDOW_DAYS}
        maxWindow={MAX_WINDOW_DAYS}
      />
    </div>
  );
}
