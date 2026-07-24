"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Sparkles, ArrowRight } from "lucide-react";

/**
 * Slim persistent "ask" entry point on the Pulse home surface. A single line, not a hero: it hands the
 * question to the full Query chat (`/query?q=…`, which prefills + auto-sends via `initialQuestion`) so
 * the home page leads with the brain's synthesized understanding, not a query box.
 */
export function AskBar({ teamSlug, teamName }: { teamSlug: string; teamName: string }) {
  const router = useRouter();
  const [q, setQ] = useState("");

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const question = q.trim();
    router.push(question ? `/t/${teamSlug}/query?q=${encodeURIComponent(question)}` : `/t/${teamSlug}/query`);
  }

  return (
    <form
      onSubmit={submit}
      className="flex items-center gap-2 rounded-xl border border-border-subtle bg-surface-inset px-3 py-2 transition-colors focus-within:border-violet/50"
    >
      <Sparkles className="size-4 shrink-0 text-violet" />
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={`Ask ${teamName}'s brain anything…`}
        aria-label={`Ask ${teamName}'s brain`}
        className="min-w-0 flex-1 bg-transparent text-sm text-ink placeholder:text-ink-tertiary focus:outline-none"
      />
      <button
        type="submit"
        aria-label="Ask"
        className="inline-flex size-7 shrink-0 items-center justify-center rounded-lg bg-violet/10 text-violet transition-colors hover:bg-violet/20"
      >
        <ArrowRight className="size-4" />
      </button>
    </form>
  );
}
