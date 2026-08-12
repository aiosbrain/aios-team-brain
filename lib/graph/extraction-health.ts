import "server-only";
import { runSql } from "@/lib/db/pg/pool";
import { ITEM_EPISODE_PREFIX } from "./episode-name";
import { neo4jConfigured, runRead } from "./neo4j";

/**
 * Graphiti EXTRACTION health — the one graph failure mode the existing signals miss.
 *
 * The projector (`lib/graph/project`) POSTs episodes to Graphiti and records `graph_project` in
 * `ingest_runs` as OK on a `202 Accepted`. But 202 only means "queued" — Graphiti then runs its own
 * LLM to extract entities/RELATES_TO facts asynchronously. When THAT step fails on every job (prod
 * 2026-07: `Output length exceeded max tokens 8192` in `resolve_extracted_nodes`, ~800 jobs backed
 * up), episodes are accepted but NO facts are created. So:
 *   • `graph_project` ingest_runs stays green (the POST succeeded),
 *   • Graphiti `/healthcheck` stays green (the service is up),
 *   • the projector-freshness check stays green (it IS writing episodes),
 * yet the graph is empty and narrative arcs synthesize from nothing / stale facts. A completely
 * silent failure. This probe compares "episodes projected" (Postgres ledger) against "facts actually
 * extracted" (Neo4j). Surfaced loudly on the admin pipeline banner + retrieval-health card.
 *
 * TWO failures, and the second one taught us the first check was the wrong question. The original
 * check was `facts === 0` — "did extraction EVER work?". On 2026-07-28 Graphiti's extraction key hit
 * `insufficient_quota` and every job failed, but the graph already held weeks of facts, so
 * `facts === 0` was false and this probe stayed SILENT. The admin card showed green for hours while
 * extraction was dead; it was found by reading service logs. A count-based check disarms itself
 * permanently the first time it succeeds.
 *
 * So the live question is RECENCY, not existence: are episodes still landing while no new fact
 * appears? Both halves are kept — zero-facts catches a broken install, the lag catches a working
 * install that stopped.
 *
 * WHAT THIS STILL CANNOT SEE — stated because the failure being corrected was over-claiming, and
 * REWRITTEN for the episode-node accuser (STALLPROBE-1); the old text described the deleted
 * fact-lag predicate and had gone quietly false in the very change that made it false:
 *   • PARTIAL failure. Any single COMPLETED job inside the lag budget reads green, so a 90%-failure
 *     rate is invisible.
 *   • ZERO-YIELD COMPLETION — the detection this slice knowingly trades away. A job that runs to
 *     completion while extracting nothing writes its episode node, so it reads green by construction.
 *     Entity-yield death has a partial backstop (the census refuses with `predicate-suspect` when a
 *     group projects ≥`MIN_EPISODES_FOR_CENSUS_SUSPICION` episodes and produces zero names), but
 *     EDGE-yield death does not: `extract_edges` legally returning `[]` on every episode — a
 *     prompt/schema regression on a graphiti upgrade is the realistic cause — leaves entities fresh,
 *     census names fresh, `facts > 0` and the episodic clock fresh, so every surface stays green.
 *     The retired fact-lag half DID fire on that state — but indistinguishably from a healthy
 *     dedup-frozen graph, which is the false positive this slice exists to remove. The trade is
 *     deliberate (a false alarm on every mature graph, every quiet night, vs. a blind spot on a
 *     failure mode never yet observed here) and it is written down rather than shipped silently.
 *   • SCOPE — fixed in two dimensions, both by review, both the same mistake: the two halves of the
 *     lag must describe ONE population, because they are subtracted. `newestEpisodeAtMs` counts
 *     `graph_episodes` rows for a team; `newestEpisodicAtMs` now matches that on BOTH axes — the
 *     team's ledger `group_id`s (a global read let another team's healthy job mask this one's) and
 *     ledger-backed item episodes only (a group-scoped read still counted `correction:<arc_id>`
 *     writebacks, which `lib/graph/arcs.ts` POSTs into the same group with no ledger row, so a human
 *     arc correction completing would have silenced this alarm mid-outage).
 *     `facts`/`countGraphFacts` REMAINS global and deliberately un-scoped: "has the extractor ever
 *     produced anything at all" is an install-level question, and scoping it is not this slice's.
 *     WHAT THE SCOPING DOES NOT FIX, so the bullet above stops short of claiming it: a team whose
 *     groups hold ZERO episode nodes reads `max() = null` ⇒ "can't tell" ⇒ green, and on a
 *     MULTI-TEAM install another team's facts keep the global `facts === 0` branch quiet too. So a
 *     brand-new team whose extraction has never once succeeded is silent on both halves — the very
 *     "202 accepted, nothing processed" shape this probe was built for. It is NOT a regression (the
 *     pre-scoping global read was equally green there, masked by the other team's clock), it is
 *     backstopped on the card by the census `predicate-suspect` refusal, and on the single-team
 *     install this product actually ships as, `facts === 0` fires normally. Closing it properly means
 *     distinguishing "read fine, found nothing" from "could not read" — a discriminated return, not a
 *     nullable one — and per-team fact counts; both are their own slice (STALLSCOPE-1).
 *   • A missing/unparseable timestamp disarms the recency half silently — safe, but invisible.
 *   • Detection lags by the budget (6h) by construction.
 *
 * Best-effort: nulls/`stalled:false` on any error so it never breaks a page render.
 */

/** Below this many projected episodes we can't distinguish "extractor broken" from "fresh install
 *  still mid-first-extraction" (Graphiti processes async), so we don't flag. With a working extractor,
 *  25 accepted episodes reliably yield ≥1 fact; 0 facts past that is unambiguous breakage. */
export const MIN_EPISODES_FOR_EXTRACTION_SIGNAL = 25;

/** How far the newest FACT may trail the newest EPISODE before extraction counts as stopped.
 *
 *  Extraction is serial and roughly 10-20s per episode, so facts always trail — the budget has to
 *  absorb a normal backlog without paging anyone. Six hours is well past any healthy queue and well
 *  short of the hours this went unnoticed for. Measured against the newest EPISODE, never against
 *  `now`: a team that projected nothing for a week has legitimately old facts, and comparing to the
 *  wall clock would cry stall on every quiet team. */
export const EXTRACTION_LAG_BUDGET_MS = 6 * 3_600_000;

export interface GraphExtractionHealth {
  episodes: number | null; // projected episodes for this team (Postgres ledger)
  facts: number | null; // extracted RELATES_TO facts in Neo4j (null = Neo4j unreadable)
  stalled: boolean; // episodes are landing but not becoming facts → extractor failing
  /** The extractor is accumulating same-name duplicate entities above this graph's own baseline
   *  (the name-collision census, ALARMFIX-1) — a DIFFERENT failure from `stalled`: extraction is
   *  working, and producing bad knowledge. Kept as its own flag rather than folded into `stalled`
   *  because the two send an operator to different places (service logs vs the Extraction model
   *  picker). */
  censusPolluted: boolean;
  reason: string | null; // human-facing cause when stalled OR polluted
}

