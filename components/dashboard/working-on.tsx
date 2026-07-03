import { Users } from "lucide-react";
import type { WorkingOnEntry } from "@/lib/dashboard/working-on";

/**
 * "Working on" — one line per person, drawn from the Learning layer (Graphiti facts) and keyed on
 * the member roster so names are canonical and deduped (see lib/dashboard/working-on). Empty state
 * when the learning graph has no recent person facts yet.
 */
export function WorkingOn({ entries }: { entries: WorkingOnEntry[] }) {
  return (
    <section className="prism-card px-5 py-4">
      <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-ink-tertiary">
        <Users className="size-3.5 text-violet" /> Working on
      </h2>
      {entries.length === 0 ? (
        <p className="text-sm text-ink-tertiary">
          No recent activity from the learning layer yet.
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {entries.map((e) => (
            <li key={e.memberId} className="flex flex-col gap-0.5">
              <span className="text-sm font-medium text-ink">{e.name}</span>
              <span className="text-sm text-ink-secondary">{e.fact}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
