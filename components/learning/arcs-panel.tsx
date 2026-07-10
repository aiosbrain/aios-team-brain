"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Loader2, Sparkles, RefreshCw, ChevronRight, ExternalLink } from "lucide-react";

interface ArcEvidence {
  fact: string;
  at?: string;
  itemId?: string;
  source?: string;
}

interface Arc {
  id: string;
  title: string;
  confidence: "high" | "medium" | "low";
  summary: string;
  participants: string[];
  supporting_sources: string[];
  evidence: ArcEvidence[];
  derived_at: string;
}

const CONF: Record<string, string> = {
  high: "bg-emerald-500/12 text-emerald-400",
  medium: "bg-amber-500/12 text-amber-400",
  low: "bg-surface-inset text-ink-tertiary",
};

type Status = "loading" | "ready" | "error";

/** Layer 3 — narrative arcs, with inline-editable summaries + human-correction recompute. */
export function ArcsPanel({ teamSlug }: { teamSlug: string }) {
  const [arcs, setArcs] = useState<Arc[]>([]);
  const [status, setStatus] = useState<Status>("loading");
  const [edited, setEdited] = useState<Record<string, string>>({}); // arc_id → corrected text
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [recomputing, setRecomputing] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch("/api/brain/arcs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ team: teamSlug }),
        });
        if (!res.ok) throw new Error();
        const data = (await res.json()) as { arcs?: Arc[] };
        if (alive) {
          setArcs(data.arcs ?? []);
          setStatus("ready");
        }
      } catch {
        if (alive) setStatus("error");
      }
    })();
    return () => {
      alive = false;
    };
  }, [teamSlug]);

  function saveEdit(id: string) {
    const text = draft.trim();
    setEdited((e) => (text ? { ...e, [id]: text } : e));
    setEditing(null);
  }

  async function recompute() {
    const corrections = Object.entries(edited).map(([arc_id, corrected_text]) => ({ arc_id, corrected_text }));
    if (!corrections.length) return;
    setRecomputing(true);
    try {
      const res = await fetch("/api/brain/arcs/recompute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ team: teamSlug, corrections }),
      });
      if (res.ok) {
        const data = (await res.json()) as { arcs?: Arc[] };
        setArcs(data.arcs ?? []);
        setEdited({});
      }
    } finally {
      setRecomputing(false);
    }
  }

  if (status === "loading") {
    return (
      <p className="flex items-center gap-2 px-1 py-6 text-sm text-ink-tertiary">
        <Loader2 className="size-4 animate-spin" /> synthesizing arcs…
      </p>
    );
  }
  if (status === "error") {
    return (
      <p className="rounded-lg border border-border-subtle px-4 py-3 text-sm text-ink-tertiary">
        Couldn&apos;t synthesize arcs right now.
      </p>
    );
  }
  if (arcs.length === 0) {
    return (
      <div className="prism-card flex flex-col items-center gap-2 px-4 py-8 text-center">
        <Sparkles className="size-5 text-violet" />
        <p className="max-w-sm text-sm text-ink-secondary">
          No active narrative arcs yet — they emerge once the graph has a week of activity to synthesize.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {arcs.map((arc) => {
        const text = edited[arc.id] ?? arc.summary;
        const isEdited = arc.id in edited;
        return (
          <div key={arc.id} className="prism-card flex flex-col gap-2 p-4">
            <div className="flex items-start justify-between gap-3">
              <h3 className="font-medium text-ink">{arc.title}</h3>
              <div className="flex shrink-0 items-center gap-2">
                {isEdited ? (
                  <span className="rounded-full bg-emerald-500/12 px-2 py-0.5 text-[10px] font-medium text-emerald-400">
                    edited
                  </span>
                ) : null}
                <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${CONF[arc.confidence]}`}>
                  {arc.confidence}
                </span>
              </div>
            </div>

            {editing === arc.id ? (
              <textarea
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    saveEdit(arc.id);
                  } else if (e.key === "Escape") {
                    setEditing(null);
                  }
                }}
                onBlur={() => saveEdit(arc.id)}
                className="min-h-16 w-full resize-none rounded-md border border-border-default bg-surface-base px-2.5 py-1.5 text-sm text-ink outline-none focus:border-violet/50"
              />
            ) : (
              <p
                onClick={() => {
                  setDraft(text);
                  setEditing(arc.id);
                }}
                className="cursor-text text-sm leading-relaxed text-ink-secondary hover:text-ink"
                title="Click to edit"
              >
                {text}
              </p>
            )}

            {arc.participants.length ? (
              <div className="flex flex-wrap gap-1.5">
                {arc.participants.map((p) => (
                  <span key={p} className="rounded-full bg-surface-inset px-2 py-0.5 text-[11px] text-ink-secondary">
                    {p}
                  </span>
                ))}
              </div>
            ) : null}

            {arc.evidence.length ? (
              <details className="group/ev mt-0.5">
                <summary className="flex w-fit cursor-pointer list-none items-center gap-1 text-xs font-medium text-ink-secondary transition-colors hover:text-ink">
                  <ChevronRight className="size-3.5 transition-transform group-open/ev:rotate-90" />
                  Evidence ({arc.evidence.length})
                </summary>
                <ul className="mt-2 flex flex-col gap-2 border-l border-border-subtle pl-3">
                  {arc.evidence.map((e, i) => (
                    <li key={i} className="flex flex-col gap-0.5">
                      <span className="text-sm leading-snug text-ink-secondary">{e.fact}</span>
                      {e.itemId ? (
                        <Link
                          href={`/t/${teamSlug}/library/${e.itemId}`}
                          className="inline-flex w-fit items-center gap-1 text-[11px] text-violet hover:underline"
                        >
                          view source{e.source ? ` · ${e.source}` : ""}
                          <ExternalLink className="size-3" />
                        </Link>
                      ) : e.source ? (
                        <span className="text-[11px] text-ink-tertiary">{e.source}</span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
          </div>
        );
      })}

      {Object.keys(edited).length > 0 ? (
        <div className="flex items-center justify-between gap-3 rounded-xl border border-violet/25 bg-violet/5 px-4 py-3">
          <p className="text-sm text-ink-secondary">
            {Object.keys(edited).length} arc{Object.keys(edited).length > 1 ? "s" : ""} edited — recompute to
            fold your corrections back into the graph.
          </p>
          <button
            type="button"
            onClick={recompute}
            disabled={recomputing}
            className="btn-prism inline-flex shrink-0 items-center gap-1.5"
          >
            {recomputing ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
            Recompute
          </button>
        </div>
      ) : null}
    </div>
  );
}
