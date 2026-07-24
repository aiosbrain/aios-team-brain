"use client";

import { useCallback, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ChevronRight, Radio, ExternalLink, Pencil, Lock, ArrowRight } from "lucide-react";
import {
  getMemberItemsAction,
  previewCorrectionPlanAction,
  applyAttributionCorrectionAction,
} from "@/app/t/[team]/admin/attribution/actions";
import type { MemberAttribution, MemberItem } from "@/lib/attribution/health";

/**
 * The per-person attribution DRILL-DOWN: expand a member (or the unattributed bucket) to the actual
 * items behind the count — each linkable to its library page, with the resolver's "why is this theirs?"
 * signal and a per-item "correct" affordance. The chips become source filters. Client-side because the
 * expansion is fetched on demand and must refetch after a correction (revalidatePath alone won't refresh
 * a client-fetched list). Reads route through `getMemberItemsAction` (admin-gated); corrections build a
 * closed `itemId` plan and go through the SAME preview→apply path as the NL box. See
 * docs/design/attribution-drilldown.md.
 */

type Chip = MemberAttribution["bySource"][number];

// A member UUID can never equal this plain-string key, so it's a safe sentinel for the null bucket.
const UNATTRIBUTED = "__unattributed__";

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

// How the author signal resolves against the team's mappings — the mapping KIND (where to go fix it).
const METHOD_LABEL: Record<string, string> = {
  provider: "provider id",
  email: "email",
  handle: "handle",
  heuristic: "name guess",
};

interface RowState {
  items: MemberItem[];
  loading: boolean;
  error: string | null;
  source: string | null; // active source filter (null = all)
}

interface Row {
  key: string;
  memberId: string | null;
  name: string;
  total: number;
  chips: Chip[];
}

