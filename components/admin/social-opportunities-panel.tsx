"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Radar, Sparkles, Wand2, Copy, Check } from "lucide-react";
import { discoverNow, discoverFromArcsNow, generateNow } from "@/app/t/[team]/admin/social/actions";
import type { OpportunityRow, VariantRow } from "@/lib/social/types";

const PCT = (n: number) => `${Math.round(n * 100)}%`;

const PLATFORM_LABEL: Record<string, string> = { x: "X (Twitter)", linkedin: "LinkedIn" };

/** Copy-to-clipboard button — v1 posting is draft-for-copy-paste, so this is the primary action. */
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          /* clipboard blocked — no-op */
        }
      }}
      className="inline-flex items-center gap-1 rounded-md border border-border-default px-2 py-1 text-xs font-medium text-ink-secondary transition-colors hover:border-violet/40"
    >
      {copied ? <Check className="size-3.5 text-emerald-600" /> : <Copy className="size-3.5" />}
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

function DraftCard({ variant }: { variant: VariantRow }) {
  const label = PLATFORM_LABEL[variant.platform] ?? variant.platform;
  const hasBody = !!variant.body.trim();
  return (
    <div className="rounded-lg border border-border-subtle bg-surface-raised/40 p-3">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-xs font-semibold text-ink">{label}</span>
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-ink-tertiary">{variant.status.replace(/_/g, " ")}</span>
          {hasBody ? <CopyButton text={variant.body} /> : null}
        </div>
      </div>
      {hasBody ? (
        <p className="whitespace-pre-wrap text-sm leading-snug text-ink-secondary">{variant.body}</p>
      ) : (
        <p className="text-xs italic text-ink-tertiary">Not drafted yet — click Generate.</p>
      )}
    </div>
  );
}

export function SocialOpportunitiesPanel({
  teamSlug,
  opportunities,
  drafts,
}: {
  teamSlug: string;
  opportunities: OpportunityRow[];
  drafts: Record<string, VariantRow[]>;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function discover(kind: "items" | "arcs") {
    setError(null);
    setMsg(null);
    startTransition(async () => {
      const res = kind === "arcs" ? await discoverFromArcsNow(teamSlug) : await discoverNow(teamSlug);
      if (!res.ok) return setError(res.error ?? "discovery failed");
      setMsg(`${kind === "arcs" ? "Arcs" : "Knowledge"}: scanned ${res.scanned}, created ${res.created}, skipped ${res.skipped}.`);
      router.refresh();
    });
  }

  function generate(id: string) {
    setError(null);
    setMsg(null);
    setBusyId(id);
    startTransition(async () => {
      const res = await generateNow(teamSlug, id);
      setBusyId(null);
      if (!res.ok) return setError(res.error ?? "generation failed");
      setMsg(`Drafted ${res.generated} post${res.generated === 1 ? "" : "s"}${res.skipped ? ` (skipped ${res.skipped})` : ""}.`);
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={() => discover("items")} disabled={pending} className="btn-prism justify-center">
          <Radar className="size-4" /> {pending ? "Working…" : "Discover now"}
        </button>
        <button type="button" onClick={() => discover("arcs")} disabled={pending} className="btn-ghost justify-center">
          <Sparkles className="size-4" /> {pending ? "Working…" : "Discover from arcs"}
        </button>
        {msg ? <p className="text-sm text-emerald-700">{msg}</p> : null}
        {error ? <p className="text-sm text-red">{error}</p> : null}
      </div>

      {opportunities.length === 0 ? (
        <p className="text-sm text-ink-tertiary">
          No opportunities yet. “Discover now” scans recent decisions and deliverables; “Discover from
          arcs” turns your narrative arcs into candidate stories.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {opportunities.map((o) => {
            const variants = drafts[o.id] ?? [];
            const drafted = variants.some((v) => v.body.trim());
            return (
              <div key={o.id} className="prism-card flex flex-col gap-3 p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <h3 className="truncate font-medium text-ink">{o.title}</h3>
                      <span
                        className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] ${
                          o.access === "external" ? "bg-amber-100 text-amber-800" : "bg-slate-100 text-slate-700"
                        }`}
                        title={o.access === "external" ? "public-safe" : "internal — not for public posting"}
                      >
                        {o.access}
                      </span>
                    </div>
                    {o.summary ? <p className="mt-0.5 line-clamp-2 text-sm text-ink-tertiary">{o.summary}</p> : null}
                    <p className="mt-1 text-[11px] text-ink-tertiary">
                      {o.source_type} · novelty {PCT(o.novelty_score)} · relevance {PCT(o.relevance_score)} · {o.status}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => generate(o.id)}
                    disabled={pending}
                    className="btn-ghost shrink-0 justify-center text-sm"
                  >
                    <Wand2 className="size-4" />
                    {busyId === o.id ? "Generating…" : drafted ? "Regenerate" : "Generate"}
                  </button>
                </div>

                {variants.length > 0 ? (
                  <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                    {variants.map((v) => (
                      <DraftCard key={v.id} variant={v} />
                    ))}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
