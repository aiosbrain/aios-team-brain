import type { TimelineDay } from "@/lib/dashboard/timeline-group";
import { PersonWorkCard } from "@/components/dashboard/person-work-card";

/**
 * The day → person → work list — the shared render for BOTH the server-rendered Timeline panel (the
 * initial 7-day window) and the client "Show earlier days" expansion, so an expanded day looks identical
 * to an SSR'd one. Pure markup (no hooks), so it renders in either a server or client boundary.
 */
export function TimelineDays({ days }: { days: TimelineDay[] }) {
  return (
    <>
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
    </>
  );
}
