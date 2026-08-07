/**
 * The battery's quality measurements, read out of Neo4j and Postgres (PIPEFF-2 / AIO-821).
 *
 * Produces the five quality numbers an arm is judged on. It does NOT judge — `decision.mjs` owns
 * that, so the readout stays a function of the numbers rather than of whoever is reading them.
 *
 * WHAT EACH ONE IS FOR, since three of the five exist only because review found the others blind:
 *
 *   Q1  entity yield          two-sided. Fragmentation RAISES node count, so a floor alone waved it
 *                             through — and it is the only gate that sees variant-form inflation
 *                             ("John" as a separate node from "John Smith"), which Q6 cannot,
 *                             because such a node carries no member name at all.
 *   Q2  people recall         member names literally present in a chunk, found as an Entity.
 *   Q3  duplicate share       TWO-SIDED, using `extraction-health.ts`'s own predicate. A
 *                             failure-to-merge emits NO IS_DUPLICATE_OF edge, so fragmentation makes
 *                             this FALL — an upper bound alone pointed the wrong way.
 *   Q4  cross-chunk continuity the within-document mechanism the window exists for.
 *   Q6  cross-item convergence the cross-item dedupe judgment the window also feeds. Fragmentation's
 *                             most direct signal.
 *
 * TIER NOTE (CLAUDE.md §5): every query is scoped to ONE `group_id`. The corpus is selected
 * `access='team'` precisely so the whole battery lives in one group — the graph has no other tier
 * enforcement, so a query that spanned groups would silently mix tiers.
 */
import { runRead } from "@/lib/graph/neo4j";
// Shared with judge.mjs so the universe rule has ONE implementation.
export { buildUniverse, nameConvergence } from "./q7.mjs";
import { itemIdFromEpisodeName } from "@/lib/graph/episode-name";

export type Metrics = {
  Q1: number;
  Q2: number;
  Q3: number;
  Q4: number;
  Q6: number;
  personsLost: number;
  dupeEdges: number;
  episodes: number;
};

/** Case-normalised, so "john smith" and "John Smith" are not silently two people. */
const norm = (s: string) => s.trim().toLowerCase();

/** Q1 — Entity nodes per episode. */
export async function entityYield(groupId: string, episodes: number): Promise<number> {
  const rows = await runRead<{ n: number }>("MATCH (n:Entity {group_id: $g}) RETURN count(n) AS n", { g: groupId });
  return episodes > 0 ? Number(rows[0]?.n ?? 0) / episodes : 0;
}

/**
 * How many Episodic nodes actually LANDED in the graph. `armsCompleted` must be measured, not
 * asserted: Graphiti 202-accepts episodes into an in-memory queue and its worker dies silently on a
 * non-Cancelled exception (a recorded incident class), so "we pushed 108" says nothing about how
 * many were processed. The judge compares this against the corpus's expected count per rep.
 */
export async function episodicCount(groupId: string): Promise<number> {
  const rows = await runRead<{ n: number }>("MATCH (e:Episodic {group_id: $g}) RETURN count(e) AS n", { g: groupId });
  return Number(rows[0]?.n ?? 0);
}

/**
 * Q3 — the IS_DUPLICATE_OF share of RELATES_TO edges.
 *
 * The predicate is deliberately identical to `lib/graph/extraction-health.ts`'s, which is pinned by
 * `test/guards/dedupe-predicate-pinned.test.ts` against what the deployed image actually writes. If a
 * Graphiti upgrade renames the relation, that guard fails the build rather than this quietly reading
 * zero — and a zero here would look like a *clean* graph while meaning the opposite.
 */
export async function dupeShare(groupId: string): Promise<{ share: number; total: number }> {
  const rows = await runRead<{ total: number; dupe: number }>(
    `MATCH (a:Entity {group_id: $g})-[r:RELATES_TO]->(b:Entity {group_id: $g})
     RETURN count(r) AS total, count(CASE WHEN r.name = 'IS_DUPLICATE_OF' THEN 1 END) AS dupe`,
    { g: groupId }
  );
  const total = Number(rows[0]?.total ?? 0);
  const dupe = Number(rows[0]?.dupe ?? 0);
  return { share: total > 0 ? dupe / total : 0, total };
}

/**
 * Q4 — for multi-chunk items, the share of an item's entities that appear in ≥2 of its chunks.
 *
 * The join is `(:Episodic)-[:MENTIONS]->(:Entity)`, built in `_process_episode_data` over the
 * RESOLVED (post-dedupe, canonical) nodes — so this measures whether resolution converged across
 * chunks, which is what it is for.
 *
 * The item id comes from `itemIdFromEpisodeName`, never a `STARTS WITH 'items:<id>'` prefix match,
 * which would swallow `items:123` into `items:12`.
 */
export async function crossChunkContinuity(groupId: string, multiChunkItemIds: Set<string>): Promise<number> {
  const rows = await runRead<{ episode: string; entity: string }>(
    `MATCH (e:Episodic {group_id: $g})-[:MENTIONS]->(n:Entity {group_id: $g})
     RETURN e.name AS episode, n.uuid AS entity`,
    { g: groupId }
  );
  return continuityFrom(rows, multiChunkItemIds);
}

