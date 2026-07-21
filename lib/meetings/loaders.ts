import "server-only";
import { cache } from "react";
import { serverClient } from "@/lib/db/server";
import { currentMember } from "@/lib/auth/guard";
import { listMeetingNotesForTeam, type MeetingNoteSummary, type ViewerTier } from "./notes";

/**
 * Request-scoped memoized loaders for the Meetings surface. The two-pane layout AND the page it
 * wraps (index or detail) each need the team, the viewer, and the note list — without this they each
 * re-query on the same request (the layout renders alongside the page). `cache()` dedupes by args
 * within one request, so a single Meetings render hits Postgres once for each, not two/three times.
 */

export const loadTeamId = cache(async (teamSlug: string): Promise<string | null> => {
  const db = await serverClient();
  const { data } = await db.from("teams").select("id").eq("slug", teamSlug).maybeSingle();
  return (data as { id: string } | null)?.id ?? null;
});

/** The current member for this team (id/role/tier), memoized per team for the request. */
export const loadViewer = cache((teamId: string) => currentMember(teamId));

export const loadMeetingNotes = cache(async (teamId: string, tier: ViewerTier): Promise<MeetingNoteSummary[]> => {
  const db = await serverClient();
  return listMeetingNotesForTeam(db, teamId, tier);
});

/** When the meeting happened, if known, else when it was ingested — the sort key for the list. */
export function meetingTime(note: MeetingNoteSummary): number {
  const t = new Date(note.occurredAt ?? note.createdAt).getTime();
  return Number.isNaN(t) ? 0 : t;
}

/** Notes newest-first — the canonical order for both the list rail and "which note is the default". */
export function sortedMeetingNotes(notes: MeetingNoteSummary[]): MeetingNoteSummary[] {
  return [...notes].sort((a, b) => meetingTime(b) - meetingTime(a));
}
