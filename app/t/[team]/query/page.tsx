import type { Metadata } from "next";
import { serverClient } from "@/lib/db/server";
import { ChatWorkspace } from "@/components/chat/chat-workspace";

export const metadata: Metadata = { title: "Chat" };

export default async function QueryPage({
  params,
  searchParams,
}: {
  params: Promise<{ team: string }>;
  searchParams: Promise<{ q?: string }>;
}) {
  const { team: teamSlug } = await params;
  const { q } = await searchParams;
  const supabase = await serverClient();

  const { data: team } = await supabase
    .from("teams")
    .select("id, name")
    .eq("slug", teamSlug)
    .maybeSingle();
  if (!team) return null;

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-3">
      <div>
        <h1 className="text-2xl font-semibold text-ink">Chat</h1>
        <p className="mt-1 text-sm text-ink-secondary">
          Ask {team.name}&apos;s shared memory — Slack, decisions, tasks, code, and the knowledge
          graph. Answers cite their sources.
        </p>
      </div>
      <ChatWorkspace teamSlug={teamSlug} initialQuestion={q} />
    </div>
  );
}
