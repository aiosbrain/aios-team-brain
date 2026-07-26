import "server-only";
import { adminClient } from "@/lib/db/admin";
import type { DbClient } from "@/lib/db/types";
import type { ViewerTier } from "@/lib/auth/visibility";
import { getWorkTimeline } from "./work-timeline";
import { attachPersonDaySummaries } from "./timeline-summary";
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
// Bump when the TimelineDay[] SHAPE changes: a cached row from an older deploy is then treated as a
// cache MISS (rebuilt), so the panel never renders a stale wrong shape. `summary` was ADDITIVE + optional
// (no bump — a v3 row renders fine). v4 adds a REQUIRED `PersonDay.signals[]` (the Context lane): an old
// row lacking it would TypeError the card's `.map`, and it's part of the stable `GET /api/v1/timeline`
// shape, so it MUST bump — the cold rebuild is the cheap pure builder (no inline LLM).
// v5: commits inherit their PR's task (work_events), so a cached v4 ledger would serve link-less rows for
// a full TTL after deploy — bump so it rebuilds with the new links.
// v6: a referenced task now heads its own group whatever its status. The SHAPE is unchanged, but the
// MEANING is: a v5 row would keep serving the old "Other · not linked to a task" grouping (with its
// self-contradicting chips) for a full TTL after deploy. Same rule as v5 — bump on a meaning change.
// v7: evidence can now be linked by the LLM doc→task pass (`linkVia:"inferred"`). A v6 row would keep
// serving those docs in "Other" for a full TTL after deploy — same meaning-change rule as v5/v6.
export const PAYLOAD_VERSION = 7;

/** The timeline WITH the per-person-day synopsis attached. Runs the (up to 7d × roster) best-effort LLM
 *  calls — so it's used ONLY on the BACKGROUND refresh path, never inline on a request (a cold miss
 *  returns the pure ledger fast and schedules this). Never in the raw builder the data-mechanics tier calls. */
async function buildTimeline(db: DbClient, teamId: string, tier: ViewerTier): Promise<TimelineDay[]> {
  return attachPersonDaySummaries(db, teamId, await getWorkTimeline(db, teamId, tier));
}

interface CacheEntry {
  days: TimelineDay[];
  at: number; // epoch ms computed
}

// In-memory cache (per process), fronting the Postgres row. Keyed by `${teamId}:${tier}`.
const mem = new Map<string, CacheEntry>();
// Keys refreshing in the background, so N concurrent stale reads fire ONE rebuild. The PROMISE is
// retained (not just the key) so an in-flight rebuild can be awaited — see `settleTimelineRefreshes`.
const refreshing = new Map<string, Promise<void>>();
// Keys whose inputs changed WHILE a rebuild was in flight — that rebuild's result is already stale, so
// one more pass runs when it finishes (trailing edge). Without this a mid-rebuild bust is lost.
const dirty = new Set<string>();

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
  for (const tier of ["team", "external"] as const) {
    const key = memKey(teamId, tier);
    mem.delete(key);
    // Invalidate an ALREADY-RUNNING rebuild too. It read its inputs before this bust, so its result is
    // wrong the moment it lands — and it lands stamped `computed_at = now`, which would make the stale
    // payload look FRESH and suppress the next read's refresh entirely (the re-attribution would then be
    // invisible for a full TTL). Marking dirty makes the in-flight pass run once more with the new data.
    if (refreshing.has(key)) dirty.add(key);
  }
  try {
    const staleAt = new Date(Date.now() - TTL_MS - 60_000).toISOString();
    await db.from("work_timeline_cache").update({ computed_at: staleAt }).eq("team_id", teamId);
  } catch {
    // best-effort — the ledger still refreshes on its normal TTL if this fails
  }
}

