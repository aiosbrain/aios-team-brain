import "server-only";
import { neo4jConfigured, runRead } from "./neo4j";
import { ITEM_EPISODE_PREFIX } from "./episode-name";

/**
 * GRAPHSAT-1 — the per-ITEM episode lookup reconcile uses when a group's REST listing SATURATES.
 *
 * `GET /episodes/{group}?last_n=` is Graphiti's only listing and a full window is inconclusive, so a
 * group past `GRAPH_LANDED_SCAN_DEPTH` was skipped wholesale — prod's General (2,833 rows, ~7k
 * episodes) healed NOTHING from 2026-08-04: no landed confirmation, no uuid backfill, no partial
 * measurement, no re-queue. The ticket assumed this needed a sidecar endpoint; it does not — the
 * brain already reads Neo4j over bolt (`./neo4j`), and this is the same shape `learning.ts` and
 * `extraction-health.ts` ship.
 *
 * BY ITEM IDENTITY, NOT BY CURRENT EXPECTED NAMES (Codex design round 1 BLOCKER): the REST path
 * confirms an item through ANY `items:<id>*` episode (`itemIdFromEpisodeName`, first-wins), so a
 * doc that shrank 3→1 chunks is confirmed today via its legacy `items:x#0`. Asking only for the
 * current expected name (`items:x`) would judge that landed row never-landed — and re-push it.
 * The stem match (`split(e.name,'#')[0]`) returns EVERY present chunk of every ledger item, which
 * is exactly the population the REST listing would have shown for those items. `split` on a name
 * with no `#` yields `[name]`; item ids are uuids, so `#` cannot occur inside one.
 *
 * TIER ISOLATION: `e.group_id = $g` is the SOLE scope (no RLS backstop — CLAUDE.md §5); the guard
 * `test/guards/graph-tier-filter.test.ts` requires that term in every Cypher block of this module,
 * and the `test:neo4j` tier proves a same-id node in another group is never returned.
 *
 * FAIL DIRECTION: returns `null` when Neo4j is not configured; REJECTS on ANY batch error without
 * surfacing partial rows — a partial result would read absent-because-unfetched as never-landed,
 * the fail-toward-re-push direction reconcile must never take. The caller degrades to today's
 * skip-and-count.
 */
export const LOOKUP_BATCH = 500;

export interface EpisodeRefLite {
  uuid: string;
  name: string;
}

export type EpisodeLookup = (groupId: string, itemIds: readonly string[]) => Promise<EpisodeRefLite[] | null>;

/** Injectable per-batch read (tests mock this; production is `runRead`). */
export type BatchRead = (cypher: string, params: Record<string, unknown>) => Promise<EpisodeRefLite[]>;

export const ITEM_EPISODES_CYPHER =
  `MATCH (e:Episodic) ` +
  `WHERE e.group_id = $g AND e.name STARTS WITH $prefix AND split(e.name, '#')[0] IN $itemNames ` +
  `RETURN e.uuid AS uuid, e.name AS name`;

export async function lookupItemEpisodes(
  groupId: string,
  itemIds: readonly string[],
  read: BatchRead = runRead as BatchRead,
  configured: () => boolean = neo4jConfigured
): Promise<EpisodeRefLite[] | null> {
  if (!configured()) return null;
  const out: EpisodeRefLite[] = [];
  for (let i = 0; i < itemIds.length; i += LOOKUP_BATCH) {
    const itemNames = itemIds.slice(i, i + LOOKUP_BATCH).map((id) => `${ITEM_EPISODE_PREFIX}${id}`);
    // No try/catch: a batch failure REJECTS the whole lookup. Rows collected so far are discarded
    // with it — never returned.
    const rows = await read(ITEM_EPISODES_CYPHER, { g: groupId, prefix: ITEM_EPISODE_PREFIX, itemNames });
    for (const r of rows) {
      if (typeof r.uuid === "string" && typeof r.name === "string") out.push({ uuid: r.uuid, name: r.name });
    }
  }
  return out;
}

/** The production lookup reconcile defaults to. */
export const neo4jEpisodeLookup: EpisodeLookup = (groupId, itemIds) => lookupItemEpisodes(groupId, itemIds);
