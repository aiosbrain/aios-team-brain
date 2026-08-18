"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Loader2, Sparkles, RefreshCw, ChevronRight, ExternalLink } from "lucide-react";
import { digest, DIGEST_ARC_LIMIT } from "@/lib/dashboard/pulse-digest";

interface ArcEvidence {
  fact: string;
  at?: string;
  itemId?: string;
  source?: string;
}

interface Arc {
  /** PPARC-3: present on a fused (enforced) panel — the partition this arc came from. */
  sourceGroup?: string;
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

/**
 * Layer 3 — narrative arcs, with inline-editable summaries + human-correction recompute.
 *
 * `variant="digest"` is the Pulse SNAPSHOT rendering: the top `DIGEST_ARC_LIMIT` arcs as clamped
 * headlines, so the band that answers "what's happening" has a fixed height instead of one proportional
 * to `MAX_ARCS`. It expands to the full editable list in place ("Show all N") — deliberately ONE panel
 * rather than a digest up top plus a duplicate list below, so there is no second fetch and no way for
 * the two to disagree. Editing is a full-view affordance: a two-line clamp is not an editing surface.
 */
export function ArcsPanel({ teamSlug, variant = "full" }: { teamSlug: string; variant?: "full" | "digest" }) {
  const [arcs, setArcs] = useState<Arc[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [status, setStatus] = useState<Status>("loading");
  // LEGACY-ALWAYS-NULL since PRET-6: the server's empty-panel diagnosis retired with the
  // permissive mode (§5.7 — it read team-wide health a partitioned member must not see), so
  // `reason`/`note` arrive as null/undefined and the red problem-card branch below never fires.
  // Kept as wire-tolerant state (an older server could still populate them); diagnosis lives on
  // the admin health surfaces.
  const [emptyReason, setEmptyReason] = useState<string | null>(null);
  const [emptyNote, setEmptyNote] = useState<string | null>(null);
  // COMPOSITE identity (Codex PPARC-3 High 1): arc_id is sha(title) and legitimately collides
  // ACROSS partitions in a fused panel — keying edit state on the id alone routed a human's prose
  // to the wrong partition (the first matching arc won). Key = `${sourceGroup}|${arc_id}`; "|"
  // appears in neither charset.
  const [edited, setEdited] = useState<Record<string, string>>({}); // composite key → corrected text
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [recomputing, setRecomputing] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

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
        const data = (await res.json()) as { arcs?: Arc[]; reason?: string | null; note?: string | null };
        if (alive) {
          setArcs(data.arcs ?? []);
          setEmptyReason(data.reason ?? null);
          setEmptyNote(data.note ?? null);
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

  const keyOf = (a: { id: string; sourceGroup?: string }) => `${a.sourceGroup ?? ""}|${a.id}`;

  function saveEdit(id: string) {
    const text = draft.trim();
    setEdited((e) => (text ? { ...e, [id]: text } : e));
    setEditing(null);
  }

  async function recompute() {
    const all = Object.entries(edited).map(([key, corrected_text]) => {
      const sep = key.indexOf("|");
      const sourceGroup = key.slice(0, sep) || undefined;
      const arc_id = key.slice(sep + 1);
      return {
        key,
        arc_id,
        corrected_text,
        // `arc_id` is a hash of the title and churns on every recompute, so the server stores the title
        // beside it to keep the correction diagnosable afterwards.
        arc_title: arcs.find((a) => a.id === arc_id && (a.sourceGroup ?? undefined) === sourceGroup)?.title ?? "",
        // ONE partition per POST. Since PRET-3 every served arc carries sourceGroup; an
        // undefined here means a stale pre-unification panel and the server 422s until reload.
        sourceGroup,
      };
    });
    if (!all.length) return;
    setRecomputing(true);
    setSaveError(null);
    try {
      // Group by partition — one POST each (the server 422s a cross-partition batch by design).
      const byGroup = new Map<string | undefined, typeof all>();
      for (const c of all) {
        const arr = byGroup.get(c.sourceGroup) ?? [];
        arr.push(c);
        byGroup.set(c.sourceGroup, arr);
      }
      let anyFailed = false;
      for (const [group, batch] of byGroup) {
        const res = await fetch("/api/brain/arcs/recompute", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            team: teamSlug,
            ...(group ? { sourceGroup: group } : {}),
            corrections: batch.map(({ arc_id, corrected_text, arc_title }) => ({ arc_id, corrected_text, arc_title })),
          }),
        });
        if (res.ok) {
          // Drop THIS batch's edits — a partial-failure retry then resends only the failed
          // partitions (Fable PPARC-3 Medium 1: resending a succeeded one 403-loops on churned
          // arc ids or re-pays its synthesis).
          setEdited((e) => {
            const next = { ...e };
            for (const c of batch) delete next[c.key];
            return next;
          });
        } else anyFailed = true;
      }
      if (!anyFailed) {
        // Re-fetch the FUSED panel rather than trusting a recompute body (Fable PPARC-3 High 4:
        // the single-partition response collapsed the panel and carried no sourceGroup, so every
        // SECOND correction 422'd). The GET restores full coverage + annotations.
        const res = await fetch("/api/brain/arcs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ team: teamSlug }),
        });
        if (res.ok) {
          const data = (await res.json()) as { arcs?: Arc[] };
          setArcs(data.arcs ?? []);
        }
      } else {
        // Say so. A failed save used to stop the spinner and leave the old arcs, which reads exactly
        // like "nothing happened" — the same silent-revert experience H13 is about, one layer up. The
        // edits stay in `edited`, so the retry is one click.
        setSaveError("Could not save your correction — it has not been applied. Try again.");
      }
    } catch {
      setSaveError("Could not reach the server — your correction has not been saved.");
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
    // PRET-6: the server sends reason=null always (diagnosis retired — see the state note above),
    // so this renders the benign empty note; the red card survives only for an older server.
    const isProblem = emptyReason === "no_facts" || emptyReason === "model_failing";
    if (isProblem && emptyNote) {
      return (
        <div className="rounded-lg border border-red-400/30 bg-red-400/10 px-4 py-3 text-sm text-red-600 dark:text-red-300">
          {emptyNote}
        </div>
      );
    }
    return (
      <div className="prism-card flex flex-col items-center gap-2 px-4 py-8 text-center">
        <Sparkles className="size-5 text-violet" />
        <p className="max-w-sm text-sm text-ink-secondary">
          {emptyNote ??
            "No active narrative arcs yet — they emerge once the graph has enough team activity to synthesize."}
        </p>
      </div>
    );
  }

