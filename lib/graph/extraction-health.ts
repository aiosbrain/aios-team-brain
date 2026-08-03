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
 *     invisible. Graphiti also writes `IS_DUPLICATE_OF` bookkeeping edges with a fresh `created_at`
 *     (~26% of the graph) — the same behaviour that protects against false positives means a run
 *     producing no real knowledge still looks alive.
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
  /** The extractor is producing duplicate entities well above this graph's own baseline — a DIFFERENT
   *  failure from `stalled`: extraction is working, and producing bad knowledge. Kept as its own flag
   *  rather than folded into `stalled` because the two send an operator to different places (service
   *  logs vs the Extraction model picker). */
  dedupePolluted: boolean;
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
 * Unfiltered, like `countGraphFacts`: an `IS_DUPLICATE_OF` edge is noise for display but is still
 * proof the extractor ran, which is the only question here.
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
    dedupePolluted: false,
    reason: null,
  };
  if (!neo4jConfigured()) return empty;
  const [episodes, facts, newestEpisode, newestFact, dedupe] = await Promise.all([
    countProjectedEpisodes(teamId),
    countGraphFacts(),
    newestEpisodeAtMs(teamId),
    newestFactAtMs(),
    dedupeSignals(),
  ]);
  const pollution = deriveDedupePollution(dedupe);
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
    dedupePolluted: pollution.polluted,
    // Two distinct causes deserve two distinct sentences — "it never worked" and "it stopped" send an
    // operator to different places. Both name the graphiti service logs, which is where the actual
    // error string lives (a token cap, a 429 `insufficient_quota`, an invalid group_id).
    // A STALL outranks pollution: no facts at all is worse news than bad facts, and stacking two
    // paragraphs into one banner buries both.
    reason: !stalled
      ? pollution.reason
      : neverExtracted
        ? `${episodes} episodes were projected but the graph has 0 extracted facts — Graphiti is accepting episodes (202) yet its entity-extraction worker is failing on every job (commonly the LLM output-token cap, e.g. "Output length exceeded max tokens"). New activity isn't becoming graph facts, so narrative arcs can't update. Check the graphiti service logs.`
        : `Graph extraction has STOPPED: episodes are still being projected, but no new fact has been extracted for about ${lagHours}h (the graph holds ${facts} facts from before). Graphiti keeps returning 202 while its extraction worker fails every job — most often the extraction LLM key is out of quota (a 429 \`insufficient_quota\`), or its output-token cap is being exceeded. Narrative arcs and the Learning panel are running on stale facts. Check the graphiti service logs.`,
  };
}

/* ────────────────────────────────────────────────────────────────────────────────────────────────
 * DEDUPE POLLUTION — the extractor confusing entity identity, which no static check can predict.
 *
 * On 2026-07-30 a cheaper extraction model was selected. It passed the save-time structured-output
 * check (#442) because it genuinely supports structured outputs; it just resolves identity badly. For
 * four days it filled the graph with duplicate entities, and every headline number moved the RIGHT
 * way — total spend fell, because episode volume dropped faster than work per episode rose. It was
 * found by hand.
 *
 * WHY THE THRESHOLD IS RELATIVE, NOT ABSOLUTE. Graphiti records entity dedup as a `RELATES_TO` edge
 * named `IS_DUPLICATE_OF` — normal bookkeeping, emitted by every model. `lib/graph/learning.ts`
 * measured ~26% of this graph as those edges on 2026-07-20, ten days BEFORE the bad model, and filters
 * them out of every read. So "any duplicate edges" is the healthy steady state: an absolute threshold
 * would be permanently on, which is the cry-wolf failure this repo has already paid for twice.
 *
 * Only a RATE CHANGE against the graph's own trailing baseline is signal. That also makes it
 * self-calibrating: a corpus that naturally produces more dedupe edges is never accused of a
 * regression it doesn't have.
 * ──────────────────────────────────────────────────────────────────────────────────────────────── */

/** Recent window whose dedupe share is judged. */
export const DEDUPE_RECENT_MS = 24 * 3_600_000;
/** Trailing window it is judged AGAINST — long enough that one bad day can't move the baseline it is
 *  compared to, which is what stops the alarm normalising a regression as it happens. */
export const DEDUPE_BASELINE_MS = 14 * 86_400_000;
/** Below this many recent edges the share is noise — 1 of 3 is 33% and means nothing. Mirrors
 *  MIN_EPISODES_FOR_EXTRACTION_SIGNAL's role: refuse to judge a sample too small to carry a verdict. */
export const MIN_EDGES_FOR_DEDUPE_SIGNAL = 200;
/**
 * How far above its own baseline the recent share must sit. MEASURED, not chosen: healthy observations
 * are ~26% (learning.ts, 2026-07-20) and ~35% (sampled 2026-08-03 over pre-07-30 edges); the bad model
 * ran ~70%. 1.4x over a ~30% baseline fires at ~42% — above every healthy reading, well below the
 * degraded one.
 */
