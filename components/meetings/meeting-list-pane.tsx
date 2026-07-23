"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { MemberAvatar } from "@/components/people/member-avatar";
import { timeAgo } from "@/components/format";
import { meetingSynopsis } from "@/lib/meetings/summary-format";
import type { MeetingNoteSummary } from "@/lib/meetings/notes";

interface MeetingListPaneProps {
  teamSlug: string;
  notes: MeetingNoteSummary[];
  /** Note the index route shows by default (newest) — highlighted when the path has no explicit id. */
  defaultActiveId?: string | null;
}

/**
 * The left rail of the two-pane Meetings view: every meeting the viewer can see, newest first, with
 * the currently-open one highlighted (derived from the path, so it stays in sync across navigation).
 * On the bare index path (no id) the default note the index renders is highlighted instead.
 * The parent layout owns sorting; this component only renders + marks the active row.
 */
export function MeetingListPane({ teamSlug, notes, defaultActiveId = null }: MeetingListPaneProps) {
  const pathname = usePathname();
  const onIndex = pathname === `/t/${teamSlug}/meetings`;

  return (
    <nav aria-label="Meetings" className="flex w-full flex-col gap-1.5">
      {notes.map((note) => {
        const href = `/t/${teamSlug}/meetings/${note.id}`;
        const active = pathname === href || (onIndex && note.id === defaultActiveId);
        const synopsis = meetingSynopsis(note.summary);
        return (
          <Link
            key={note.id}
            href={href}
            // Full prefetch (data, not just the loading skeleton) so clicking a meeting is served
            // from the client cache instead of a fresh ~0.5s+ server round-trip. Fires in the
            // background as items enter the viewport; a full prefetch is cached under the `static`
            // staleTimes bucket (300s). Meeting notes are near-immutable, so 5-min freshness is fine;
            // any edit calls revalidatePath and purges the entry anyway.
            prefetch
            aria-current={active ? "page" : undefined}
            className={`flex flex-col gap-1.5 rounded-lg border px-3.5 py-3 transition-colors ${
              active
                ? "border-violet/40 bg-violet/10"
                : "border-border-subtle bg-surface-raised hover:border-border hover:bg-surface-overlay"
            }`}
          >
            <div className="flex items-start justify-between gap-2">
              <h2 className={`truncate text-sm font-medium ${active ? "text-ink" : "text-ink-secondary"}`}>
                {note.title}
              </h2>
              <span className="shrink-0 text-[11px] text-ink-tertiary">
                {note.occurredAt ?? timeAgo(note.createdAt)}
              </span>
            </div>
            {synopsis ? (
              <p className={`line-clamp-3 text-xs leading-snug ${active ? "text-ink-secondary" : "text-ink-tertiary"}`}>
                {synopsis}
              </p>
            ) : null}
            {note.attendees.length ? (
              <div className="flex -space-x-1.5">
                {note.attendees.slice(0, 5).map((a) => (
                  <MemberAvatar key={a.id} person={a} size={16} className="ring-2 ring-surface-raised" />
                ))}
                {note.attendees.length > 5 ? (
                  <span className="flex size-4 items-center justify-center rounded-full bg-surface-inset text-[9px] font-medium text-ink-tertiary ring-2 ring-surface-raised">
                    +{note.attendees.length - 5}
                  </span>
                ) : null}
              </div>
            ) : (
              <span className="text-[11px] text-ink-tertiary">No attendees</span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}
