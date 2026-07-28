import "server-only";
import { adminClient } from "@/lib/db/admin";
import type { DbClient } from "@/lib/db/types";
import type { ViewerTier } from "@/lib/auth/visibility";
import { getWorkTimeline } from "./work-timeline";
import { attachPersonDaySummaries, type SummaryPassResult } from "./timeline-summary";
import type { TimelineDay } from "./timeline-group";
import { freshness, type Freshness } from "@/lib/freshness";

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
/** The same TTL, exported: it's the threshold that decides `freshness.stale`, so a consumer reasoning
 *  about staleness must be able to read the number rather than re-declare it (H6's drift shape). */
export const TIMELINE_TTL_MS = TTL_MS;
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
// v8: `PersonDay.other[]` is REPLACED by `unlinked: number` — unlinked evidence is omitted, `total`
// counts only rendered work, and a person-day with nothing left is dropped. A v7 row therefore carries
// a shape this build does not render AND person-days it would have dropped, so the card shows a name
// with an empty body under it — the exact thing the omission was meant to prevent.
//
// v9: `other[]` is BACK (rendered below the tasks) after v8 omitted it. v8 was correct in principle and
// a deploy too early in practice — linking was at 9/220 items, so it hid ~96% of the team's week. A v8
// row would keep serving that hidden state, so it must read as a miss.
//
// v10: `TaskGroup.assignee` (`{ name, avatarUrl }`) — a task that belongs to SOMEONE ELSE now says so on
// the card. A v9 row has no such field, so a teammate's ticket would keep rendering as if it were yours.
//
// The v8 bump was MISSED once and it is worth saying why: the change was authored on v6→v7, then rebased
// onto a branch that had already taken 7 for its own shape change, so two incompatible payloads shipped
// under one version and prod served a stale row as a HIT. When rebasing, re-check that the version you
// bumped TO is still unclaimed on the new base.
//
// v10 also found the hole in the guard built for that miss: it pinned only `PersonDay`'s own keys, so a
// change one level down (`TaskGroup`) passed it untouched. `test/guards/timeline-payload-shape.test.ts`
// now pins EVERY node in the tree — a nested field can strand a stale row just as badly as a top-level one.
export const PAYLOAD_VERSION = 10;

/** The timeline WITH the per-person-day synopsis attached. Runs the (up to 7d × roster) best-effort LLM
 *  calls — so it's used ONLY on the BACKGROUND refresh path, never inline on a request (a cold miss
 *  returns the pure ledger fast and schedules this). Never in the raw builder the data-mechanics tier calls. */
async function buildTimeline(db: DbClient, teamId: string, tier: ViewerTier): Promise<SummaryPassResult> {
  // Refresh the INFERRED doc→task links first, so anything new lands in the payload we're about to write
  // rather than one cycle later. This is the VIEW-DRIVEN trigger: a rebuild happens because somebody
  // looked, which is exactly when an inference is worth paying for — an unread team's timeline shouldn't
  // spend anything. The pass enforces its OWN cooldown against the last recorded run (shared with the
  // scheduler's clock, so the two triggers can't double-charge) and is a cheap indexed no-op otherwise.
  //
  // Deliberately only on this BACKGROUND path — never the cold-miss request path, whose whole job is to
  // return the pure ledger fast. Imported lazily so the LLM pass isn't pulled into modules that only read
  // the cache, and fully swallowed: a rebuild must never fail because an inference did.
  try {
    const { runDocTaskInference } = await import("./doc-task-infer-run");
    await runDocTaskInference(db, teamId);
  } catch (err) {
    console.warn("[timeline] doc-task inference skipped:", err instanceof Error ? err.message : err);
  }
  return attachPersonDaySummaries(db, teamId, await getWorkTimeline(db, teamId, tier));
}


/**
 * How old a payload may be and still lend its synopsis across a version bump.
 *
 * A salvaged sentence is only defensible as a BRIDGE to the next background refresh — it was written
 * about a day's work as it stood then. Two days is long enough to cover a bump plus a quiet weekend,
 * short enough that nobody reads a stale description of an active day.
 *
 * HONEST LIMIT: this measures age since the row was last PERSISTED, not since the sentence was
 * authored — a cold miss re-stamps `computed_at`, so carrying a summary resets its clock. It is not an
 * absolute shelf life. What actually bounds it is `attachPersonDaySummaries`, which rebuilds every
 * person-day's summary from scratch and never preserves an existing one: any completed background pass
 * either replaces the sentence or drops it. Riding past 48h would need every cycle's deploy to kill the
 * in-flight LLM fan-out, repeatedly. Bounded in practice, not by this constant.
 */
const SALVAGE_MAX_AGE_MS = 48 * 3_600_000;

/** `${date}|${memberId}` → that person-day's synopsis. */
export type SalvagedSummaries = Map<string, string>;

const salvageKey = (date: string, memberId: string): string => `${date}|${memberId}`;

