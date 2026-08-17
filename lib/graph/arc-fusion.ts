import "server-only";
import type { DbClient } from "@/lib/db/types";
import type { NarrativeArc } from "./arcs";
import { getArcs, schedulePartitionRefresh, PPARC_SYNTH_BUDGET_PER_READ, MAX_ARCS, type ProviderKeys } from "./arcs";
import { readArcCache, arcTtlMs, type ArcCacheEntry } from "./arc-cache";
import { freshness, computedNow, type Freshness } from "@/lib/freshness";
import { latestPushByGroup } from "./extraction-health";

/**
 * PPARC-3 — serve-time FUSION of partition-native arc rows (design docs/design/per-project-arcs.md
 * §2.2). Fusion computes NO prose: it reads each visible partition's `g:` row, annotates every arc
 * with its `sourceGroup`, interleaves partitions round-robin (recency-ranked) so one busy
 * partition cannot evict every other's arcs from the panel, and caps at the panel size. Arc order
 * WITHIN a partition is the row's own (lineage-stable), so a byte-stable set of rows produces a
 * byte-stable panel (design Medium 8 — the panel must not churn when nothing changed).
 *
 * COLD POLICY (§2.2): at most ONE missing/stale partition synthesizes inline (the highest-ranked —
 * the reader gets a real answer); the rest are served from whatever rows exist and warmed in the
 * background under `PPARC_SYNTH_BUDGET_PER_READ`. Coverage is DISCLOSED (`covered`/`total`), the
 * same vocabulary as the retrieve K-cap.
 *
 * FUSED ENVELOPE (design Medium 6b): `as_of` = the OLDEST fused row's computed_at (an honest
 * floor, never a fabricated now); `stale`/`degraded` = true if ANY fused row is; an EMPTY fused
 * panel is `computedNow()` (the §5.7 neutral-envelope rule carries over verbatim at the route).
 */

/** The panel size — the synthesis-side MAX_ARCS by IMPORT, not by literal (drift-proof); fusion
 *  must not out-grow what one synthesis could have served. */
export const FUSED_PANEL_MAX = MAX_ARCS;

export interface FusedArc extends NarrativeArc {
  /** The partition this arc came from — the wire field the corrections write gate keys on. */
  sourceGroup: string;
}

export interface FusedArcPanel {
  arcs: FusedArc[];
  /** Background g: refreshes this read scheduled (missing OR stale partitions) — the SWR "R". */
  warmScheduled: number;
  freshness: Freshness;
  /** Partitions with a cached (or just-synthesized) row vs. the reader's resolvable total. */
  covered: number;
  total: number;
}

/** Pure fusion core — exported for the unit tier. Entries arrive ALREADY ranked (highest first). */
export function fuseArcRows(
  ranked: ReadonlyArray<{ group: string; entry: ArcCacheEntry }>,
  panelMax: number = FUSED_PANEL_MAX
): { arcs: FusedArc[]; asOf: number | null; anyDegraded: boolean } {
  const queues = ranked.map((r) => ({
    group: r.group,
    arcs: r.entry.arcs.map((a) => ({ ...a, sourceGroup: r.group })),
    i: 0,
  }));
  const fused: FusedArc[] = [];
  // Round-robin in rank order: one arc per partition per pass, partition-internal order preserved.
  let progressed = true;
  while (fused.length < panelMax && progressed) {
    progressed = false;
    for (const q of queues) {
      if (fused.length >= panelMax) break;
      if (q.i < q.arcs.length) {
        fused.push(q.arcs[q.i]);
        q.i++;
        progressed = true;
      }
    }
  }
  const asOf = ranked.length === 0 ? null : Math.min(...ranked.map((r) => r.entry.computedAt));
  const anyDegraded = ranked.some((r) => r.entry.degraded);
  return { arcs: fused, asOf, anyDegraded };
}

/**
 * The enforced read's fused panel: read every partition's `g:` row, synthesize AT MOST ONE missing
 * partition inline, warm the rest in the background, fuse with disclosure.
 */