export interface ExtractionSignals {
  episodes: number | null;
  facts: number | null;
  /** Newest `graph_episodes.projected_at` (ms) — when WE last pushed. */
  newestEpisodeAtMs?: number | null;
  /**
   * Newest RELATES_TO `created_at` (ms) — see `newestFactAtMs()` for why it is not `valid_at`.
   *
   * ACCEPTED AND DELIBERATELY IGNORED since STALLPROBE-1. It is not read by the predicate at all;
   * the field survives as NEGATIVE SPACE, so that "a 30-day-stale fact with a live extractor is not
   * a stall" is expressible as a test. That test is the thing that reddens if a future change
   * re-wires fact age into the verdict, which is exactly the bug this slice removed. Optional
   * because production no longer supplies it: the pipeline banner stopped fetching it (a dead
   * 113k-relationship Neo4j scan per render), and the admin card fetches it only to SHOW it.
   */
  newestFactAtMs?: number | null;
  /**
   * Newest `Episodic.created_at` (ms) — the liveness signal (STALLPROBE-1). See
   * `newestEpisodicAtMs()` for the precise reading: the node's EXISTENCE proves a job completed;
   * its `created_at` is the job's START instant.
   *
   * REQUIRED, deliberately. The first version of this field was optional with "omitted ⇒ old
   * behaviour", and that is exactly how the second call site (`lib/query/retrieval-health`, the
   * surface that produced the bug report) stayed unwired while every test passed. Required makes
   * omission a typecheck failure — a build-failing guard instead of a thing to remember.
   */
  newestEpisodicAtMs: number | null;
}

/**
 * Pure verdict: are episodes reaching Graphiti but not becoming facts? `null` anywhere means
 * "can't tell" (Neo4j unreadable, ledger unreadable, or an older Graphiti that didn't stamp a
 * timestamp) — NOT stalled, since a different leg owns reachability and "don't know" must never
 * read as "broken". Exported for unit tests.
 */
export function deriveGraphExtractionStalled(input: ExtractionSignals): boolean {
  const { episodes, facts } = input;
  if (episodes === null || facts === null) return false;
  // Too few episodes to judge either way — a fresh install may still be mid-first-extraction.
  if (episodes < MIN_EPISODES_FOR_EXTRACTION_SIGNAL) return false;
  // Never extracted anything: the original 2026-07 failure. Outranks liveness on purpose — an
  // extractor that runs to completion and still produces zero facts IS broken.
  if (facts === 0) return true;

  // ── LIVENESS IS THE EPISODE NODE, NOT THE FACTS (STALLPROBE-1) ───────────────────────────────
  // This used to compare the newest episode against the newest FACT, which asks "when did the graph
  // last learn something NEW?" and was read as "when did a job last FINISH?". On a mature graph those
  // diverge: prod runs 6.6 `dedupe_edges` per `extract_edges` (measured 2026-08-12: 8,919/1,340 over
  // 30d; 6.59 over 7d; 7.50 over 2d), so most extracted edges resolve onto an existing edge and
  // create no `RELATES_TO` — the clock freezes while extraction works. On
  // 2026-08-12 that reported "accepting episodes but extracting 0 facts" one minute after a clean run,
  // beside a census counting 2,928 new entities.
  //
  // `Episodic` is the honest evidence: graphiti persists it in `add_nodes_and_edges_bulk` — the single
  // Neo4j write, reached only after node resolution, edge extraction/resolution and attribute
  // extraction have all returned — and a new episode is ALWAYS a new node, so unlike entities and
  // edges it cannot deduplicate. The node's EXISTENCE is what proves a job completed; its `created_at`
  // is the job's START instant (`utc_now()` taken at the top of `add_episode`), not the episode's
  // backdated `reference_time` and not the completion instant. So "episodes pushed but no episode node
  // completing" is the literal contract of this probe ("202 accepted, nothing processed"), now covering
  // the whole pipeline INCLUDING the Neo4j write — which the two rejected ledger designs both left
  // uncovered.
  const newestEpisode = input.newestEpisodeAtMs ?? null;
  // `?? null` normalises an omitted field to the explicit unknown branch. Honest about what this is
  // worth: it changes NO current behaviour — `undefined` already falls through to `newestEpisode -
  // undefined > budget`, i.e. `NaN > budget`, i.e. `false`, which is the same verdict the null branch
  // gives. A mutation removing it survives the whole suite, and that is correct rather than a gap in
  // the tests. It is kept because the equivalence is accidental: it holds only while the comparison
  // stays a subtraction against a fixed budget, and NaN reaching a future `<`/`>=` rewrite would return
  // the WRONG verdict silently. The field is required in TS, but `tsconfig` excludes the `test/` tree,
  // so omission is reachable from tests and from any JS caller.
  const newestEpisodic = input.newestEpisodicAtMs ?? null;
  // Either side unknown → can't tell. Neo4j reachability is a different leg's job, and "don't know"
  // must never read as "broken" (the standing rule at the top of this file).
  if (newestEpisode === null || newestEpisodic === null) return false;
  return newestEpisode - newestEpisodic > EXTRACTION_LAG_BUDGET_MS;
}

/** Count RELATES_TO facts in the graph. A numeric health probe (no content leaves the graph), so it's
 *  deliberately not tier-scoped — "is the extractor producing ANY facts?" is a global question. */
export async function countGraphFacts(): Promise<number | null> {
  if (!neo4jConfigured()) return null;
  try {
    const rows = await runRead<{ n: number }>("MATCH ()-[r:RELATES_TO]->() RETURN count(r) AS n");
    return rows[0]?.n ?? 0;
  } catch {
    return null; // Neo4j unreachable — the reachability leg reports that; here it's just "unknown"
  }
}

/**
 * When the newest RELATES_TO edge was EXTRACTED.
 *
 * Deliberately `r.created_at` and NOT the `workTs` expression the Learning panel uses. `workTs`
 * prefers `valid_at`, which Graphiti backdates to the episode's work time — so a fact extracted five
 * minutes ago about a month-old Slack thread carries a month-old `valid_at`. Ranking by that is right
 * for display and catastrophic for a health probe: it would report a stall on a perfectly healthy
 * extractor that happens to be chewing through a backfill of old content.
 *
 * Unfiltered, like `countGraphFacts`: any edge, bookkeeping or not, is proof the extractor ran,
 * which is the only question here.
 */
/**
 * Parse a timestamp from either probe into epoch ms, or null.
 *
 * Pure and exported because this seam has two different producers and no compiler between them:
 * Postgres `timestamptz::text` (`2026-07-28 12:34:56.789+00`) and Neo4j `toString(datetime)`
 * (`2026-07-28T12:34:56.789000000Z`). If either format shifts — a Neo4j upgrade emitting a bracketed
 * named zone parses to NaN — the recency check silently disarms while every other test stays green.
 * That is the same self-disarming class as the bug this file was rewritten to fix, so the formats are
 * pinned in the unit tier rather than assumed.
 */
