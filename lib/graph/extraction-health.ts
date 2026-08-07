import "server-only";
import { runSql } from "@/lib/db/pg/pool";
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
 * WHAT THIS STILL CANNOT SEE — stated because the failure being corrected was over-claiming:
 *   • PARTIAL failure. Any single success inside the lag budget reads green, so a 90%-failure rate is
 *     invisible. (On graphiti_core ≤0.13.2 the `IS_DUPLICATE_OF` bookkeeping edges — ~26% of the
 *     graph — kept a run producing no real knowledge looking alive; 0.29.3 no longer writes them,
 *     but any single real fact inside the budget still reads green.)
 *   • SCOPE ASYMMETRY. Episodes are counted per team; facts are counted globally (the fact probe is
 *     deliberately not tier-scoped). On an instance with more than one group, one group's extraction
 *     dying is masked by another group's fresh facts.
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
  /** Newest `graph_episodes.projected_at` (ms). */
  newestEpisodeAtMs?: number | null;
  /** Newest RELATES_TO `created_at` (ms) — see `newestFactAtMs()` for why it is not `valid_at`. */
  newestFactAtMs?: number | null;
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
  // Never extracted anything: the original 2026-07 failure.
  if (facts === 0) return true;
  // Extracted once, then stopped: the 2026-07-28 quota failure the count-based check could not see.
  const newestEpisode = input.newestEpisodeAtMs ?? null;
  const newestFact = input.newestFactAtMs ?? null;
  if (newestEpisode === null || newestFact === null) return false;
  return newestEpisode - newestFact > EXTRACTION_LAG_BUDGET_MS;
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

/** Projected episodes for a team from the Postgres ledger (no Graphiti round-trip). */
async function countProjectedEpisodes(teamId: string): Promise<number | null> {
  try {
    const res = await runSql<{ n: number }>(
      "select count(*)::int as n from graph_episodes where team_id = $1",
      [teamId]
    );
    return res.rows[0]?.n ?? 0;
  } catch {
    return null;
  }
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
  const [episodes, facts, newestEpisode, newestFact, censuses] = await Promise.all([
    countProjectedEpisodes(teamId),
    countGraphFacts(),
    newestEpisodeAtMs(teamId),
    newestFactAtMs(),
    groupCensuses(teamId),
  ]);
  const pollutedCensus = censuses.find((c) => c.pollution.judgeable && c.pollution.polluted) ?? null;
  const signals: ExtractionSignals = {
    episodes,
    facts,
    newestEpisodeAtMs: newestEpisode,
    newestFactAtMs: newestFact,
  };
  const stalled = deriveGraphExtractionStalled(signals);
  const neverExtracted = stalled && facts === 0;
  const lagHours =
    newestEpisode !== null && newestFact !== null
      ? Math.round((newestEpisode - newestFact) / 3_600_000)
      : null;
  return {
    episodes,
    facts,
    stalled,
    censusPolluted: pollutedCensus !== null,
    // Two distinct causes deserve two distinct sentences — "it never worked" and "it stopped" send an
    // operator to different places. Both name the graphiti service logs, which is where the actual
    // error string lives (a token cap, a 429 `insufficient_quota`, an invalid group_id).
    // A STALL outranks pollution: no facts at all is worse news than bad facts, and stacking two
    // paragraphs into one banner buries both.
    reason: !stalled
      ? (pollutedCensus?.pollution.reason ?? null)
      : neverExtracted
        ? `${episodes} episodes were projected but the graph has 0 extracted facts — Graphiti is accepting episodes (202) yet its entity-extraction worker is failing on every job (commonly the LLM output-token cap, e.g. "Output length exceeded max tokens"). New activity isn't becoming graph facts, so narrative arcs can't update. Check the graphiti service logs.`
        : `Graph extraction has STOPPED: episodes are still being projected, but no new fact has been extracted for about ${lagHours}h (the graph holds ${facts} facts from before). Graphiti keeps returning 202 while its extraction worker fails every job — most often the extraction LLM key is out of quota (a 429 \`insufficient_quota\`), or its output-token cap is being exceeded. Narrative arcs and the Learning panel are running on stale facts. Check the graphiti service logs.`,
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
 *    `graph_episodes` ledger: episodes projected in the window but zero census names ⇒
 *    `predicate-suspect` (a graphiti bump renaming `Entity`/`created_at` — OR a stalled extractor;
 *    the alert mail names both); no episodes either ⇒ a genuinely young/quiet group
 *    (`small-sample`). "Young" is thereby defined by the ledger, the one source that knows whether
 *    anything was pushed. An unreadable ledger (`recentEpisodes: null`) reads as `small-sample`,
 *    never as an accusation.
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
    // The tripwire that replaced the old zero-predicate check — see the contract above.
    return (recentEpisodes ?? 0) > 0 ? refuse("predicate-suspect") : refuse("small-sample");
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
  nowMs: number
): Promise<Map<string, GroupEpisodeFlow> | null> {
  try {
    const recentSince = new Date(nowMs - CENSUS_RECENT_MS).toISOString();
    const baselineSince = new Date(nowMs - CENSUS_BASELINE_MS).toISOString();
    const params: unknown[] = [recentSince, baselineSince];
    let where = "";
    if (teamId !== null) {
      params.push(teamId);
      where = "where team_id = $3";
    }
    const res = await runSql<{ group_id: string; recent: number; baseline: number; span: number }>(
      `select group_id,
              count(*) filter (where projected_at >= $1 and content_sha256 <> '')::int as recent,
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
}

/**
 * The census across every group the `graph_episodes` ledger knows (scoped to a team when `teamId`
 * given; instance-wide for the scheduled alarm when null). Group enumeration is LEDGER-DEFINED on
 * purpose — the ledger is the one source that knows what was pushed, so a group that exists only in
 * Neo4j (never projected by this install) is not this alarm's to judge. Best-effort: an unreadable
 * ledger returns [] and every caller degrades quietly.
 */
export async function groupCensuses(
  teamId: string | null,
  nowMs = Date.now()
): Promise<GroupCensus[]> {
  const flows = await groupEpisodeFlows(teamId, nowMs);
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
      const signals = configured ? await nameCollisionSignals(group, nowMs) : unknown;
      return {
        group,
        signals,
        recentEpisodes: flow.recentEpisodes,
        baselineEpisodes: flow.baselineEpisodes,
        spanEpisodes: flow.spanEpisodes,
        pollution: deriveNameCollisionPollution({
          configured,
          signals,
          recentEpisodes: flow.recentEpisodes,
        }),
      };
    })
  );
}
