import "server-only";
import { adminClient } from "@/lib/db/admin";
import type { DbClient } from "@/lib/db/types";
import type { ViewerTier } from "@/lib/auth/visibility";
import { getWorkTimeline } from "./work-timeline";
import type { TimelineDay } from "./timeline-group";

/**
 * The persisted, queryable work-timeline LAYER. `lib/dashboard/work-timeline.getWorkTimeline` is the
 * (expensive-ish) builder — it fetches `items` + `tasks`, attributes, and groups. This file caches its
 * output in Postgres `work_timeline_cache` so every surface — the dashboard panel, the CLI + machines
 * (`GET /api/v1/timeline`), and (later) the LLM retrieval path — reads the SAME assembled ledger
 * instead of each recomputing it. Sole writer of `work_timeline_cache`.
 *
 * Serve-stale-while-revalidate (mirrors lib/graph/arc-cache): fresh → return; stale → return stale NOW
 * + refresh behind the request; cold miss → build inline. Deliberately NO 48h empty-clobber guard
 * (unlike arcs): the timeline is a FACTUAL ledger built from Postgres (no flaky LLM), so an empty
 * result is the truth of a quiet week — pinning last week's work would be misleading. A stale row is
 * still served for one cycle, but an empty rebuild is accepted.
 *
 * `group_key` = the viewer TIER ('team' | 'external'); the (team_id, group_key) PK already scopes by
 * team, so the tier alone separates a team viewer's (team+external) ledger from an external viewer's
 * (external-only). No cross-tier bleed, no RLS backstop (CLAUDE.md §5) — the builder's `visibleItems`/
 * `visibleTasks` do the row-level filtering; this key just keeps the two tiers' payloads in separate rows.
 */

const TTL_MS = 5 * 60_000; // 5-min freshness; the ledger is cheap, so refresh often.
// Bump when the TimelineDay[] SHAPE changes (e.g. PR-D's task→evidence nesting): a cached row from an
// older deploy is then treated as a cache MISS (rebuilt), so the panel never renders a stale wrong shape.
const PAYLOAD_VERSION = 2;

interface CacheEntry {
  days: TimelineDay[];
  at: number; // epoch ms computed
}

// In-memory cache (per process), fronting the Postgres row. Keyed by `${teamId}:${tier}`.
const mem = new Map<string, CacheEntry>();
// Keys refreshing in the background, so N concurrent stale reads fire ONE rebuild.
const refreshing = new Set<string>();

const memKey = (teamId: string, tier: ViewerTier): string => `${teamId}:${tier}`;

/** Read the cached ledger for one team+tier. Null on miss/any error (best-effort — a cache read must
 *  never fail the panel; the caller builds inline). */
export async function readTimelineCache(
  db: DbClient,
  teamId: string,
  tier: ViewerTier
): Promise<CacheEntry | null> {
  try {
    const { data } = await db
      .from("work_timeline_cache")
      .select("payload, computed_at")
      .eq("team_id", teamId)
      .eq("group_key", tier)
      .maybeSingle();
    if (!data) return null;
    const row = data as { payload: unknown; computed_at: string | Date };
    // Payload is `{ v, days }`. A missing/older version = a shape from a previous deploy → treat as a
    // MISS so the caller rebuilds (never render a stale wrong shape).
    const p = row.payload as { v?: number; days?: unknown } | null;
    if (!p || p.v !== PAYLOAD_VERSION || !Array.isArray(p.days)) return null;
    const days = p.days as TimelineDay[];
    const at =
      typeof row.computed_at === "string" ? Date.parse(row.computed_at) : new Date(row.computed_at).getTime();
    return { days, at: Number.isFinite(at) ? at : 0 };
  } catch {
    return null;
  }
}

/** Upsert the ledger for one team+tier, stamping `computed_at` now. Best-effort — a failed write must
 *  never fail the build (the days are still returned). */
export async function writeTimelineCache(
  db: DbClient,
  teamId: string,
  tier: ViewerTier,
  days: TimelineDay[]
): Promise<void> {
  try {
    // `payload` is a top-level JSON array — serialize it ourselves (the pg adapter binds a raw JS array
    // as a Postgres array literal, which the jsonb column rejects); a text param assignment-casts to jsonb.
    await db.from("work_timeline_cache").upsert(
      { team_id: teamId, group_key: tier, payload: JSON.stringify({ v: PAYLOAD_VERSION, days }), computed_at: new Date().toISOString() },
      { onConflict: "team_id,group_key" }
    );
  } catch {
    // best-effort — the ledger is still returned even if we couldn't persist it
  }
}

/**
 * Mark ALL of a team's cached timelines STALE (both tiers) + evict this process's in-memory copy, so
 * the next view serves the stale-but-real ledger and rebuilds behind the request. Called after a
 * re-attribution (which changes who owns items → the timeline changes) alongside the arc bust. Stale =
 * `computed_at` just past the TTL (never epoch — same rationale as staleArcCache, though this layer has
 * no empty-clobber cap). Best-effort.
 */
export async function bustTeamTimeline(db: DbClient, teamId: string): Promise<void> {
  for (const tier of ["team", "external"] as const) mem.delete(memKey(teamId, tier));
  try {
    const staleAt = new Date(Date.now() - TTL_MS - 60_000).toISOString();
    await db.from("work_timeline_cache").update({ computed_at: staleAt }).eq("team_id", teamId);
  } catch {
    // best-effort — the ledger still refreshes on its normal TTL if this fails
  }
}

/** Fire-and-forget background rebuild for a stale key (SWR). Uses its own adminClient (not request-
 *  bound). Deduped via `refreshing`; errors logged, never thrown. */
function refreshInBackground(teamId: string, tier: ViewerTier): void {
  const key = memKey(teamId, tier);
  if (refreshing.has(key)) return;
  refreshing.add(key);
  void (async () => {
    const bg = adminClient();
    try {
      const days = await getWorkTimeline(bg, teamId, tier);
      mem.set(key, { days, at: Date.now() });
      await writeTimelineCache(bg, teamId, tier, days);
    } catch (err) {
      console.error("[timeline] background refresh failed:", err instanceof Error ? err.message : err);
    } finally {
      refreshing.delete(key);
    }
  })();
}

/**
 * Return the work-timeline for a team+tier, serve-stale-while-revalidate:
 *   1. fresh in-memory → return instantly;
 *   2. Postgres `work_timeline_cache` — fresh → return; stale → return stale NOW + rebuild behind the request;
 *   3. cold miss → build inline, then persist.
 * The one reader every surface calls (panel, `/api/v1/timeline`). Tier isolation is enforced inside the
 * builder's `visibleItems`/`visibleTasks`, so this is safe with `adminClient`.
 */
export async function getCachedWorkTimeline(
  db: DbClient,
  teamId: string,
  tier: ViewerTier
): Promise<TimelineDay[]> {
  const key = memKey(teamId, tier);
  const now = Date.now();

  const cached = mem.get(key);
  if (cached && now - cached.at < TTL_MS) return cached.days;

  const persisted = await readTimelineCache(db, teamId, tier);
  if (persisted) {
    mem.set(key, { days: persisted.days, at: persisted.at });
    if (now - persisted.at < TTL_MS) return persisted.days;
    refreshInBackground(teamId, tier); // stale → serve stale, rebuild behind the request
    return persisted.days;
  }

  // Cold miss — build inline so the first viewer gets a real answer, then persist.
  const days = await getWorkTimeline(db, teamId, tier);
  mem.set(key, { days, at: Date.now() });
  await writeTimelineCache(db, teamId, tier, days);
  return days;
}