export function parseProbeTimestamp(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

export async function newestFactAtMs(): Promise<number | null> {
  if (!neo4jConfigured()) return null;
  try {
    const rows = await runRead<{ at: string | null }>(
      "MATCH ()-[r:RELATES_TO]->() WHERE r.created_at IS NOT NULL RETURN toString(max(r.created_at)) AS at"
    );
    return parseProbeTimestamp(rows[0]?.at ?? null);
  } catch {
    return null;
  }
}

/**
 * When this team last actually PUSHED an episode — the other half of the lag comparison.
 *
 * `content_sha256 <> ''` is load-bearing, not tidiness. Two paths in `lib/graph/project.ts` bump
 * `projected_at` while POSTing nothing to Graphiti: the blanking/redaction path and the tier-vacate
 * path, both of which park the row on a `""` sentinel sha. A plain `max(projected_at)` therefore
 * counts a redaction wave as "an episode just landed" — and with no extraction to follow it, the lag
 * check would go red on a completely healthy extractor six hours later. That is the cry-wolf failure
 * this whole probe is supposed to avoid, so it must not be the probe's own first bug. Real pushes
 * always store a 64-char digest (even `sha("")`), so the sentinel is an unambiguous discriminator.
 *
 * Exported so the retrieval-health card compares against the SAME quantity — two implementations of
 * one number is how one surface keeps a bug the other one fixed.
 */
export async function newestEpisodeAtMs(teamId: string): Promise<number | null> {
  try {
    const res = await runSql<{ at: string | null }>(
      "select max(projected_at)::text as at from graph_episodes where team_id = $1 and content_sha256 <> ''",
      [teamId]
    );
    return parseProbeTimestamp(res.rows[0]?.at ?? null);
  } catch {
    return null;
  }
}

/**
 * The liveness signal: `max(Episodic.created_at)` in Neo4j — the newest job that RAN TO COMPLETION.
 *
 * Read it precisely, because the two halves come from different places. The node's **existence**
 * is the completion evidence: it is written only by `add_nodes_and_edges_bulk` at the very end of
 * `add_episode` (graphiti-core 0.29.3 `graphiti.py:726`, reached via `:1170`), so a job that died
 * anywhere earlier leaves nothing behind. Its **`created_at` is the job's START instant** —
 * `now = utc_now()` is taken at the top of `add_episode` (`:1068`) and handed to the constructor
 * (`:1109`) — so this value is "when the newest COMPLETED job STARTED", not when it finished. The
 * imprecision is bounded by one job's duration (seconds to a couple of minutes) against a 6h budget,
 * and it errs toward a LARGER measured lag, i.e. toward accusing rather than toward suppressing a
 * real outage. It is stated rather than rounded off because a future budget tightened toward job
 * duration would make it load-bearing.
 *
 * KNOWN LIMITATION, verified not assumed: this holds for `add_episode` (singular), which is the path
 * we use — the projector POSTs `/messages` fire-and-forget with no uuid (`lib/graph/graphiti-client`),
 * so a fresh node is constructed every time and `EpisodicNode.get_by_uuid` is never taken. Graphiti
 * also ships `add_episode_bulk` (`:1230`), which saves its episode nodes BEFORE extraction (`:1336`,
 * "# Save all episodes"). If the graph service ever moved to that path, an episode node would exist
 * even when extraction failed outright and this signal would decay to exactly the "202 accepted"
 * semantic it replaces. Nothing in this repo can detect that switch, so it is written down here.
 * (`add_triplet` at `:1645` constructs a throwaway `EpisodicNode` — the literal is at `:1745` — but
 * passes `[]` as the episodic nodes to the bulk write, so it never persists one and cannot refresh
 * this clock.)
 *
 * Chosen over the extractor's LLM spend ledger after two review rounds killed
 * that approach: `meterGraphCall` meters whatever `usage` arrives at any HTTP status (so billed
 * non-2xx generations aren't invisible spend), which means a truncated extraction — a 200 carrying
 * usage — writes an ordinary row while creating nothing. Narrowing to late-stage `call_kind`s did not
 * save it either: on graphiti-core 0.13.2 `extract_edges` ran CONCURRENTLY with the stage that failed
 * in the 2026-07 outage, everything after that call (including the Neo4j write itself) was still
 * uncovered, and `call_kind` is prompt-prefix-matched so a graph-service upgrade would fall to
 * `unknown` and re-manufacture the alarm.
 *
 * The episode node has none of those problems: it makes no claim about stage ordering, it depends on
 * no prompt text, a new episode can never deduplicate onto an existing node (the property whose
 * absence caused the false positive), and it is wall-clock rather than the backdated `reference_time`.
 * It is behind the only Neo4j write ON THE PATH WE RUN — scoped deliberately, because 0.29.3 writes
 * more after it when a saga is passed (`:736-780`) or communities are enabled (`:1184`), neither of
 * which the REST server does; an upgrade that starts passing sagas would move that boundary. The
 * write itself IS covered rather than merely assumed to be: `add_nodes_and_edges_bulk` runs as one
 * managed transaction (`utils/bulk_utils.py:136-146`, `session.execute_write`), so a failure part-way
 * through rolls the episode node back with everything else.
 *
 * SCOPED TO THE SAME POPULATION AS `newestEpisodeAtMs`, unlike `countGraphFacts` and
 * `newestFactAtMs` — and that difference is the point, not an inconsistency. This value is
 * SUBTRACTED FROM `newestEpisodeAtMs`, so anything the two halves disagree about becomes a wrong
 * verdict. It took two review rounds to get the population right, and both misses were the same
 * mistake in different dimensions:
 *
 *   • GROUP. The first draft read `MATCH (e:Episodic)` across the whole database while its
 *     counterpart is team-scoped, so on a multi-team instance ANY other team's completed job
 *     refreshed this team's clock and its dead extractor read green forever.
 *   • KIND. Scoping by group alone was still wrong: `lib/graph/arcs.ts` POSTs `correction:<arc_id>`
 *     episodes into the SAME team group with no `graph_episodes` row behind them, so a human arc
 *     correction completing would refresh a clock whose other half counts only ledger rows. An admin
 *     fixing an arc would have silenced this alarm for the whole budget, mid-outage. Hence the
 *     `ITEM_EPISODE_PREFIX` filter: only ledger-backed item episodes count, which is exactly what
 *     `newestEpisodeAtMs` measures. A positive prefix match rather than a `correction:` denylist, so
 *     a future non-ledger episode kind is excluded by default instead of needing a new rule.
 *
 * The global fact reads stay global because they answer a different, install-level question ("has
 * the extractor ever produced anything at all"), which no team owns.
 *
 * Still a pure health probe: one `max()` aggregation, returning a timestamp and never a name, a body
 * or a `group_id` — no content leaves the graph. NO PERFORMANCE CLAIM is made for the scoping: an
 * earlier version of this comment said the global form was "a label scan", which review corrected —
 * graphiti creates BOTH `episode_group_id` on `(n:Episodic) ON (n.group_id)` and
 * `created_at_episodic_index` on `(n:Episodic) ON (n.created_at)` (`graph_queries.py:65`, `:75`), so
 * both forms are index-supported. The scoping is for correctness. That ledger `group_id`s match
 * Neo4j's is not assumed either — the census next door runs `MATCH (n:Entity {group_id: $g})` on
 * those same ids and returns real prod numbers.
 *
 * Null on an unreadable/unconfigured Neo4j, an unreadable ledger (`groupIds === null`), or a team
 * that has pushed nothing (`[]`) — all of which the predicate treats as "can't tell", never as
 * "broken". The empty case matters: `IN []` matches nothing, which would otherwise read as a
 * proven-silent extractor rather than as an absence of evidence.
 */
export async function newestEpisodicAtMs(groupIds: string[] | null): Promise<number | null> {
  if (!neo4jConfigured()) return null;
  if (groupIds === null || groupIds.length === 0) return null;
  try {
    const rows = await runRead<{ at: string | null }>(
      "MATCH (e:Episodic) WHERE e.group_id IN $g AND e.name STARTS WITH $p AND e.created_at IS NOT NULL RETURN toString(max(e.created_at)) AS at",
      { g: groupIds, p: ITEM_EPISODE_PREFIX }
    );
    return parseProbeTimestamp(rows[0]?.at ?? null);
  } catch {
    return null;
  }
}

/**
 * Episodes this team actually PUSHED, from the Postgres ledger (no Graphiti round-trip).
 *
 * `content_sha256 <> ''` for the same reason `newestEpisodeAtMs` carries it, and it was missing here
 * until review caught it: the blanking/redaction and tier-vacate paths in `lib/graph/project.ts` park
 * a row on the `""` sentinel sha without POSTing anything to Graphiti. Counting those inflates the
 * number that clears `MIN_EPISODES_FOR_EXTRACTION_SIGNAL`, whose whole contract is "N ACCEPTED
 * episodes reliably yield ≥1 fact" — a tombstone was never accepted by anything. Concretely: a young
 * team with 20 real pushes and 5 redactions read as 25, cleared the fresh-install floor, and could be
 * accused of "0 facts" while its first extraction was still legitimately pending.
 */
export async function countProjectedEpisodes(teamId: string): Promise<number | null> {
  try {
    const res = await runSql<{ n: number }>(
      "select count(*)::int as n from graph_episodes where team_id = $1 and content_sha256 <> ''",
      [teamId]
    );
    return res.rows[0]?.n ?? 0;
  } catch {
    return null;
  }
}

/**
 * The `group_id`s this team has actually pushed episodes into — the scope for the liveness read.
 *
 * Exists because the liveness leg's first draft was GLOBAL (`MATCH (e:Episodic)` over the whole
 * database) while its counterpart `newestEpisodeAtMs` is team-scoped, so on a multi-team instance any
 * other team completing a job refreshed this team's clock and hid its dead extractor. Ledger-defined
 * for the same reason `groupCensuses` is: the ledger is the one source that knows what THIS team
 * pushed, and a group that exists only in Neo4j is not this team's to judge.
 *
 * Same `content_sha256 <> ''` sentinel as everywhere else here — a group that only ever received
 * redaction tombstones never had anything extracted, so it must not widen the scope. `null` on an
 * unreadable ledger, which the caller turns into "can't tell", never into an accusation.
 */
export async function teamEpisodeGroupIds(teamId: string): Promise<string[] | null> {
  try {
    const res = await runSql<{ group_id: string | null }>(
      "select distinct group_id from graph_episodes where team_id = $1 and content_sha256 <> ''",
      [teamId]
    );
    return res.rows
      .map((r) => r.group_id)
      .filter((g): g is string => typeof g === "string" && g.length > 0);
  } catch {
    return null;
  }
}

/**
 * WHICH stall this is — the discriminator both surfaces branch on.
 *
 * `never-extracted` and `stopped` send an operator to different places and, since STALLPROBE-1, make
 * DIFFERENT factual claims: "0 facts" is true only of the first. Exported and pure because it and
 * `extractionStallReason` are the single writer of that distinction; the admin card used to compose
 * its own copy and hard-coded the never-extracted wording for BOTH, so a liveness stall rendered
 * "accepting episodes but extracting 0 facts" beside the same card's own 113,352-fact count. That is
 * the "asserts X next to its own contradicting evidence" defect this whole slice exists to remove,
 * and shipping it on the TRUE-positive path — the one an operator must believe — would have been
 * worse than the false positive being fixed. Found by review.
 */
export type ExtractionStallCause = "never-extracted" | "stopped";

export function extractionStallCause(stalled: boolean, facts: number | null): ExtractionStallCause | null {
  if (!stalled) return null;
  return facts === 0 ? "never-extracted" : "stopped";
}

/**
 * The operator sentence for a stall. Pure, and the ONLY place either surface's copy is written.
 *
 * `lagHours` is hours between the newest PUSHED episode and the newest COMPLETED job — see
 * `getGraphExtractionHealth` for why that is start-stamped, and `newestEpisodicAtMs` for why it
 * overstates in the accusing direction. Null renders as "for some time" rather than "for nullh".
 */
export function extractionStallReason(
  cause: ExtractionStallCause,
  args: { episodes: number | null; facts: number | null; lagHours: number | null }
): string {
  if (cause === "never-extracted") {
    return `${args.episodes ?? 0} episodes were projected but the graph has 0 extracted facts — Graphiti is accepting episodes (202) yet its entity-extraction worker is failing on every job. Check the graphiti service logs for the actual error; the usual causes are the extraction LLM's output-token cap or an out-of-quota key. New activity isn't becoming graph facts, so narrative arcs can't update.`;
  }
  const forHow = args.lagHours === null ? "for some time" : `for about ${args.lagHours}h`;
  // `facts === null` is UNKNOWN (Neo4j unreadable), not zero. An earlier draft printed "holds 0 facts
  // from before", which is this file's own banned pattern — a zero indistinguishable from a
  // measurement — in the one sentence an operator acts on. Unreachable from either production caller
  // today (the predicate returns false on null facts), so this is a pure-function contract rather
  // than a live bug; it is fixed anyway because the function is exported and the next caller is free.
  const held =
    args.facts === null
      ? "The graph holds facts from before (the exact count is currently unreadable);"
      : `The graph holds ${args.facts} facts from before;`;
  return `Graph extraction has STOPPED: episodes are still being projected, but graphiti has not completed one ${forHow} — no new episode node has appeared in the graph, and an episode node is only written once a job has finished everything else. (${held} fact age itself is not the signal, because on a mature graph most extracted edges deduplicate and create no new fact even when extraction is perfectly healthy.) Check the graphiti service logs for the actual error — usually an out-of-quota extraction key, the output-token cap, or a failing Neo4j write. Narrative arcs and the Learning panel are running on stale facts.`;
}

/** Hours between the newest pushed episode and the newest completed job; null when either is unknown. */
export function extractionLagHours(
  newestEpisodeAt: number | null,
  newestEpisodicAt: number | null
): number | null {
  return newestEpisodeAt !== null && newestEpisodicAt !== null
    ? Math.round((newestEpisodeAt - newestEpisodicAt) / 3_600_000)
    : null;
}

export async function getGraphExtractionHealth(teamId: string): Promise<GraphExtractionHealth> {
  const empty: GraphExtractionHealth = {
    episodes: null,
    facts: null,
    stalled: false,
    censusPolluted: false,
    reason: null,
  };
  if (!neo4jConfigured()) return empty;
  const [episodes, facts, newestEpisode, censuses, newestEpisodic] = await Promise.all([
    countProjectedEpisodes(teamId),
    countGraphFacts(),
    newestEpisodeAtMs(teamId),
    groupCensuses(teamId),
    // Liveness: the newest graphiti job that RAN TO COMPLETION, scoped to THIS team's groups so
    // another team's healthy extraction can't refresh this team's clock (STALLPROBE-1).
    teamEpisodeGroupIds(teamId).then((groups) => newestEpisodicAtMs(groups)),
  ]);
  const pollutedCensus = censuses.find((c) => c.pollution.judgeable && c.pollution.polluted) ?? null;
  const signals: ExtractionSignals = {
    episodes,
    facts,
    newestEpisodeAtMs: newestEpisode,
    newestEpisodicAtMs: newestEpisodic,
  };
  const stalled = deriveGraphExtractionStalled(signals);
  const cause = extractionStallCause(stalled, facts);
  // Hours since the newest COMPLETED job started, not since the last new fact — the reason string
  // quotes this and it must name the thing the verdict actually rests on. (Start, not finish: see
  // `newestEpisodicAtMs`. It overstates by at most one job's duration, in the accusing direction.)
  const lagHours = extractionLagHours(newestEpisode, newestEpisodic);
  return {
    episodes,
    facts,
    stalled,
    censusPolluted: pollutedCensus !== null,
    // Two distinct causes deserve two distinct sentences — "it never worked" and "it stopped" send an
    // operator to different places, and since STALLPROBE-1 only the first may claim "0 facts". Both
    // name the graphiti service logs, which is where the actual error string lives (a token cap, a
    // 429 `insufficient_quota`, an invalid group_id).
    // A STALL outranks pollution: no facts at all is worse news than bad facts, and stacking two
    // paragraphs into one banner buries both.
    reason:
      cause === null
        ? (pollutedCensus?.pollution.reason ?? null)
        : extractionStallReason(cause, { episodes, facts, lagHours }),
  };
}

/* ────────────────────────────────────────────────────────────────────────────────────────────────
 * NAME-COLLISION CENSUS — the extractor confusing entity identity, which no static check can predict.
 *
 * On 2026-07-30 a cheaper extraction model was selected. It passed the save-time structured-output
 * check (#442) because it genuinely supports structured outputs; it just resolves identity badly. For
 * four days it filled the graph with duplicate entities, and every headline number moved the RIGHT
 * way — total spend fell, because episode volume dropped faster than work per episode rose. It was
 * found by hand. That was AIO-693, and its first detector judged the `IS_DUPLICATE_OF` share of
 * recent `RELATES_TO` edges.
 *
 * WHY THE EDGE PREDICATE IS RETIRED (ALARMFIX-1). graphiti_core 0.29.3 — deployed since #490 —
 * NEVER writes `IS_DUPLICATE_OF` on the server path: `add_episode` discards the duplicate pairs and
 * merges via the uuid map alone; nothing in the wheel writes the relation at all. The old predicate
 * read a literal zero forever, its zero-predicate guard correctly refused to judge, and the alarm sat
 * silently disabled with no surface saying so.
 *
 * THE REPLACEMENT SIGNAL is the graph's own name-collision census: of case/whitespace-normalised
 * `Entity` names in a group whose NEWEST node was created in the recent window, the fraction carried
 * by MORE THAN ONE node (the "same-name split share"). On 0.29.3 exact-normalised-name resolution is
 * deterministic and pre-LLM, so a same-name split can only arise when embedding candidate retrieval
 * misses the existing node — which is exactly the surviving failure shape (embedding degradation,
 * index trouble, retrieval cap pressure), measured directly as the OUTCOME the alarm exists for.
 * Cheap (one Cypher aggregation per group, no LLM), computed PER GROUP so one group's health can't
 * mask another's.
 *
 * The threshold architecture stays RELATIVE + floored (a rate change against the graph's own
 * trailing baseline, self-calibrating), but the old zero-semantics are INVERTED: zero split names
 * over a real sample is the measured healthy steady state on 0.29.3 (0 splits / 684 names on a fresh
 * 108-episode graph), NOT a broken predicate. The "is the query even matching anything" tripwire is
 * replaced, not dropped — see `deriveNameCollisionPollution`'s ledger cross-check.
 * ──────────────────────────────────────────────────────────────────────────────────────────────── */

/**
 * The `ingest_runs.source` under which the alarm's delivery half (`lib/graph/extraction-alert`)
 * records its transitions. Defined HERE, not there, so `lib/ingest/pipeline-health` can exclude the
 * ledger from its legs without importing the mailer into every dashboard render.
 */
export const GRAPH_HEALTH_SOURCE = "graph_health";

/**
 * Recent window whose names are censused — a NEW constant, deliberately not a reuse of the old
 * 24h `DEDUPE_RECENT_MS`: the denominator counts only names that gained a node in the window, and
 * names arrive far slower than edges did, so a 24h window on a mature mostly-merging graph could sit
 * permanently under any minimum. Pre-committed response if prod measurement shows this 7d window
 * still under-fills: WIDEN it until the denominator clears `MIN_NAMES_FOR_CENSUS_SIGNAL` rather than
 * lowering the minimum — and the baseline scales with it (below).
 */
export const CENSUS_RECENT_MS = 7 * 86_400_000;
/**
 * Trailing window the recent share is judged AGAINST (names whose newest node falls before the
 * recent window but inside this span). Scales with the recent window at ~1:14 — a widened recent
 * window must not quietly eat the baseline sample it is judged against — and is long enough that one
 * bad week can't move the baseline it is compared to.
 */
export const CENSUS_BASELINE_MS = 14 * CENSUS_RECENT_MS;
/**
 * Below this many recent NAMES the share is noise — 1 split of 3 names is 33% and means nothing.
 * A name-based minimum, its own constant (edges and names are different populations). INITIAL VALUE,
 * measured-not-chosen refinement pending: the rollout ships the census on the admin card first, and
 * this minimum is re-derived from prod's observed name arrival rate before the alarm is armed.
 */
export const MIN_NAMES_FOR_CENSUS_SIGNAL = 50;
/**
 * Below this many episodes projected INTO THE RECENT WINDOW, a zero-name census is not evidence of
 * anything and must not accuse — it reads `small-sample` (which parks the blindness clock) rather
 * than `predicate-suspect` (which runs it). CENSUSFLOOR-1 / AIO-867.
 *
 * The bug this closes, found live on the admin card: the floor was **one episode**, and prod's
 * `aios_external` group held exactly one 196-char boilerplate index stub in the window — so the card
 * read "rename or stalled extractor" about a working extractor (Neo4j: 16 entities all-time in that
 * group). An alarm surface that accuses on no evidence trains its reader to ignore it, which is how
 * the alarm this replaced ended up silently dead.
 *
 * SEPARATE from `MIN_EPISODES_FOR_EXTRACTION_SIGNAL` despite sharing its initial value, because they
 * are different quantities: that one counts LIFETIME episodes (a fresh-install threshold), this one
 * counts 7-day-WINDOWED episodes (a rate). One constant would couple them, and a future
 * re-derivation of either would silently move the other.
 *
 * 25 is deliberately CONSERVATIVE, not inherited: at prod's measured 12.66 entities/episode even
 * 3-5 typical episodes yielding zero names would be anomalous, so detection needs far less. It is
 * set high against the counter-case that makes a low floor dangerous — a workspace restructure
 * re-pushing several boilerplate index files in one week legitimately yields near-zero names, and a
 * card that accuses on that burst is back to crying wolf.
 *
 * KNOWN AND ACCEPTED, both halves (see docs/design/census-sample-floor.md §2): a group pushing 25
 * boilerplate episodes would still be accused; and a GENUINE per-group extraction failure in a group
 * that never reaches 25 episodes per window is now permanently silent, its detection riding on the
 * busy group (which does trip — a global stall decays the busy group's `recentNames` to 0 against
 * thousands of recent episodes).
 */
export const MIN_EPISODES_FOR_CENSUS_SUSPICION = 25;
/**
 * ⚠️ PLACEHOLDER — armed after prod measurement per the rollout (docs/design/dedupe-alarm-0293.md):
 * the card ships the per-group split-share numbers first, the margin is set from a few days of
 * measured baseline in a follow-up commit (the same measured-not-chosen path the original AIO-693
 * constants took), and only then is `CENSUS_ALARM_ARMED` flipped. Until then this value gates
 * nothing (the verdict is clamped un-polluted while unarmed).
 */
export const CENSUS_MARGIN = 1.5;
/**
 * ⚠️ PLACEHOLDER — armed after prod measurement per the rollout, same as `CENSUS_MARGIN`. The floor
 * is what judges alone when the baseline share is literally zero (the healthy steady state on
 * 0.29.3), so it is the constant prod measurement matters most for.
 */
export const CENSUS_ABSOLUTE_FLOOR = 0.1;
/**
 * The alarm's arming switch — flipping this to true is rollout step 3, in the same commit that sets
 * `CENSUS_MARGIN`/`CENSUS_ABSOLUTE_FLOOR` from prod measurement. While false the derivation runs in
 * full (refusals and `judgeable` still compute — the blindness meta-alarm keys on them) but the
 * verdict is never `polluted: true`, so the card shows real numbers while no mail can fire on
 * unmeasured constants.
 */
export const CENSUS_ALARM_ARMED = false;

export type CensusRefusal =
  | "graph-unreadable"
  | "graph-unconfigured"
  | "small-sample"
  | "no-baseline"
  | "predicate-suspect";

export interface NameCollisionSignals {
  /** Normalised names whose newest node landed in the recent window; null = Neo4j unreadable. */
  recentNames: number | null;
  /** Of those, names carried by MORE than one node. */
  recentSplit: number | null;
  /** Names whose newest node landed in the trailing baseline window (excluding recent). */
  baselineNames: number | null;
  baselineSplit: number | null;
}

export interface NameCollisionPollution {
  polluted: boolean;
  /**
   * Could the detector actually JUDGE this tick, or did it refuse? Consumers that act on
   * transitions — the alarm's edge state machine — MUST key on this and not on `polluted`, because a
   * refusal also reads `polluted: false`: during a sustained incident, one quiet week under the name
   * minimum would otherwise look like a judged recovery and send a "recovered" mail while the graph
   * is still splintering.
   */
  judgeable: boolean;
  recentShare: number | null;
  baselineShare: number | null;
  reason: string | null;
  /**
   * The machine-readable refusal cause (null = judged). ADDITIVE over the old contract: the
   * blindness meta-alarm's clock keys on it (`lib/graph/extraction-alert.refusalRunsClock`) and the
   * admin retrieval-health card renders it.
   */
  refusal: CensusRefusal | null;
}

const share = (part: number | null, total: number | null): number | null =>
  typeof part === "number" && typeof total === "number" && total > 0 ? part / total : null;

/**
 * Mirrors graphiti_core 0.29.3's `_normalize_string_exact` (dedup_helpers.py): lowercase, trim, and
 * COLLAPSE INTERNAL WHITESPACE RUNS. `toLower(trim(...))` alone would undercount splits that differ
 * by a whitespace run — the census's job is to match what the deployed wheel actually resolves by.
 */
export function normalizeEntityName(raw: string): string {
  return raw.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * The recent window's lower bound, as an ISO instant. ONE derivation, shared by the census's ledger
 * leg (`groupEpisodeFlows`, windowed on `projected_at`) and the entity-count leg
 * (`recentEntityCount`, windowed on Neo4j `n.created_at`).
 *
 * Single-sourced because `entitiesPerEpisode` divides one by the other: two independently-computed
 * spans would produce a ratio that is dimensionally wrong and looks perfectly reasonable — a number
 * on a card with no way to tell it apart from a measurement. Guarded in
 * `test/guards/entities-per-episode.test.ts`.
 */
export function censusRecentSince(nowMs: number): string {
  return new Date(nowMs - CENSUS_RECENT_MS).toISOString();
}

/**
 * The sentinel upper bound for a LIVE read — "no right edge". A far-future instant rather than a
 * conditionally-omitted clause, so there is exactly ONE query text: a Cypher `n.created_at <
 * datetime($until)` with a null `$until` evaluates to null and silently filters every row out, and
 * two query strings (bounded / unbounded) is how the bounded form ends up untested.
 */
export const CENSUS_UNBOUNDED_UNTIL = "9999-12-31T23:59:59.999Z";

/**
 * The recent window's UPPER bound. `null` ⇒ live (unbounded); a number ⇒ a retroactive span.
 *
 * The upper bound is not decoration. The retroactive pre-deploy baseline the verification table
 * depends on is a **span**, and a lower-bound-only query would sweep post-deploy nodes into the
 * "before" side — reading the patched extractor's behaviour as the baseline it is being compared
 * against. Shared by BOTH legs of `entitiesPerEpisode` for the same reason `censusRecentSince` is.
 */
export function censusRecentUntil(untilMs: number | null): string {
  return untilMs === null ? CENSUS_UNBOUNDED_UNTIL : new Date(untilMs).toISOString();
}

/** One per-raw-name row from the census Cypher (Cypher aggregates by the RAW name). */
export interface CensusNameRow {
  name: string | null;
  nodes: number;
  newest: string | null;
}

/**
 * Normalise, re-group, and window the per-name rows. Pure and TS-side by necessity: normalising
 * after a Cypher-side aggregation is impossible — two raw names that collapse to one arrive as
 * pre-aggregated totals that cannot be re-merged — so the aggregation lives on the TS side of the
 * normalisation, and the recency filter is applied here too. A name whose `newest` doesn't parse is
 * dropped from both windows (it cannot be windowed; safe, never accusing).
 */
export function windowNameCensus(rows: CensusNameRow[], nowMs: number): NameCollisionSignals {
  const byNorm = new Map<string, { nodes: number; newestMs: number | null }>();
  for (const row of rows) {
    if (typeof row.name !== "string") continue;
    const norm = normalizeEntityName(row.name);
    if (norm === "") continue;
    const nodes = Number(row.nodes) || 0;
    const newestMs = parseProbeTimestamp(row.newest);
    const prev = byNorm.get(norm);
    byNorm.set(
      norm,
      prev === undefined
        ? { nodes, newestMs }
        : {
            nodes: prev.nodes + nodes,
            newestMs:
              prev.newestMs === null
                ? newestMs
                : newestMs === null
                  ? prev.newestMs
                  : Math.max(prev.newestMs, newestMs),
          }
    );
  }
  const recentSince = nowMs - CENSUS_RECENT_MS;
  const baselineSince = nowMs - CENSUS_BASELINE_MS;
  let recentNames = 0;
  let recentSplit = 0;
  let baselineNames = 0;
  let baselineSplit = 0;
  for (const { nodes, newestMs } of byNorm.values()) {
    if (newestMs === null) continue;
    if (newestMs >= recentSince) {
      recentNames += 1;
      if (nodes > 1) recentSplit += 1;
    } else if (newestMs >= baselineSince) {
      baselineNames += 1;
      if (nodes > 1) baselineSplit += 1;
    }
  }
  return { recentNames, recentSplit, baselineNames, baselineSplit };
}

/**
 * The census read for one group: per-RAW-name rows (Cypher's implicit grouping), normalised and
 * windowed on the TS side (see `windowNameCensus`). `n.created_at` is EXTRACTION time, deliberately
 * not `valid_at` — same choice and same reason as the stall probe's `r.created_at`: a backfill must
 * be judged by what the extractor just did, not its content's age.
 */
export async function nameCollisionSignals(
  groupId: string,
  nowMs = Date.now()
): Promise<NameCollisionSignals> {
  const unknown: NameCollisionSignals = {
    recentNames: null,
    recentSplit: null,
    baselineNames: null,
    baselineSplit: null,
  };
  if (!neo4jConfigured()) return unknown;
  try {
    const rows = await runRead<CensusNameRow>(
      `MATCH (n:Entity {group_id: $g})
       RETURN n.name AS name, count(n) AS nodes, max(n.created_at) AS newest`,
      { g: groupId }
    );
    return windowNameCensus(rows, nowMs);
  } catch {
    return unknown; // unreadable → unknown, never degraded
  }
}

/* ────────────────────────────────────────────────────────────────────────────────────────────────
 * ENTITY YIELD PER EPISODE — the sensor for the failure the census is blind to (PIPEFF-2 / AIO-821).
 *
 * The same-item predecessor filter shipped in `graphiti/Dockerfile` PATCH 3 stops attaching ten
 * unrelated documents' chunks to every extraction call. Its plausible failure mode is NOT the
 * same-name split the census counts — it is **variant-name fragmentation** ("John" beside "John
 * Smith"), which the census sees as two different names and cannot detect by construction. What
 * variant fragmentation DOES move is the number of entity nodes a given volume of episodes produces,
 * so entity yield per episode is the metric that is actually sensitive to it.
 *
 * WHY IT NEEDED A NEW QUERY. The census returns per-name ALL-TIME node counts plus each name's
 * newest `created_at`; "entities created in the window" is NOT recoverable from that (a name with 5
 * nodes and a recent newest says nothing about how many of the 5 are new). All-time entities ÷
 * windowed episodes is dimensionally incoherent, drifts upward forever on a growing graph, and is
 * numerically dead: a week of +30% fragmentation on ~300 new episodes moves a ~5,400-episode
 * cumulative total by under 2%.
 *
 * ⚠️ OBSERVATIONAL ONLY, DELIBERATELY. This value feeds NO alert path — not
 * `deriveNameCollisionPollution`, not `lib/graph/extraction-alert`, not the graph leg's state. It is
 * rendered on the admin card and nothing else, because its band is UNDERIVED: the battery's ~7% was
 * single-rep noise on a 108-episode corpus, while prod's week-over-week content mix (a GitHub-heavy
 * week vs a Slack-heavy one) can legitimately move entity yield by more. A band invented now would
 * both false-fire and swallow real fragmentation. The band gets set from two weeks of measured prod
 * variation, in a later commit — the measured-not-chosen rule this workstream applies to every other
 * constant. Until then a movement is a prompt to LOOK, never a rollback trigger.
 *
 * Windowing by `created_at` is also what makes the before/after comparison possible at all: the
 * patch, the card and the graphiti rebuild ship in one merge, so a "pre-deploy reading from the card"
 * was uncapturable by construction. A `created_at`-windowed count reads the historical baseline out
 * of graph history AFTER the deploy.
 * ──────────────────────────────────────────────────────────────────────────────────────────────── */

/**
 * Entity nodes CREATED in the recent window for one group. Per group — and therefore tier-scoped,
 * since `group_id` is `<slug>_<tier>` and the group list comes from the team-scoped ledger (there is
 * no RLS backstop; see CLAUDE.md §5).
 *
 * `n.created_at` is EXTRACTION time, not `valid_at` — the same choice, for the same reason, as the
 * census and the stall probe: a backfill must be judged by what the extractor just did, not by how
 * old its content is.
 */
export async function recentEntityCount(
  groupId: string,
  nowMs = Date.now(),
  untilMs: number | null = null
): Promise<number | null> {
  if (!neo4jConfigured()) return null;
  try {
    const rows = await runRead<{ entities: number }>(
      `MATCH (n:Entity {group_id: $g})
       WHERE n.created_at >= datetime($since) AND n.created_at < datetime($until)
       RETURN count(n) AS entities`,
      { g: groupId, since: censusRecentSince(nowMs), until: censusRecentUntil(untilMs) }
    );
    // NOT `?? 0`. A `count(*)` always returns a row, so a missing one means the query did not run the
    // way this code thinks it did — and this file's own rule is that a zero which looks like a
    // measurement is worse than an admitted unknown.
    const raw = rows[0]?.entities;
    if (raw === undefined || raw === null) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null; // unreadable → unknown, never a zero that looks like a measurement
  }
}

/**
 * Entities created in the window ÷ episodes projected in the SAME window.
 *
 * `null` — never `Infinity`, never `NaN`, never `0` — whenever the ratio is not computable: an
 * unreadable leg, or a window in which nothing was projected. A divide-by-zero that renders as a
 * number is indistinguishable from a real reading on the card, which is the exact class of failure
 * this repo has been bitten by (a parser matching nothing "measured" zero). Pure, so every one of
 * those cases is testable without Neo4j.
 */
export function deriveEntitiesPerEpisode(
  entities: number | null,
  episodes: number | null
): number | null {
  if (entities === null || episodes === null) return null;
  if (!Number.isFinite(entities) || !Number.isFinite(episodes)) return null;
  if (episodes <= 0) return null; // no denominator ⇒ no measurement, not zero and not Infinity
  return entities / episodes;
}

export interface NameCollisionInput {
  /** `neo4jConfigured()` — false means there is no graph to protect (refusal: graph-unconfigured). */
  configured: boolean;
  signals: NameCollisionSignals;
  /**
   * Episodes projected for THIS group inside the recent window, from the Postgres `graph_episodes`
   * ledger (real pushes only — the `content_sha256 <> ''` sentinel excludes redaction bumps).
   * The census/ledger cross-check tripwire: null = ledger unreadable.
   */
  recentEpisodes: number | null;
}

/**
 * Is this group accumulating same-name entity splits at a rate its own history doesn't justify?
 *
 * Pure so every refusal-to-judge is testable without Neo4j. Every uncertain case returns
 * `polluted: false` — unknown must never read as degraded (the same contract
 * `deriveGraphExtractionStalled` keeps) — and carries a machine-readable `refusal` for the
 * blindness meta-alarm.
 *
 * The judging rules, stated (not left to be discovered):
 *  • ZERO split names over a real sample is a LEGAL, HEALTHY, JUDGED reading — 0.29.3 resolves
 *    exact normalised names deterministically, so 0 splits is the expected steady state. The old
 *    predicate's `zero ⇒ unjudgeable` rule is NOT carried forward.
 *  • At `baselineShare === 0` the relative margin rejects nothing, so ONLY the absolute floor
 *    judges.
 *  • A ZERO-NAME census is indistinguishable from a young group on its own, so it cross-checks the
 *    `graph_episodes` ledger: **at least `MIN_EPISODES_FOR_CENSUS_SUSPICION`** episodes projected in
 *    the window but zero census names ⇒ `predicate-suspect` (a graphiti bump renaming
 *    `Entity`/`created_at` — OR a stalled extractor; the alert mail names both); fewer than that ⇒ a
 *    genuinely young/quiet group (`small-sample`). "Young" is thereby defined by the ledger, the one
 *    source that knows whether anything was pushed. An unreadable ledger (`recentEpisodes: null`)
 *    reads as `small-sample`, never as an accusation.
 *
 *    The floor is load-bearing, not decoration (CENSUSFLOOR-1): this cross-check originally accused
 *    on ONE episode, and prod's `aios_external` — a single 196-char boilerplate index stub in the
 *    window — was rendered on the admin card as "stalled extractor" while that group in fact held 16
 *    entities. `small-sample` PARKS the blindness clock and `predicate-suspect` RUNS it, so the floor
 *    is also what stops a low-volume group from paging an install where nothing is wrong.
 *
 * `armed` defaults to `CENSUS_ALARM_ARMED` (rollout: false until margin/floor are measured); tests
 * pass `true` to pin the armed mechanics. While unarmed the verdict is clamped `polluted: false`
 * but `judgeable`/`refusal` compute in full — the meta-alarm layer needs them.
 */
export function deriveNameCollisionPollution(
  input: NameCollisionInput,
  armed = CENSUS_ALARM_ARMED
): NameCollisionPollution {
  const { configured, signals, recentEpisodes } = input;
  const recentShare = share(signals.recentSplit, signals.recentNames);
  const baselineShare = share(signals.baselineSplit, signals.baselineNames);
  const refuse = (refusal: CensusRefusal): NameCollisionPollution => ({
    polluted: false,
    judgeable: false,
    recentShare,
    baselineShare,
    reason: null,
    refusal,
  });
  if (!configured) return refuse("graph-unconfigured");
  if (
    signals.recentNames === null ||
    signals.recentSplit === null ||
    signals.baselineNames === null ||
    signals.baselineSplit === null
  ) {
    return refuse("graph-unreadable");
  }
  if (signals.recentNames === 0) {
    // The tripwire that replaced the old zero-predicate check — see the contract above. The floor is
    // what stops it accusing on no evidence (CENSUSFLOOR-1): below it, zero names is unremarkable.
    return (recentEpisodes ?? 0) >= MIN_EPISODES_FOR_CENSUS_SUSPICION
      ? refuse("predicate-suspect")
      : refuse("small-sample");
  }
  if (signals.recentNames < MIN_NAMES_FOR_CENSUS_SIGNAL) return refuse("small-sample");
  if (signals.baselineNames < MIN_NAMES_FOR_CENSUS_SIGNAL) return refuse("no-baseline");
  const rs = signals.recentSplit / signals.recentNames;
  const bs = signals.baselineSplit / signals.baselineNames;
  // Zero baseline share ⇒ the relative margin rejects nothing ⇒ the absolute floor judges alone.
  const overMargin = bs === 0 ? true : rs >= bs * CENSUS_MARGIN;
  const wouldPollute = rs >= CENSUS_ABSOLUTE_FLOOR && overMargin;
  const polluted = armed && wouldPollute;
  const pct = (n: number) => `${Math.round(n * 1000) / 10}%`;
  return {
    polluted,
    judgeable: true,
    recentShare: rs,
    baselineShare: bs,
    refusal: null,
    reason: polluted
      ? `Extraction is accumulating same-name duplicate entities: ${pct(rs)} of entity names active ` +
        `in the last ${Math.round(CENSUS_RECENT_MS / 86_400_000)} days are carried by more than one ` +
        `node, against ${pct(bs)} for this graph's own baseline. That is the signature of embedding ` +
        `candidate retrieval missing existing nodes or an extraction model resolving identity badly — ` +
        `check the Extraction model in Admin → Integrations.`
      : null,
  };
}

/** Per-group episode flow from the Postgres ledger — the census's cross-check + the alarm's
 *  release valve. Real pushes only (`content_sha256 <> ''`, same sentinel as `newestEpisodeAtMs`). */
interface GroupEpisodeFlow {
  recentEpisodes: number;
  baselineEpisodes: number;
  /** Across the FULL recent+baseline span — zero means nothing is being extracted into the group. */
  spanEpisodes: number;
}

async function groupEpisodeFlows(
  teamId: string | null,
  nowMs: number,
  untilMs: number | null = null
): Promise<Map<string, GroupEpisodeFlow> | null> {
  try {
    // The SAME span helpers the entity-count leg uses — `entitiesPerEpisode` divides one by the
    // other, so neither edge may become a second, independently-computed window.
    //
    // Only the RECENT leg takes the upper bound. `baseline` and `span` are live-alarm concepts (the
    // trailing comparison window and the release valve); bounding them would change what the
    // pollution alarm judges, which this sensor is explicitly not allowed to do. For every live
    // caller `untilMs` is null ⇒ the sentinel ⇒ byte-identical behaviour to an unbounded filter.
    const recentSince = censusRecentSince(nowMs);
    const recentUntil = censusRecentUntil(untilMs);
    const baselineSince = new Date(nowMs - CENSUS_BASELINE_MS).toISOString();
    const params: unknown[] = [recentSince, baselineSince, recentUntil];
    let where = "";
    if (teamId !== null) {
      params.push(teamId);
      where = "where team_id = $4";
    }
    const res = await runSql<{ group_id: string; recent: number; baseline: number; span: number }>(
      `select group_id,
              count(*) filter (where projected_at >= $1 and projected_at < $3 and content_sha256 <> '')::int as recent,
              count(*) filter (where projected_at >= $2 and projected_at < $1 and content_sha256 <> '')::int as baseline,
              count(*) filter (where projected_at >= $2 and content_sha256 <> '')::int as span
         from graph_episodes ${where}
        group by group_id`,
      params
    );
    return new Map(
      res.rows.map((r) => [
        r.group_id,
        {
          recentEpisodes: Number(r.recent) || 0,
          baselineEpisodes: Number(r.baseline) || 0,
          spanEpisodes: Number(r.span) || 0,
        },
      ])
    );
  } catch {
    return null;
  }
}

/** One group's census + ledger flow + derived verdict — the unit every surface consumes. */
export interface GroupCensus {
  group: string;
  signals: NameCollisionSignals;
  recentEpisodes: number | null;
  baselineEpisodes: number | null;
  spanEpisodes: number | null;
  pollution: NameCollisionPollution;
  /** Entity nodes CREATED in the recent window (PIPEFF-2). Null = graph unreadable/unconfigured. */
  recentEntities: number | null;
  /** `recentEntities / recentEpisodes`, both over the recent window — observational, see the
   *  section header above. Null when either leg is unknown or the window projected nothing. */
  entitiesPerEpisode: number | null;
}

/**
 * The census across every group the `graph_episodes` ledger knows (scoped to a team when `teamId`
 * given; instance-wide for the scheduled alarm when null). Group enumeration is LEDGER-DEFINED on
 * purpose — the ledger is the one source that knows what was pushed, so a group that exists only in
 * Neo4j (never projected by this install) is not this alarm's to judge. Best-effort: an unreadable
 * ledger returns [] and every caller degrades quietly.
 *
 * `untilMs` (PIPEFF-2, default null = live) puts a right edge on the `entitiesPerEpisode` legs —
 * BOTH of them, which is the whole point: it is what makes the retroactive pre-deploy baseline
 * readable from THIS surface instead of a hand-written Cypher whose window is derived independently
 * of `censusRecentSince`. It does not move the census/alarm legs (see `groupEpisodeFlows`).
 */
export async function groupCensuses(
  teamId: string | null,
  nowMs = Date.now(),
  untilMs: number | null = null
): Promise<GroupCensus[]> {
  const flows = await groupEpisodeFlows(teamId, nowMs, untilMs);
  if (flows === null) return [];
  const configured = neo4jConfigured();
  const unknown: NameCollisionSignals = {
    recentNames: null,
    recentSplit: null,
    baselineNames: null,
    baselineSplit: null,
  };
  return Promise.all(
    [...flows.entries()].map(async ([group, flow]) => {
      const [signals, recentEntities] = configured
        ? await Promise.all([
            nameCollisionSignals(group, nowMs),
            recentEntityCount(group, nowMs, untilMs),
          ])
        : ([unknown, null] as const);
      return {
        group,
        signals,
        recentEpisodes: flow.recentEpisodes,
        baselineEpisodes: flow.baselineEpisodes,
        spanEpisodes: flow.spanEpisodes,
        // `recentEntities`/`entitiesPerEpisode` are deliberately NOT passed to
        // `deriveNameCollisionPollution` — the yield sensor is observational and must not be able to
        // move an alarm verdict (PIPEFF-2; its band is underived until prod measurement exists).
        pollution: deriveNameCollisionPollution({
          configured,
          signals,
          recentEpisodes: flow.recentEpisodes,
        }),
        recentEntities,
        entitiesPerEpisode: deriveEntitiesPerEpisode(recentEntities, flow.recentEpisodes),
      };
    })
  );
}
