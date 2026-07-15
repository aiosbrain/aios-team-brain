import type { ReactNode } from "react";
import { NotebookText } from "lucide-react";

import { serverClient } from "@/lib/db/server";
import { currentMember } from "@/lib/auth/guard";
import { listMeetingNotesForTeam, type MeetingNoteSummary } from "@/lib/meetings/notes";
import { EmptyState } from "@/components/empty-state";
import { NewMeetingNoteButton } from "@/components/meetings/new-meeting-note-button";
import { ImportPushedMeetingsButton } from "@/components/meetings/import-pushed-meetings-button";
import { MergeDuplicatesButton } from "@/components/meetings/merge-duplicates-button";
import { MeetingListPane } from "@/components/meetings/meeting-list-pane";

/** When the meeting happened, if known, else when it was ingested — the sort key for the list. */
function meetingTime(note: MeetingNoteSummary): number {
  const stamp = note.occurredAt ?? note.createdAt;
  const t = new Date(stamp).getTime();
  return Number.isNaN(t) ? 0 : t;
}

/**
 * Two-pane Meetings shell shared by the index and the per-note detail route: the meeting list lives
 * on the left (newest first), the selected meeting's summary/transcript/action-items render on the
 * right (`children`). Rendered once and preserved across navigation between meetings, so switching
 * meetings only re-renders the right pane.
 */
export default async function MeetingsLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ team: string }>;
}) {
  const { team: teamSlug } = await params;
  const db = await serverClient();

  const { data: team } = await db.from("teams").select("id").eq("slug", teamSlug).maybeSingle();
  if (!team) return null;

  const me = await currentMember(team.id);
  if (!me) return null;

  // listMeetingNotesForTeam enforces the team-tier gate itself (external → []).
  const notes = await listMeetingNotesForTeam(db, team.id, me.tier);
  const sorted = [...notes].sort((a, b) => meetingTime(b) - meetingTime(a));
  const canManage = me.tier === "team";

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-ink">Meetings</h1>
          <p className="text-sm text-ink-secondary">
            Pick a meeting to read its summary, open the transcript, and push action items to your
            task tool.
          </p>
        </div>
        {canManage ? (
          <div className="flex items-center gap-2">
            {me.role === "admin" ? <MergeDuplicatesButton teamSlug={teamSlug} /> : null}
            <ImportPushedMeetingsButton teamSlug={teamSlug} />
            <NewMeetingNoteButton teamSlug={teamSlug} />
          </div>
        ) : null}
      </div>

      {sorted.length === 0 ? (
        <EmptyState
          icon={NotebookText}
          title="No meeting notes yet"
          action="Upload a transcript with the button above, or push meetings from the CLI and click Import — the roster, summary, and action items are extracted automatically."
        />
      ) : (
        <div className="flex flex-col gap-5 sm:flex-row sm:items-start sm:gap-6">
          <div className="w-full shrink-0 self-start sm:sticky sm:top-6 sm:w-72 lg:w-80">
            <MeetingListPane teamSlug={teamSlug} notes={sorted} />
          </div>
          <div className="min-w-0 flex-1">{children}</div>
        </div>
      )}
    </div>
  );
}
