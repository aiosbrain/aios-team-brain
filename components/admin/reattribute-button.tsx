"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";
import { reattributeIdentitiesNow } from "@/app/t/[team]/admin/members/actions";

/**
 * Admin trigger to re-attribute already-ingested content to the current identity mappings — the fix
 * for "I corrected a link, but old Slack threads / issues / commits still show the wrong person."
 */
export function ReattributeButton({ teamSlug }: { teamSlug: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [note, setNote] = useState<string | null>(null);

  function run() {
    setNote(null);
    startTransition(async () => {
      const res = await reattributeIdentitiesNow(teamSlug);
      setNote(res.ok ? res.message ?? "Done." : res.error ?? "failed");
      if (res.ok) router.refresh();
    });
  }

  return (
    <div className="flex items-center gap-2">
      {note ? <span className="text-xs text-ink-tertiary">{note}</span> : null}
      <button
        type="button"
        onClick={run}
        disabled={pending}
        title="Re-apply current identity mappings to already-ingested content"
        className="flex items-center gap-1.5 rounded-lg border border-border-default px-3 py-1.5 text-xs font-medium text-ink-secondary hover:text-ink disabled:opacity-50"
      >
        <RefreshCw className={`size-3.5 ${pending ? "animate-spin" : ""}`} /> Re-attribute content
      </button>
    </div>
  );
}
