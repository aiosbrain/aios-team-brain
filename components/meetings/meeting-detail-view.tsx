import { notFound } from "next/navigation";
import { serverClient } from "@/lib/db/server";
import { getMeetingNote, type ViewerTier } from "@/lib/meetings/notes";
import { MemberAvatar } from "@/components/people/member-avatar";
import { MeetingDetailTabs } from "@/components/meetings/meeting-detail-tabs";

/**
 * The right-pane detail for one meeting (header + Summary/Transcript tabs). Shared by BOTH the detail
 * route (`/meetings/[id]`) and the index (`/meetings`, which renders the newest note inline instead of
 * redirecting) — so opening Meetings is a single request, not a request + redirect.
 */
export async function MeetingDetailView({
  teamSlug,
  teamId,
  noteId,
  tier,
}: {
  teamSlug: string;
  teamId: string;
  noteId: string;
  tier: ViewerTier;
}) {
  const db = await serverClient();
  // getMeetingNote enforces the team-tier gate itself (external → null).
  const note = await getMeetingNote(db, teamId, noteId, tier);
  if (!note) notFound();

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="font-display text-2xl text-ink">{note.title}</h2>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-tertiary">
          {note.occurredAt ? <span>{note.occurredAt}</span> : null}
          {note.submitters.length ? (
            <span className="flex items-center gap-1.5">
              {note.submitters.map((s) => (
                <MemberAvatar key={s.id} person={s} size={16} />
              ))}
              Submitted by {note.submitters.map((s) => s.displayName).join(" and ")}
            </span>
          ) : null}
        </div>
        {note.attendees.length ? (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {note.attendees.map((a) => (
              <span
                key={a.id}
                className="flex items-center gap-1.5 rounded-full border border-border-subtle bg-surface-overlay px-2 py-0.5 text-xs text-ink-secondary"
              >
                <MemberAvatar person={a} size={16} />
                {a.displayName}
              </span>
            ))}
          </div>
        ) : null}
      </div>

      <MeetingDetailTabs teamSlug={teamSlug} noteId={note.id} summary={note.summary} rawText={note.rawText} />
    </div>
  );
}
