import "server-only";
import { runSql } from "@/lib/db/pg/pool";
import { ITEM_EPISODE_PREFIX } from "./episode-name";
import { neo4jConfigured, runRead } from "./neo4j";
// The age gate's grace, IMPORTED rather than restated (STALLSCOPE-1 §2d): `lib/graph/reconcile` already
// owns "an episode legitimately isn't in the graph yet" for this exact seam, derived from the projector
// cadence. Two independent readings of one idea is the drift shape this repo keeps getting bitten by.
// Stated coupling: it tracks `GRAPH_PROJECT_MINUTES`, so tuning the projector to a 5-minute cadence also
// cuts this grace to 5 minutes — tolerable only because the corroboration in `deriveExtractionVerdict`,
// not the grace, is what carries the cold-start case.
import { LANDED_GRACE_MS } from "./reconcile";

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
 *     `facts` WAS global and deliberately un-scoped here ("has the extractor ever produced anything at
 *     all" is an install-level question). STALLSCOPE-1 scoped it — see the bullet below; this sentence
 *     is kept in the past tense rather than deleted because the global reading is what made the
 *     never-extracted half undetectable per team, and that is the reason the scoping exists.
 *     WHAT THE SCOPING DID NOT FIX, and STALLSCOPE-1 now does: a team whose groups held ZERO episode
 *     nodes read `max() = null` ⇒ "can't tell" ⇒ green, and on a MULTI-TEAM install another team's
 *     facts kept the global `facts === 0` branch quiet too, so a team whose extraction had never once
 *     succeeded was silent on both halves — the very "202 accepted, nothing processed" shape this
 *     probe was built for. Both halves are closed below: liveness is a DISCRIMINATED return
 *     (`ExtractionLiveness`) so "read fine, found nothing" is expressible, and the fact count is
 *     scoped to the team's ledger groups.
 *   • A missing/unparseable timestamp still reads as "could not read" — safe, and now visible as a
 *     distinct kind rather than an indistinguishable null.
 *   • Detection lags by the budget (6h) on the lag branch, and by the first-completion grace on the
 *     zero-evidence branches, by construction.
 *   • QUEUE DEPTH, not extraction failure, is the innocent reading of "nothing has completed for us"
 *     on a multi-tenant install — so the loud path for those branches requires positive evidence that
 *     the worker is serving OTHER groups' item episodes. On a single-team install that evidence cannot
 *     exist, which is correct: with no other tenant there is no queue to be stuck behind.
 *
 * Best-effort: nulls/`stalled:false` on any error so it never breaks a page render.
 */

/** Below this many distinct ITEMS projected we can't distinguish "extractor broken" from "fresh
 *  install still mid-first-extraction" (Graphiti processes async), so we don't flag. With a working
 *  extractor, 25 accepted ITEMS — one or more episodes each — reliably yield ≥1 fact; 0 facts past that
 *  is unambiguous breakage. (The old wording said "25 accepted episodes" about a count of items, which
 *  is the unit error this rename exists to stop.)
 *
 *  RENAMED from `MIN_EPISODES_FOR_EXTRACTION_SIGNAL` (STALLSCOPE-1). The quantity compared against it
 *  has counted distinct ITEMS since PCCC-3 — one item holds one ledger row per group under fan-out,
 *  and one item is one-or-more chunk EPISODES. The unit error is safe in DIRECTION (items ≤ episodes,
 *  so the floor waits longer than its contract asks) but a constant whose name misdescribes its own
 *  quantity is how the next reader re-derives it wrongly, and the card was rendering the same number
 *  labelled "episodes". */
export const MIN_ITEMS_FOR_EXTRACTION_SIGNAL = 25;

/** How far the newest FACT may trail the newest EPISODE before extraction counts as stopped.
 *
 *  Extraction is serial and roughly 10-20s per episode, so facts always trail — the budget has to
 *  absorb a normal backlog without paging anyone. Six hours is well past any healthy queue and well
 *  short of the hours this went unnoticed for. Measured against the newest EPISODE, never against
 *  `now`: a team that projected nothing for a week has legitimately old facts, and comparing to the
 *  wall clock would cry stall on every quiet team. */
export const EXTRACTION_LAG_BUDGET_MS = 6 * 3_600_000;

/** How far into the FUTURE the queue corroborator's clock may sit and still count as evidence.
 *
 *  Graphiti stamps `created_at` from its own container clock, so a few seconds of skew against this
 *  process is ordinary and a stamp hours ahead is not — it means a clock is wrong. The tolerance
 *  matters because the corroborator can only SUPPRESS: without a bound, one future-dated episode node
 *  would mute the alarm for as long as it stayed in the future, which is the "an alarm that quietly
 *  declines to fire" failure this family exists to remove. Found by review. */
export const WORKER_CLOCK_SKEW_TOLERANCE_MS = 5 * 60_000;

export interface GraphExtractionHealth {
  items: number | null; // distinct ITEMS projected for this team (Postgres ledger; see the floor's note)
  facts: number | null; // extracted RELATES_TO facts in THIS TEAM's groups (null = Neo4j unreadable)
  stalled: boolean; // episodes are landing but not becoming facts → extractor failing
  /** The extractor is accumulating same-name duplicate entities above this graph's own baseline
   *  (the name-collision census, ALARMFIX-1) — a DIFFERENT failure from `stalled`: extraction is
   *  working, and producing bad knowledge. Kept as its own flag rather than folded into `stalled`
   *  because the two send an operator to different places (service logs vs the Extraction model
   *  picker). */
  censusPolluted: boolean;
  reason: string | null; // human-facing cause when stalled OR polluted
  /**
   * A TRUE, non-loud statement for the admin card when a zero-evidence state is SUPPRESSED because
   * the graph worker is provably completing other work (STALLSCOPE-1 §2e). Never reaches the pipeline
   * banner — `lib/ingest/pipeline-health` keys the loud synthetic leg on `stalled` alone — because
   * "your items are queued behind someone else's" is not "the brain isn't getting fresh data".
   */
  observation: string | null;
}

/**
 * Did the graph ANSWER, and what did it say? The whole point of STALLSCOPE-1 (§2a).
 *
 * `newestEpisodicAtMs` used to return `number | null`, where `null` meant five different things:
 * Neo4j unconfigured, the read threw, the stamp was unparseable, there was no ledger scope to query,
 * and — the one that matters — THE READ SUCCEEDED AND FOUND NOTHING. The predicate mapped all five to
 * "can't tell", which is right for four of them and silently discards the fifth: zero completed jobs
 * against a ledger that says thousands of items were pushed is evidence, not the absence of it.
 *
 * `none` means exactly "no `items:`-prefixed episode node currently exists in these groups" — NOT
 * "the extractor is dead". Everything that turns that observation into an accusation is in
 * `deriveExtractionVerdict` and the copy, where it can be argued with.
 */
export type ExtractionLiveness =
  | { kind: "unreadable" }
  | { kind: "none" }
  | { kind: "at"; atMs: number };

export interface ExtractionSignals {
  /** Distinct ITEMS with a real (non-sentinel) ledger row for this team; null = ledger unreadable. */
  items: number | null;
  /** Oldest `first_seen_at` in that population — the SET-ONCE clock the age gate needs (§2d). */
  firstSeenAtMs: number | null;
  facts: number | null;
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
  /** Newest `graph_episodes.projected_at` (ms) — when WE last pushed. */
  newestPushAtMs: number | null;
  /**
   * The liveness signal (STALLPROBE-1), now discriminated (STALLSCOPE-1). The episode node's
   * EXISTENCE proves a job completed; its `created_at` is the job's START instant.
   *
   * REQUIRED, deliberately. The first version of this field was optional with "omitted ⇒ old
   * behaviour", and that is exactly how the second call site (`lib/query/retrieval-health`, the
   * surface that produced the bug report) stayed unwired while every test passed. Required makes
   * omission a typecheck failure — a build-failing guard instead of a thing to remember.
   */
  liveness: ExtractionLiveness;
  /**
   * The GLOBAL episodic clock — is the graph worker completing ANYTHING, for anyone?
   *
   * This is the same un-scoped read STALLPROBE-1 deleted as this team's CLOCK, and re-adding it needs
   * the distinction stated: it is not a clock here and it can only ever SUPPRESS loudness. It never
   * accuses, never feeds the lag branch, and never suppresses the card observation. The masking that
   * made a global read wrong as a clock — another team's healthy job refreshing yours — is exactly the
   * property that makes it right as "is the worker alive": a serial worker completing someone else's
   * backlog is why a cold team can have no completion of its own for hours (measured: prod extracts
   * ~1 episode/minute, and its own first ingest hour queued 175 items).
   */
  workerLiveness: ExtractionLiveness;
  /** Wall clock, injected so the age gate is testable. */
  nowMs: number;
}

/** WHICH stall this is — the discriminator both surfaces branch on, and the single writer of what may
 *  be CLAIMED. Renamed wholesale by STALLSCOPE-1 so every consumer breaks at compile time: the old
 *  `never-extracted` asserted a dead worker and the rejected `zero-yield` asserted a yield regression,
 *  and neither is implied by the evidence that produces them. */
/**
 * An ARRAY first, with the type derived from it, because a union alone has no runtime value and
 * therefore cannot be iterated by a test. A mutation proved that matters: the card's copy map was typed
 * `Record<ExtractionStallCause, …>`, which correctly reddens `tsc` when an entry is DELETED — but
 * swapping that annotation for `Record<string, …>` and adding a fourth cause compiles perfectly, and
 * the new cause silently renders the `stopped` wording. That is the same "the guard is satisfiable by
 * editing the guard" shape two reviewers found in LLMOBS-1. With the causes enumerable at runtime, the
 * copy tests iterate them and a cause with no distinct sentence reddens whatever the annotations say.
 */
export const EXTRACTION_STALL_CAUSES = ["no-facts", "no-completion-visible", "stopped"] as const;
export type ExtractionStallCause = (typeof EXTRACTION_STALL_CAUSES)[number];

export interface ExtractionVerdict {
  stalled: boolean;
  cause: ExtractionStallCause | null;
  /** Machine-readable, like `cause`: a state that is TRUE and worth showing but must not go loud. */
  observed: "queued-behind-worker" | null;
}

/**
 * Pure verdict: is this team's extraction broken, and may we say so LOUDLY? (STALLSCOPE-1 §2e.)
 *
 * Three branches, and the difference between them is what evidence each rests on:
 *
 *  • THE LAG BRANCH measures from an actual completion, so it has standing evidence by construction:
 *    never age-gated, never suppressed. (Draft 2 of the spec gated it and contradicted itself — a
 *    mature team is inside the grace for one window after the migration backfill, which must not
 *    silence a real stall.)
 *  • THE ZERO-EVIDENCE BRANCHES (`facts === 0`, and "no job has ever completed here") rest on an
 *    ABSENCE, and an absence has two innocent explanations this predicate has to rule out before it
 *    goes loud: the team started pushing moments ago (the age gate), or the serial worker is busy with
 *    someone else's backlog (the corroboration). Measured: prod cleared the 25-item floor 17 SECONDS
 *    after its first push, and extracts ~1 episode/minute, so a cold team behind an ordinary first
 *    ingest hour (175 items) legitimately has no completion of its own for hours. No constant bounds
 *    that; evidence does.
 *  • BELOW THE FLOOR nothing is emitted at all — not even the observation.
 *
 * "Don't know" must never read as "broken" — the standing rule at the top of this file — but note
 * where it now stops applying: `facts === 0` can only come from a SUCCESSFUL read, so it stays able to
 * accuse even when the liveness read failed. The reviewers split on that (one wanted both reads to
 * answer, one called the veto a detection loss); the veto lost, because a query-specific timeout on one
 * of two independent Neo4j sessions would otherwise silence the exact 2026-07 outage shape, and the
 * cost of keeping it is only that `no-facts` copy may claim nothing about completions — which it doesn't.
 */
export function deriveExtractionVerdict(input: ExtractionSignals): ExtractionVerdict {
  const quiet: ExtractionVerdict = { stalled: false, cause: null, observed: null };
  const { items, facts, liveness, workerLiveness, nowMs } = input;
  // Too few items to judge either way — a fresh install may still be mid-first-extraction. Also the
  // ledger-unreadable and empty-ledger cases, which are an absence of evidence about everything.
  if (items === null || items < MIN_ITEMS_FOR_EXTRACTION_SIGNAL) return quiet;

  // ── THE LAG BRANCH ────────────────────────────────────────────────────────────────────────────
  // LIVENESS IS THE EPISODE NODE, NOT THE FACTS (STALLPROBE-1).
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
  const newestPush = input.newestPushAtMs ?? null;
  const lagStalled =
    liveness.kind === "at" &&
    newestPush !== null &&
    newestPush - liveness.atMs > EXTRACTION_LAG_BUDGET_MS;
  const stopped: ExtractionVerdict = { stalled: true, cause: "stopped", observed: null };

  // ── THE ZERO-EVIDENCE BRANCHES ────────────────────────────────────────────────────────────────
  // `facts === 0` outranks "nothing completed": both are true in that cell, and the fact count is the
  // more specific claim. Facts include those extracted from `correction:<arc_id>` episodes (which have
  // no ledger row), so `facts > 0` does NOT imply item extraction ever ran — hence the second branch.
  const zeroEvidence: ExtractionStallCause | null =
    facts === 0 ? "no-facts" : liveness.kind === "none" ? "no-completion-visible" : null;
  if (zeroEvidence === null) return lagStalled ? stopped : quiet;

  // AGE GATE — a SET-ONCE clock (`first_seen_at`), never `projected_at`, which every re-push bumps.
  const gatePassed = input.firstSeenAtMs !== null && nowMs - input.firstSeenAtMs > LANDED_GRACE_MS;
  if (!gatePassed) return lagStalled ? stopped : quiet;

  // CORROBORATION — but ONLY where the team has no evidence of its own.
  //
  // Queue depth is the innocent explanation for "nothing has completed for US". It is NOT an
  // explanation for "jobs complete for us and produce no facts": the team's own completions disprove
  // the queue hypothesis outright, and `origin/main` kept that state loud on purpose ("an extractor
  // that runs to completion and still produces zero facts IS broken"). The first version of this
  // corroboration applied to every zero-evidence cell and silently reversed that — found by review,
  // and the reason it slipped through is that the check was a superset of the signal it was checking.
  const teamHasOwnEvidence = liveness.kind === "at";
  // Suppression requires POSITIVE evidence of another tenant being served: an unreadable clock
  // corroborates nothing and suppresses nothing. A materially FUTURE stamp is not evidence either —
  // clock skew between the graph store and this process is seconds, so a stamp beyond that tolerance
  // means something is wrong with a clock, and "wrong clock" must not be able to mute an alarm forever.
  const workerAgeMs = workerLiveness.kind === "at" ? nowMs - workerLiveness.atMs : null;
  const workerBusy =
    !teamHasOwnEvidence &&
    workerAgeMs !== null &&
    workerAgeMs >= -WORKER_CLOCK_SKEW_TOLERANCE_MS &&
    workerAgeMs <= EXTRACTION_LAG_BUDGET_MS;
  if (workerBusy) {
    // Still true, still worth showing — just not "the brain isn't getting fresh data".
    return lagStalled ? stopped : { stalled: false, cause: null, observed: "queued-behind-worker" };
  }
  return { stalled: true, cause: zeroEvidence, observed: null };
}

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

/**
 * This TEAM's facts and its newest one — ONE read, two numbers (STALLSCOPE-1 §2b).
 *
 * SCOPED, where `countGraphFacts` was global. That global count is what kept the never-extracted half
 * permanently disarmed on any install holding facts from anywhere else: `facts === 0` was false forever
 * for the team that was actually broken. Scoping is a NARROWING, and a narrowed count that reads zero
 * ACCUSES — so the copy names a group-id/scheme mismatch as a possible cause rather than asserting a
 * dead worker. (It does NOT name graphiti "normalising" group ids: the pinned wheel validates and
 * raises, never rewrites — `graphiti_core/helpers.py:136`. A mismatch can only come from an app-side
 * scheme change or a stale ledger.)
 *
 * ONE query, not two, so the count on the card and the "newest fact" beside it cannot come from two
 * populations or two instants — the same rule that made `newestEpisodeAtMs` shared rather than
 * reimplemented. `r.created_at` and NOT `valid_at`: graphiti backdates `valid_at` to the episode's work
 * time, so a fact extracted five minutes ago about a month-old thread carries a month-old `valid_at`,
 * which is right for display and catastrophic for a health probe chewing through a backfill.
 *
 * Index-supported by `relation_group_id` on `()-[e:RELATES_TO]-() ON (e.group_id)`
 * (`graphiti_core/graph_queries.py:68`). NO performance claim is made — an earlier slice made one about
 * a label scan and had to withdraw it; the scoping is for correctness.
 *
 * `facts: null` (never `0`) when unconfigured, when the read throws, or when there is no scope: an
 * `IN []` match returns a genuine `0` that would read as a proven-empty graph.
 */
async function readTeamFacts(
  groupIds: string[]
): Promise<{ facts: number | null; newestFactAtMs: number | null }> {
  const unknown = { facts: null, newestFactAtMs: null };
  if (!neo4jConfigured() || groupIds.length === 0) return unknown;
  try {
    const rows = await runRead<{ n: number; at: string | null }>(
      "MATCH ()-[r:RELATES_TO]->() WHERE r.group_id IN $g RETURN count(r) AS n, toString(max(r.created_at)) AS at",
      { g: groupIds }
    );
    const raw = rows[0]?.n;
    // NOT `?? 0`: a `count()` always returns a row, so a missing one means the query did not run the
    // way this code thinks it did — and a zero that looks like a measurement is this file's own banned
    // pattern, in the direction that accuses.
    if (raw === undefined || raw === null) return unknown;
    const n = Number(raw);
    if (!Number.isFinite(n)) return unknown;
    return { facts: n, newestFactAtMs: parseProbeTimestamp(rows[0]?.at ?? null) };
  } catch {
    return unknown;
  }
}

/** Everything the ledger knows about this team's pushes, from ONE statement (STALLSCOPE-1 §2c). */
export interface LedgerRead {
  /** `unreadable` = the query threw; `empty` = it answered and this team has pushed nothing real. */
  kind: "unreadable" | "empty" | "read";
  /** Distinct ITEMS (not rows). 0 unless `kind === "read"`. */
  items: number;
  /** Oldest `first_seen_at` — the set-once age-gate clock. */
  firstSeenAtMs: number | null;
  /** Newest `projected_at` among REAL pushes — the other half of the lag comparison. */
  newestPushAtMs: number | null;
  /**
   * Newest `projected_at` over ANY row, sentinel included — deliberately a different population from
   * `newestPushAtMs`, and that difference is why they must come from one pass rather than two reads
   * that can drift. This one answers "is the projector alive at all", and a redaction pass IS the
   * projector doing work; the lag comparison needs the newest episode actually PUSHED, since a
   * redaction wave bumps the ledger with nothing for graphiti to extract.
   *
   * Carried over from the `graphFreshness` read this replaced (PCCC-5's amendment to it): the same
   * stance covers PCCC-5's DEFERRED bookkeeping inserts — a cold initiative's withheld row counts as
   * projector liveness here and is excluded from `items`/`newestPushAtMs`/`groups` by the sentinel
   * filter, because this field asks "is the projector running" and those ask "did content ship".
   */
  lastProjectedAt: string | null;
  /** The `group_id`s this team has actually pushed into — the scope for both graph reads. */
  groups: string[];
}

/**
 * ONE statement, one snapshot — because these four values are compared against each other.
 *
 * Before this they were two concurrent reads (a count and a distinct-group scan), so an insert, a
 * purge or a sentinel transition landing between them could produce `items > 0` with `groups === []`:
 * a team that looks pushed-but-unscoped, which is exactly the shape that decides whether an absence of
 * graph evidence is allowed to accuse. A named producer does not close that race; one statement does.
 *
 * `content_sha256 <> ''` is load-bearing, not tidiness, and the set of things it excludes keeps GROWING
 * — it is now FOUR kinds of row rather than the original two: redaction/blanking tombstones and
 * tier-vacate rows (both park on the `""` sentinel while POSTing nothing), UNLANDED RESERVATIONS
 * (PCCC-3's reserve-before-push), and DEFERRED fan-out rows (PCCC-5: extraction deliberately withheld
 * for a cold initiative, `project.ts` inserting `content_sha256: ""`). None of the four was ever
 * accepted by graphiti, so counting them would inflate the floor that licenses an accusation and, worse,
 * a redaction wave would read as "episodes just landed" and the lag check would go red on a healthy
 * extractor six hours later. Real pushes always store a 64-char digest (even `sha("")`) — which is why
 * the filter keeps working as new sentinel meanings arrive, but each new one is a reason to re-check
 * that it does rather than assume it.
 *
 * `count(distinct (source_table, source_id))` is PCCC-3's expression, kept verbatim: the ledger's
 * identity is per-(item, group), so under fan-out one item holds several rows and `count(*)` would
 * inflate the floor by the average partition count.
 */
async function readLedger(teamId: string): Promise<LedgerRead> {
  try {
    const res = await runSql<{
      items: number | string;
      first_seen_at: string | null;
      newest_push_at: string | null;
      last_projected_at: string | null;
      groups: string[] | null;
    }>(
      `select count(distinct (source_table, source_id)) filter (where content_sha256 <> '')::int as items,
              min(first_seen_at) filter (where content_sha256 <> '')::text as first_seen_at,
              max(projected_at) filter (where content_sha256 <> '')::text as newest_push_at,
              max(projected_at)::text as last_projected_at,
              array_agg(distinct group_id) filter (where content_sha256 <> '') as groups
         from graph_episodes
        where team_id = $1`,
      [teamId]
    );
    const row = res.rows[0];
    const items = Number(row?.items ?? 0);
    const lastProjectedAt = row?.last_projected_at ?? null;
    if (!Number.isFinite(items) || items <= 0) {
      return {
        kind: "empty",
        items: 0,
        firstSeenAtMs: null,
        newestPushAtMs: null,
        lastProjectedAt,
        groups: [],
      };
    }
    return {
      kind: "read",
      items,
      firstSeenAtMs: parseProbeTimestamp(row?.first_seen_at ?? null),
      newestPushAtMs: parseProbeTimestamp(row?.newest_push_at ?? null),
      lastProjectedAt,
      // `array_agg` over an aggregate with no rows is null; over rows it can still hold a null member
      // if the column ever were nullable. Filtered either way — a null group id must never widen a
      // scope, and an empty scope must never be read as a proven-empty graph.
      groups: (row?.groups ?? []).filter((g): g is string => typeof g === "string" && g.length > 0),
    };
  } catch {
    return {
      kind: "unreadable",
      items: 0,
      firstSeenAtMs: null,
      newestPushAtMs: null,
      lastProjectedAt: null,
      groups: [],
    };
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
async function readEpisodicLiveness(groupIds: string[]): Promise<ExtractionLiveness> {
  if (!neo4jConfigured() || groupIds.length === 0) return { kind: "unreadable" };
  try {
    const rows = await runRead<{ at: string | null }>(
      "MATCH (e:Episodic) WHERE e.group_id IN $g AND e.name STARTS WITH $p AND e.created_at IS NOT NULL RETURN toString(max(e.created_at)) AS at",
      { g: groupIds, p: ITEM_EPISODE_PREFIX }
    );
    return livenessFromMax(rows);
  } catch {
    return { kind: "unreadable" };
  }
}

/**
 * "Is the worker completing item extraction for SOMEONE ELSE right now?" — the queue-depth
 * corroborator, and every word of that question is load-bearing.
 *
 * WHY IT EXISTS. A cold team can have no completion of its own for hours while nothing is wrong: the
 * graphiti worker is serial, so this team's first episode sits behind whatever is already queued
 * (measured: ~1 episode/minute, and prod's own first ingest hour queued 175 items). No time constant
 * distinguishes that from a dead extractor — evidence does.
 *
 * WHY IT EXCLUDES THIS TEAM'S GROUPS, which the first version did not. Review killed that version, and
 * the reasoning is worth keeping: an unfiltered global max is a SUPERSET of the team-scoped max, so
 * whenever the team's own liveness said `at`, "the worker is busy" was true BY CONSTRUCTION — and the
 * `at` + zero-facts state, which `origin/main` deliberately kept LOUD ("an extractor that runs to
 * completion and still produces zero facts IS broken"), silently became a non-loud note. A corroborator
 * built from a superset of the thing it is corroborating cannot corroborate anything.
 *
 * WHY IT FILTERS `items:` TOO. Without it, one `correction:<arc_id>` episode — which `lib/graph/arcs.ts`
 * POSTs with no ledger row, and which is exactly what the TEAM clock had to exclude for the same
 * reason — would mark the worker busy and suppress the alarm for the whole budget. That is the bug
 * STALLPROBE-1 fixed on the team clock, arriving one layer out.
 *
 * On a SINGLE-TEAM install this therefore reads `none` and suppresses nothing, which is correct: with
 * no other tenant there is no queue to be stuck behind, so an absence of your own completions is about
 * your extractor. It can only ever SUPPRESS loudness — it never accuses, never feeds the lag branch,
 * and never suppresses the card observation.
 *
 * A different alias (`w:`) than the scoped query above, on purpose: the source-level test that pins the
 * scoped query's filters anchors on `"MATCH (e:Episodic)`, and a second literal opening with the same
 * text would let it pin the wrong query and pass for the wrong reason.
 */
async function readWorkerLiveness(excludeGroupIds: string[]): Promise<ExtractionLiveness> {
  if (!neo4jConfigured()) return { kind: "unreadable" };
  try {
    const rows = await runRead<{ at: string | null }>(
      "MATCH (w:Episodic) WHERE NOT w.group_id IN $g AND w.name STARTS WITH $p AND w.created_at IS NOT NULL RETURN toString(max(w.created_at)) AS at",
      { g: excludeGroupIds, p: ITEM_EPISODE_PREFIX }
    );
    return livenessFromMax(rows);
  } catch {
    return { kind: "unreadable" };
  }
}

/**
 * One `max()` row → a liveness kind. The discrimination this slice exists for lives here:
 *   • no row at all       ⇒ `unreadable`. A `max()` aggregation always returns one row, so its absence
 *                           means the query did not run the way this code thinks it did.
 *   • a row, `at` null    ⇒ `none`. THE READ SUCCEEDED AND FOUND NOTHING — the case that used to be
 *                           indistinguishable from a failure and was therefore thrown away.
 *   • a row, unparseable  ⇒ `unreadable`. A format we cannot read is not a measurement (a Neo4j upgrade
 *                           emitting a bracketed named zone would land here rather than silently
 *                           disarming the check).
 */
function livenessFromMax(rows: { at: string | null }[]): ExtractionLiveness {
  if (rows.length === 0) return { kind: "unreadable" };
  const raw = rows[0]?.at ?? null;
  if (raw === null) return { kind: "none" };
  const atMs = parseProbeTimestamp(raw);
  return atMs === null ? { kind: "unreadable" } : { kind: "at", atMs };
}

/**
 * The operator sentence for a stall. Pure, and the ONLY place either surface's copy is written.
 *
 * Every sentence here is constrained by what its cell of the state table actually proves — the defect
 * class this whole family exists to remove is an alarm asserting something beside its own contradicting
 * evidence. So: `no-facts` may not claim anything about completions except what `liveness` says;
 * `no-completion-visible` may not print a fact count it does not have and may not assert a dead worker as the
 * only cause; neither may name a `group_id` (the copy says "this team's graph groups").
 *
 * `lagHours` is hours between the newest PUSHED episode and the newest COMPLETED job — start-stamped,
 * overstating in the accusing direction. Null renders as "for some time" rather than "for nullh".
 */
export function extractionStallReason(
  cause: ExtractionStallCause,
  args: {
    items: number | null;
    facts: number | null;
    lagHours: number | null;
    liveness: ExtractionLiveness;
  }
): string {
  const items = args.items ?? 0;
  if (cause === "no-facts") {
    // What the liveness read is allowed to add — and nothing more. The `at` clause deliberately quotes
    // no age: `lagHours` measures push-minus-completion, not the completion's age, and printing one as
    // the other is the same class of error as the fact-lag/liveness conflation STALLPROBE-1 removed.
    // The `at` clause is RECENCY-aware: `no-facts` outranks the lag branch, so this cell is reachable
    // with a completion OLDER than the budget, where "jobs are completing" would be false (review).
    const stale = args.lagHours !== null && args.lagHours > EXTRACTION_LAG_BUDGET_MS / 3_600_000;
    const completions =
      args.liveness.kind === "none"
        ? "The graph holds no completed episode in this projector's format for those groups at all."
        : args.liveness.kind === "at"
          ? stale
            ? `Jobs have completed for those groups before, but the newest one is about ${args.lagHours}h behind the newest push, so extraction has also stopped.`
            : "Jobs ARE completing for those groups, so this is not simply a dead worker."
          : "Whether any job is completing could not be read from the graph just now.";
    return `${items} items have been projected for this team, but the graph holds 0 extracted facts in this team's graph groups. ${completions} Possible causes, none of them yet established: extraction completing while extracting no relations (a prompt or schema change on a graphiti upgrade), content that yields none, a change to the group-id or episode-name scheme, or a graph-store restore. Check the graphiti service logs for the actual error. Narrative arcs and the Learning panel have nothing to run on for this team.`;
  }
  if (cause === "no-completion-visible") {
    // `facts === null` is UNKNOWN (Neo4j unreadable), not zero. Printing "0 facts" there is this file's
    // own banned pattern — a zero indistinguishable from a measurement — in the one sentence an
    // operator acts on.
    const held =
      args.facts === null
        ? "The fact count for those groups is currently unreadable."
        : `The graph does hold ${args.facts} facts in those groups — arc corrections write facts with no ledger row behind them, so facts alone do not prove item extraction ran.`;
    return `The graph currently holds no completed episode in this projector's format for this team's graph groups, though ${items} items have been projected. ${held} Causes: the extraction worker failing every job for these groups; a graph-store wipe or restore; or a change to the group-id or episode-name scheme. A wipe DOES self-heal — reconcile re-queues never-landed rows and the projector re-pushes them — but only at the re-queue drip rate (a bounded number of items per team per cycle), so a real corpus takes days; the fast repair is a forced re-projection. Check the graphiti service logs for the actual error.`;
  }
  const forHow = args.lagHours === null ? "for some time" : `for about ${args.lagHours}h`;
  // `facts === null` is UNKNOWN (Neo4j unreadable), not zero. An earlier draft printed "holds 0 facts
  // from before", which is this file's own banned pattern — a zero indistinguishable from a
  // measurement — in the one sentence an operator acts on. This IS reachable now (it was not before
  // STALLSCOPE-1, and a comment here said so until review caught it): `at` liveness + unreadable facts
  // + a stale completion is a pinned row of the state table and lands exactly here.
  const held =
    args.facts === null
      ? "The graph holds facts from before (the exact count is currently unreadable);"
      : `The graph holds ${args.facts} facts from before in this team's groups;`;
  return `Graph extraction has STOPPED: episodes are still being projected, but graphiti has not completed one ${forHow} — no new episode node has appeared in the graph, and an episode node is only written once a job has finished everything else. (${held} fact age itself is not the signal, because on a mature graph most extracted edges deduplicate and create no new fact even when extraction is perfectly healthy.) Check the graphiti service logs for the actual error — usually an out-of-quota extraction key, the output-token cap, or a failing Neo4j write. Narrative arcs and the Learning panel are running on stale facts.`;
}

/**
 * The SHORT leg text for a stall — the one line the admin card's Graph memory leg shows.
 *
 * Server-side like the long reason, and for the same reason: the card used to compose this itself and
 * hard-coded the never-extracted wording for BOTH causes, so a liveness stall asserted "extracting 0
 * facts" beside the card's own 113,352-fact count. The card appends its own freshness suffix (item
 * count + "last projected"), which is formatting, not a claim.
 *
 * Typed `Record<ExtractionStallCause, …>` so deleting an entry fails the build, and iterated by
 * `EXTRACTION_STALL_CAUSES` in the tests so ADDING a cause without a distinct sentence fails too —
 * the annotation-swap a mutation walked straight through.
 */
export function extractionStallShortText(
  cause: ExtractionStallCause,
  args: { lagHours: number | null }
): string {
  const lag = args.lagHours === null ? "longer than the alarm budget" : `~${args.lagHours}h`;
  const byCause: Record<ExtractionStallCause, string> = {
    "no-facts": "0 extracted facts in this team's graph groups",
    "no-completion-visible": "the graph holds no completed extraction for this team",
    // The MEASURED lag, not the budget constant: hard-coding "over 6h" drifts silently if
    // `EXTRACTION_LAG_BUDGET_MS` moves, and importing that constant into a component would drag a
    // `server-only` module across the boundary.
    stopped: `no extraction has completed in ${lag}`,
  };
  return byCause[cause];
}

/**
 * The non-loud sentence for a suppressed zero-evidence state (STALLSCOPE-1 §2e).
 *
 * Deliberately separate from `extractionStallReason`, because it is separate in kind: it makes no
 * accusation and never reaches the pipeline banner. It exists so the suppression is VISIBLE — an alarm
 * that quietly declines to fire is how the census alarm sat dead for weeks (ALARMFIX-1), and the fix
 * there was the same one: make the refusal itself renderable.
 */
export function extractionObservationNote(items: number | null): string {
  // Every clause is true BY CONSTRUCTION, which took a review round to make so: this note is reachable
  // only when the team's own liveness is `none`/`unreadable` (no completion of its own) and the worker
  // read — which EXCLUDES this team's groups and counts only `items:` episodes — found a recent
  // completion. The first version could render "completing work for other groups" about the team's own
  // group, and "no extraction has completed yet" about a team whose jobs were completing.
  return `${items ?? 0} items have been projected for this team and the graph holds no completed extraction for its groups — but graphiti IS completing item extraction for OTHER groups right now, so the likeliest explanation is queue depth rather than a failure. Worth a look if it persists past the next day.`;
}

/** Hours between the newest pushed episode and the newest completed job; null when either is unknown. */
export function extractionLagHours(
  newestPushAt: number | null,
  liveness: ExtractionLiveness
): number | null {
  return newestPushAt !== null && liveness.kind === "at"
    ? Math.round((newestPushAt - liveness.atMs) / 3_600_000)
    : null;
}

/** Everything a health surface needs, from ONE producer (STALLSCOPE-1 §2g). */
export interface ExtractionReading {
  signals: ExtractionSignals;
  verdict: ExtractionVerdict;
  /** The stall sentence, or null when not stalled. Server-composed; surfaces render it verbatim. */
  reason: string | null;
  /** The non-loud note, or null. Card only — never the banner. */
  note: string | null;
  lagHours: number | null;
  /** Newest RELATES_TO in THIS team's groups — observational, rendered beside `facts`. */
  newestFactAtMs: number | null;
  /** Newest `projected_at` over ANY ledger row (sentinels included) — "is the projector alive at all",
   *  which the retrieval card's own stale-projector banner reads. Same pass as everything else. */
  lastProjectedAt: string | null;
}

/**
 * THE single assembler of extraction health. Both surfaces call this and nothing else.
 *
 * `lib/query/retrieval-health` and `getGraphExtractionHealth` used to each build these signals from the
 * same six reads, and two implementations of one verdict is how one surface keeps a bug the other one
 * fixed — it already happened here: when the liveness leg landed, the card (the surface that produced
 * the bug report) was missed entirely while every test stayed green. It happened AGAIN in the meantime:
 * PCCC-3 changed the predicate's item count to `count(distinct …)` and left the card's own count on
 * `count(*)`, so under fan-out the number shown and the number reasoned about would diverge.
 *
 * The ledger read comes FIRST and everything else is scoped by it: the graph reads have no scope until
 * the ledger says which groups this team pushed into, and an empty/unreadable ledger must produce
 * "unreadable" graph legs rather than an `IN []` zero that reads as a proven-empty graph.
 */
export async function readExtractionSignals(
  teamId: string,
  nowMs: number = Date.now()
): Promise<ExtractionReading> {
  const ledger = await readLedger(teamId);
  const [facts, liveness, workerLiveness] = await Promise.all([
    readTeamFacts(ledger.groups),
    readEpisodicLiveness(ledger.groups),
    // Scoped to EVERYONE ELSE (see `readWorkerLiveness`) and never subtracted from anything. Fetched
    // even when this team has no scope, because it is what decides whether an absence is worth
    // shouting about — and with an empty exclusion list it degrades to "is the worker doing item
    // extraction at all", which is the right question for a team that has pushed nothing.
    readWorkerLiveness(ledger.groups),
  ]);
  const signals: ExtractionSignals = {
    items: ledger.kind === "unreadable" ? null : ledger.items,
    firstSeenAtMs: ledger.firstSeenAtMs,
    facts: facts.facts,
    newestFactAtMs: facts.newestFactAtMs,
    newestPushAtMs: ledger.newestPushAtMs,
    liveness,
    workerLiveness,
    nowMs,
  };
  const verdict = deriveExtractionVerdict(signals);
  const lagHours = extractionLagHours(signals.newestPushAtMs, liveness);
  return {
    signals,
    verdict,
    reason:
      verdict.cause === null
        ? null
        : extractionStallReason(verdict.cause, {
            items: signals.items,
            facts: signals.facts,
            lagHours,
            liveness,
          }),
    note: verdict.observed === null ? null : extractionObservationNote(signals.items),
    lagHours,
    newestFactAtMs: facts.newestFactAtMs,
    lastProjectedAt: ledger.lastProjectedAt,
  };
}

export async function getGraphExtractionHealth(teamId: string): Promise<GraphExtractionHealth> {
  const empty: GraphExtractionHealth = {
    items: null,
    facts: null,
    stalled: false,
    censusPolluted: false,
    reason: null,
    observation: null,
  };
  if (!neo4jConfigured()) return empty;
  const [reading, censuses] = await Promise.all([
    readExtractionSignals(teamId),
    groupCensuses(teamId),
  ]);
  const pollutedCensus = censuses.find((c) => c.pollution.judgeable && c.pollution.polluted) ?? null;
  return {
    items: reading.signals.items,
    facts: reading.signals.facts,
    stalled: reading.verdict.stalled,
    censusPolluted: pollutedCensus !== null,
    observation: reading.note,
    // Three distinct causes, three distinct sentences — they send an operator to different places and
    // only one of them may claim "0 facts". The server owns both the discriminator and the sentence
    // (`deriveExtractionVerdict` / `extractionStallReason`) so no surface can compose its own and drift.
    // A STALL outranks pollution: no facts at all is worse news than bad facts, and stacking two
    // paragraphs into one banner buries both.
    reason: reading.reason ?? pollutedCensus?.pollution.reason ?? null,
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