/**
 * Pull the per-person-day summaries out of a cache payload of ANY version.
 *
 * Why this ignores `PAYLOAD_VERSION` when everything else treats a mismatch as a miss: the version
 * guards the SHAPE the panel renders, and rendering a stale shape is what strands a wrong card. A
 * `summary` is not shape — it is a sentence about what a person did on a day, and a field moving
 * elsewhere in the tree doesn't make that sentence untrue. Dropping it is what makes the synopsis
 * vanish for everyone on every bump.
 */
export function salvageSummaries(payload: unknown, computedAtMs: number, nowMs: number): SalvagedSummaries {
  const out: SalvagedSummaries = new Map();
  if (!Number.isFinite(computedAtMs) || nowMs - computedAtMs > SALVAGE_MAX_AGE_MS) return out;
  const days = (payload as { days?: unknown } | null)?.days;
  if (!Array.isArray(days)) return out;
  for (const d of days as { date?: unknown; people?: unknown }[]) {
    if (typeof d?.date !== "string" || !Array.isArray(d.people)) continue;
    for (const p of d.people as { memberId?: unknown; summary?: unknown }[]) {
      // Keyed on the PERSON and the DAY together. Keying on either alone would smear one person's
      // sentence across the team, or one day's across the week — a confidently wrong synopsis is
      // worse than none, which is the whole reason this is a bridge and not a cache.
      if (typeof p?.memberId === "string" && typeof p.summary === "string" && p.summary)
        out.set(salvageKey(d.date, p.memberId), p.summary);
    }
  }
  return out;
}

/**
 * Re-attach salvaged summaries to freshly built days. Immutable — returns new objects.
 *
 * NEVER overwrites: a day the builder already summarised keeps its own. Only the gap left by the
 * cold-miss path (which skips the LLM by design) gets filled.
 */
export function attachSalvagedSummaries(days: TimelineDay[], salvaged: SalvagedSummaries): TimelineDay[] {
  if (!salvaged.size) return days;
  return days.map((d) => ({
    ...d,
    people: d.people.map((p) => {
      if (p.summary) return p;
      // Read ONCE into a local. A conditional spread that calls `.get` twice is correct and is exactly
      // the line a later edit turns into `summary: undefined` — which would ADD the key to the payload
      // and put it out of step with the shape the version pins.
      const carried = salvaged.get(salvageKey(d.date, p.memberId));
      return carried ? { ...p, summary: carried } : p;
    }),
  }));
}

