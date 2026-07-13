import type { Metadata } from "next";
import Link from "next/link";
import { NotebookText } from "lucide-react";
import { serverClient } from "@/lib/db/server";
import { currentMember } from "@/lib/auth/guard";
import { listMeetingNotesForTeam } from "@/lib/meetings/notes";
import { EmptyState } from "@/components/empty-state";
import { MemberAvatar } from "@/components/people/member-avatar";
import { NewMeetingNoteButton } from "@/components/meetings/new-meeting-note-button";
import { ImportPushedMeetingsButton } from "@/components/meetings/import-pushed-meetings-button";
import { timeAgo } from "@/components/format";

export const metadata: Metadata = { title: "Meeting notes" };

export default async function MeetingsPage({ params }: { params: Promise<{ team: string }> }) {
  const { team: teamSlug } = await params;
  const db = await serverClient();

  const { data: team } = await db.from("teams").select("id").eq("slug", teamSlug).maybeSingle();
  if (!team) return null;

  const me = await currentMember(team.id);
  if (!me) return null;

  // listMeetingNotesForTeam enforces the team-tier gate itself (external → []).
  const notes = await listMeetingNotesForTeam(db, team.id, me.tier);

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-ink">Meeting notes</h1>
          <p className="text-sm text-ink-secondary">
            Upload a transcript — attendees and a summary are inferred automatically, and any
            action items land in Tasks.
          </p>
        </div>
        {me.tier === "team" ? (
          <div className="flex items-center gap-2">
            <ImportPushedMeetingsButton teamSlug={teamSlug} />
            <NewMeetingNoteButton teamSlug={teamSlug} />
          </div>
        ) : null}
      </div>

      {notes.length === 0 ? (
        <EmptyState
          icon={NotebookText}
          title="No meeting notes yet"
          action="Upload a transcript with the button above — the roster, summary, and any todo items are extracted automatically."
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {notes.map((note) => (
            <Link
              key={note.id}
              href={`/t/${teamSlug}/meetings/${note.id}`}
              className="prism-card prism-card-hover flex flex-col gap-3 px-5 py-5"
            >
              <div className="flex items-start justify-between gap-3">
                <h2 className="truncate font-display text-lg text-ink">{note.title}</h2>
                <span className="shrink-0 text-xs text-ink-tertiary">
                  {note.occurredAt ?? timeAgo(note.createdAt)}
                </span>
              </div>
              {note.summary ? (
                <p className="line-clamp-2 text-sm text-ink-secondary">{note.summary}</p>
              ) : (
                <p className="text-sm italic text-ink-tertiary">No summary available.</p>
              )}
              <div className="mt-auto flex items-center justify-between gap-3 pt-1">
                <div className="flex items-center gap-1.5 text-xs text-ink-tertiary">
                  {note.submittedBy ? (
                    <>
                      <MemberAvatar person={note.submittedBy} size={20} />
                      <span>{note.submittedBy.displayName}</span>
                    </>
                  ) : (
                    <span>Unknown submitter</span>
                  )}
                </div>
                {note.attendees.length ? (
                  <div className="flex -space-x-2">
                    {note.attendees.slice(0, 5).map((a) => (
                      <MemberAvatar
                        key={a.id}
                        person={a}
                        size={24}
                        className="ring-2 ring-surface-raised"
                      />
                    ))}
                    {note.attendees.length > 5 ? (
                      <span className="flex size-6 items-center justify-center rounded-full bg-surface-inset text-[10px] font-medium text-ink-tertiary ring-2 ring-surface-raised">
                        +{note.attendees.length - 5}
                      </span>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
