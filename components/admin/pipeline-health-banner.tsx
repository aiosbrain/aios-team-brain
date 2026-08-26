"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { AlertTriangle, X } from "lucide-react";
import type { PipelineHealth } from "@/lib/ingest/pipeline-health";
import { alertSignature } from "@/lib/ingest/pipeline-alert";
import { timeAgo } from "@/components/format";
import { legDetail } from "@/lib/ingest/pipeline-health";

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
 *
 * Dismissible: the ✕ hides it (persisted in localStorage), but ONLY for the exact current failure set
 * (see `alertSignature`) — a new/different break re-shows it, so you can't permanently hide a broken
 * pipeline. Dismissal is per-surface (`href`) and shared across pages that pass the same href.
 */
export function PipelineHealthBanner({ health, href }: { health: PipelineHealth; href: string }) {
  const signature = alertSignature(health.failing);
  // Key on the PATH, not the whole href: the link now carries a `#ingestion-runs` fragment, and keying
  // on the full string would silently un-dismiss every already-dismissed banner the moment that anchor
  // was added (and again on any future fragment change). The fragment picks a scroll position; it isn't
  // a different surface.
  const storageKey = `pipeline-alert-dismissed:${href.split("#")[0]}`;
  // `hydrated` false during SSR + first client render (matching markup); the mount effect reads the
  // client-only localStorage to decide if THIS exact alert was already dismissed.
  const [state, setState] = useState<{ hydrated: boolean; dismissed: boolean }>({ hydrated: false, dismissed: false });
  useEffect(() => {
    let dismissed = false;
    try {
      dismissed = window.localStorage.getItem(storageKey) === signature;
    } catch {
      /* localStorage unavailable (private mode) → treat as not dismissed, still show the alert */
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time hydration read of a client-only store
    setState({ hydrated: true, dismissed });
  }, [storageKey, signature]);

  if (health.healthy || health.failing.length === 0) return null;
  // Show by default (incl. SSR); hide only after hydration confirms this exact alert was dismissed.
  if (state.hydrated && state.dismissed) return null;

  const dismiss = () => {
    try {
      window.localStorage.setItem(storageKey, signature);
    } catch {
      /* ignore — dismissal just won't persist */
    }
    setState((s) => ({ ...s, dismissed: true }));
  };

  return (
    <div className="relative rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 pr-9 text-red-700 dark:text-red-300">
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss alert"
        title="Dismiss (re-appears if a different leg breaks)"
        className="absolute right-1.5 top-1.5 rounded p-1 text-red-600/70 transition-colors hover:bg-red-500/15 hover:text-red-700 dark:text-red-300/70 dark:hover:text-red-200"
      >
        <X className="size-4" />
      </button>
      <div className="flex items-center gap-2">
        <AlertTriangle className="size-4 shrink-0" />
        <p className="text-sm font-semibold">
          {health.failing.length} ingestion {health.failing.length === 1 ? "leg is broken" : "legs are broken"} —
          the brain isn&apos;t getting fresh data
        </p>
      </div>
      <ul className="mt-2 flex flex-col gap-1 pl-6">
        {health.failing.map((l) => (
          <li key={l.source} className="text-xs">
            <span className="font-medium">{LABEL[l.source] ?? l.source}</span>{" "}
            {l.stale && l.ok ? (
              <span>— last successful run {timeAgo(l.at)} (may have stopped)</span>
            ) : (
              <span>
                {/* `failingSince` — the OLDEST failure in the current streak — NOT `l.at`, which is
                    the NEWEST run. Under the old code a leg failing for three days was labelled
                    "failing since 20 minutes ago" every time the poller re-failed, which is what made
                    a stale red banner indistinguishable from a live one (BANNERFLAP-1 §3b). Null for
                    the synthetic `graph_extract` leg, which is not a point-in-time failure and gets no
                    fabricated instant — the copy falls back to the cause alone. */}
                — failing{l.failingSince ? ` since ${timeAgo(l.failingSince)}` : ""}
                {/* LLMCREDIT-3: THE DIAGNOSIS LEADS. This rendered `l.error` alone, which for a
                    provider failure meant four hundred characters of JSON — clipped mid-word — where
                    "OpenRouter is out of credit" was the whole answer. The composition is
                    `legDetail`, a pure function, because this component is not reachable from the
                    unit tier and pinning only the classifier would leave the call site untested. */}
                {(() => {
                  const d = legDetail(l);
                  if (!d.lead) return d.raw ? <span className="text-red-600/80 dark:text-red-300/80">: {d.raw}</span> : null;
                  return (
                    <>
                      <span className="text-red-700 dark:text-red-200">: {d.lead}</span>
                      {d.raw ? (
                        <span className="block pl-6 text-[11px] text-red-600/60 dark:text-red-300/60">{d.raw}</span>
                      ) : null}
                    </>
                  );
                })()}
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
