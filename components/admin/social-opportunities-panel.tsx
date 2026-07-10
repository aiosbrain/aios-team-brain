"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Radar } from "lucide-react";
import { discoverNow, planNow } from "@/app/t/[team]/admin/social/actions";
import type { OpportunityRow } from "@/lib/social/types";

const PLANNED_OR_BEYOND = new Set(["planned"]);

const PCT = (n: number) => `${Math.round(n * 100)}%`;

export function SocialOpportunitiesPanel({
  teamSlug,
  opportunities,
}: {
  teamSlug: string;
  opportunities: OpportunityRow[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [planningId, setPlanningId] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function run() {
    setError(null);
    setMsg(null);
    startTransition(async () => {
      const res = await discoverNow(teamSlug);
      if (!res.ok) return setError(res.error ?? "discovery failed");
      setMsg(`Scanned ${res.scanned}, created ${res.created}, skipped ${res.skipped}.`);
      router.refresh();
    });
  }

  function plan(id: string) {
    setError(null);
    setMsg(null);
    setPlanningId(id);
    startTransition(async () => {
      const res = await planNow(teamSlug, id);
      setPlanningId(null);
      if (!res.ok) return setError(res.error ?? "planning failed");
      setMsg(res.created ? `Planned — ${res.variants} variants created.` : "Already planned.");
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <button type="button" onClick={run} disabled={pending} className="btn-prism justify-center">
          <Radar className="size-4" /> {pending ? "Discovering…" : "Discover now"}
        </button>
        {msg ? <p className="text-sm text-emerald-700">{msg}</p> : null}
        {error ? <p className="text-sm text-red">{error}</p> : null}
      </div>

      {opportunities.length === 0 ? (
        <p className="text-sm text-ink-tertiary">
          No opportunities yet. “Discover now” scans recent decisions, deliverables, and commits and
          ranks what’s worth communicating.
        </p>
      ) : (
        <div className="prism-card overflow-hidden">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-ink-tertiary">
              <tr className="border-b border-border-subtle">
                <th className="px-3 py-2 font-medium">Title</th>
                <th className="px-3 py-2 font-medium">Tier</th>
                <th className="px-3 py-2 font-medium">Source</th>
                <th className="px-3 py-2 font-medium">Novelty</th>
                <th className="px-3 py-2 font-medium">Relevance</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium"></th>
              </tr>
            </thead>
            <tbody>
              {opportunities.map((o) => (
                <tr key={o.id} className="border-b border-border-subtle/50">
                  <td className="px-3 py-2 text-ink">{o.title}</td>
                  <td className="px-3 py-2">
                    <span
                      className={`rounded px-1.5 py-0.5 text-xs ${
                        o.access === "external" ? "bg-amber-100 text-amber-800" : "bg-slate-100 text-slate-700"
                      }`}
                    >
                      {o.access}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-ink-tertiary">{o.source_type}</td>
                  <td className="px-3 py-2 text-ink-secondary">{PCT(o.novelty_score)}</td>
                  <td className="px-3 py-2 text-ink-secondary">{PCT(o.relevance_score)}</td>
                  <td className="px-3 py-2 text-ink-tertiary">{o.status}</td>
                  <td className="px-3 py-2 text-right">
                    {PLANNED_OR_BEYOND.has(o.status) ? (
                      <span className="text-xs text-ink-tertiary">planned</span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => plan(o.id)}
                        disabled={pending}
                        className="text-xs font-medium text-violet hover:underline disabled:opacity-50"
                      >
                        {planningId === o.id ? "Planning…" : "Plan"}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
