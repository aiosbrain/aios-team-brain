import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, ScanLine } from "lucide-react";
import { notFound } from "next/navigation";

import { currentMember } from "@/lib/auth/guard";
import { serverClient } from "@/lib/db/server";
import { MeetingTodoReview } from "@/components/meetings/meeting-todo-review";

export const metadata: Metadata = { title: "Extract meeting tasks" };

export default async function ExtractMeetingTasksPage({ params }: { params: Promise<{ team: string }> }) {
  const { team: teamSlug } = await params;
  const db = await serverClient();
  const { data: team } = await db
    .from("teams")
    .select("id, slug")
    .eq("slug", teamSlug)
    .maybeSingle();
  if (!team) notFound();

  const member = await currentMember(team.id);
  if (!member) notFound();

  if (member.tier !== "team") {
    return (
      <div className="mx-auto flex max-w-5xl flex-col gap-5">
        <Link href={`/t/${teamSlug}/tasks`} className="btn-ghost w-fit">
          <ArrowLeft className="size-4" />
          Back to tasks
        </Link>
        <section className="prism-card px-6 py-8">
          <h1 className="text-2xl font-semibold text-ink">Meeting extraction is team-only</h1>
          <p className="mt-2 max-w-2xl text-sm text-ink-tertiary">
            Meeting notes can include internal context, so only team-tier members can review and create extracted tasks.
          </p>
        </section>
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-5">
      <Link href={`/t/${teamSlug}/tasks`} className="btn-ghost w-fit">
        <ArrowLeft className="size-4" />
        Back to tasks
      </Link>
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="mb-2 flex items-center gap-2 text-sm font-medium text-violet">
            <ScanLine className="size-4" />
            User-reviewed extraction
          </div>
          <h1 className="text-2xl font-semibold text-ink">Extract action items from meetings</h1>
          <p className="mt-2 max-w-3xl text-sm text-ink-tertiary">
            Scan team-brain notes for likely todos, edit the candidates, then choose exactly which items become tasks in
            Extracted from Meetings. Nothing is created until you click Create selected.
          </p>
        </div>
      </header>
      <MeetingTodoReview teamSlug={team.slug} />
    </div>
  );
}
