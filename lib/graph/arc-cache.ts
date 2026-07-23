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

export interface ArcCacheEntry {
  arcs: NarrativeArc[];
  /** epoch ms of when this cache row was computed (for TTL/staleness checks in `arcs.ts`). */
  computedAt: number;
  /** Hash of the LLM synthesis input at that compute — the fact-set-hash skip compares against it. */
  factsHash: string | null;
}

/** Read the cached arcs for one team+group_key. Null on miss or any error (best-effort — a cache
 *  read must never fail the Learning page; the caller falls back to computing). */
export async function readArcCache(db: DbClient, teamId: string, groupKey: string): Promise<ArcCacheEntry | null> {
  try {
    const { data } = await db
      .from("arc_cache")
      .select("arcs, computed_at, facts_hash")
      .eq("team_id", teamId)
      .eq("group_key", groupKey)
      .maybeSingle();
    if (!data) return null;
    const row = data as { arcs: unknown; computed_at: string | Date; facts_hash: string | null };
    const arcs = Array.isArray(row.arcs) ? (row.arcs as NarrativeArc[]) : [];
    const computedAt =
      typeof row.computed_at === "string" ? Date.parse(row.computed_at) : new Date(row.computed_at).getTime();
    return { arcs, computedAt: Number.isFinite(computedAt) ? computedAt : 0, factsHash: row.facts_hash ?? null };
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

/** Upsert the cached arcs for one team+group_key, stamping `computed_at` now. Best-effort — a failed
 *  cache write must never fail synthesis (the arcs are still returned to the caller). */
export async function writeArcCache(
  db: DbClient,
  teamId: string,
  groupKey: string,
  arcs: NarrativeArc[],
  factsHash: string | null
): Promise<void> {
  try {
    // `arcs` is a top-level JSON array. The pg adapter only auto-casts non-array objects to jsonb, so
    // serialize it ourselves — a string param binds as text and Postgres assignment-casts it into the
    // jsonb column (a raw JS array would otherwise be bound as a Postgres array literal → json error).
    await db.from("arc_cache").upsert(
      { team_id: teamId, group_key: groupKey, arcs: JSON.stringify(arcs), facts_hash: factsHash, computed_at: new Date().toISOString() },
      { onConflict: "team_id,group_key" }
    );
  } catch {
    // best-effort — synthesis result is still returned even if we couldn't persist it
  }
}