/**
 * HARD-DELETE one team+tier row (and this process's in-memory copy). The counterpart to
 * `bustTeamTimeline`, for when the cached ledger is not merely stale but no longer ALLOWED to be
 * served: it holds item/task TITLES and the LLM per-person-day summaries built from the tier-filtered
 * set at compute time, so after an item is narrowed external→team the external row still names it.
 * A stale-mark won't do — the read path serves the stale ledger first and rebuilds behind it.
 */
export async function purgeTimelineCacheTier(
  db: DbClient,
  teamId: string,
  tier: ViewerTier
): Promise<void> {
  mem.delete(memKey(teamId, tier));
  try {
    await db.from("work_timeline_cache").delete().eq("team_id", teamId).eq("group_key", tier);
  } catch {
    // best-effort — the caller's stale-mark backstop still bounds the exposure to one TTL
  }
}

/** Fire-and-forget background rebuild for a stale key (SWR). Uses its own adminClient (not request-
 *  bound). Deduped via `refreshing`; errors logged, never thrown. */
function refreshInBackground(teamId: string, tier: ViewerTier): void {
  const key = memKey(teamId, tier);
  // TRAILING EDGE, not plain dedup. A request arriving DURING a rebuild must not be dropped: the running
  // pass already read its inputs, so it cannot contain whatever just changed — yet it finishes by writing
  // `computed_at = now`, marking that stale-by-then payload FRESH for a full TTL. That silently discarded
  // a `bustTeamTimeline` (i.e. a re-attribution) landing mid-rebuild. So mark the key dirty and re-run
  // once when the in-flight pass finishes. Mirrors the running/dirty coalescer in
  // `lib/ingest/reconcile-attribution.ts`. N concurrent stale reads still collapse to <=2 rebuilds.
  // The retained promise spans the WHOLE loop, so `settleTimelineRefreshes` awaits the trailing re-run too.
  if (refreshing.has(key)) {
    dirty.add(key);
    return;
  }
  const task = (async () => {
    // EVERYTHING inside the try, including client construction: the promise must not settle before
    // `refreshing.set(key, task)` below runs. A synchronous throw here would settle it immediately,
    // stranding a settled promise in the map — which would suppress that key's rebuilds for the life
    // of the process and make `settleTimelineRefreshes` reject. Cheap to make structurally impossible.
    try {
      const bg = adminClient();
      do {
        dirty.delete(key); // claim the current request; anything arriving from here re-dirties the key
        const days = await buildTimeline(bg, teamId, tier);
        mem.set(key, { days, at: Date.now() });
        await writeTimelineCache(bg, teamId, tier, days);
      } while (dirty.has(key));
    } catch (err) {
      console.error("[timeline] background refresh failed:", err instanceof Error ? err.message : err);
    } finally {
      dirty.delete(key);
      refreshing.delete(key);
    }
  })();
  refreshing.set(key, task);
}

/**
 * Await every in-flight background rebuild. Callers of `getCachedWorkTimeline` never need this — the
 * whole point of SWR is that they don't wait — but a test asserting the REBUILT payload otherwise has
 * to poll on a timeout, which is a race dressed up as a test (it failed ~1 in 3 on a loaded runner,
 * costing real CI cycles). Awaiting the actual promise makes that deterministic. Also the honest hook
 * for a graceful shutdown that wants in-flight writes to land. Never throws: the task swallows its own
 * errors, so this resolves even when a rebuild failed.
 */
export async function settleTimelineRefreshes(): Promise<void> {
  await Promise.all([...refreshing.values()]);
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

  // Cold miss — return the PURE ledger FAST (no inline LLM), persist it so there's always a row, then
  // add the per-person-day synopsis in the background. The first viewer sees the timeline immediately;
  // summaries appear on the next view once the background pass writes them (kept off the request path so
  // a big team's fan-out can't blow the page / route budget).
  const days = await getWorkTimeline(db, teamId, tier);
  mem.set(key, { days, at: Date.now() });
  await writeTimelineCache(db, teamId, tier, days);
  refreshInBackground(teamId, tier);
  return days;
}
