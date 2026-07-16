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
 *
 * SPARSE-DATA FALLBACK: the `sinceISO` window is a SOFT preference, not a hard cutoff. When the
 * windowed query returns nothing (a stale graph — e.g. Graphiti's extractor stalled and the newest
 * fact is weeks old), we retry the SAME query without the time bound and surface the most-recent-N
 * regardless of age. The panel then shows real recent learning instead of looking broken. The
 * group_id tier filter is NEVER dropped — only the time bound is — so tier isolation still holds.
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
  sinceISO: string | null,
  limit = 15
): Promise<AtomicFact[]> {
  if (!neo4jConfigured() || groups.length === 0) return [];
  // `withSince` gates ONLY the time bound; the group_id tier filter is present either way.
  const factsCypher = (withSince: boolean) =>
    `MATCH (a:Entity)-[r:RELATES_TO]->(b:Entity)
     WHERE r.group_id IN $groups${withSince ? " AND r.created_at >= datetime($since)" : ""}
     RETURN r.uuid AS id,
            r.fact AS fact,
            toString(r.created_at) AS at,
            head([l IN labels(a) WHERE l <> 'Entity']) AS subjectType,
            a.name AS subject,
            b.name AS object,
            r.episodes AS episodeUuids
     ORDER BY r.created_at DESC
     LIMIT toInteger($limit)`;
  const query = async (withSince: boolean): Promise<AtomicFact[]> => {
    const rows = await runRead<{
      id: string;
      fact: string;
      at: string;
      subjectType: string | null;
      subject: string | null;
      object: string | null;
      episodeUuids: string[] | null;
    }>(factsCypher(withSince), { groups, since: sinceISO, limit });
    return rows.map((r) => ({
      id: r.id,
      fact: r.fact,
      at: r.at,
      subjectType: (r.subjectType ?? "entity").toLowerCase(),
      subject: r.subject ?? "",
      object: r.object ?? "",
      episodeUuids: Array.isArray(r.episodeUuids) ? r.episodeUuids : [],
    }));
  };
  try {
    // `sinceISO === null` means "no time box — just the most-recent N" (arcs aren't time-boxed).
    // With a window, fall back to most-recent-N (still tier-scoped) only when the window is empty —
    // preserves the "recent" intent when the graph is fresh, degrades gracefully when it's stale/sparse.
    if (sinceISO === null) return await query(false);
    const windowed = await query(true);
    return windowed.length > 0 ? windowed : await query(false);
  } catch {
    return []; // degrade — panel shows empty rather than erroring
  }
}

/**
 * Resolve a set of episode UUIDs → their source item id + source, tier-scoped. Episodes are named
 * `items:<id>`, so this lets a fact (which carries `episodeUuids`) link back to the brain item that
 * produced it — the provenance behind a narrative arc's evidence. Best-effort empty map on failure.
 */
export async function resolveEpisodeItems(
  groups: string[],
  uuids: string[]
): Promise<Map<string, { itemId?: string; source?: string }>> {
  const out = new Map<string, { itemId?: string; source?: string }>();
  const unique = [...new Set(uuids.filter(Boolean))].slice(0, 500);
  if (!neo4jConfigured() || groups.length === 0 || unique.length === 0) return out;
  try {
    const rows = await runRead<{ uuid: string; name: string | null; source: string | null }>(
      `MATCH (ep:Episodic)
       WHERE ep.group_id IN $groups AND ep.uuid IN $uuids
       RETURN ep.uuid AS uuid, ep.name AS name, ep.source AS source`,
      { groups, uuids: unique }
    );
    for (const r of rows) {
      const name = r.name ?? "";
      out.set(r.uuid, {
        itemId: name.startsWith("items:") ? name.slice("items:".length) : undefined,
        source: r.source ? r.source.toLowerCase() : undefined,
      });
    }
    return out;
  } catch {
    return out; // degrade — evidence just won't carry links
  }
}

/** Layer 2 — an event (a source episode) with its participants + the facts extracted from it. */
export interface GraphEvent {
  id: string; // episode uuid
  itemId: string | null; // parsed from the episode name "items:<id>" → link back to the brain item
  source: string; // slack / github / notion / granola / linear …
  title: string;
  at: string;
  participants: string[];
  facts: string[];
  factCount: number;
}

/**
 * Layer 2 — recent events (source episodes) for the tier-visible groups, newest first. Each episode
 * is one ingested item (its `name` is `items:<id>`); we return its mentioned entities (participants)
 * and the facts extracted from it, so the panel can group facts by the event that produced them.
 */
export async function recentEvents(
  groups: string[],
  sinceISO: string,
  limit = 30
): Promise<GraphEvent[]> {
  if (!neo4jConfigured() || groups.length === 0) return [];
  // `withSince` gates ONLY the time bound; both group_id tier filters are present either way.
  const eventsCypher = (withSince: boolean) =>
    `MATCH (ep:Episodic)
     WHERE ep.group_id IN $groups${withSince ? " AND ep.created_at >= datetime($since)" : ""}
     OPTIONAL MATCH (ep)-[:MENTIONS]->(p:Entity)
     OPTIONAL MATCH (a:Entity)-[r:RELATES_TO]->(b:Entity)
       WHERE r.group_id IN $groups AND ep.uuid IN r.episodes
     RETURN ep.uuid AS id, ep.name AS name, ep.source AS source,
            ep.source_description AS title, toString(ep.created_at) AS at,
            collect(DISTINCT p.name) AS participants,
            collect(DISTINCT r.fact) AS facts
     ORDER BY at DESC
     LIMIT toInteger($limit)`;
  const query = async (withSince: boolean): Promise<GraphEvent[]> => {
    const rows = await runRead<{
      id: string;
      name: string | null;
      source: string | null;
      title: string | null;
      at: string;
      participants: (string | null)[] | null;
      facts: (string | null)[] | null;
    }>(eventsCypher(withSince), { groups, since: sinceISO, limit });
    return rows.map((r) => {
      const name = r.name ?? "";
      const participants = (r.participants ?? []).filter((x): x is string => !!x);
      const facts = (r.facts ?? []).filter((x): x is string => !!x);
      return {
        id: r.id,
        itemId: name.startsWith("items:") ? name.slice("items:".length) : null,
        source: (r.source ?? "").toLowerCase(),
        title: r.title ?? name,
        at: r.at,
        participants,
        facts,
        factCount: facts.length,
      };
    });
  };
  try {
    const windowed = await query(true);
    // Same sparse-data fallback as recentFacts — most-recent-N when the window is empty.
    return windowed.length > 0 ? windowed : await query(false);
  } catch {
    return [];
  }
}