interface CacheEntry {
  days: TimelineDay[];
  at: number; // epoch ms computed
  /** The synopsis pass didn't produce prose for this ledger. Carried in memory as well as in Postgres:
   *  this map is read BEFORE the row, so omitting it would report a partial payload as healthy for the
   *  life of the process (R2/M6). */
  degraded: boolean;
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

/** The raw persisted row, version and all. Two readers want it for different questions: the ledger
 *  read below (which rejects a foreign version) and the synopsis salvage (which doesn't care). */
async function readTimelineCacheRow(
  db: DbClient,
  teamId: string,
  tier: ViewerTier
): Promise<{ payload: unknown; computed_at: string | Date; degraded?: boolean | null } | null> {
  const { data } = await db
    .from("work_timeline_cache")
    .select("payload, computed_at, degraded")
    .eq("team_id", teamId)
    .eq("group_key", tier)
    .maybeSingle();
  return (data as { payload: unknown; computed_at: string | Date; degraded?: boolean | null } | null) ?? null;
}

/** The previous payload's per-person-day summaries, whatever version wrote them. Empty on any error —
 *  a missing synopsis is a cosmetic loss and must never fail the panel. */
async function readSalvageableSummaries(
  db: DbClient,
  teamId: string,
  tier: ViewerTier
): Promise<SalvagedSummaries> {
  try {
    const row = await readTimelineCacheRow(db, teamId, tier);
    if (!row) return new Map();
    const at =
      typeof row.computed_at === "string" ? Date.parse(row.computed_at) : new Date(row.computed_at).getTime();
    return salvageSummaries(row.payload, at, Date.now());
  } catch {
    return new Map();
  }
}

/** Read the cached ledger for one team+tier. Null on miss/any error (best-effort — a cache read must
 *  never fail the panel; the caller builds inline). */
export async function readTimelineCache(
  db: DbClient,
  teamId: string,
  tier: ViewerTier
): Promise<CacheEntry | null> {
  try {
    const row = await readTimelineCacheRow(db, teamId, tier);
    if (!row) return null;
    // Payload is `{ v, days }`. A missing/older version = a shape from a previous deploy → treat as a
    // MISS so the caller rebuilds (never render a stale wrong shape).
    const p = row.payload as { v?: number; days?: unknown } | null;
    if (!p || p.v !== PAYLOAD_VERSION || !Array.isArray(p.days)) return null;
    const days = p.days as TimelineDay[];
    const at =
      typeof row.computed_at === "string" ? Date.parse(row.computed_at) : new Date(row.computed_at).getTime();
    // `=== true` so a row written before the column existed reads false — "no evidence of degradation",
    // not "verified good". Defaulting the other way would mark every pre-migration team's ledger bad.
    return { days, at: Number.isFinite(at) ? at : 0, degraded: row.degraded === true };
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
  days: TimelineDay[],
  /** The per-person-day synopses are missing or carried over, so the prose wasn't computed for this
   *  ledger. Persisted (R2/M6) so the NEXT reader of this row inherits the verdict instead of being
   *  handed a partial payload as healthy. Defaults false — the callers that know pass it explicitly. */
  degraded = false
): Promise<void> {
  try {
    // `payload` is a top-level JSON array — serialize it ourselves (the pg adapter binds a raw JS array
    // as a Postgres array literal, which the jsonb column rejects); a text param assignment-casts to jsonb.
    await db.from("work_timeline_cache").upsert(
      {
        team_id: teamId,
        group_key: tier,
        payload: JSON.stringify({ v: PAYLOAD_VERSION, days }),
        computed_at: new Date().toISOString(),
        degraded,
      },
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
 *
 * The DELETE is what closes it, and that matters more since `salvageSummaries`: if this delete fails
 * (swallowed below) the surviving row's summaries are no longer merely served for one TTL — a later
 * version bump can carry those sentences into the fresh payload and re-stamp them, so the caller's
 * stale-mark no longer bounds them. Salvage is same-tier, so this is a compound failure (a failed
 * delete AND a bump) rather than a new path, and the immediate background refresh overwrites it — but
 * "one TTL" is no longer the true bound, and the comment below used to claim it was.
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
    // best-effort — the caller's stale-mark backstop bounds a SERVED stale payload to one TTL (see the
    // header for why that is no longer the whole story for the summaries)
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
        const built = await buildTimeline(bg, teamId, tier);
        mem.set(key, { days: built.days, at: Date.now(), degraded: built.degraded });
        await writeTimelineCache(bg, teamId, tier, built.days, built.degraded);
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
 * The ledger plus how much it can be trusted (R2/M6). The envelope sits BESIDE `days`, not around it, so
 * `TimelineDay[]` — and the shape guard that pins it — are untouched.
 */
export interface CachedTimeline {
  days: TimelineDay[];
  freshness: Freshness;
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
): Promise<CachedTimeline> {
  const key = memKey(teamId, tier);
  const now = Date.now();

  const cached = mem.get(key);
  if (cached && now - cached.at < TTL_MS) {
    return { days: cached.days, freshness: freshness(cached.at, TTL_MS, { now, degraded: cached.degraded }) };
  }

  const persisted = await readTimelineCache(db, teamId, tier);
  if (persisted) {
    mem.set(key, { days: persisted.days, at: persisted.at, degraded: persisted.degraded });
    // ONE envelope for both the fresh and the stale branch — `freshness()` derives `stale` from the same
    // age comparison the branch below makes, so the reported staleness cannot disagree with the decision
    // actually taken (they were two separate readings of the clock in every earlier draft of this).
    // The PERSISTED verdict — so a reader who didn't do the work still learns the prose is missing.
    const f = freshness(persisted.at, TTL_MS, { now, degraded: persisted.degraded });
    if (!f.stale) return { days: persisted.days, freshness: f };
    refreshInBackground(teamId, tier); // stale → serve stale, rebuild behind the request
    return { days: persisted.days, freshness: f };
  }

  // Cold miss — return the PURE ledger FAST (no inline LLM), persist it so there's always a row, then
  // add the per-person-day synopsis in the background. The first viewer sees the timeline immediately;
  // summaries appear on the next view once the background pass writes them (kept off the request path so
  // a big team's fan-out can't blow the page / route budget).
  const built = await getWorkTimeline(db, teamId, tier);
  // …but a cold miss is USUALLY A VERSION BUMP, not a genuinely empty cache — and that path was
  // silently deleting the synopsis from every person-day until a background pass finished. Twice the
  // user's report was "we've lost the summaries at the top of each person's day", both times right
  // after a deploy of mine. The previous row's sentences still describe those same person-days, so
  // carry them across as a bridge; the background pass overwrites them with freshly computed ones.
  // Best-effort by construction: no salvageable row → `built`, unchanged.
  const days = attachSalvagedSummaries(built, await readSalvageableSummaries(db, teamId, tier));
  const at = Date.now();
  mem.set(key, { days, at, degraded: true });
  // PERSISTED as degraded, not just reported. The row this writes is what the next reader gets, and its
  // prose is either absent or salvaged from an older payload version — so the flag has to live on the row
  // or the very next request hands the same partial ledger over as healthy. Self-healing: the background
  // pass below rewrites the row with the real verdict once summaries land.
  await writeTimelineCache(db, teamId, tier, days, true);
  refreshInBackground(teamId, tier);
  // DEGRADED, deliberately. A cold miss returns the pure ledger: its per-person-day synopses are either
  // absent (the background pass hasn't run) or SALVAGED from an older payload version. Both are "this is
  // real work data with prose that wasn't computed for it", which is precisely the plausible-but-partial
  // state R2 exists to name. Freshly computed, so `stale` is false — the two flags are independent, and
  // this is the case that proves it: newest possible payload, least trustworthy prose.
  return { days, freshness: freshness(at, TTL_MS, { now: at, degraded: true }) };
}