/** The aggregation half of Q4, split out so it is testable without a graph. Pure. */
export function continuityFrom(rows: { episode: string; entity: string }[], multiChunkItemIds: Set<string>): number {
  // item id -> entity uuid -> the set of chunk episodes that mention it
  const perItem = new Map<string, Map<string, Set<string>>>();
  for (const r of rows) {
    const itemId = itemIdFromEpisodeName(r.episode);
    if (!itemId || !multiChunkItemIds.has(itemId)) continue;
    const forItem = perItem.get(itemId) ?? new Map<string, Set<string>>();
    const chunks = forItem.get(r.entity) ?? new Set<string>();
    chunks.add(r.episode);
    forItem.set(r.entity, chunks);
    perItem.set(itemId, forItem);
  }

  let shared = 0;
  let total = 0;
  for (const forItem of perItem.values()) {
    for (const chunks of forItem.values()) {
      total++;
      if (chunks.size >= 2) shared++;
    }
  }
  return total > 0 ? shared / total : 0;
}

/**
 * Q2 and Q6 together, because both are computed over the same member-name evidence and running them
 * apart would let the two disagree about who counts as present.
 *
 * `presence` maps a normalised member name to the set of item ids whose text literally contains it —
 * derived from the seeded Postgres by the caller, so this stays a pure Neo4j read plus set algebra.
 *
 *   Q2 = names present anywhere and found as an Entity, over names present anywhere.
 *   Q6 = distinct Entity nodes carrying a name, over names present in ≥2 DISTINCT items.
 *        Restricted that way because cross-ITEM convergence is the thing the unrelated predecessors
 *        were feeding; a name confined to one item cannot demonstrate it.
 *
 * `personsLost` is Q2's second, noise-free clause: names present in the source and absent from the
 * graph entirely.
 */
export async function peopleMetrics(
  groupId: string,
  presence: Map<string, Set<string>>
): Promise<{ recall: number; convergence: number; personsLost: number; qualifyingLost: number; convergenceNames: number }> {
  const rows = await runRead<{ name: string }>("MATCH (n:Entity {group_id: $g}) RETURN n.name AS name", { g: groupId });
  return peopleFrom(rows.map((r) => r.name), presence);
}

/** The aggregation half of Q2/Q6, split out so it is testable without a graph. Pure. */
export function peopleFrom(
  entityNames: string[],
  presence: Map<string, Set<string>>
): { recall: number; convergence: number; personsLost: number; qualifyingLost: number; convergenceNames: number } {
  const rows = entityNames.map((name) => ({ name }));
  const nodesByName = new Map<string, number>();
  for (const r of rows) {
    const n = norm(r.name ?? "");
    if (!n) continue;
    nodesByName.set(n, (nodesByName.get(n) ?? 0) + 1);
  }

  const present = [...presence.keys()];
  const found = present.filter((n) => (nodesByName.get(n) ?? 0) > 0);
  const recall = present.length > 0 ? found.length / present.length : 0;

  const multiItem = present.filter((n) => (presence.get(n)?.size ?? 0) >= 2);
  const nodesForMultiItem = multiItem.reduce((s, n) => s + (nodesByName.get(n) ?? 0), 0);
  const convergence = multiItem.length > 0 ? nodesForMultiItem / multiItem.length : 0;

  // Q2 v2's count clause: a QUALIFYING name (present in >=2 distinct items) absent from the graph.
  const qualifyingLost = multiItem.filter((n) => (nodesByName.get(n) ?? 0) === 0).length;
  return { recall, convergence, personsLost: present.length - found.length, qualifyingLost, convergenceNames: multiItem.length };
}

/**
 * The raw entity-name census of a rep's graph — every case-normalised Entity name with its distinct
 * node count. Q7 is computed FROM these (plus the corpus bodies) at judge time, because its universe
 * is the union of the INCUMBENT's two reps and rep 2 does not exist while rep 1 is harvested.
 */
export async function entityNameCounts(groupId: string): Promise<{ name: string; nodes: number }[]> {
  const rows = await runRead<{ name: string; nodes: number }>(
    "MATCH (n:Entity {group_id: $g}) RETURN n.name AS name, count(n) AS nodes",
    { g: groupId }
  );
  const merged = new Map<string, number>();
  for (const r of rows) {
    const n = norm(r.name ?? "");
    if (!n) continue;
    // Case-variants of one name are ONE name with their node counts summed — "graphiti" and
    // "Graphiti" as separate nodes is exactly the fragmentation Q7 exists to count.
    merged.set(n, (merged.get(n) ?? 0) + Number(r.nodes));
  }
  return [...merged.entries()].map(([name, nodes]) => ({ name, nodes }));
}

/**
 * Which member names literally appear in which items' text.
 *
 * Literal presence is the point: it is the only definition that needs no answer key, which is what
 * keeps the whole battery self-calibrating against this install rather than against a fixture.
 */
export function memberPresence(members: { display_name: string }[], items: { id: string; body: string }[]): Map<string, Set<string>> {
  const presence = new Map<string, Set<string>>();
  for (const m of members) {
    const name = (m.display_name ?? "").trim();
    // A one-word handle would match far too much prose to mean anything.
    if (name.length < 4 || !name.includes(" ")) continue;
    const needle = name.toLowerCase();
    for (const it of items) {
      if (!(it.body ?? "").toLowerCase().includes(needle)) continue;
      const set = presence.get(norm(name)) ?? new Set<string>();
      set.add(it.id);
      presence.set(norm(name), set);
    }
  }
  return presence;
}
