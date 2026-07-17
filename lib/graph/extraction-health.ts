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
 * extracted" (Neo4j) — many projected but zero extracted ⇒ the extractor is broken. Surfaced loudly
 * on the admin pipeline banner + retrieval-health card.
 *
 * Best-effort: nulls/`stalled:false` on any error so it never breaks a page render.
 */

/** Below this many projected episodes we can't distinguish "extractor broken" from "fresh install
 *  still mid-first-extraction" (Graphiti processes async), so we don't flag. With a working extractor,
 *  25 accepted episodes reliably yield ≥1 fact; 0 facts past that is unambiguous breakage. */
export const MIN_EPISODES_FOR_EXTRACTION_SIGNAL = 25;

export interface GraphExtractionHealth {
  episodes: number | null; // projected episodes for this team (Postgres ledger)
  facts: number | null; // extracted RELATES_TO facts in Neo4j (null = Neo4j unreadable)
  stalled: boolean; // projected a meaningful backlog but zero facts extracted → extractor failing
  reason: string | null; // human-facing cause when stalled
}

/**
 * Pure verdict: are episodes reaching Graphiti but not becoming facts? `null` on either side means
 * "can't tell" (Neo4j unreadable, or ledger unreadable) — NOT stalled, since a different leg owns
 * reachability. Exported for unit tests.
 */
export function deriveGraphExtractionStalled(episodes: number | null, facts: number | null): boolean {
  if (episodes === null || facts === null) return false;
  return episodes >= MIN_EPISODES_FOR_EXTRACTION_SIGNAL && facts === 0;
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
  const [episodes, facts] = await Promise.all([countProjectedEpisodes(teamId), countGraphFacts()]);
  const stalled = deriveGraphExtractionStalled(episodes, facts);
  return {
    episodes,
    facts,
    stalled,
    reason: stalled
      ? `${episodes} episodes were projected but the graph has 0 extracted facts — Graphiti is accepting episodes (202) yet its entity-extraction worker is failing on every job (commonly the LLM output-token cap, e.g. "Output length exceeded max tokens"). New activity isn't becoming graph facts, so narrative arcs can't update. Check the graphiti service logs.`
      : null,
  };
}
