import Link from "next/link";
import { AlertTriangle } from "lucide-react";
import type { PipelineHealth } from "@/lib/ingest/pipeline-health";
import { timeAgo } from "@/components/format";

/** Human labels for the ingest_runs `source` slugs. */
const LABEL: Record<string, string> = {
  slack: "Slack sync",
  plane: "Plane sync",
  linear: "Linear sync",
  linear_inbound: "Linear inbound",
  github: "GitHub sync",
  dense: "Semantic index",
  graph_project: "Graph projector",
  graph_extract: "Graph extraction",
  meeting_notes: "Meeting notes",
  auth_cleanup: "Auth cleanup",
  pm_sync: "PM projection",
  scan: "Codebase scan",
  llm: "Answering model",
};

/**
 * LOUD, hard-to-miss banner when any ingestion leg is broken or stale — so a wedged pipeline (the
 * graph projector 422'ing for weeks) can't hide as one red row in a table. Renders nothing when the
 * pipeline is healthy. Meant to sit at the TOP of the admin surface (and the home dashboard for
 * admins), above everything else. `href` links to the full runs detail.
 */
export function PipelineHealthBanner({ health, href }: { health: PipelineHealth; href: string }) {
  if (health.healthy || health.failing.length === 0) return null;

  return (
    <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-red-700 dark:text-red-300">
      <div className="flex items-center gap-2">
        <AlertTriangle className="size-4 shrink-0" />
        <p className="text-sm font-semibold">
          {health.failing.length} ingestion {health.failing.length === 1 ? "leg is" : "legs are"} broken
          — the brain isn&apos;t getting fresh data
        </p>
      </div>
      <ul className="mt-2 flex flex-col gap-1 pl-6">
        {health.failing.map((l) => (
          <li key={l.source} className="text-xs">
            <span className="font-medium">{LABEL[l.source] ?? l.source}</span>{" "}
            {l.stale && l.ok ? (
              <span>— no successful run in {timeAgo(l.at)} (may have stopped)</span>
            ) : (
              <span>
                — failing{l.at ? ` since ${timeAgo(l.at)}` : ""}
                {l.error ? <span className="text-red-600/80 dark:text-red-300/80">: {l.error}</span> : null}
              </span>
            )}
          </li>
        ))}
      </ul>
      <Link href={href} className="mt-2 inline-block pl-6 text-xs font-medium underline">
        View ingestion runs →
      </Link>
    </div>
  );
}
