import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { serverClient } from "@/lib/db/server";
import { currentMember } from "@/lib/auth/guard";
import { getMeetingNote } from "@/lib/meetings/notes";
import { resolvePrimaryProvider } from "@/lib/pm-sync/project";
import { MemberAvatar } from "@/components/people/member-avatar";
import { MeetingActionItems } from "@/components/meetings/meeting-action-items";
import { MeetingDetailTabs } from "@/components/meetings/meeting-detail-tabs";

export const metadata: Metadata = { title: "Meeting note" };

export default async function MeetingNotePage({
  params,
}: {
  params: Promise<{ team: string; id: string }>;
}) {
  const { team: teamSlug, id } = await params;
  const db = await serverClient();

  const { data: team } = await db.from("teams").select("id").eq("slug", teamSlug).maybeSingle();
  if (!team) return null;

  const me = await currentMember(team.id);
  if (!me) return null;

  // getMeetingNote enforces the team-tier gate itself (external → null).
  const note = await getMeetingNote(db, team.id, id, me.tier);
  if (!note) notFound();

  // The team's primary PM tool — labels the "Push to …" control and gates it when none is set.
  const primary = await resolvePrimaryProvider(db, team.id);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="font-display text-2xl text-ink">{note.title}</h2>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-tertiary">
          {note.occurredAt ? <span>{note.occurredAt}</span> : null}
          {note.submittedBy ? (
            <span className="flex items-center gap-1.5">
              <MemberAvatar person={note.submittedBy} size={16} />
              Submitted by {note.submittedBy.displayName}
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

      <MeetingDetailTabs
        teamSlug={teamSlug}
        noteId={note.id}
        summary={note.summary}
        rawText={note.rawText}
        actionItems={
          <MeetingActionItems
            teamSlug={teamSlug}
            noteId={note.id}
            todos={note.extractedTodos}
            provider={primary.provider}
          />
        }
      />
    </div>
  );
}
