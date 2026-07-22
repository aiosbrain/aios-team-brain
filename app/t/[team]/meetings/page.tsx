import type { Metadata } from "next";

import { loadTeamId, loadViewer, loadMeetingNotes, sortedMeetingNotes } from "@/lib/meetings/loaders";
import { MeetingDetailView } from "@/components/meetings/meeting-detail-view";

export const metadata: Metadata = { title: "Meetings" };

/**
 * Meetings index: the list is the layout's left rail. Rather than REDIRECT to the newest note (a
 * second full request), render its detail inline here — so arriving at /meetings is one request. If
 * no meeting exists the layout shows the empty state (this returns nothing). All loads are the same
 * `cache()`d calls the layout already made this request, so they don't re-query.
 */
export default async function MeetingsIndexPage({ params }: { params: Promise<{ team: string }> }) {
  const { team: teamSlug } = await params;
  const teamId = await loadTeamId(teamSlug);
  if (!teamId) return null;

  const me = await loadViewer(teamId);
  if (!me) return null;

  const notes = await loadMeetingNotes(teamId, me.tier);
  if (notes.length === 0) return null; // layout shows the empty state

  const newest = sortedMeetingNotes(notes)[0];
  return <MeetingDetailView teamSlug={teamSlug} teamId={teamId} noteId={newest.id} tier={me.tier} />;
}
