import { adminClient } from "@/lib/db/admin";
import { visibleGroupIds } from "@/lib/graph/group";
import { recentEvents } from "@/lib/graph/learning";
import { resolveHumanActorsByItem } from "@/lib/graph/human-actors";
import { attributeEventParticipants } from "@/lib/graph/arc-attribution";
import { groupEventsByDay } from "@/lib/graph/timeline";

/**
 * Timeline — the team's recent work on a WORK-time axis (events grouped by work day, newest first),
 * now that facts/events order by when the work happened, not when it was extracted (see
 * docs/design/arcs-work-time-chronology.md). Tier-scoped via `visibleGroupIds` (sole enforcement,
 * CLAUDE §5). Best-effort — an empty/unreachable graph renders the empty state. All time formatting
 * happens in `loadTimeline` (not during render, so the server component stays a pure render).
 */

const WINDOW_DAYS = 30;
const LIMIT = 120;

const SOURCE_ICON: Record<string, string> = {
  slack: "💬",
  github: "🐙",
  git: "🔗",
  linear: "📐",
  plane: "📐",
  notion: "📝",
  granola: "🎙️",
  gdrive: "📄",
  confluence: "📘",
  web: "🌐",
};

interface TimelineEventView {
  id: string;
  icon: string;
  title: string;
  time: string;
  meta: string;
}
interface TimelineDayView {
  date: string;
  label: string;
  events: TimelineEventView[];
}

function dayLabel(date: string, today: string, yest: string): string {
  if (date === today) return "Today";
  if (date === yest) return "Yesterday";
  const t = Date.parse(date);
  if (Number.isNaN(t)) return "Undated";
  return new Date(t).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

function timeOf(at: string): string {
  const t = Date.parse(at);
  return Number.isNaN(t) ? "" : new Date(t).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

/** Fetch + group + format — all `Date`/`Date.now` usage lives here, off the render path. */
async function loadTimeline(teamSlug: string, teamId: string, tier: "team" | "external"): Promise<TimelineDayView[]> {
  const today = new Date().toISOString().slice(0, 10);
  const yest = new Date(Date.now() - 86400_000).toISOString().slice(0, 10);
  const since = new Date(Date.now() - WINDOW_DAYS * 86400_000).toISOString();

  const events = await recentEvents(visibleGroupIds(teamSlug, tier), since, LIMIT);
  const itemIds = [...new Set(events.map((e) => e.itemId).filter((id): id is string => !!id))];
  const humanByItem = await resolveHumanActorsByItem(adminClient(), teamId, itemIds);
  const days = groupEventsByDay(attributeEventParticipants(events, humanByItem));

  return days.map((day) => ({
    date: day.date,
    label: dayLabel(day.date, today, yest),
    events: day.events.map((ev) => ({
      id: ev.id,
      icon: SOURCE_ICON[ev.source] ?? "📌",
      title: ev.title || "(untitled event)",
      time: timeOf(ev.at),
      meta:
        `${ev.source || "source"} · ${ev.factCount} fact${ev.factCount === 1 ? "" : "s"}` +
        (ev.participants.length ? ` · ${ev.participants.join(", ")}` : ""),
    })),
  }));
}

export async function TimelinePanel({
  teamSlug,
  teamId,
  tier,
}: {
  teamSlug: string;
  teamId: string;
  tier: "team" | "external";
}) {
  const days = await loadTimeline(teamSlug, teamId, tier);

  if (days.length === 0) {
    return (
      <p className="rounded-lg border border-border-subtle px-4 py-6 text-center text-sm text-ink-tertiary">
        No recent activity to chart yet — the timeline fills in as the brain extracts events from your team&apos;s work.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      {days.map((day) => (
        <div key={day.date}>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-tertiary">{day.label}</h3>
          <ol className="ml-2 flex flex-col border-l border-border-subtle">
            {day.events.map((ev) => (
              <li key={ev.id} className="relative ml-4 pb-4 last:pb-0">
                <span className="absolute -left-[22px] top-1.5 size-2 rounded-full border-2 border-surface bg-violet" aria-hidden />
                <div className="flex items-start gap-2">
                  <span className="mt-0.5 text-sm leading-none">{ev.icon}</span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-ink">{ev.title}</p>
                    <p className="mt-0.5 text-[11px] text-ink-tertiary">
                      {ev.time ? `${ev.time} · ` : ""}
                      {ev.meta}
                    </p>
                  </div>
                </div>
              </li>
            ))}
          </ol>
        </div>
      ))}
    </div>
  );
}
