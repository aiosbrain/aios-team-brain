import type { Metadata } from "next";

import { loadTeamId, loadViewer } from "@/lib/meetings/loaders";
import { MeetingDetailView } from "@/components/meetings/meeting-detail-view";

export const metadata: Metadata = { title: "Meeting note" };

export default async function MeetingNotePage({
  params,
}: {
  params: Promise<{ team: string; id: string }>;
}) {
  const { team: teamSlug, id } = await params;
  const teamId = await loadTeamId(teamSlug);
  if (!teamId) return null;

  const me = await loadViewer(teamId);
  if (!me) return null;

  return <MeetingDetailView teamSlug={teamSlug} teamId={teamId} noteId={id} tier={me.tier} />;
}
