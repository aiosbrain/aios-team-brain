import "server-only";
import type { DbClient } from "@/lib/db/types";
import type { NarrativeArc } from "./arcs";

/**
 * Postgres persistence for the Layer-3 narrative-arc synthesis (`arc_cache` table). Arcs are an
 * expensive LLM synthesis over the last 7d of the graph and identical for everyone sharing a
 * tier-visible group set, so we cache the fully-attributed result. This layer survives restarts/
 * deploys and is shared across instances (the in-memory cache in `arcs.ts` does neither); `arcs.ts`
 * reads it serve-stale-while-revalidate. Regenerable cache, never a source of truth — safe to
 * truncate. Sole writer of `arc_cache`.
 *
 * `group_key` is the caller's sorted `visibleGroupIds(tier)` set (the same value `arcs.ts` already
 * uses as its in-memory key), so a row is inherently tier-scoped — an `external` viewer only ever
 * touches the external-group row, with no cross-tier bleed.
 */

/** How long a synthesized arc set is served before the next view triggers a background recompute
 *  (serve-stale-while-revalidate). 4h — arcs are a slow, expensive, once-a-day-ish narrative; a shorter
 *  window just burns LLM calls (the fact-set-hash skip already keeps unchanged facts from re-synthesizing).
 *  Shared with `staleArcCache` below so a re-attribution's forced-stale mark stays PAST this window. */
export const ARC_CACHE_TTL_MS = 4 * 60 * 60_000;

/**
 * How long an UNTRUSTWORTHY arc set is served before the next view retries it. Short enough that a
 * transient LLM/graph failure self-heals in minutes rather than hours, long enough that a persistent one
 * doesn't turn every page view into a recompute.
 *
 * Moved here from `arcs.ts` so it sits beside the TTL it is an alternative to — the two are one rule, and
 * `arcTtlMs` below is the only place that rule is spelled out (H6's drift shape).
 */
export const UNTRUSTED_RETRY_AFTER_MS = 5 * 60_000;

/**
 * The TTL that applies to a row, given whether it is degraded. THE single expression of "an untrusted
 * result gets a short life".
 *
 * This is what replaced backdating `computed_at`. Previously an untrusted row was written with its
 * timestamp pushed `TTL - RETRY` into the past, so that `now - computed_at >= TTL` came true after
 * `RETRY` — the same staleness, bought by falsifying the timestamp. Deriving the TTL instead is exactly
 * equivalent (fresh for `RETRY` either way) and leaves `computed_at` meaning only "when computed".
 */
export function arcTtlMs(degraded: boolean): number {
  return degraded ? UNTRUSTED_RETRY_AFTER_MS : ARC_CACHE_TTL_MS;
}

export interface ArcCacheEntry {
  arcs: NarrativeArc[];
  /** epoch ms of when this cache row was computed (for TTL/staleness checks in `arcs.ts`). */
  computedAt: number;
  /** Hash of the LLM synthesis input at that compute — the fact-set-hash skip compares against it. */
  factsHash: string | null;
  /**
   * The synthesis that produced these arcs could not be trusted — the model failed, or an input leg did.
   * PERSISTED (R2/M6), so it survives the request that discovered it: before this column, the next reader
   * of the very same row reported the payload as healthy.
   *
   * `false` means "no evidence of degradation", NOT "verified good" — rows predating the column read
   * false. Also NOT the same as stale: a degraded row can be seconds old.
   */
  degraded: boolean;
}

/** Read the cached arcs for one team+group_key. Null on miss or any error (best-effort — a cache
 *  read must never fail the Learning page; the caller falls back to computing). */
export async function readArcCache(db: DbClient, teamId: string, groupKey: string): Promise<ArcCacheEntry | null> {
  try {
    const { data } = await db
      .from("arc_cache")
      .select("arcs, computed_at, facts_hash, degraded")
      .eq("team_id", teamId)
      .eq("group_key", groupKey)
      .maybeSingle();
    if (!data) return null;
    const row = data as {
      arcs: unknown;
      computed_at: string | Date;
      facts_hash: string | null;
      degraded?: boolean | null;
    };
    const arcs = Array.isArray(row.arcs) ? (row.arcs as NarrativeArc[]) : [];
    const computedAt =
      typeof row.computed_at === "string" ? Date.parse(row.computed_at) : new Date(row.computed_at).getTime();
    return {
      arcs,
      computedAt: Number.isFinite(computedAt) ? computedAt : 0,
      factsHash: row.facts_hash ?? null,
      // `?? false` covers a row written before the column existed. Defaulting the OTHER way would mark
      // every pre-migration row untrustworthy and stampede a recompute for every team on deploy.
      degraded: row.degraded === true,
    };
  } catch {
    return null;
  }
}

