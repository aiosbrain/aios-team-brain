"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Combine, Loader2 } from "lucide-react";
import { mergeDuplicateMeetingsAction } from "@/app/t/[team]/meetings/actions";

/**
 * Admin-only one-time cleanup: merge already-created duplicate meetings (same date + overlapping
 * transcripts) into one note each. Confirms first — it mutates transcripts and hides the duplicates.
 */
export function MergeDuplicatesButton({ teamSlug }: { teamSlug: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);

  function run() {
    if (!window.confirm("Merge same-day duplicate meetings into one each? Transcripts are combined and the duplicates are hidden.")) return;
    setMsg(null);
    start(async () => {
      const res = await mergeDuplicateMeetingsAction(teamSlug);
      if (!res.ok) return setMsg(res.error ?? "merge failed");
      setMsg(res.merged ? `Merged ${res.merged} duplicate${res.merged === 1 ? "" : "s"}.` : "No duplicates found.");
      router.refresh();
    });
  }

  return (
    <div className="flex items-center gap-2">
      {msg ? <span className="text-xs text-ink-tertiary">{msg}</span> : null}
      <button
        type="button"
        onClick={run}
        disabled={pending}
        className="btn-ghost"
        title="Merge same-day duplicate meetings into one"
      >
        {pending ? <Loader2 className="size-4 animate-spin" /> : <Combine className="size-4" />}
        Merge duplicates
      </button>
    </div>
  );
}
