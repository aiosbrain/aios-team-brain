import { adminClient } from "@/lib/db/admin";
import { getWorkTimeline } from "@/lib/dashboard/work-timeline";
import type { PersonDay } from "@/lib/dashboard/timeline-group";
import { MemberAvatar } from "@/components/people/member-avatar";
import { SourceIcon, sourceLabel } from "@/components/icons/source-icon";

/**
 * Timeline — the team's recent work as a human-readable day → person → evidence ledger over the last
 * 7 days (GitHub commits, Linear/Plane tasks, dated docs), each with a brand source icon + link. Reads
 * Postgres `items`+`tasks` (via `getWorkTimeline`, tier-gated through the §5 choke-points), NOT the
 * graph — so it shows real per-person work instead of chunked extraction episodes. Best-effort: an
 * empty week renders the empty state. `adminClient` is safe here because `visibleItems`/`visibleTasks`
 * apply the tier filter inside the query regardless of the client.
 */

function timeOf(at: string): string {
  const t = Date.parse(at);
  return Number.isNaN(t) ? "" : new Date(t).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

/** "12 items · GitHub, Linear" — the distinct sources a person touched that day. */
function personSummary(p: PersonDay): string {
  const sources = [...new Set(p.sources.map((s) => sourceLabel(s.source)))];
  return `${p.total} item${p.total === 1 ? "" : "s"} · ${sources.join(", ")}`;
}

export async function TimelinePanel({ teamId, tier }: { teamId: string; tier: "team" | "external" }) {
  const days = await getWorkTimeline(adminClient(), teamId, tier);

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

                <div className="flex flex-col gap-3">
                  {p.sources.map((g) => (
                    <div key={g.source} className="flex flex-col gap-1.5">
                      <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-ink-secondary">
                        <SourceIcon source={g.source} className="size-3.5" />
                        {sourceLabel(g.source)}
                        <span className="font-normal text-ink-tertiary/70">· {g.count}</span>
                      </div>
                      <ul className="flex flex-col gap-1 border-l border-border-subtle pl-3">
                        {g.items.map((it) => (
                          <li key={it.id} className="flex items-baseline justify-between gap-3">
                            {it.url ? (
                              <a
                                href={it.url}
                                target="_blank"
                                rel="noreferrer"
                                className="truncate text-sm text-ink hover:text-violet"
                              >
                                {it.title}
                              </a>
                            ) : (
                              <span className="truncate text-sm text-ink">{it.title}</span>
                            )}
                            <span className="shrink-0 text-[11px] text-ink-tertiary">{timeOf(it.at)}</span>
                          </li>
                        ))}
                        {g.count > g.items.length ? (
                          <li className="text-[11px] text-ink-tertiary">+{g.count - g.items.length} more</li>
                        ) : null}
                      </ul>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
