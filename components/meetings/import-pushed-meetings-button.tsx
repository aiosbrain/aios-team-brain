"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { DownloadCloud, Loader2 } from "lucide-react";
import { importPushedMeetingsAction } from "@/app/t/[team]/meetings/actions";

/**
 * Pull meetings that arrived via the CLI (`aios push`) into the Meetings page. They already live in
 * the brain as transcript items; this creates the meeting-note metadata (summary/attendees) so they
 * appear here. Idempotent — safe to click repeatedly.
 */
export function ImportPushedMeetingsButton({ teamSlug }: { teamSlug: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);

  function run() {
    setMsg(null);
    startTransition(async () => {
      const res = await importPushedMeetingsAction(teamSlug);
      if (!res.ok) return setMsg(res.error ?? "import failed");
      setMsg(
        res.created
          ? `Imported ${res.created} meeting${res.created === 1 ? "" : "s"}.`
          : res.scanned
            ? "All pushed meetings already imported."
            : "No pushed meetings found to import."
      );
      router.refresh();
    });
  }

  return (
    <div className="flex items-center gap-2">
      {msg ? <span className="text-xs text-ink-tertiary">{msg}</span> : null}
      <button type="button" onClick={run} disabled={pending} className="btn-ghost">
        {pending ? <Loader2 className="size-4 animate-spin" /> : <DownloadCloud className="size-4" />}
        Import pushed meetings
      </button>
    </div>
  );
}