  // Unsaved corrections must follow the user across the collapse. The digest renders `edited[...]` text,
  // so without this a collapsed panel showed a correction as if it had been applied while the only save
  // control lived in the expanded view — an in-memory edit with no visible way to commit or discard it.
  const pendingCount = Object.keys(edited).length;
  // The failure notice travels WITH the Recompute button. Rendering the control in both densities but the
  // "it didn't save" alert in only one would recreate the silent-revert the alert exists to prevent.
  const pendingBanner = (
    <>
      {pendingCount > 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-violet/25 bg-violet/5 px-4 py-3">
          <p className="text-sm text-ink-secondary">
            {pendingCount} arc{pendingCount > 1 ? "s" : ""} edited — recompute to fold your corrections back
            into the graph.
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
      {saveError ? (
        <p role="alert" className="px-1 pt-2 text-sm text-rose-500">
          {saveError}
        </p>
      ) : null}
    </>
  );

  // SNAPSHOT — bounded headlines. Height stops tracking arc count, which is the whole point of the
  // Pulse header; the full list (with editing + evidence) is one click away in the same panel.
  if (variant === "digest" && !expanded) {
    const { shown, hidden, total } = digest(arcs, DIGEST_ARC_LIMIT);
    return (
      <div className="flex flex-col gap-2">
        {shown.map((arc) => (
          <div key={arc.id} className="prism-card flex flex-col gap-1 p-3">
            <div className="flex items-start justify-between gap-3">
              <h3 className="text-sm font-medium leading-snug text-ink">{arc.title}</h3>
              <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${CONF[arc.confidence]}`}>
                {arc.confidence}
              </span>
            </div>
            <p className="line-clamp-2 text-[13px] leading-snug text-ink-secondary">
              {edited[keyOf(arc)] ?? arc.summary}
            </p>
          </div>
        ))}
        {/* UNCONDITIONAL — not `hidden > 0`. This panel is mounted in exactly one place (the Pulse
            snapshot), so gating the only route into the expanded view on "there are more than 3 arcs"
            made summary editing, human-correction recompute, evidence trails, and the un-clamped
            prose unreachable ANYWHERE in the product whenever the model returned ≤ 3 arcs. */}
        <button
          type="button"
          onClick={() => setExpanded(true)}
          aria-expanded={false}
          className="w-fit text-xs font-medium text-violet hover:underline"
        >
          {hidden > 0 ? `Show all ${total} arcs →` : "View & edit arcs →"}
        </button>
        {pendingBanner}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {arcs.map((arc) => {
        const arcK = keyOf(arc);
        const text = edited[arcK] ?? arc.summary;
        const isEdited = arcK in edited;
        return (
          <div key={arcK} className="prism-card flex flex-col gap-2 p-4">
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

            {editing === arcK ? (
              <textarea
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    saveEdit(arcK);
                  } else if (e.key === "Escape") {
                    setEditing(null);
                  }
                }}
                onBlur={() => saveEdit(arcK)}
                className="min-h-16 w-full resize-none rounded-md border border-border-default bg-surface-base px-2.5 py-1.5 text-sm text-ink outline-none focus:border-violet/50"
              />
            ) : (
              <p
                onClick={() => {
                  setDraft(text);
                  setEditing(arcK);
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

      {/* Reversible — an expansion you can't undo turns the snapshot into a one-way trip to the old feed. */}
      {variant === "digest" ? (
        <button
          type="button"
          onClick={() => setExpanded(false)}
          aria-expanded={true}
          className="w-fit text-xs font-medium text-violet hover:underline"
        >
          ← Show fewer
        </button>
      ) : null}

      {pendingBanner}
    </div>
  );
}
