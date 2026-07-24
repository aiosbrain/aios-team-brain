import type { ReactNode } from "react";
import { NotebookText } from "lucide-react";

import { loadTeamId, loadViewer, loadMeetingNotes, sortedMeetingNotes } from "@/lib/meetings/loaders";
import { EmptyState } from "@/components/empty-state";
import { NewMeetingNoteButton } from "@/components/meetings/new-meeting-note-button";
import { ImportPushedMeetingsButton } from "@/components/meetings/import-pushed-meetings-button";
import { MeetingListPane } from "@/components/meetings/meeting-list-pane";

/**
 * Two-pane Meetings shell shared by the index and the per-note detail route: the meeting list lives
 * on the left (newest first), the selected meeting's summary/transcript/action-items render on the
 * right (`children`). Rendered once and preserved across navigation between meetings, so switching
 * meetings only re-renders the right pane. All loads are `cache()`d, so the page rendered as
 * `children` this request reuses these results instead of re-querying.
 */
export default async function MeetingsLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ team: string }>;
}) {
  const { team: teamSlug } = await params;

  const teamId = await loadTeamId(teamSlug);
  if (!teamId) return null;

  const me = await loadViewer(teamId);
  if (!me) return null;

  // loadMeetingNotes enforces the team-tier gate itself (external → []).
  const sorted = sortedMeetingNotes(await loadMeetingNotes(teamId, me.tier));
  const canManage = me.tier === "team";

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-ink">Meetings</h1>
          <p className="text-sm text-ink-secondary">
            Pick a meeting to read its summary and open the full transcript.
          </p>
        </div>
        {canManage ? (
          <div className="flex items-center gap-2">
            {/* Duplicate-meeting merge is now automatic on ingest (backfillMeetingNotesFromItems →
                backfillMergeDuplicateMeetings) — the manual "Merge duplicates" button was removed. */}
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
          <div className="w-full shrink-0 self-start sm:sticky sm:top-6 sm:w-80 lg:w-96 xl:w-[28rem]">
            <MeetingListPane teamSlug={teamSlug} notes={sorted} defaultActiveId={sorted[0]?.id ?? null} />
          </div>
          <div className="min-w-0 flex-1">{children}</div>
        </div>
      )}
    </div>
  );
}
