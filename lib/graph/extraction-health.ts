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
  reason: string | null; // human-facing cause when stalled
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
export async function newestFactAtMs(): Promise<number | null> {
  if (!neo4jConfigured()) return null;
  try {
    const rows = await runRead<{ at: string | null }>(
      "MATCH ()-[r:RELATES_TO]->() WHERE r.created_at IS NOT NULL RETURN toString(max(r.created_at)) AS at"
    );
    const at = rows[0]?.at ?? null;
    if (!at) return null;
    const ms = Date.parse(at);
    return Number.isFinite(ms) ? ms : null;
  } catch {
    return null;
  }
}

/** When this team last had an episode projected — the other half of the lag comparison. */
async function newestEpisodeAtMs(teamId: string): Promise<number | null> {
  try {
    const res = await runSql<{ at: string | null }>(
      "select max(projected_at)::text as at from graph_episodes where team_id = $1",
      [teamId]
    );
    const at = res.rows[0]?.at ?? null;
    if (!at) return null;
    const ms = Date.parse(at);
    return Number.isFinite(ms) ? ms : null;
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
  const empty: GraphExtractionHealth = { episodes: null, facts: null, stalled: false, reason: null };
  if (!neo4jConfigured()) return empty;
  const [episodes, facts, newestEpisode, newestFact] = await Promise.all([
    countProjectedEpisodes(teamId),
    countGraphFacts(),
    newestEpisodeAtMs(teamId),
    newestFactAtMs(),
  ]);
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
    // Two distinct causes deserve two distinct sentences — "it never worked" and "it stopped" send an
    // operator to different places. Both name the graphiti service logs, which is where the actual
    // error string lives (a token cap, a 429 `insufficient_quota`, an invalid group_id).
    reason: !stalled
      ? null
      : neverExtracted
        ? `${episodes} episodes were projected but the graph has 0 extracted facts — Graphiti is accepting episodes (202) yet its entity-extraction worker is failing on every job (commonly the LLM output-token cap, e.g. "Output length exceeded max tokens"). New activity isn't becoming graph facts, so narrative arcs can't update. Check the graphiti service logs.`
        : `Graph extraction has STOPPED: episodes are still being projected, but no new fact has been extracted for about ${lagHours}h (the graph holds ${facts} facts from before). Graphiti keeps returning 202 while its extraction worker fails every job — most often the extraction LLM key is out of quota (a 429 \`insufficient_quota\`), or its output-token cap is being exceeded. Narrative arcs and the Learning panel are running on stale facts. Check the graphiti service logs.`,
  };
}
