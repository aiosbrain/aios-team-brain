import "server-only";
import { createHash } from "node:crypto";
import {
  authorizationEpoch,
  lockedAuthorizationEpoch,
  withLockedAuthorizationEpoch,
} from "@/lib/access/authorization-epoch";
import { adminClient } from "@/lib/db/admin";
import { withTransaction } from "@/lib/db/pg/pool";
import type { DbClient } from "@/lib/db/types";
import type { ViewerTier } from "@/lib/auth/visibility";
import { getWorkTimeline } from "./work-timeline";
import { attachPersonDaySummaries, type SummaryPassResult } from "./timeline-summary";
import type { TimelineDay } from "./timeline-group";
import { freshness, type Freshness } from "@/lib/freshness";
import { visibleItemIdsForProjects } from "@/lib/access/enforce";
import { resolveContentAdmission, contentReaderFor, type ContentAdmission, type ContentReader } from "@/lib/access/admission";

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
 * `group_key` was the viewer TIER ('team' | 'external'), then (Phase B slice 4, spec §5.8) a
 * VISIBILITY VARIANT `vis:<tier>:<hash>`, and is now (TIERRET-1) an admission variant — all keyed by
 * the member's sorted effective-project-set hash: members with identical group signatures (and
 * admission class) share one row (bounded cardinality =
 * distinct group combinations, not principal count), and an enforcing read NEVER touches the plain
 * tier row, whose payload (titles + LLM prose) may name work outside the member's visibility. The
 * (team_id, group_key) PK accommodates both without a migration. No cross-tier bleed, no RLS
 * backstop (CLAUDE.md §5) — the builder's membership filters do the row-level filtering; the key
 * keeps each view's payload in its own row.
 *
 * TIERRET-1 — a NEW key namespace, `adm:<class>:<tier>:<hash>` (see `admissionTimelineKey`):
 *   · CLASS is the member-content admission (`me` oracle-accepted Everyone member, `mg` any other
 *     admitted member, `lg` legacy non-principal). Two readers sharing a posture and a project hash
 *     can still differ in payload — a connector's legacy hand-entered rule vs a grantless agent's
 *     closed arm — so the class is part of every key, not inferred from the hash.
 *   · The NAMESPACE is one the pre-TIERRET code never reads: its reader and its same-key salvage both
 *     look up exactly `vis:<tier>:<hash>`. A version bump alone could not give that isolation —
 *     `MIN_SALVAGEABLE_VERSION` is a FLOOR, so old code would salvage a wider v16 summary after a
 *     rollback. New code never writes `vis:` rows and never salvages across namespaces.
 *   · Old code cannot purge `adm:` rows while it runs, so rolling FORWARD after a rollback must first
 *     run `purgeAdmissionTimelineNamespace` (the mandatory roll-forward step in
 *     docs/RELEASE-NOTES-tierret1.md, "Timeline cache — rollback and roll-forward").
 */

/** One cached view: the reader's ADMISSION (class + granted projects + posture). Carries the
 *  CHEAP part only (the admission + hash); the expensive item-id set is resolved only when a build
 *  actually runs (miss/stale), never on a hit — see `buildEnforcement`.
 *
 *  There is deliberately NO separate tier field (TIERRET-1 final review HIGH). The posture that keys
 *  the row and the posture the builder's legacy arm reads are ONE value — `admission.posture`, captured
 *  once by the resolver. A caller's tier was read earlier (auth) and can disagree after a legal
 *  membership write lands in between; letting it pick the key while the admission picked the rows
 *  published one authority's payload under another reader class's key. */
interface TimelineView {
  admission: ContentAdmission;
  /** sha256(sorted granted project ids)[0,16] — the §5.8 visibility hash; ∅ for legacy. */
  visibilityHash: string;
}

/** The three admission classes a timeline payload can differ by (see the header). */
export type TimelineAdmissionClass = "me" | "mg" | "lg";

export function timelineAdmissionClass(a: { kind: string; everyone?: boolean }): TimelineAdmissionClass {
  if (a.kind === "member") return a.everyone === true ? "me" : "mg";
  if (a.kind === "legacy") return "lg";
  throw new Error(`timeline: unknown admission kind ${JSON.stringify(a.kind)} (fail closed)`);
}

/** The NEW namespace prefix — never `vis:` (the pre-TIERRET reader's), never a bare tier. */
export const ADMISSION_NAMESPACE = "adm";

