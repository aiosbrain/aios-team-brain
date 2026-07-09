"use client";

import Link from "next/link";
import { Sparkles, MessageSquare } from "lucide-react";
import { QueryChat } from "@/components/query-chat";

export function AskBrain({ teamSlug, teamName }: { teamSlug: string; teamName: string }) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <h2 className="flex items-center gap-2 font-display text-lg text-ink">
          <Sparkles className="size-4 text-violet" /> Ask {teamName}&apos;s brain
        </h2>
        <Link
          href={`/t/${teamSlug}/query`}
          className="flex items-center gap-1 text-xs font-medium text-violet hover:underline"
        >
          <MessageSquare className="size-3.5" /> Open full chat
        </Link>
      </div>
      <QueryChat teamSlug={teamSlug} variant="embed" persistKey={`aios:home-thread:${teamSlug}`} />
    </section>
  );
}