/**
 * Mark ALL of a team's cached arcs STALE, so the next Learning view serves the stale-but-real prior and
 * fires the SWR recompute (with the now-corrected `items.member_id`). Used after a re-attribution so arcs
 * reflect the change immediately instead of waiting out the 4h TTL. See docs/design/attribution-propagation.md.
 *
 * Stale = `computed_at` set to JUST PAST the TTL (TTL + 1-min grace), NEVER epoch: `getArcs` then treats
 * it stale (SWR fires), but `commitArcs`'s empty-clobber guard still sees a "recent" prior (TTL+1min ≪
 * `EMPTY_CLOBBER_MAX_AGE_MS` 48h), so if that recompute hiccups and returns [] the real arcs are KEPT, not
 * blanked. Epoch would trip "prior too old → accept empty" and re-create the 2026-07 blank-panel bug.
 * Best-effort — a failed stale-mark must never fail the caller.
 */
export async function staleArcCache(db: DbClient, teamId: string): Promise<void> {
  try {
    // > the TTL (so getArcs sees it stale), ≪ the 48h clobber cap. Tied to ARC_CACHE_TTL_MS so a TTL
    // change can't silently break the re-attribution→refresh guarantee. (Keep the clobber cap ≫ the TTL.)
    const staleAt = new Date(Date.now() - (ARC_CACHE_TTL_MS + 60_000)).toISOString();
    await db.from("arc_cache").update({ computed_at: staleAt }).eq("team_id", teamId);
  } catch {
    // best-effort — arcs still refresh on their normal TTL if this fails
  }
}

/**
 * HARD-DELETE one team+group_key row. Used only when the cached arcs are not merely stale but no longer
 * ALLOWED to be served: an item narrowed external→team leaves LLM prose synthesized from it sitting in
 * the external-tier row, and `staleArcCache` is not enough there — `getArcs` is serve-stale-while-
 * revalidate, so a stale row is still handed to the next external viewer (and every one after, until the
 * background recompute lands). Deleting forces a miss.
 *
 * The cost is deliberate: with no prior row, `commitArcs`'s empty-clobber guard has nothing to protect,
 * so a recompute that comes back empty is accepted and the external panel is blank until synthesis
 * recovers. Tier isolation outranks panel continuity — a blank panel is a UX regression, serving
 * retracted content is a leak with no DB backstop (CLAUDE.md §5).
 */
export async function purgeArcCacheKey(db: DbClient, teamId: string, groupKey: string): Promise<void> {
  try {
    await db.from("arc_cache").delete().eq("team_id", teamId).eq("group_key", groupKey);
  } catch {
    // best-effort — but see the caller: the purge failing is why the stale-mark runs as a backstop
  }
}

/** Upsert the cached arcs for one team+group_key, stamping `computed_at` now. Best-effort — a failed
 *  cache write must never fail synthesis (the arcs are still returned to the caller). */
export async function writeArcCache(
  db: DbClient,
  teamId: string,
  groupKey: string,
  arcs: NarrativeArc[],
  factsHash: string | null,
  /**
   * `degraded: true` for a result we don't trust enough to serve for a full window but still want
   * persisted — a synthesis that produced nothing although facts existed (the model failed), or one whose
   * inputs were degraded. It shortens the row's life via `arcTtlMs`, so the next view retries within
   * minutes instead of hours: SWR only re-fires on a stale row, so "fresh and wrong" is the one state
   * that can't self-heal (the H12 incident).
   *
   * This used to be done by BACKDATING `computed_at` by `TTL - retryAfterMs`, because there was nowhere
   * to record the fact. Same retry behaviour, but the timestamp lied by ~4 hours — and the flag lived
   * only for the request that discovered it, so the next reader of the row saw a healthy payload. Now the
   * timestamp is always the honest write time and the trust verdict is its own column (R2/M6).
   *
   * `computed_at` stays close to now, so the row remains far inside `EMPTY_CLOBBER_MAX_AGE_MS` and the
   * next attempt still treats it as recent transient-failure cover rather than "persistently empty".
   */
  opts: { degraded?: boolean } = {}
): Promise<void> {
  try {
    // `arcs` is a top-level JSON array. The pg adapter only auto-casts non-array objects to jsonb, so
    // serialize it ourselves — a string param binds as text and Postgres assignment-casts it into the
    // jsonb column (a raw JS array would otherwise be bound as a Postgres array literal → json error).
    await db.from("arc_cache").upsert(
      {
        team_id: teamId,
        group_key: groupKey,
        arcs: JSON.stringify(arcs),
        facts_hash: factsHash,
        computed_at: new Date().toISOString(),
        degraded: opts.degraded === true,
      },
      { onConflict: "team_id,group_key" }
    );
  } catch {
    // best-effort — synthesis result is still returned even if we couldn't persist it
  }
}