export function admissionTimelineKey(cls: TimelineAdmissionClass, tier: ViewerTier, visibilityHash: string): string {
  return `${ADMISSION_NAMESPACE}:${cls}:${tier}:${visibilityHash}`;
}

function visibilityHashOf(admission: ContentAdmission): string {
  const projects = admission.kind === "member" ? [...admission.grantedProjectIds] : [];
  return createHash("sha256").update(projects.sort().join(",")).digest("hex").slice(0, 16);
}

// The POSTURE (tier) segment stays (PRET-5 L3): the legacy arm's payload still depends on it, and
// keeping it for every class means no two postures ever share a row. It is the RESOLVED admission's
// posture — never a caller-supplied tier (see `TimelineView`).
const viewKey = (v: TimelineView): string =>
  admissionTimelineKey(timelineAdmissionClass(v.admission), v.admission.posture, v.visibilityHash);

/** Resolve the item-id set + reader for a build. Called ONLY on a miss/rebuild — and freshly on
 *  each trailing-edge re-run, so a bust landing mid-rebuild rebuilds with the CURRENT membership set
 *  of the frozen grant set, not a frozen item snapshot (Fable B4 Low). THROWS on a substrate read
 *  error (Codex B4 Medium): an error-derived empty must never be cached as a shared variant. */
async function buildEnforcement(
  db: DbClient,
  teamId: string,
  view: TimelineView
): Promise<{ visibleItemIds: ReadonlySet<string>; reader: ContentReader }> {
  const reader = contentReaderFor(view.admission);
  if (view.admission.kind !== "member") return { visibleItemIds: new Set<string>(), reader };
  const { ids, error } = await visibleItemIdsForProjects(db, teamId, new Set(view.admission.grantedProjectIds));
  if (error) throw new Error("access substrate read failed while resolving timeline enforcement");
  return { visibleItemIds: ids, reader };
}

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
//
// v11: a Slack REPLIER's evidence title is now prefixed "Replied in …" instead of carrying the thread
// root's snippet verbatim (see the authorship note in `lib/dashboard/work-timeline`). SHAPE unchanged,
// MEANING changed — a v10 row keeps rendering a teammate's sentence under the replier's own name, which
// is the misattribution the fix exists to remove. Same meaning-change rule as v5/v6/v7.
// v12: MEETINGS are work. A person now gets an evidence row for every meeting they ATTENDED (from
// `meeting_note_attendees`), not just the one person who pushed the transcript — plus the new optional
// `via` key marking a submitter fallback. Both a shape change (a new key) and a meaning change (a v11
// row keeps serving meeting-less person-days for a full TTL after deploy), so it bumps under either rule.
// v14 (PRET-6): the permissive tier row is retired — every row is a vis-variant and the
// posture walls are gone from the evidence legs; pre-change rows read as misses.
// v13 (PRET-5): the enforcing build's walls went mode-keyed.
// v16 (TIERRET-1): membership is the only member read rule — admitted members now get granted
// meetings and hand-entered rows (meaning change). 15 is RESERVED by the pending Slack-semantics PR
// (#714), so this deliberately skips it: two incompatible payloads must never share a version (the
// v8 lesson below). The version is NOT the isolation mechanism — the `adm:` namespace is (header).
// Integrating #714 later must keep both bumps distinct (take the next unclaimed number) and keep
// its revision/item fingerprints; this change does not touch the Slack leg.
// v18 (AIO-1167): Google evidence now comes from the complete source-time ledger and obeys manual
// credit locks. Old payloads/summaries can name the wrong person or omit capped Drive evidence.
// Authored as v15 and moved on the rebase: 16 is TIERRET-1 above and 17 is the number #714's branch
// now claims for the Slack meaning it had reserved 15 for, so this takes the next unclaimed one.
// Whichever of the two lands second must re-check that its number is still free (the v8 lesson).
export const PAYLOAD_VERSION = 18;

/** The timeline WITH the per-person-day synopsis attached. Runs the (up to 7d × roster) best-effort LLM
 *  calls — so it's used ONLY on the BACKGROUND refresh path, never inline on a request (a cold miss
 *  returns the pure ledger fast and schedules this). Never in the raw builder the data-mechanics tier calls. */