export const DEDUPE_MARGIN = 1.4;
/**
 * …AND an absolute floor, because a relative margin alone fires on noise when the baseline is tiny
 * (2% → 3% is +50%). 45% sits above every healthy observation on record and below the degraded one.
 */
export const DEDUPE_ABSOLUTE_FLOOR = 0.45;

export interface DedupeSignals {
  /** Edges extracted in the recent window; null = Neo4j unreadable. */
  recentTotal: number | null;
  recentDupe: number | null;
  /** Edges extracted in the trailing baseline window, EXCLUDING the recent one. */
  baselineTotal: number | null;
  baselineDupe: number | null;
}

export interface DedupePollution {
  polluted: boolean;
  recentShare: number | null;
  baselineShare: number | null;
  reason: string | null;
}

const share = (dupe: number | null, total: number | null): number | null =>
  typeof dupe === "number" && typeof total === "number" && total > 0 ? dupe / total : null;

/**
 * Is the extractor producing duplicate entities at a rate its own history doesn't justify?
 *
 * Pure so every refusal-to-judge is testable without Neo4j. Every uncertain case returns
 * `polluted: false` — unknown must never read as degraded, or an outage teaches people to ignore the
 * banner (the same contract `deriveGraphExtractionStalled` keeps).
 */
export function deriveDedupePollution(s: DedupeSignals): DedupePollution {
  const recentShare = share(s.recentDupe, s.recentTotal);
  const baselineShare = share(s.baselineDupe, s.baselineTotal);
  const out = (polluted: boolean, reason: string | null = null): DedupePollution => ({
    polluted,
    recentShare,
    baselineShare,
    reason,
  });
  // Unreadable graph, too small a sample, or no baseline to compare against: all "can't tell".
  if (recentShare === null || baselineShare === null) return out(false);
  if ((s.recentTotal ?? 0) < MIN_EDGES_FOR_DEDUPE_SIGNAL) return out(false);
  if ((s.baselineTotal ?? 0) < MIN_EDGES_FOR_DEDUPE_SIGNAL) return out(false);
  if (recentShare < DEDUPE_ABSOLUTE_FLOOR) return out(false);
  if (recentShare < baselineShare * DEDUPE_MARGIN) return out(false);
  const pct = (n: number) => `${Math.round(n * 100)}%`;
  return out(
    true,
    `Extraction is producing duplicate entities: ${pct(recentShare)} of the last 24h of graph edges ` +
      `are duplicate-of records, against ${pct(baselineShare)} for this graph's own baseline. That is ` +
      `the signature of an extraction model resolving entity identity badly — check the Extraction ` +
      `model in Admin → Integrations.`
  );
}

/**
 * Read both windows in ONE aggregate. Same query class as `countGraphFacts` — an aggregate returns one
 * row, so this scans `RELATES_TO` once and costs what the probe's existing full-edge scans cost
 * (tens of ms at ~31k edges). A `LIMIT` would do nothing here: it applies after aggregation.
 *
 * `r.created_at` is EXTRACTION time, deliberately not `valid_at`, which Graphiti backdates to the
 * episode's work time — ranking a health probe by that reports on a backfill's content age instead of
 * on what the extractor just did.
 */
export async function dedupeSignals(nowMs = Date.now()): Promise<DedupeSignals> {
  const unknown: DedupeSignals = { recentTotal: null, recentDupe: null, baselineTotal: null, baselineDupe: null };
  if (!neo4jConfigured()) return unknown;
  try {
    const recentSince = new Date(nowMs - DEDUPE_RECENT_MS).toISOString();
    const baselineSince = new Date(nowMs - DEDUPE_BASELINE_MS).toISOString();
    const rows = await runRead<{
      recentTotal: number;
      recentDupe: number;
      baselineTotal: number;
      baselineDupe: number;
    }>(
      `MATCH ()-[r:RELATES_TO]->()
       WHERE r.created_at >= datetime($baselineSince)
       RETURN
         count(CASE WHEN r.created_at >= datetime($recentSince) THEN 1 END) AS recentTotal,
         count(CASE WHEN r.created_at >= datetime($recentSince) AND r.name = 'IS_DUPLICATE_OF' THEN 1 END) AS recentDupe,
         count(CASE WHEN r.created_at < datetime($recentSince) THEN 1 END) AS baselineTotal,
         count(CASE WHEN r.created_at < datetime($recentSince) AND r.name = 'IS_DUPLICATE_OF' THEN 1 END) AS baselineDupe`,
      { recentSince, baselineSince }
    );
    const r = rows[0];
    return r
      ? {
          recentTotal: Number(r.recentTotal) || 0,
          recentDupe: Number(r.recentDupe) || 0,
          baselineTotal: Number(r.baselineTotal) || 0,
          baselineDupe: Number(r.baselineDupe) || 0,
        }
      : unknown;
  } catch {
    return unknown; // unreadable → unknown, never degraded
  }
}
