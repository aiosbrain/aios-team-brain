import { adminClient } from "@/lib/db/admin";
import { getCachedWorkTimeline } from "@/lib/dashboard/timeline-cache";
import { PersonWorkCard } from "@/components/dashboard/person-work-card";

/**
 * Timeline — the team's recent work as a human-readable day → person → work ledger over the last 7
 * days, where a person's evidence (GitHub commits, docs) nests UNDER the task it contributes to (linked
 * by issue key), with an "Other" bucket for evidence linked to no task. Reads the persisted layer
 * (`getCachedWorkTimeline` → `work_timeline_cache`, SWR), the same payload the CLI reads at
 * `GET /api/v1/timeline`. Each person renders via the shared `PersonWorkCard`, so the Home "Working on"
 * section (each person's most recent day) is IDENTICAL to a timeline day. Best-effort: an empty week
 * renders the empty state. `adminClient` is safe because `visibleItems`/`visibleTasks` apply the tier
 * filter regardless.
 */

export async function TimelinePanel({ teamId, tier }: { teamId: string; tier: "team" | "external" }) {
  const days = await getCachedWorkTimeline(adminClient(), teamId, tier);

  if (days.length === 0) {
    return (
      <p className="rounded-lg border border-border-subtle px-4 py-6 text-center text-sm text-ink-tertiary">
        No recent work to show — the timeline fills in as commits, tasks, and docs land over the last 7 days.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {days.map((day) => (
        <div key={day.date} className="flex flex-col gap-3">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-ink-tertiary">{day.label}</h3>

          <div className="flex flex-col gap-3">
            {day.people.map((p) => (
              <PersonWorkCard key={p.memberId} person={p} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