async function buildTimeline(db: DbClient, teamId: string, view: TimelineView): Promise<SummaryPassResult> {
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
  const enforce = await buildEnforcement(db, teamId, view);
  return attachPersonDaySummaries(db, teamId, await getWorkTimeline(db, teamId, view.admission.posture, undefined, enforce));
}

/** The cheap half of a read: the reader's admission + the key it maps to. Throws on any resolution
 *  error — the caller writes nothing (no empty success row from a failed resolution). Takes no tier:
 *  the admission it resolves is the sole posture authority for everything downstream. */
async function resolveView(db: DbClient, teamId: string, memberId: string): Promise<TimelineView> {
  const admission = await resolveContentAdmission(db, teamId, memberId);
  return { admission, visibilityHash: visibilityHashOf(admission) };
}

/** The cache key a member's read maps to right now — for operators and the dm tier (AC-12). `_tier`
 *  is kept for signature compatibility and IGNORED: the key's posture is the resolved admission's. */
export async function timelineViewKey(db: DbClient, teamId: string, _tier: ViewerTier, memberId: string): Promise<string> {
  return viewKey(await resolveView(db, teamId, memberId));
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

/**
 * The OLDEST payload version whose prose may still be carried forward.
 *
 * Age is not the only way a salvaged sentence can be wrong — CONTENT can be, too. Every summary written
 * before v11 was distilled from a prompt in which a Slack replier's evidence carried the thread ROOT
 * author's words (see the authorship note in `lib/dashboard/work-timeline`), so a v10 sentence can state
 * in prose exactly the misattribution v11 exists to remove: "<person> shared two sizzle reels…" about a
 * message someone else wrote. A cold miss is USUALLY a version bump, and that path re-persists whatever
 * it salvages — so without this gate the fix would launder the old claim into the new row and the bound
 * would be "until the next COMPLETED background LLM pass", i.e. unbounded whenever the provider is down
 * or no answering model is configured.
 *
 * This is deliberately a floor, not a blanket "never salvage across a bump": dropping every synopsis on
 * every bump is the regression the salvage was built for (reported twice as "we've lost the summaries").
 * Raise it ONLY for a bump that changes what the prose can claim, not for a shape change.
 *
 * v18 (AIO-1167) is such a bump — older prose can credit Drive work to the wrong person — so the
 * floor follows `PAYLOAD_VERSION` to it (authored as 15; renumbered with the version on the rebase).
 */
export const MIN_SALVAGEABLE_VERSION = 18;

/** `${date}|${memberId}` → that person-day's synopsis. */
export type SalvagedSummaries = Map<string, string>;

const salvageKey = (date: string, memberId: string): string => `${date}|${memberId}`;

/**
 * Pull the per-person-day summaries out of a cache payload of any version AT OR ABOVE
 * `MIN_SALVAGEABLE_VERSION`.
 *
 * Why this mostly ignores `PAYLOAD_VERSION` when everything else treats a mismatch as a miss: the
 * version guards the SHAPE the panel renders, and rendering a stale shape is what strands a wrong card.
 * A `summary` is not shape — it is a sentence about what a person did on a day, and a field moving
 * elsewhere in the tree doesn't make that sentence untrue. Dropping it is what makes the synopsis
 * vanish for everyone on every bump.
 *
 * The ONE exception is a bump that changes what the prose is allowed to CLAIM — see
 * `MIN_SALVAGEABLE_VERSION`. A sentence written about mislabelled inputs is not merely stale, it is
 * wrong, and carrying it forward would re-persist the very claim the bump removed.
 */
export function salvageSummaries(payload: unknown, computedAtMs: number, nowMs: number): SalvagedSummaries {
  const out: SalvagedSummaries = new Map();
  if (!Number.isFinite(computedAtMs) || nowMs - computedAtMs > SALVAGE_MAX_AGE_MS) return out;
  // A payload with no readable `v` predates versioning (or is corrupt) — treat it as too old to trust,
  // the same direction as every other unprovable case in this change.
  // `Number.isFinite`, not `typeof === "number"`: `NaN < 11` is false, so a NaN version would sail
  // through the comparison. Unreachable from a persisted row (jsonb turns NaN into null), but this is an
  // exported pure function and a gate that only holds for the callers you thought of is not a gate.
  const version = (payload as { v?: unknown } | null)?.v;
  if (!Number.isFinite(version as number) || (version as number) < MIN_SALVAGEABLE_VERSION) return out;
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
  authorizationEpoch: number;
}

// In-memory cache (per process), fronting the Postgres row. Keyed by `${teamId}:${viewKey}`.
const mem = new Map<string, CacheEntry>();
// Keys refreshing in the background, so N concurrent stale reads fire ONE rebuild. The PROMISE is
// retained (not just the key) so an in-flight rebuild can be awaited — see `settleTimelineRefreshes`.
const refreshing = new Map<string, Promise<void>>();
// Keys whose inputs changed WHILE a rebuild was in flight — that rebuild's result is already stale, so
// one more pass runs when it finishes (trailing edge). Without this a mid-rebuild bust is lost.
const dirty = new Set<string>();

const memKey = (teamId: string, groupKey: string): string => `${teamId}:${groupKey}`;

/** The raw persisted row, version and all. Two readers want it for different questions: the ledger
 *  read below (which rejects a foreign version) and the synopsis salvage (which doesn't care).
 *  Takes the GROUP KEY, not the tier — a visibility variant must read ITS OWN row only; falling
 *  back to the tier row would serve titles/prose from outside the member's visibility. */
async function readTimelineCacheRow(
  db: DbClient,
  teamId: string,
  groupKey: string
): Promise<{ payload: unknown; computed_at: string | Date; degraded?: boolean | null; authorization_epoch: string | number } | null> {
  const { data } = await db
    .from("work_timeline_cache")
    .select("payload, computed_at, degraded, authorization_epoch")
    .eq("team_id", teamId)
    .eq("group_key", groupKey)
    .maybeSingle();
  return (data as { payload: unknown; computed_at: string | Date; degraded?: boolean | null; authorization_epoch: string | number } | null) ?? null;
}

/** The previous payload's per-person-day summaries, whatever version wrote them. Empty on any error —
 *  a missing synopsis is a cosmetic loss and must never fail the panel. */
async function readSalvageableSummaries(
  db: DbClient,
  teamId: string,
  groupKey: string,
  expectedAuthorizationEpoch: number,
): Promise<SalvagedSummaries> {
  try {
    return await withTransaction(async () => {
      const epoch = await lockedAuthorizationEpoch(teamId);
      if (epoch !== expectedAuthorizationEpoch) return new Map();
      const row = await readTimelineCacheRow(db, teamId, groupKey);
      if (!row || Number(row.authorization_epoch) !== epoch) return new Map();
      const at =
        typeof row.computed_at === "string" ? Date.parse(row.computed_at) : new Date(row.computed_at).getTime();
      return salvageSummaries(row.payload, at, Date.now());
    });
  } catch {
    return new Map();
  }
}

/** The admission-keyed part of a view — what `readTimelineCache`/`writeTimelineCache` address. */
export type TimelineVariant = Pick<TimelineView, "admission" | "visibilityHash">;

/** Resolve a member's variant (admission + hash) — the ONE resolver, so a fixture or operator tool
 *  addresses exactly the row a real read would. Throws on any resolution error. */
export async function resolveTimelineVariant(db: DbClient, teamId: string, memberId: string): Promise<TimelineVariant> {
  const { admission, visibilityHash } = await resolveView(db, teamId, memberId);
  return { admission, visibilityHash };
}

/** Read the cached ledger for one variant. Null on miss/any error (best-effort — a cache read
 *  must never fail the panel; the caller builds inline). `_tier` is kept for signature compatibility
 *  and IGNORED: the row is addressed by the variant's own resolved posture, so a disagreeing tier can
 *  never reach another reader class's row. */
export async function readTimelineCache(
  db: DbClient,
  teamId: string,
  _tier: ViewerTier,
  variant: TimelineVariant
): Promise<CacheEntry | null> {
  try {
    return await withTransaction(async () => {
      const epoch = await lockedAuthorizationEpoch(teamId);
      const row = await readTimelineCacheRow(db, teamId, viewKey(variant));
      if (!row || Number(row.authorization_epoch) !== epoch) return null;
      // Payload is `{ v, days }`. A missing/older version = a shape from a previous deploy → treat as a
      // MISS so the caller rebuilds (never render a stale wrong shape).
      const p = row.payload as { v?: number; days?: unknown } | null;
      if (!p || p.v !== PAYLOAD_VERSION || !Array.isArray(p.days)) return null;
      const days = p.days as TimelineDay[];
      const at =
        typeof row.computed_at === "string" ? Date.parse(row.computed_at) : new Date(row.computed_at).getTime();
      // `=== true` so a row written before the column existed reads false — "no evidence of degradation",
      // not "verified good". Defaulting the other way would mark every pre-migration team's ledger bad.
      return { days, at: Number.isFinite(at) ? at : 0, degraded: row.degraded === true, authorizationEpoch: epoch };
    });
  } catch {
    return null;
  }
}

/** What a ledger write did. Only `published` may be mirrored into process memory as-is. */
export type TimelineCacheWriteOutcome =
  | { status: "published"; authorizationEpoch: number }
  | { status: "epoch_rejected"; expectedAuthorizationEpoch: number; currentAuthorizationEpoch: number }
  | { status: "posture_refused" }
  | { status: "cache_failed"; expectedAuthorizationEpoch: number | null; error: string };

/** Upsert the ledger for one variant, stamping `computed_at` now. Best-effort — a failed write must
 *  never fail the build (the days are still returned).
 *
 *  The row is addressed by the variant's resolved posture, never by `tier`. A `tier` that DISAGREES
 *  with that posture is REFUSED (nothing written): `days` is caller-assembled, and a mismatched tier
 *  is the sign it was built under a different authority than the variant's key names — placing it
 *  anywhere could publish one reader class's payload to another. Internal callers always pass the
 *  variant's own posture.
 *
 *  The write is also bound to the team's authorization epoch: a ledger built under an epoch that has
 *  since advanced is rejected rather than published under the current one. */
export async function writeTimelineCache(
  db: DbClient,
  teamId: string,
  tier: ViewerTier,
  days: TimelineDay[],
  /** The per-person-day synopses are missing or carried over, so the prose wasn't computed for this
   *  ledger. Persisted (R2/M6) so the NEXT reader of this row inherits the verdict instead of being
   *  handed a partial payload as healthy. Defaults false — the callers that know pass it explicitly. */
  degraded: boolean,
  /** The admission-keyed variant — the row is `adm:<class>:<posture>:<hash>`, never a tier/`vis:` row. */
  variant: TimelineVariant,
  expectedAuthorizationEpoch?: number,
): Promise<TimelineCacheWriteOutcome> {
  if (tier !== variant.admission.posture) {
    console.warn("[timeline] cache write refused: caller tier disagrees with the resolved admission posture");
    return { status: "posture_refused" };
  }
  try {
    return await withTransaction(async () => {
      const currentEpoch = await lockedAuthorizationEpoch(teamId);
      const epoch = expectedAuthorizationEpoch ?? currentEpoch;
      if (currentEpoch !== epoch) {
        return {
          status: "epoch_rejected" as const,
          expectedAuthorizationEpoch: epoch,
          currentAuthorizationEpoch: currentEpoch,
        };
      }
      // `payload` is a top-level JSON array — serialize it ourselves (the pg adapter binds a raw JS array
      // as a Postgres array literal, which the jsonb column rejects); a text param assignment-casts to jsonb.
      const { error } = await db.from("work_timeline_cache").upsert(
        {
          team_id: teamId,
          group_key: viewKey(variant),
          payload: JSON.stringify({ v: PAYLOAD_VERSION, days }),
          computed_at: new Date().toISOString(),
          degraded,
          authorization_epoch: epoch,
        },
        { onConflict: "team_id,group_key" }
      );
      if (error) throw error;
      return { status: "published" as const, authorizationEpoch: epoch };
    });
  } catch (error) {
    // best-effort — the ledger is still returned even if we couldn't persist it
    console.error("[timeline] cache publication failed:", error instanceof Error ? error.message : error);
    return {
      status: "cache_failed",
      expectedAuthorizationEpoch: expectedAuthorizationEpoch ?? null,
      error: error instanceof Error ? error.message : "timeline cache publication failed",
    };
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
  // EVERY view of the team — the two tier rows AND all §5.8 visibility variants (their keys are not
  // enumerable from here, so sweep by prefix). The DB update below is already team-wide.
  const prefix = `${teamId}:`;
  for (const key of [...mem.keys()]) if (key.startsWith(prefix)) mem.delete(key);
  // Invalidate an ALREADY-RUNNING rebuild too. It read its inputs before this bust, so its result is
  // wrong the moment it lands — and it lands stamped `computed_at = now`, which would make the stale
  // payload look FRESH and suppress the next read's refresh entirely (the re-attribution would then be
  // invisible for a full TTL). Marking dirty makes the in-flight pass run once more with the new data.
  for (const key of refreshing.keys()) if (key.startsWith(prefix)) dirty.add(key);
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
  // The tier row AND its §5.8 visibility variants: a vis:<tier>:<hash> payload is built from the
  // same tier-filtered set, so whatever made the tier row no longer servable applies to every
  // variant of it (this is the "narrowed external→team" path — titles/prose must actually go).
  // TIERRET-1 (N4): the NEW namespace too, or a renamed key would evade this purge. Every
  // `adm:<class>:<tier>:*` variant of the tier goes; and on the EXTERNAL purge (an item leaving
  // external-shared), every `adm:mg:*` variant as well — a non-Everyone member may have seen the
  // item ONLY through an external-shared grant, and its key (class + grant hash) does not move when
  // the item does. Everyone members (`me`) keep General and external-shared both, so the narrowed
  // item stays visible to them and their rows are left for the stale-mark backstop.
  const shapes = [
    { exact: tier },
    { prefix: `vis:${tier}:` },
    ...(["me", "mg", "lg"] as const).map((cls) => ({ prefix: `${ADMISSION_NAMESPACE}:${cls}:${tier}:` })),
    ...(tier === "external" ? [{ prefix: `${ADMISSION_NAMESPACE}:mg:` }] : []),
  ];
  for (const key of [...mem.keys()]) {
    if (!key.startsWith(`${teamId}:`)) continue;
    const group = key.slice(teamId.length + 1);
    if (shapes.some((s) => ("exact" in s ? group === s.exact : group.startsWith(s.prefix)))) mem.delete(key);
  }
  // An in-flight rebuild of a purged key read pre-narrowing inputs: re-run it (trailing edge).
  for (const key of refreshing.keys()) {
    if (!key.startsWith(`${teamId}:`)) continue;
    const group = key.slice(teamId.length + 1);
    if (shapes.some((s) => ("exact" in s ? group === s.exact : group.startsWith(s.prefix)))) dirty.add(key);
  }
  try {
    for (const s of shapes) {
      if ("exact" in s) await db.from("work_timeline_cache").delete().eq("team_id", teamId).eq("group_key", s.exact);
      else await db.from("work_timeline_cache").delete().eq("team_id", teamId).like("group_key", `${s.prefix}%`);
    }
  } catch {
    // best-effort — the caller's stale-mark backstop bounds a SERVED stale payload to one TTL (see the
    // header for why that is no longer the whole story for the summaries)
  }
}

/**
 * TIERRET-1 ROLL-FORWARD STEP (mandatory after any rollback — docs/RELEASE-NOTES-tierret1.md,
 * "Timeline cache — rollback and roll-forward"): delete
 * EVERY `adm:` row, instance-wide, and this process's copies. While rolled back, the old code serves
 * from `vis:` and cannot see — let alone purge — `adm:` rows, so a narrowing that happened then left
 * them stale; the new code must not serve or salvage them when it returns. Old `vis:` rows are left
 * alone (the new code never reads them). Idempotent; run before the rolled-forward build serves.
 * Returns ok:false on a write failure so the operator can retry rather than proceed.
 */
export async function purgeAdmissionTimelineNamespace(db: DbClient): Promise<{ ok: boolean; error?: string }> {
  const marker = `:${ADMISSION_NAMESPACE}:`;
  for (const key of [...mem.keys()]) if (key.includes(marker)) mem.delete(key);
  for (const key of refreshing.keys()) if (key.includes(marker)) dirty.add(key);
  try {
    const { error } = await db.from("work_timeline_cache").delete().like("group_key", `${ADMISSION_NAMESPACE}:%`);
    return error ? { ok: false, error: error.message } : { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Fire-and-forget background rebuild for a stale key (SWR). Uses its own adminClient (not request-
 *  bound). Deduped via `refreshing`; errors logged, never thrown. */
function refreshInBackground(teamId: string, view: TimelineView): void {
  // The view is FROZEN into the rebuild: a variant row's hash is a pure function of the effective
  // project set that produced it, so rebuilding with that same set is exactly what keeps the row
  // correct for every member who maps to it — a member whose groups changed maps to a DIFFERENT
  // key on their next read and never sees this row again.
  const key = memKey(teamId, viewKey(view));
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
        const epoch = await authorizationEpoch(bg, teamId);
        const built = await buildTimeline(bg, teamId, view);
        if (await authorizationEpoch(bg, teamId) !== epoch) { dirty.add(key); continue; }
        const publication = await writeTimelineCache(bg, teamId, view.admission.posture, built.days, built.degraded, view, epoch);
        if (publication.status === "epoch_rejected") {
          dirty.add(key);
          continue;
        }
        // Unreachable here (the tier passed IS the variant's posture); never mirror a refused write.
        if (publication.status === "posture_refused") continue;
        // A persistent-cache outage is allowed to fall back to process memory only after one final
        // authoritative check. An epoch rejection never publishes either copy: both were built under
        // authorization that is no longer current.
        if (publication.status === "cache_failed") {
          const authorized = await withLockedAuthorizationEpoch(teamId, (current) => {
            if (current !== epoch) return false;
            mem.set(key, { days: built.days, at: Date.now(), degraded: built.degraded, authorizationEpoch: epoch });
            return true;
          });
          if (!authorized) dirty.add(key);
          continue;
        }
        mem.set(key, { days: built.days, at: Date.now(), degraded: built.degraded, authorizationEpoch: epoch });
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

export class TimelineAuthorizationChangedError extends Error {
  readonly retryable = true;

  constructor() {
    super("Timeline authorization changed while the view was being built; retry the request");
    this.name = "TimelineAuthorizationChangedError";
  }
}

export interface TimelineReadHooks {
  /** Deterministic concurrency hook used by the epoch-race regression tests. */
  beforeColdPublish?: (attempt: number) => Promise<void>;
}

/**
 * Return the work-timeline for a team+tier, serve-stale-while-revalidate:
 *   1. fresh in-memory → return instantly;
 *   2. Postgres `work_timeline_cache` — fresh → return; stale → return stale NOW + rebuild behind the request;
 *   3. cold miss → build inline, then persist.
 * The one reader every surface calls (panel, `/api/v1/timeline`). Access is enforced inside the
 * builder (membership filters + the reader's provenance ctx), so this is safe with `adminClient`.
 *
 * `memberId` is REQUIRED (Phase B slice 4, §5.8): the read resolves the member's CONTENT ADMISSION
 * (TIERRET-1 — `lib/access/admission.ts`, the one resolver) and serves its
 * `adm:<class>:<posture>:<hash>` variant. `null` THROWS (fail closed — PRET-6: there is no tier row).
 * A resolution error throws BEFORE any write, so a failure never becomes a cached empty success.
 *
 * `_tier` is kept for call-site compatibility and IGNORED (TIERRET-1 final review HIGH). It was read
 * at auth time and a legal membership write can move the posture before the admission is resolved
 * here; the ONE captured `view.admission.posture` governs the key, lookup, cold build, salvage, write
 * and the background refresh alike, so no path can mix two authorities.
 */
export async function getCachedWorkTimeline(
  db: DbClient,
  teamId: string,
  _tier: ViewerTier,
  memberId: string | null,
  hooks: TimelineReadHooks = {},
): Promise<CachedTimeline> {
  // An authorization-epoch change mid-read retries the WHOLE resolution once — the admission, key
  // and item set of the superseded attempt are never reused.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await getCachedWorkTimelineAttempt(db, teamId, memberId, hooks, attempt);
    if (result !== null) return result;
  }
  throw new TimelineAuthorizationChangedError();
}

async function getCachedWorkTimelineAttempt(
  db: DbClient,
  teamId: string,
  memberId: string | null,
  hooks: TimelineReadHooks,
  attempt: number,
): Promise<CachedTimeline | null> {
  // PRET-6: there is no permissive tier row anymore — a principal-less read is a caller bug.
  if (memberId == null) throw new Error("timeline read without a principal (fail closed)");
  const view = await resolveView(db, teamId, memberId); // CHEAP (admission + project hash)
  const posture = view.admission.posture;
  const key = memKey(teamId, viewKey(view));
  const now = Date.now();
  // The shared epoch lock gives a memory hit a linearization point before a concurrent revocation.
  // Without it, a process could read the old epoch, pause behind a revoker, then serve old memory
  // after the revocation had already reported success.
  const { epoch, cached } = await withLockedAuthorizationEpoch(teamId, (current) => {
    const hit = mem.get(key);
    return { epoch: current, cached: hit?.authorizationEpoch === current ? hit : undefined };
  });
  if (cached && cached.authorizationEpoch === epoch && now - cached.at < TTL_MS) {
    return { days: cached.days, freshness: freshness(cached.at, TTL_MS, { now, degraded: cached.degraded }) };
  }

  const persisted = await readTimelineCache(db, teamId, posture, view);
  if (persisted) {
    mem.set(key, { days: persisted.days, at: persisted.at, degraded: persisted.degraded, authorizationEpoch: persisted.authorizationEpoch });
    // ONE envelope for both the fresh and the stale branch — `freshness()` derives `stale` from the same
    // age comparison the branch below makes, so the reported staleness cannot disagree with the decision
    // actually taken (they were two separate readings of the clock in every earlier draft of this).
    // The PERSISTED verdict — so a reader who didn't do the work still learns the prose is missing.
    const f = freshness(persisted.at, TTL_MS, { now, degraded: persisted.degraded });
    if (!f.stale) return { days: persisted.days, freshness: f };
    refreshInBackground(teamId, view); // stale → serve stale, rebuild behind the request
    return { days: persisted.days, freshness: f };
  }

  // Cold miss — return the PURE ledger FAST (no inline LLM), persist it so there's always a row, then
  // add the per-person-day synopsis in the background. The first viewer sees the timeline immediately;
  // summaries appear on the next view once the background pass writes them (kept off the request path so
  // a big team's fan-out can't blow the page / route budget).
  const built = await getWorkTimeline(db, teamId, posture, undefined, await buildEnforcement(db, teamId, view));
  // …but a cold miss is USUALLY A VERSION BUMP, not a genuinely empty cache — and that path was
  // silently deleting the synopsis from every person-day until a background pass finished. Twice the
  // user's report was "we've lost the summaries at the top of each person's day", both times right
  // after a deploy of mine. The previous row's sentences still describe those same person-days, so
  // carry them across as a bridge; the background pass overwrites them with freshly computed ones.
  // Best-effort by construction: no salvageable row → `built`, unchanged.
  // SAME-KEY salvage only: prose from the tier row was written about the FULL tier-visible set and
  // can name work outside this view's visibility — carrying it into a variant payload is a leak.
  // TIERRET-1: the same key is an `adm:` key, so salvage never crosses the authorization namespace in
  // either direction (old `vis:` prose is never read here; old code never reads `adm:` rows).
  // Same EPOCH too: prose written under a superseded authorization epoch is never carried.
  const days = attachSalvagedSummaries(
    built,
    await readSalvageableSummaries(db, teamId, viewKey(view), epoch),
  );
  const at = Date.now();
  await hooks.beforeColdPublish?.(attempt);
  // PERSISTED as degraded, not just reported. The row this writes is what the next reader gets, and its
  // prose is either absent or salvaged from an older payload version — so the flag has to live on the row
  // or the very next request hands the same partial ledger over as healthy. Self-healing: the background
  // pass below rewrites the row with the real verdict once summaries land.
  const publication = await writeTimelineCache(db, teamId, posture, days, true, view, epoch);
  // `posture_refused` is unreachable here (the tier passed IS the variant's posture); treated like
  // an epoch rejection so a refused write is never mirrored into memory or served.
  if (publication.status === "epoch_rejected" || publication.status === "posture_refused") return null;
  if (publication.status === "cache_failed") {
    const authorized = await withLockedAuthorizationEpoch(teamId, (current) => {
      if (current !== epoch) return false;
      mem.set(key, { days, at, degraded: true, authorizationEpoch: epoch });
      return true;
    });
    if (!authorized) return null;
  } else {
    // Publish process memory only after the durable writer accepted the same epoch.
    mem.set(key, { days, at, degraded: true, authorizationEpoch: epoch });
  }
  refreshInBackground(teamId, view);
  // DEGRADED, deliberately. A cold miss returns the pure ledger: its per-person-day synopses are either
  // absent (the background pass hasn't run) or SALVAGED from an older payload version. Both are "this is
  // real work data with prose that wasn't computed for it", which is precisely the plausible-but-partial
  // state R2 exists to name. Freshly computed, so `stale` is false — the two flags are independent, and
  // this is the case that proves it: newest possible payload, least trustworthy prose.
  return { days, freshness: freshness(at, TTL_MS, { now: at, degraded: true }) };
}
