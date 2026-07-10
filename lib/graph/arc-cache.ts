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

export interface ArcCacheEntry {
  arcs: NarrativeArc[];
  /** epoch ms of when this cache row was computed (for TTL/staleness checks in `arcs.ts`). */
  computedAt: number;
}

/** Read the cached arcs for one team+group_key. Null on miss or any error (best-effort — a cache
 *  read must never fail the Learning page; the caller falls back to computing). */
export async function readArcCache(db: DbClient, teamId: string, groupKey: string): Promise<ArcCacheEntry | null> {
  try {
    const { data } = await db
      .from("arc_cache")
      .select("arcs, computed_at")
      .eq("team_id", teamId)
      .eq("group_key", groupKey)
      .maybeSingle();
    if (!data) return null;
    const row = data as { arcs: unknown; computed_at: string | Date };
    const arcs = Array.isArray(row.arcs) ? (row.arcs as NarrativeArc[]) : [];
    const computedAt =
      typeof row.computed_at === "string" ? Date.parse(row.computed_at) : new Date(row.computed_at).getTime();
    return { arcs, computedAt: Number.isFinite(computedAt) ? computedAt : 0 };
  } catch {
    return null;
  }
}

/** Upsert the cached arcs for one team+group_key, stamping `computed_at` now. Best-effort — a failed
 *  cache write must never fail synthesis (the arcs are still returned to the caller). */
export async function writeArcCache(
  db: DbClient,
  teamId: string,
  groupKey: string,
  arcs: NarrativeArc[]
): Promise<void> {
  try {
    // `arcs` is a top-level JSON array. The pg adapter only auto-casts non-array objects to jsonb, so
    // serialize it ourselves — a string param binds as text and Postgres assignment-casts it into the
    // jsonb column (a raw JS array would otherwise be bound as a Postgres array literal → json error).
    await db.from("arc_cache").upsert(
      { team_id: teamId, group_key: groupKey, arcs: JSON.stringify(arcs), computed_at: new Date().toISOString() },
      { onConflict: "team_id,group_key" }
    );
  } catch {
    // best-effort — synthesis result is still returned even if we couldn't persist it
  }
}
