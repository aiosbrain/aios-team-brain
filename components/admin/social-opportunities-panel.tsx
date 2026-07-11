"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Radar, PenLine, Sparkles, AlertTriangle, ShieldAlert, ImagePlus, Send, Check, X, Rocket } from "lucide-react";
import {
  discoverNow,
  discoverFromArcsNow,
  planNow,
  generateDrafts,
  generateImage,
  submitApproval,
  decideContentApproval,
  setAutonomyLevel,
  connectTypefully,
  setDryRun,
  scheduleVariantAction,
} from "@/app/t/[team]/admin/social/actions";
import { AUTONOMY_LEVELS, type AutonomyLevel } from "@/lib/social/autonomy";
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
export interface PendingApprovalView {
  id: string;
  variantId: string;
  access: string;
  platform: string;
  body: string;
  oppTitle: string;
}
export interface PublicationView {
  status: string;
  url: string | null;
  dryRun: boolean;
}

export function SocialOpportunitiesPanel({
  teamSlug,
  opportunities,
  variantsByOpportunity,
  mediaByVariant,
  imagesRemaining,
  imageCap,
  autonomy,
  pendingApprovals,
  typefullyConnected,
  typefullySocialSetId,
  publishDryRun,
  publicationsByVariant,
}: {
  teamSlug: string;
  opportunities: OpportunityRow[];
  variantsByOpportunity: Record<string, VariantView[]>;
  mediaByVariant: Record<string, string[]>;
  imagesRemaining: number;
  imageCap: number;
  autonomy: AutonomyLevel;
  pendingApprovals: PendingApprovalView[];
  typefullyConnected: boolean;
  typefullySocialSetId: string | null;
  publishDryRun: boolean;
  publicationsByVariant: Record<string, PublicationView[]>;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [scheduleAt, setScheduleAt] = useState<Record<string, string>>({});
  const [tfKey, setTfKey] = useState("");
  const [tfSet, setTfSet] = useState(typefullySocialSetId ?? "");
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
        <label className="ml-auto flex items-center gap-1 text-xs text-ink-tertiary">
          Autonomy
          <select
            className="prism-input py-1"
            value={autonomy}
            disabled={pending}
            onChange={(e) => act(() => setAutonomyLevel(teamSlug, e.target.value as AutonomyLevel), () => "Autonomy updated.")}
          >
            {AUTONOMY_LEVELS.map((l) => (
              <option key={l} value={l}>{l.replace(/_/g, " ")}</option>
            ))}
          </select>
        </label>
        <span className="text-xs text-ink-tertiary">images today: {imageCap - imagesRemaining}/{imageCap}</span>
      </div>
      {msg ? <p className="text-sm text-emerald-700">{msg}</p> : null}
      {error ? <p className="text-sm text-red">{error}</p> : null}

      <details className="prism-card p-4 text-sm">
        <summary className="cursor-pointer font-medium text-ink">
          Publishing —{" "}
          <span className={typefullyConnected ? "text-emerald-700" : "text-ink-tertiary"}>
            {typefullyConnected ? "Typefully connected" : "not connected"}
          </span>
          {" · "}
          <span className={publishDryRun ? "text-amber-700" : "text-emerald-700"}>
            {publishDryRun ? "dry-run" : "LIVE"}
          </span>
        </summary>
        <div className="mt-3 flex flex-col gap-3">
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-1 text-xs text-ink-tertiary">
              Typefully v2 API key
              <input type="password" className="prism-input" value={tfKey} onChange={(e) => setTfKey(e.target.value)} placeholder={typefullyConnected ? "•••• (set — paste to replace)" : "paste key"} />
            </label>
            <label className="flex flex-col gap-1 text-xs text-ink-tertiary">
              Social-set id
              <input className="prism-input" value={tfSet} onChange={(e) => setTfSet(e.target.value)} placeholder="social set id" />
            </label>
            <button
              type="button"
              onClick={() => act(() => connectTypefully(teamSlug, { key: tfKey || undefined, socialSetId: tfSet || undefined }), () => { setTfKey(""); return "Typefully saved."; })}
              disabled={pending}
              className="btn-prism justify-center"
            >
              Save
            </button>
          </div>
          <label className="flex items-center gap-2 text-xs text-ink-secondary">
            <input
              type="checkbox"
              checked={!publishDryRun}
              onChange={(e) => act(() => setDryRun(teamSlug, !e.target.checked), () => "Publish mode updated.")}
              disabled={pending}
            />
            Publish live (uncheck = dry-run — records a publication without posting)
          </label>
        </div>
      </details>

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
                          {v.status === "generated" ? (
                            <button
                              type="button"
                              onClick={() => act(
                                () => submitApproval(teamSlug, v.id),
                                (r) => { const x = r as { outcome?: string }; return x.outcome === "auto_approved" ? "Auto-approved." : "Submitted for approval."; },
                                v.id
                              )}
                              disabled={pending}
                              className="ml-3 mt-1 text-xs font-medium text-violet hover:underline disabled:opacity-50"
                            >
                              <Send className="mr-1 inline size-3" />
                              {busyId === v.id ? "Submitting…" : "Submit for approval"}
                            </button>
                          ) : null}
                          {v.status === "approved" ? (
                            <div className="mt-1 flex flex-wrap items-center gap-2">
                              <input
                                type="datetime-local"
                                className="prism-input py-1 text-xs"
                                value={scheduleAt[v.id] ?? ""}
                                onChange={(e) => setScheduleAt((s) => ({ ...s, [v.id]: e.target.value }))}
                              />
                              <button
                                type="button"
                                onClick={() => act(
                                  () => scheduleVariantAction(teamSlug, v.id, scheduleAt[v.id]),
                                  (r) => { const x = r as { dryRun?: boolean }; return x.dryRun ? "Scheduled (dry-run — nothing posted)." : "Scheduled to publish."; },
                                  v.id
                                )}
                                disabled={pending}
                                className="text-xs font-medium text-violet hover:underline disabled:opacity-50"
                              >
                                <Rocket className="mr-1 inline size-3" />
                                {busyId === v.id ? "Scheduling…" : scheduleAt[v.id] ? "Schedule" : "Publish now"}
                              </button>
                            </div>
                          ) : null}
                          {(publicationsByVariant[v.id] ?? []).map((p, i) => (
                            <p key={i} className="mt-0.5 text-xs text-ink-tertiary">
                              publication: {p.status}{p.dryRun ? " (dry-run)" : ""}
                              {p.url ? <> · <a href={p.url} target="_blank" rel="noreferrer" className="text-violet hover:underline">view</a></> : null}
                            </p>
                          ))}
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

      {pendingApprovals.length > 0 ? (
        <div className="prism-card flex flex-col gap-3 p-4">
          <p className="text-sm font-medium text-ink">Pending approvals ({pendingApprovals.length})</p>
          <ul className="flex flex-col gap-3">
            {pendingApprovals.map((a) => (
              <li key={a.id} className="flex flex-col gap-1 border-b border-border-subtle/60 pb-3 last:border-0 last:pb-0">
                <div className="flex items-center gap-2 text-xs text-ink-tertiary">
                  <span className="font-medium uppercase text-ink-secondary">{a.platform}</span>
                  <span
                    className={`rounded px-1.5 py-0.5 ${a.access === "external" ? "bg-amber-100 text-amber-800" : "bg-slate-100 text-slate-700"}`}
                  >
                    {a.access}
                  </span>
                  <span>· {a.oppTitle}</span>
                </div>
                <p className="whitespace-pre-wrap text-sm text-ink">{a.body}</p>
                <div className="mt-1 flex items-center gap-2">
                  <input
                    className="prism-input flex-1 py-1 text-xs"
                    placeholder="note (optional)"
                    value={notes[a.id] ?? ""}
                    onChange={(e) => setNotes((n) => ({ ...n, [a.id]: e.target.value }))}
                  />
                  <button
                    type="button"
                    onClick={() => act(() => decideContentApproval(teamSlug, a.id, "approved", notes[a.id] ?? ""), () => "Approved.", a.id)}
                    disabled={pending}
                    className="flex items-center gap-1 text-xs font-medium text-emerald-700 hover:underline disabled:opacity-50"
                  >
                    <Check className="size-3" /> Approve
                  </button>
                  <button
                    type="button"
                    onClick={() => act(() => decideContentApproval(teamSlug, a.id, "denied", notes[a.id] ?? ""), () => "Denied.", a.id)}
                    disabled={pending}
                    className="flex items-center gap-1 text-xs font-medium text-red hover:underline disabled:opacity-50"
                  >
                    <X className="size-3" /> Deny
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
