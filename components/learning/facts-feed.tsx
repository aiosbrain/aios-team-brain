"use client";

import { useEffect, useState } from "react";
import { Loader2, Sparkles } from "lucide-react";

/** One atomic fact from the graph (Layer 1). Mirrors lib/graph/learning.AtomicFact. */
interface AtomicFact {
  id: string;
  fact: string;
  at: string;
  subjectType: string;
  subject: string;
  object: string;
  episodeUuids: string[];
}

// Type badge colors — keyed by the subject entity's label (lowercased). Falls back to neutral.
const BADGE: Record<string, string> = {
  decision: "bg-violet/12 text-violet",
  person: "bg-sky-500/12 text-sky-400",
  goal: "bg-emerald-500/12 text-emerald-400",
  risk: "bg-rose-500/12 text-rose-400",
  ownership: "bg-amber-500/12 text-amber-400",
  code: "bg-indigo-500/12 text-indigo-400",
  relation: "bg-teal-500/12 text-teal-400",
};

function relTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

type Status = "loading" | "ready" | "error";

/** Layer 1 — live feed of recently-extracted facts, auto-refreshing every 60s. */
export function FactsFeed({ teamSlug }: { teamSlug: string }) {
  const [facts, setFacts] = useState<AtomicFact[]>([]);
  const [status, setStatus] = useState<Status>("loading");

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch(`/api/brain/facts?team=${encodeURIComponent(teamSlug)}`);
        if (!res.ok) throw new Error(`facts ${res.status}`);
        const data = (await res.json()) as { facts?: AtomicFact[] };
        if (alive) {
          setFacts(data.facts ?? []);
          setStatus("ready");
        }
      } catch {
        if (alive) setStatus("error");
      }
    };
    void load();
    const t = setInterval(load, 60_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [teamSlug]);

  if (status === "loading") {
    return (
      <p className="flex items-center gap-2 px-1 py-6 text-sm text-ink-tertiary">
        <Loader2 className="size-4 animate-spin" /> loading facts…
      </p>
    );
  }
  if (status === "error") {
    return (
      <p className="rounded-lg border border-border-subtle px-4 py-3 text-sm text-ink-tertiary">
        Couldn&apos;t load facts right now.
      </p>
    );
  }
  if (facts.length === 0) {
    return (
      <div className="prism-card flex flex-col items-center gap-2 px-4 py-8 text-center">
        <Sparkles className="size-5 text-violet" />
        <p className="max-w-sm text-sm text-ink-secondary">
          No facts extracted in the last 24 hours. The graph fills in as your team&apos;s activity is
          ingested and Graphiti extracts entities and relationships.
        </p>
      </div>
    );
  }

  return (
    <div className="prism-card divide-y divide-border-subtle">
      {facts.map((f) => (
        <div key={f.id} className="flex items-start gap-3 px-4 py-3">
          <span
            className={`mt-0.5 shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium capitalize ${
              BADGE[f.subjectType] ?? "bg-surface-inset text-ink-tertiary"
            }`}
          >
            {f.subjectType}
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm text-ink">{f.fact}</p>
            <p className="mt-0.5 text-[11px] text-ink-tertiary">{relTime(f.at)}</p>
          </div>
        </div>
      ))}
    </div>
  );
}
