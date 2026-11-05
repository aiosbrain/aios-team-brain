import "server-only";
import type { DbClient } from "@/lib/db/types";
import type { NarrativeArc } from "./arcs";
import { getArcs, schedulePartitionRefresh, PPARC_SYNTH_BUDGET_PER_READ, MAX_ARCS, type ProviderKeys } from "./arcs";
import { readArcCache, arcTtlMs, type ArcCacheEntry } from "./arc-cache";
import { freshness, computedNow, type Freshness } from "@/lib/freshness";
import { latestPushByGroup } from "./extraction-health";
import { authorizationEpoch } from "@/lib/access/authorization-epoch";
import { withLockedAuthorizationEpoch } from "@/lib/access/authorization-epoch";
import { filterArcsByVisibleItems } from "./arc-visibility";
import { ArcSynthesisAuthorizationChangedError } from "./arc-input-authorization";
import { arcCorrectionVersion } from "./arc-corrections";

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

/** The caller may retry this response; serving a mixed/pre-revocation fusion is never an option. */
export class ArcFusionAuthorizationChangedError extends Error {
  readonly retryable = true;
  constructor() {
    super("arc visibility changed during synthesis; retry");
    this.name = "ArcFusionAuthorizationChangedError";
  }
}

export interface ArcFusionReadHooks {
  beforeFinalEpochCheck?: (attempt: number) => Promise<void>;
  /** Bind a caller-owned enforcement/scope snapshot to this exact durable epoch. */
  expectedAuthorizationEpoch?: number;
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
  /**
   * M9: `null` means "this deployment has no model" — a copied staging environment, where the
   * central spend policy denies every provider call. It is an EXPLICIT absence, not a placeholder
   * credential: fusion then reads the cached partition rows and performs neither the inline
   * synthesis nor the background warm, so the panel degrades to what is already stored instead of
   * throwing out of the eager key resolution the route used to do first.
   */
  keys: ProviderKeys | null,
  testHooks: ArcFusionReadHooks = {},
): Promise<FusedArcPanel> {
  return getFusedArcsAttempt(db, teamId, teamSlug, groups, keys, 0, testHooks);
}

