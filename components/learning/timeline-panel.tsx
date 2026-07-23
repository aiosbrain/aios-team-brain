import { adminClient } from "@/lib/db/admin";
import { getCachedWorkTimeline } from "@/lib/dashboard/timeline-cache";
import type { PersonDay, SourceGroup, TaskGroup } from "@/lib/dashboard/timeline-group";
import { MemberAvatar } from "@/components/people/member-avatar";
import { SourceIcon, sourceLabel } from "@/components/icons/source-icon";

/**
 * Timeline — the team's recent work as a human-readable day → person → work ledger over the last 7
 * days, where a person's evidence (GitHub commits, docs) nests UNDER the task it contributes to (linked
 * by issue key), with an "Other" bucket for evidence linked to no task. Reads the persisted layer
 * (`getCachedWorkTimeline` → `work_timeline_cache`, SWR), the same payload the CLI reads at
 * `GET /api/v1/timeline`. Best-effort: an empty week renders the empty state. `adminClient` is safe
 * because `visibleItems`/`visibleTasks` apply the tier filter regardless.
 */

function timeOf(at: string): string {
  const t = Date.parse(at);
  return Number.isNaN(t) ? "" : new Date(t).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

/** "3 tasks · 12 items" — a person's day at a glance. */
function personSummary(p: PersonDay): string {
  const items = p.tasks.reduce((n, t) => n + t.evidenceCount, 0) + p.other.reduce((n, g) => n + g.count, 0);
  const parts: string[] = [];
  if (p.tasks.length) parts.push(`${p.tasks.length} task${p.tasks.length === 1 ? "" : "s"}`);
  parts.push(`${items} item${items === 1 ? "" : "s"}`);
  return parts.join(" · ");
}

const STATUS_STYLE: Record<string, { label: string; cls: string }> = {
  backlog: { label: "Backlog", cls: "text-ink-tertiary bg-ink-tertiary/10" },
  ready: { label: "Ready", cls: "text-sky-700 bg-sky-500/10" },
  in_progress: { label: "In progress", cls: "text-violet bg-violet/10" },
  in_review: { label: "In review", cls: "text-amber-700 bg-amber-500/10" },
  blocked: { label: "Blocked", cls: "text-red-700 bg-red-500/10" },
  done: { label: "Done", cls: "text-emerald-700 bg-emerald-500/10" },
};

function StatusPill({ status }: { status: string }) {
  const s = STATUS_STYLE[status] ?? { label: status || "—", cls: "text-ink-tertiary bg-ink-tertiary/10" };
  return <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${s.cls}`}>{s.label}</span>;
}

/** The evidence items of one source (nested under a task or in Other), newest-first with "+N more". */
function EvidenceList({ group }: { group: SourceGroup }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-ink-secondary">
        <SourceIcon source={group.source} className="size-3.5" />
        {sourceLabel(group.source)}
        <span className="font-normal text-ink-tertiary/70">· {group.count}</span>
      </div>
      <ul className="flex flex-col gap-1 border-l border-border-subtle pl-3">
        {group.items.map((it) => (
          <li key={it.id} className="flex items-baseline justify-between gap-3">
            {it.url ? (
              <a href={it.url} target="_blank" rel="noreferrer" className="truncate text-sm text-ink hover:text-violet">
                {it.title}
              </a>
            ) : (
              <span className="truncate text-sm text-ink">{it.title}</span>
            )}
            <span className="shrink-0 text-[11px] text-ink-tertiary">{timeOf(it.at)}</span>
          </li>
        ))}
        {group.count > group.items.length ? (
          <li className="text-[11px] text-ink-tertiary">+{group.count - group.items.length} more</li>
        ) : null}
      </ul>
    </div>
  );
}

/** A task header (source icon + title + status + optional "Newly assigned" badge) with its evidence nested. */
function TaskCard({ task }: { task: TaskGroup }) {
  return (
    <div className="flex flex-col gap-2 rounded-md border border-border-subtle/60 p-2.5">
      <div className="flex items-center gap-2">
        <SourceIcon source={task.source} className="size-4" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">{task.title}</span>
        <StatusPill status={task.status} />
      </div>
      {task.sources.length ? (
        <div className="flex flex-col gap-2 pl-6">
          {task.sources.map((g) => (
            <EvidenceList key={g.source} group={g} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

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
              <div key={p.memberId} className="prism-card flex flex-col gap-3 p-4">
                <div className="flex items-center gap-2.5">
                  <MemberAvatar person={{ displayName: p.name, avatarUrl: p.avatarUrl }} size={32} />
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-ink">{p.name}</p>
                    <p className="text-[11px] text-ink-tertiary">{personSummary(p)}</p>
                  </div>
                </div>

                {p.summary ? (
                  <p className="text-[13px] leading-snug text-ink-secondary">{p.summary}</p>
                ) : null}

                {p.tasks.length ? (
                  <div className="flex flex-col gap-2">
                    {p.tasks.map((t) => (
                      <TaskCard key={t.taskId} task={t} />
                    ))}
                  </div>
                ) : null}

                {p.other.length ? (
                  <div className="flex flex-col gap-2">
                    <div className="text-[11px] font-semibold uppercase tracking-wider text-ink-tertiary/80">
                      Other · not linked to a task
                    </div>
                    <div className="flex flex-col gap-2 pl-1">
                      {p.other.map((g) => (
                        <EvidenceList key={g.source} group={g} />
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