export async function getFusedArcs(
  db: DbClient,
  teamId: string,
  teamSlug: string,
  groups: readonly string[],
  keys: ProviderKeys
): Promise<FusedArcPanel> {
  if (groups.length === 0) return { arcs: [], warmScheduled: 0, freshness: computedNow(), covered: 0, total: 0 };

  // Rank by the partition's own latest real push — the same recency prior the K-cap uses; a
  // failed read degrades RANKING only, never coverage.
  const recency = await latestPushByGroup(teamId, [...groups]).catch(() => new Map<string, number>());
  const rankedGroups = [...groups].sort(
    (a, b) => (recency.get(b) ?? 0) - (recency.get(a) ?? 0) || a.localeCompare(b)
  );

  // PARALLEL reads (Codex PPARC-3 Medium 3: serial per-partition awaits made a wide scope pay
  // N round-trips end-to-end where one batch suffices).
  const entries: Array<{ group: string; entry: ArcCacheEntry | null }> = await Promise.all(
    rankedGroups.map(async (group) => ({ group, entry: await readArcCache(db, teamId, `g:${group}`) }))
  );

  // ONE inline synthesis: the highest-ranked partition with NO row at all. Stale-present rows are
  // served immediately and revalidated via the background warm below (they never synthesize
  // inline) — an earlier comment here claimed getArcs would SWR them, but this path reads rows
  // directly and must own its own revalidation (Fable PPARC-3 High 2).
  const inlineTarget = rankedGroups.find((g) => entries.find((e) => e.group === g)?.entry == null);
  if (inlineTarget) {
    const { arcs, freshness: inlineFreshness } = await getArcs(db, teamId, teamSlug, "team", [inlineTarget], keys, {
      scopeKey: `g:${inlineTarget}`,
    });
    const refreshed = await readArcCache(db, teamId, `g:${inlineTarget}`);
    const slot = entries.find((e) => e.group === inlineTarget);
    // The fallback (cache write swallowed its failure) carries getArcs' OWN freshness — hardcoding
    // {now, degraded:false} fabricated a healthy-fresh verdict for a possibly-degraded synthesis
    // (Fable PPARC-3 Medium 2; the trust-dial class one branch deep).
    if (slot)
      slot.entry =
        refreshed ??
        (arcs.length > 0
          ? { arcs, computedAt: inlineFreshness.computedAt, factsHash: null, degraded: inlineFreshness.degraded }
          : null);
  }
  // Background-warm EVERYTHING else — missing AND stale-present (Fable PPARC-3 High 2: warming
  // only the missing left stale rows with no revalidation trigger at all — SWR with no R). The
  // scheduling reuses THE ROWS ALREADY READ above (Codex Medium 3: re-probing them through
  // warmPartitionArcs doubled the serial reads), is budgeted, and its count is the pin's
  // observable; the syntheses themselves stay background.
  // ONE clock for the warm classifier AND the returned envelope, captured AFTER the inline
  // synthesis (Codex PPARC-4 Medium 2): with the clock taken before a long inline synthesis, a
  // row crossing its TTL during it was scheduled for refresh yet reported `stale: false` — the
  // envelope must never contradict the scheduler's own verdict about the same row.
  const now = Date.now();
  let warmScheduled = 0;
  for (const e of entries) {
    if (e.group === inlineTarget) continue;
    if (warmScheduled >= PPARC_SYNTH_BUDGET_PER_READ) break;
    const isFresh =
      e.entry != null &&
      !freshness(e.entry.computedAt, arcTtlMs(e.entry.degraded), { now, degraded: e.entry.degraded }).stale;
    if (isFresh) continue;
    const prior = e.entry ? { arcs: e.entry.arcs, factsHash: e.entry.factsHash, degraded: e.entry.degraded } : null;
    if (schedulePartitionRefresh(db, teamId, e.group, keys, prior)) warmScheduled++;
  }

  const present = entries.filter((e): e is { group: string; entry: ArcCacheEntry } => e.entry != null);
  const { arcs, asOf, anyDegraded } = fuseArcRows(present);
  const anyStale = present.some(
    (p) => freshness(p.entry.computedAt, arcTtlMs(p.entry.degraded), { now, degraded: p.entry.degraded }).stale
  );
  return {
    arcs,
    warmScheduled,
    freshness:
      asOf == null
        ? computedNow()
        : { ...freshness(asOf, arcTtlMs(anyDegraded), { now, degraded: anyDegraded }), stale: anyStale, degraded: anyDegraded },
    covered: present.length,
    total: groups.length,
  };
}
