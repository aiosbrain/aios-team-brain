"use client";

import { useState, type ReactNode } from "react";
import { FileText, ScrollText } from "lucide-react";

type TabKey = "summary" | "transcript";

interface MeetingDetailTabsProps {
  summary: string;
  rawText: string;
  /** The action-items section, rendered under the summary (it owns its own server actions). */
  actionItems: ReactNode;
}

/**
 * Right-pane tabs for a meeting: "Summary" (the LLM summary plus the action-items section beneath it)
 * and "Transcript" (the full raw text). Summary leads because it's the digest; the transcript is the
 * evidence you drop into on demand.
 */
export function MeetingDetailTabs({ summary, rawText, actionItems }: MeetingDetailTabsProps) {
  const [tab, setTab] = useState<TabKey>("summary");

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
            <h2 className="text-xs font-semibold uppercase tracking-wider text-ink-tertiary">Summary</h2>
            {summary ? (
              <p className="whitespace-pre-wrap text-sm text-ink-secondary">{summary}</p>
            ) : (
              <p className="text-sm italic text-ink-tertiary">No summary available.</p>
            )}
          </div>
          {actionItems}
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
