"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Radar, PenLine, Sparkles, AlertTriangle, ShieldAlert, ImagePlus } from "lucide-react";
import { discoverNow, discoverFromArcsNow, planNow, generateDrafts, generateImage } from "@/app/t/[team]/admin/social/actions";
import type { OpportunityRow } from "@/lib/social/types";

const PCT = (n: number) => `${Math.round(n * 100)}%`;

interface Finding {
  rule: string;
  term: string;
}
export interface VariantView {
  id: string;
  platform: string;
  status: string;
  body: string;
  validation: { violations?: Finding[]; warnings?: Finding[] } | null;
}

export function SocialOpportunitiesPanel({
  teamSlug,
  opportunities,
  variantsByOpportunity,
  mediaByVariant,
  imagesRemaining,
  imageCap,
}: {
  teamSlug: string;
  opportunities: OpportunityRow[];
  variantsByOpportunity: Record<string, VariantView[]>;
  mediaByVariant: Record<string, string[]>;
  imagesRemaining: number;
  imageCap: number;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function act(fn: () => Promise<{ ok: boolean; error?: string }>, onOk: (r: unknown) => string, id?: string) {
    setError(null);
    setMsg(null);
    setBusyId(id ?? null);
    startTransition(async () => {
      const res = await fn();
      setBusyId(null);
      if (!res.ok) return setError(res.error ?? "something went wrong");
      setMsg(onOk(res));
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => act(() => discoverNow(teamSlug), (r) => {
            const x = r as { scanned?: number; created?: number; skipped?: number };
            return `Scanned ${x.scanned}, created ${x.created}, skipped ${x.skipped}.`;
          })}
          disabled={pending}
          className="btn-prism justify-center"
        >
          <Radar className="size-4" /> {pending && !busyId ? "Discovering…" : "Discover now"}
        </button>
        <button
          type="button"
          onClick={() => act(() => discoverFromArcsNow(teamSlug), (r) => {
            const x = r as { scanned?: number; created?: number; skipped?: number };
            return `Arcs: scanned ${x.scanned}, created ${x.created}, skipped ${x.skipped}.`;
          })}
          disabled={pending}
          className="btn-ghost justify-center"
        >
          <Sparkles className="size-4" /> {pending ? "Discovering…" : "Discover from arcs"}
        </button>
        <span className="ml-auto text-xs text-ink-tertiary">images today: {imageCap - imagesRemaining}/{imageCap}</span>
        {msg ? <p className="text-sm text-emerald-700">{msg}</p> : null}
        {error ? <p className="text-sm text-red">{error}</p> : null}
      </div>

      {opportunities.length === 0 ? (
        <p className="text-sm text-ink-tertiary">
          No opportunities yet. “Discover now” scans recent decisions, deliverables, and commits.
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {opportunities.map((o) => {
            const variants = variantsByOpportunity[o.id] ?? [];
            const planned = o.status === "planned";
            return (
              <li key={o.id} className="prism-card flex flex-col gap-2 p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-ink">{o.title}</span>
                  <span
                    className={`rounded px-1.5 py-0.5 text-xs ${
                      o.access === "external" ? "bg-amber-100 text-amber-800" : "bg-slate-100 text-slate-700"
                    }`}
                  >
                    {o.access}
                  </span>
                  <span className="text-xs text-ink-tertiary">{o.source_type}</span>
                  <span className="text-xs text-ink-tertiary">· novelty {PCT(o.novelty_score)} · relevance {PCT(o.relevance_score)}</span>
                  <span className="ml-auto text-xs text-ink-tertiary">{o.status}</span>
                  {!planned ? (
                    <button
                      type="button"
                      onClick={() => act(() => planNow(teamSlug, o.id), () => "Planned.", o.id)}
                      disabled={pending}
                      className="text-xs font-medium text-violet hover:underline disabled:opacity-50"
                    >
                      <PenLine className="mr-1 inline size-3" />
                      {busyId === o.id ? "Planning…" : "Plan"}
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => act(
                        () => generateDrafts(teamSlug, o.id),
                        (r) => { const x = r as { generated?: number; blocked?: number }; return `Generated ${x.generated}, blocked ${x.blocked}.`; },
                        o.id
                      )}
                      disabled={pending}
                      className="text-xs font-medium text-violet hover:underline disabled:opacity-50"
                    >
                      <Sparkles className="mr-1 inline size-3" />
                      {busyId === o.id ? "Generating…" : "Generate drafts"}
                    </button>
                  )}
                </div>

                {variants.length > 0 ? (
                  <ul className="flex flex-col gap-2 border-t border-border-subtle pt-2">
                    {variants.map((v) => {
                      const violations = v.validation?.violations ?? [];
                      const warnings = v.validation?.warnings ?? [];
                      return (
                        <li key={v.id} className="text-sm">
                          <div className="flex items-center gap-2 text-xs text-ink-tertiary">
                            <span className="font-medium uppercase text-ink-secondary">{v.platform}</span>
                            <span>· {v.status}</span>
                          </div>
                          {v.body ? <p className="whitespace-pre-wrap text-ink">{v.body}</p> : <p className="text-ink-tertiary">— not generated —</p>}
                          {violations.length > 0 ? (
                            <p className="mt-0.5 flex items-center gap-1 text-xs text-red">
                              <ShieldAlert className="size-3" /> blocked: {violations.map((x) => `${x.rule} “${x.term}”`).join(", ")}
                            </p>
                          ) : null}
                          {warnings.length > 0 ? (
                            <p className="mt-0.5 flex items-center gap-1 text-xs text-amber-700">
                              <AlertTriangle className="size-3" /> review: {warnings.map((x) => `“${x.term}”`).join(", ")}
                            </p>
                          ) : null}
                          {(mediaByVariant[v.id] ?? []).length > 0 ? (
                            <div className="mt-1 flex flex-wrap gap-2">
                              {(mediaByVariant[v.id] ?? []).map((mid) => (
                                // eslint-disable-next-line @next/next/no-img-element
                                <img key={mid} src={`/api/dashboard/social/media/${mid}`} alt="generated graphic" className="size-24 rounded object-cover" />
                              ))}
                            </div>
                          ) : null}
                          <button
                            type="button"
                            onClick={() => act(
                              () => generateImage(teamSlug, v.id),
                              (r) => { const x = r as { remaining?: number }; return `Image generated (${x.remaining} left today).`; },
                              v.id
                            )}
                            disabled={pending || imagesRemaining <= 0}
                            title={imagesRemaining <= 0 ? "Daily image cap reached" : undefined}
                            className="mt-1 text-xs font-medium text-violet hover:underline disabled:opacity-50"
                          >
                            <ImagePlus className="mr-1 inline size-3" />
                            {busyId === v.id ? "Generating image…" : "Generate image"}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