async function getFusedArcsAttempt(
  db: DbClient,
  teamId: string,
  teamSlug: string,
  groups: readonly string[],
  keys: ProviderKeys | null,
  attempt: number,
  testHooks: ArcFusionReadHooks,
): Promise<FusedArcPanel> {
  if (groups.length === 0) return { arcs: [], warmScheduled: 0, freshness: computedNow(), covered: 0, total: 0 };
  const buildEpoch = testHooks.expectedAuthorizationEpoch ?? await authorizationEpoch(db, teamId);
  const buildCorrectionVersion = await arcCorrectionVersion(teamId);
  if (testHooks.expectedAuthorizationEpoch !== undefined && await authorizationEpoch(db, teamId) !== buildEpoch) {
    throw new ArcFusionAuthorizationChangedError();
  }

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
  const inlineTarget = keys == null ? undefined : rankedGroups.find((g) => entries.find((e) => e.group === g)?.entry == null);
  if (inlineTarget && keys) {
    const { arcs, freshness: inlineFreshness } = await getArcs(db, teamId, teamSlug, [inlineTarget], keys, {
      scopeKey: `g:${inlineTarget}`,
      expectedAuthorizationEpoch: buildEpoch,
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
          ? {
              arcs,
              computedAt: inlineFreshness.computedAt,
              factsHash: null,
              degraded: inlineFreshness.degraded,
              authorizationEpoch: buildEpoch,
              correctionVersion: buildCorrectionVersion,
            }
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
    // No model ⇒ no warming. Scheduling refreshes that must fail is not a degradation, it is a
    // queue of guaranteed errors against a database that is meant to cost nothing.
    if (keys == null) break;
    if (e.group === inlineTarget) continue;
    if (warmScheduled >= PPARC_SYNTH_BUDGET_PER_READ) break;
    const isFresh =
      e.entry != null &&
      !freshness(e.entry.computedAt, arcTtlMs(e.entry.degraded), { now, degraded: e.entry.degraded }).stale;
    if (isFresh) continue;
    const prior = e.entry ? {
      arcs: e.entry.arcs,
      factsHash: e.entry.factsHash,
      degraded: e.entry.degraded,
      authorizationEpoch: e.entry.authorizationEpoch,
    } : null;
    if (schedulePartitionRefresh(db, teamId, e.group, keys, prior)) warmScheduled++;
  }

  // Every fallback payload participates in the same build-start epoch. This rejects rows obtained
  // after a mid-read revocation just as strictly as rows from before it.
  const present = entries.filter(
    (e): e is { group: string; entry: ArcCacheEntry } =>
      e.entry != null
        && e.entry.authorizationEpoch === buildEpoch
        && e.entry.correctionVersion === buildCorrectionVersion,
  );
  const { arcs, asOf, anyDegraded } = fuseArcRows(present);
  const anyStale = present.some(
    (p) => freshness(p.entry.computedAt, arcTtlMs(p.entry.degraded), { now, degraded: p.entry.degraded }).stale
  );
  const result: FusedArcPanel = {
    arcs,
    warmScheduled,
    freshness:
      asOf == null
        ? computedNow()
        : { ...freshness(asOf, arcTtlMs(anyDegraded), { now, degraded: anyDegraded }), stale: anyStale, degraded: anyDegraded },
    covered: present.length,
    total: groups.length,
  };
  await testHooks.beforeFinalEpochCheck?.(attempt);
  // Arc fusion can await a slow provider synthesis after all cache reads. Revalidate at the final
  // boundary so revoking audience A while B synthesizes cannot publish/serve a mixed old envelope.
  if (await authorizationEpoch(db, teamId) !== buildEpoch
    || await arcCorrectionVersion(teamId) !== buildCorrectionVersion) {
    if (testHooks.expectedAuthorizationEpoch !== undefined) throw new ArcFusionAuthorizationChangedError();
    if (attempt === 0) return getFusedArcsAttempt(db, teamId, teamSlug, groups, keys, 1, testHooks);
    throw new ArcFusionAuthorizationChangedError();
  }
  return result;
}

/**
 * Resolve member enforcement + partitions, synthesize/fuse, and serve under one durable epoch. An
 * epoch change retries the WHOLE resolution once — visible ids and groups are never reused from the
 * superseded attempt. The final filter runs while holding the shared epoch lock.
 */
export async function getAuthorizationBoundFusedArcs(
  db: DbClient,
  teamId: string,
  teamSlug: string,
  /** M9: `null` = no model on this deployment — cached partitions only (see `getFusedArcs`). */
  keys: ProviderKeys | null,
  resolveAuthorization: () => Promise<{ groups: string[]; visibleItemIds: ReadonlySet<string> }>,
  testHooks: {
    beforeFinalAuthorizationCheck?: (attempt: number) => Promise<void>;
    fusion?: ArcFusionReadHooks;
  } = {},
): Promise<FusedArcPanel> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const epoch = await withLockedAuthorizationEpoch(teamId, (current) => current);
    const authorization = await resolveAuthorization();
    if (await authorizationEpoch(db, teamId) !== epoch) continue;
    try {
      const panel = await getFusedArcs(db, teamId, teamSlug, authorization.groups, keys, {
        ...testHooks.fusion,
        expectedAuthorizationEpoch: epoch,
      });
      await testHooks.beforeFinalAuthorizationCheck?.(attempt);
      const served = await withLockedAuthorizationEpoch(teamId, (current) => {
        if (current !== epoch) return null;
        return {
          ...panel,
          arcs: filterArcsByVisibleItems(panel.arcs, authorization.visibleItemIds) as FusedArc[],
        };
      });
      if (served) return served;
    } catch (error) {
      if (!(error instanceof ArcFusionAuthorizationChangedError) && !(error instanceof ArcSynthesisAuthorizationChangedError)) {
        throw error;
      }
    }
  }
  throw new ArcFusionAuthorizationChangedError();
}
