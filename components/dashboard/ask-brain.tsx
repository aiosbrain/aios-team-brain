"use client";

import { useRef } from "react";
import { Sparkles } from "lucide-react";
import { QueryChat, type QueryChatHandle } from "@/components/query-chat";

const SUGGESTIONS = [
  "What is the eng team working on?",
  "What did we accomplish last quarter?",
  "What's blocking sprint 1?",
  "Have we run the onboarding experiment with users yet?",
];

export function AskBrain({ teamSlug, teamName }: { teamSlug: string; teamName: string }) {
  const chatRef = useRef<QueryChatHandle>(null);

  return (
    <section className="bg-gradient-prism rounded-2xl p-[1px]">
      <div className="rounded-2xl bg-surface-inset px-5 py-5 sm:px-6 sm:py-6">
        <div className="mb-4 flex items-center gap-2">
          <Sparkles className="size-4 text-violet" />
          <h2 className="font-display text-lg text-ink">
            Ask {teamName}&apos;s brain
          </h2>
        </div>

        <QueryChat teamSlug={teamSlug} ref={chatRef} />

        <div className="mt-4 flex flex-wrap gap-2">
          {SUGGESTIONS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => chatRef.current?.ask(s)}
              className="rounded-full border border-violet/25 bg-violet/5 px-3 py-1 text-xs text-violet transition-colors hover:bg-violet/12"
            >
              {s}
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}