export function MemberDrilldown({
  teamSlug,
  members,
  unattributedTotal,
  unattributedChips,
}: {
  teamSlug: string;
  members: MemberAttribution[];
  unattributedTotal: number;
  unattributedChips: Chip[];
}) {
  const router = useRouter();
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [state, setState] = useState<Record<string, RowState>>({});
  const [, startTransition] = useTransition();

  const load = useCallback(
    (key: string, memberId: string | null, source: string | null, resetOthers = false) => {
      setState((s) => ({ ...(resetOthers ? {} : s), [key]: { items: [], loading: true, error: null, source } }));
      startTransition(async () => {
        const res = await getMemberItemsAction(teamSlug, memberId, source ?? undefined);
        setState((s) => ({
          ...s,
          [key]: res.ok
            ? { items: res.items, loading: false, error: null, source }
            : { items: [], loading: false, error: res.error, source },
        }));
      });
    },
    [teamSlug]
  );

  const toggle = useCallback(
    (key: string, memberId: string | null) => {
      if (openKey === key) return setOpenKey(null);
      setOpenKey(key);
      if (!state[key]) load(key, memberId, null);
    },
    [openKey, state, load]
  );

  // After a successful correction the item moved members — every cached expansion is now potentially
  // stale (the item left this row, joined another). Drop all caches and refetch this row; refresh the
  // server-rendered chip counts too.
  const afterCorrection = useCallback(
    (key: string, memberId: string | null) => {
      load(key, memberId, state[key]?.source ?? null, true);
      router.refresh();
    },
    [load, state, router]
  );

  const rows: Row[] = [
    ...members.map((m) => ({ key: m.memberId, memberId: m.memberId, name: m.displayName, total: m.total, chips: m.bySource })),
    ...(unattributedTotal > 0
      ? [{ key: UNATTRIBUTED, memberId: null, name: "Unattributed", total: unattributedTotal, chips: unattributedChips }]
      : []),
  ];

  if (rows.length === 0) {
    return <p className="text-sm text-ink-secondary">Nothing is attributed to a person yet — every ingested item resolved to a connector or nobody.</p>;
  }

  return (
    <div className="flex flex-col gap-2">
      {rows.map((row) => {
        const open = openKey === row.key;
        const rs = state[row.key];
        // The authoritative count for what's expanded (whole row, or the active source chip) — lets us
        // show "N of total" so a capped list never silently contradicts the chip it came from.
        const expected = rs?.source ? row.chips.find((c) => c.source === rs.source)?.items ?? rs.items.length : row.total;
        return (
          <div key={row.key} className="prism-card overflow-hidden">
            <button
              type="button"
              onClick={() => toggle(row.key, row.memberId)}
              aria-expanded={open}
              className="flex w-full flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-3 text-left hover:bg-surface-sunken/40"
            >
              <ChevronRight className={`size-4 shrink-0 text-ink-tertiary transition-transform ${open ? "rotate-90" : ""}`} />
              <span className={`font-medium ${row.memberId === null ? "text-rose" : "text-ink"}`}>{row.name}</span>
              <span className="text-xs tabular-nums text-ink-tertiary">{row.total} items</span>
              {row.chips.length > 0 && (
                <span className="ml-auto flex flex-wrap gap-1.5" onClick={(e) => e.stopPropagation()}>
                  {row.chips.map((b) => {
                    const active = open && rs?.source === b.source;
                    return (
                      <button
                        key={b.source}
                        type="button"
                        onClick={() => {
                          if (!open) setOpenKey(row.key);
                          load(row.key, row.memberId, active ? null : b.source);
                        }}
                        className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs transition-colors ${
                          active ? "border-violet bg-violet/10 text-ink" : "border-border-subtle text-ink-secondary hover:border-border-default"
                        }`}
                      >
                        {b.isSignal && <Radio className="size-2.5" />}
                        {b.source}
                        <span className="tabular-nums text-ink-tertiary">{b.items}</span>
                      </button>
                    );
                  })}
                </span>
              )}
            </button>

            {open && (
              <div className="border-t border-border-subtle/60 px-4 py-3">
                {rs?.loading && <p className="text-xs text-ink-tertiary">Loading items…</p>}
                {rs?.error && <p className="text-xs text-rose">Couldn&apos;t load items: {rs.error}</p>}
                {rs && !rs.loading && !rs.error && rs.items.length === 0 && (
                  <p className="text-xs text-ink-tertiary">No items{rs.source ? ` for ${rs.source}` : ""}.</p>
                )}
                {rs && !rs.loading && rs.items.length > 0 && (
                  <>
                    <ul className="flex flex-col divide-y divide-border-subtle/40">
                      {rs.items.map((it) => (
                        <ItemRow key={it.id} teamSlug={teamSlug} item={it} onCorrected={() => afterCorrection(row.key, row.memberId)} />
                      ))}
                    </ul>
                    {rs.items.length < expected && (
                      <p className="pt-2 text-xs text-ink-tertiary">
                        Showing {rs.items.length} of {expected}. Filter by a source to narrow — deeper paging is a follow-up.
                      </p>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** One item in the expanded list: linkable title + source/kind/updated + the "why", and a per-item
 *  "correct" affordance that reassigns exactly this item (an `itemId` plan) through preview→apply. */
function ItemRow({ teamSlug, item, onCorrected }: { teamSlug: string; item: MemberItem; onCorrected: () => void }) {
  const [editing, setEditing] = useState(false);
  const [target, setTarget] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit() {
    const toMember = target.trim();
    if (!toMember) return;
    setError(null);
    startTransition(async () => {
      const plan = { kind: "reassign" as const, match: { itemId: item.id }, toMember };
      const pre = await previewCorrectionPlanAction(teamSlug, plan);
      if (!pre.ok) return setError(pre.error);
      if (pre.preview.error) return setError(pre.preview.error);
      const res = await applyAttributionCorrectionAction(teamSlug, pre.preview.plan, pre.preview.matchedCount);
      if (!res.ok) return setError(res.error ?? "failed");
      setEditing(false);
      setTarget("");
      onCorrected();
    });
  }

  return (
    <li className="flex flex-col gap-1 py-2 first:pt-0">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm">
        <span className="rounded bg-surface-sunken px-1.5 py-0.5 text-[11px] font-medium text-ink-tertiary">{item.source}</span>
        <Link href={`/t/${teamSlug}/library/${item.id}`} className="inline-flex items-center gap-1 text-ink hover:text-violet">
          <span className="truncate">{item.title}</span>
          <ExternalLink className="size-3 shrink-0 text-ink-tertiary" />
        </Link>
        <span className="text-xs text-ink-tertiary">· {item.kind}</span>
        <span className="text-xs text-ink-tertiary">· updated {fmtDate(item.updatedAt)}</span>
        {item.locked ? (
          <span className="inline-flex items-center gap-1 rounded-full border border-border-subtle px-1.5 py-0.5 text-[11px] text-ink-secondary" title="Attribution set by a deliberate correction">
            <Lock className="size-2.5" /> manual
          </span>
        ) : item.signal ? (
          <span className="text-xs text-ink-tertiary" title="The author signal the resolver matched (what resolves now, not necessarily at ingest)">
            · {item.signal}
            {METHOD_LABEL[item.method] && <span className="text-ink-tertiary/70"> via {METHOD_LABEL[item.method]}</span>}
          </span>
        ) : null}
        {!item.locked && item.mismatch && (
          <span
            className="inline-flex items-center gap-0.5 rounded-full border border-rose/40 bg-rose/10 px-1.5 py-0.5 text-[11px] text-rose"
            title="The author signal now resolves to a different member than the current attribution — a candidate to reassign."
          >
            <ArrowRight className="size-2.5" /> {item.resolvesToName}?
          </span>
        )}
        <button
          type="button"
          onClick={() => {
            setEditing((v) => !v);
            setError(null);
          }}
          className="ml-auto inline-flex items-center gap-1 text-xs text-ink-tertiary hover:text-ink"
        >
          <Pencil className="size-3" /> correct
        </button>
      </div>

      {item.credited.length > 0 && (
        <span
          className="pl-1 text-[11px] text-ink-tertiary"
          title="Who the Timeline and arcs credit for this item (everyone who produced a version, or the corrected owner when locked) — the shared attribution oracle. Correcting the owner above collapses this everywhere."
        >
          credited to the team as: {item.credited.join(", ")}
        </span>
      )}

      {editing && (
        <div className="flex flex-wrap items-center gap-2 pl-1 pt-1">
          <input
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
            placeholder={'name, email, or "nobody"'}
            className="w-56 rounded border border-border-default bg-surface px-2 py-1 text-xs text-ink placeholder:text-ink-tertiary focus:border-violet focus:outline-none"
          />
          <button
            type="button"
            onClick={submit}
            disabled={pending || !target.trim()}
            className="rounded bg-violet px-2.5 py-1 text-xs font-medium text-white hover:bg-violet/90 disabled:opacity-50"
          >
            {pending ? "Applying…" : "Reassign"}
          </button>
          <button type="button" onClick={() => setEditing(false)} disabled={pending} className="text-xs text-ink-tertiary hover:text-ink">
            Cancel
          </button>
          {error && <span className="text-xs text-rose">{error}</span>}
        </div>
      )}
    </li>
  );
}
