import "server-only";
import { runRead, neo4jConfigured } from "./neo4j";

/**
 * "What the Brain is Learning" reads over Graphiti's Neo4j graph. Every query is scoped to the
 * caller's TIER-VISIBLE group_ids (`lib/graph/group.visibleGroupIds`) — Graphiti has no tier
 * awareness, so `WHERE x.group_id IN $groups` is the SOLE enforcement stopping an `external` viewer
 * from seeing team facts (no RLS backstop, CLAUDE.md §5). Guarded by test/guards/graph-tier-filter.
 *
 * Best-effort: returns [] when Neo4j is unconfigured/unreachable so the panel degrades gracefully.
 * Graphiti schema: `(:Entity)-[:RELATES_TO {fact, created_at, group_id, episodes}]->(:Entity)`,
 * `(:Episodic {name:"items:<id>", created_at, group_id})`, `(:Episodic)-[:MENTIONS]->(:Entity)`.
 */

/** Layer 1 — one recently-extracted fact (a RELATES_TO edge). */
export interface AtomicFact {
  id: string; // edge uuid
  fact: string;
  at: string; // ISO created_at
  subjectType: string; // subject entity's label → the type badge
  subject: string;
  object: string;
  episodeUuids: string[]; // source episodes (→ event grouping in Layer 2)
}

/**
 * Layer 1 — recent atomic facts for the given tier-visible groups, newest first. `groups` MUST be
 * the caller's `visibleGroupIds(teamSlug, tier)`. `sinceISO` bounds the window (e.g. last 24h).
 */
export async function recentFacts(
  groups: string[],
  sinceISO: string,
  limit = 15
): Promise<AtomicFact[]> {
  if (!neo4jConfigured() || groups.length === 0) return [];
  try {
    const rows = await runRead<{
      id: string;
      fact: string;
      at: string;
      subjectType: string | null;
      subject: string | null;
      object: string | null;
      episodeUuids: string[] | null;
    }>(
      `MATCH (a:Entity)-[r:RELATES_TO]->(b:Entity)
       WHERE r.group_id IN $groups AND r.created_at >= datetime($since)
       RETURN r.uuid AS id,
              r.fact AS fact,
              toString(r.created_at) AS at,
              head([l IN labels(a) WHERE l <> 'Entity']) AS subjectType,
              a.name AS subject,
              b.name AS object,
              r.episodes AS episodeUuids
       ORDER BY r.created_at DESC
       LIMIT toInteger($limit)`,
      { groups, since: sinceISO, limit }
    );
    return rows.map((r) => ({
      id: r.id,
      fact: r.fact,
      at: r.at,
      subjectType: (r.subjectType ?? "entity").toLowerCase(),
      subject: r.subject ?? "",
      object: r.object ?? "",
      episodeUuids: Array.isArray(r.episodeUuids) ? r.episodeUuids : [],
    }));
  } catch {
    return []; // degrade — panel shows empty rather than erroring
  }
}
