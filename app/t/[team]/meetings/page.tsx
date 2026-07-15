import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { serverClient } from "@/lib/db/server";
import { currentMember } from "@/lib/auth/guard";
import { listMeetingNotesForTeam, type MeetingNoteSummary } from "@/lib/meetings/notes";

export const metadata: Metadata = { title: "Meetings" };

function meetingTime(note: MeetingNoteSummary): number {
  const t = new Date(note.occurredAt ?? note.createdAt).getTime();
  return Number.isNaN(t) ? 0 : t;
}

/**
 * Meetings index: there's no standalone index UI in the two-pane view — the list is the layout's left
 * rail. If any meeting exists we redirect to the most recent one so the right pane is populated on
 * arrival; if none exist the layout renders the empty state (this returns nothing).
 */
export default async function MeetingsIndexPage({ params }: { params: Promise<{ team: string }> }) {
  const { team: teamSlug } = await params;
  const db = await serverClient();

  const { data: team } = await db.from("teams").select("id").eq("slug", teamSlug).maybeSingle();
  if (!team) return null;

  const me = await currentMember(team.id);
  if (!me) return null;

  const notes = await listMeetingNotesForTeam(db, team.id, me.tier);
  if (notes.length === 0) return null; // layout shows the empty state

  const newest = [...notes].sort((a, b) => meetingTime(b) - meetingTime(a))[0];
  redirect(`/t/${teamSlug}/meetings/${newest.id}`);
}
