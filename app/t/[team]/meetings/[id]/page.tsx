import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ChevronRight } from "lucide-react";
import { serverClient } from "@/lib/db/server";
import { currentMember } from "@/lib/auth/guard";
import { getMeetingNote } from "@/lib/meetings/notes";
import { resolvePrimaryProvider } from "@/lib/pm-sync/project";
import { MemberAvatar } from "@/components/people/member-avatar";
import { MeetingActionItems } from "@/components/meetings/meeting-action-items";

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
    <div className="mx-auto flex max-w-3xl flex-col gap-5">
      <div>
        <Link
          href={`/t/${teamSlug}/meetings`}
          className="inline-flex items-center gap-1 text-sm text-ink-tertiary hover:text-ink"
        >
          <ArrowLeft className="size-3.5" /> Meeting notes
        </Link>
        <div className="mt-2 flex items-start justify-between gap-3">
          <div>
            <h1 className="font-display text-2xl text-ink">{note.title}</h1>
            <div className="mt-0.5 flex items-center gap-3 text-xs text-ink-tertiary">
              {note.occurredAt ? <span>{note.occurredAt}</span> : null}
              {note.submittedBy ? (
                <span className="flex items-center gap-1.5">
                  <MemberAvatar person={note.submittedBy} size={16} />
                  Submitted by {note.submittedBy.displayName}
                </span>
              ) : null}
            </div>
          </div>
        </div>
      </div>

      {note.attendees.length ? (
        <div className="prism-card flex flex-col gap-2 px-5 py-4">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-ink-tertiary">
            Attendees
          </h2>
          <div className="flex flex-wrap gap-2">
            {note.attendees.map((a) => (
              <span
                key={a.id}
                className="flex items-center gap-1.5 rounded-full border border-border-subtle bg-surface-overlay px-2.5 py-1 text-sm text-ink"
              >
                <MemberAvatar person={a} size={20} />
                {a.displayName}
              </span>
            ))}
          </div>
        </div>
      ) : null}

      <div className="prism-card flex flex-col gap-2 px-5 py-4">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-ink-tertiary">Summary</h2>
        {note.summary ? (
          <p className="text-sm text-ink-secondary">{note.summary}</p>
        ) : (
          <p className="text-sm italic text-ink-tertiary">No summary available.</p>
        )}
      </div>

      {/* Full transcript: collapsed by default so the summary + action items lead. */}
      <details className="prism-card group px-5 py-4">
        <summary className="flex w-fit cursor-pointer list-none items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-ink-tertiary transition-colors hover:text-ink">
          <ChevronRight className="size-3.5 transition-transform group-open:rotate-90" />
          Full transcript
        </summary>
        <pre className="mt-3 whitespace-pre-wrap break-words font-mono text-xs text-ink-secondary">
          {note.rawText}
        </pre>
      </details>

      <MeetingActionItems
        teamSlug={teamSlug}
        noteId={note.id}
        todos={note.extractedTodos}
        provider={primary.provider}
      />
    </div>
  );
}
