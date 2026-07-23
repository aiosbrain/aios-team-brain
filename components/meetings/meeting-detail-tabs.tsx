"use client";

import { useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { FileText, Loader2, RefreshCw, ScrollText } from "lucide-react";
import { summaryBullets } from "@/lib/meetings/summary-format";
import { regenerateMeetingSummaryAction } from "@/app/t/[team]/meetings/actions";

type TabKey = "summary" | "transcript";

interface MeetingDetailTabsProps {
  teamSlug: string;
  noteId: string;
  summary: string;
  rawText: string;
}

/**
 * Right-pane tabs for a meeting: "Summary" (the LLM digest) and "Transcript" (the full raw text).
 * Summary leads because it's the digest; the transcript is the evidence you drop into on demand. A
 * bulleted summary renders as a list; a prose one (older notes) stays a paragraph, with a "Regenerate"
 * control to refresh it to the detailed bulleted format.
 */
export function MeetingDetailTabs({ teamSlug, noteId, summary, rawText }: MeetingDetailTabsProps) {
  const [tab, setTab] = useState<TabKey>("summary");
  const router = useRouter();
  const [regenerating, startRegen] = useTransition();
  const [regenError, setRegenError] = useState<string | null>(null);
  const bullets = summaryBullets(summary);

  function regenerate() {
    setRegenError(null);
    startRegen(async () => {
      const res = await regenerateMeetingSummaryAction(teamSlug, noteId);
      if (!res.ok) return setRegenError(res.error ?? "could not regenerate");
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <div role="tablist" aria-label="Meeting detail" className="flex items-center gap-1 border-b border-border-subtle">
        <TabButton active={tab === "summary"} onClick={() => setTab("summary")} icon={<FileText className="size-3.5" />}>
          Summary
        </TabButton>
        <TabButton
          active={tab === "transcript"}
          onClick={() => setTab("transcript")}
          icon={<ScrollText className="size-3.5" />}
        >
          Transcript
        </TabButton>
      </div>

      {tab === "summary" ? (
        <div className="flex flex-col gap-5">
          <div className="prism-card flex flex-col gap-2 px-5 py-4">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-ink-tertiary">Summary</h2>
              <button
                type="button"
                onClick={regenerate}
                disabled={regenerating}
                className="inline-flex items-center gap-1 text-xs text-ink-tertiary hover:text-ink disabled:opacity-50"
                title="Re-summarize the transcript in the detailed bulleted format"
              >
                {regenerating ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
                Regenerate
              </button>
            </div>
            {bullets.length ? (
              <ul className="flex list-disc flex-col gap-1.5 pl-5 text-sm text-ink-secondary">
                {bullets.map((b, i) => (
                  <li key={i}>{b}</li>
                ))}
              </ul>
            ) : summary ? (
              <p className="whitespace-pre-wrap text-sm text-ink-secondary">{summary}</p>
            ) : (
              <p className="text-sm italic text-ink-tertiary">No summary available.</p>
            )}
            {regenError ? <p className="text-xs text-rose-500">{regenError}</p> : null}
          </div>
        </div>
      ) : (
        <div className="prism-card px-5 py-4">
          <pre className="whitespace-pre-wrap break-words font-mono text-xs text-ink-secondary">{rawText}</pre>
        </div>
      )}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  icon,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
        active
          ? "border-violet text-ink"
          : "border-transparent text-ink-tertiary hover:text-ink-secondary"
      }`}
    >
      {icon}
      {children}
    </button>
  );
}
