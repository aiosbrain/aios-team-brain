import "server-only";
import { runSql } from "@/lib/db/pg/pool";
import { embed, toVectorLiteral } from "./embeddings";
import { chunkText } from "./chunk";
import { resolveEmbeddingBackend } from "./embedding-key";
import type { EmbeddingBackend } from "./embeddings-backend";

/**
 * Single writer for `item_chunks` — chunks an item's body, embeds each chunk against the team's
 * resolved embeddings backend, and REPLACES the item's chunk set. Idempotent on the item's
 * `content_sha256`: an unchanged body is a no-op, so re-running the backfill / scheduler never
 * re-embeds (and never double-charges the embeddings API).
 *
 * Optional + best-effort: a no-op unless the pgvector schema is loaded (`item_chunks` exists) AND the
 * team has a resolvable embeddings backend (Admin pick or env `EMBEDDINGS_URL`). With either absent,
 * dense indexing skips and retrieval falls back to FTS. Guarded by
 * test/guards/single-writer-item-chunks.test.ts — nothing else may write `item_chunks`.
 */

export interface IndexItemInput {
  id: string;
  teamId: string;
  body: string;
  access: "team" | "external";
  contentSha256: string;
}

export interface IndexResult {
  itemId: string;
  chunks: number;
  skipped: boolean;
}

let tablePresent: boolean | undefined;

/** True when the optional pgvector `item_chunks` table is loaded. Global (schema-level), cached. */
export async function itemChunksTablePresent(): Promise<boolean> {
  if (tablePresent !== undefined) return tablePresent;
  try {
    await runSql("select 1 from item_chunks limit 1", []);
    tablePresent = true;
  } catch {
    tablePresent = false; // optional schema not loaded
  }
  return tablePresent;
}

/** Test/backfill hook: forget the cached table-presence probe. */
export function resetDenseIndexProbe(): void {
  tablePresent = undefined;
}

/**
 * Chunk + embed one item and replace its chunk set. Returns `{skipped:true}` when the pgvector table
 * is absent or the body is unchanged. An empty body clears any stale chunks. `backend` is the team's
 * resolved embeddings backend (baseUrl+model+key). Throws only on a hard DB error; embedding transport
 * errors propagate so the caller can log + continue with the next item.
 */
export async function indexItem(item: IndexItemInput, backend: EmbeddingBackend): Promise<IndexResult> {
  if (!(await itemChunksTablePresent())) return { itemId: item.id, chunks: 0, skipped: true };
  const body = (item.body ?? "").trim();

  // Skip when the stored chunk set already reflects this body hash.
  const cur = await runSql<{ content_sha256: string }>(
    "select content_sha256 from item_chunks where item_id = $1 limit 1",
    [item.id]
  );
  if (body && cur.rows[0]?.content_sha256 === item.contentSha256) {
    return { itemId: item.id, chunks: 0, skipped: true };
  }

  const chunks = body ? chunkText(body) : [];
  if (!chunks.length) {
    await runSql("delete from item_chunks where item_id = $1", [item.id]);
    return { itemId: item.id, chunks: 0, skipped: false };
  }

  const vectors = await embed(chunks, backend);
  if (!vectors.length) return { itemId: item.id, chunks: 0, skipped: true };

  // Replace: clear old chunks, insert the fresh set (each embedding cast text → vector).
  await runSql("delete from item_chunks where item_id = $1", [item.id]);
  const values: string[] = [];
  const params: unknown[] = [];
  chunks.forEach((content, i) => {
    const b = i * 7;
    values.push(`($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, $${b + 7}::vector)`);
    params.push(item.teamId, item.id, i, content, item.access, item.contentSha256, toVectorLiteral(vectors[i]));
  });
  await runSql(
    `insert into item_chunks (team_id, item_id, chunk_idx, content, access, content_sha256, embedding) values ${values.join(", ")}`,
    params
  );
  return { itemId: item.id, chunks: chunks.length, skipped: false };
}

export interface BatchIndexResult {
  scanned: number;
  indexed: number;
  chunks: number;
  skipped: boolean; // true = dense retrieval off (whole batch was a no-op)
  failed: number; // items that errored (e.g. embeddings quota/outage) — surfaced, not swallowed
  errorSample?: string; // first error message, for the health/alert surface
}

/**
 * Scope the pending scan to teams that can actually be indexed, and seed their resolved backends so
 * the item loop doesn't re-resolve (re-decrypt) them. Env endpoint set → all teams eligible (`teamIds:
 * null`), nothing pre-seeded (each team resolves lazily — its pick may still override env). Env unset →
 * only teams whose Admin pick RESOLVES to a working backend (provider + key present+enabled); a team
 * that picked a provider but whose key was disabled/deleted is excluded so its perpetually-pending
 * items can't starve the shared batch. `teamIds: []` = nothing configured → skip.
 */
async function resolvePendingScope(): Promise<{ teamIds: string[] | null; seeded: Map<string, EmbeddingBackend> }> {
  const seeded = new Map<string, EmbeddingBackend>();
  if (process.env.EMBEDDINGS_URL) return { teamIds: null, seeded }; // env endpoint applies to every team
  const rows = await runSql<{ id: string }>("select id from teams where embedding_provider is not null", []);
  const teamIds: string[] = [];
  for (const r of rows.rows) {
    const backend = await resolveEmbeddingBackend(r.id);
    if (backend) {
      teamIds.push(r.id);
      seeded.set(r.id, backend);
    }
  }
  return { teamIds, seeded };
}

/**
 * Embed items whose chunk set is MISSING or STALE (content hash differs), bounded per call. A no-op
 * when dense retrieval is off (no pgvector table, or no team/env backend configured). Used by the
 * ingest scheduler for incremental indexing each cycle and by the backfill script. Empty-body items
 * are excluded. A team whose backend can't be resolved (e.g. its provider key was deleted) is skipped
 * WITHOUT counting toward `failed`; its items are also excluded from the scan (via `eligibleTeamIds`)
 * so they can't starve the batch. One item's transient embeddings error is skipped so the rest index.
 */
export async function indexPendingItems(limit = 100): Promise<BatchIndexResult> {
  if (!(await itemChunksTablePresent())) return { scanned: 0, indexed: 0, chunks: 0, skipped: true, failed: 0 };
  const { teamIds, seeded } = await resolvePendingScope();
  if (teamIds && teamIds.length === 0) {
    return { scanned: 0, indexed: 0, chunks: 0, skipped: true, failed: 0 }; // nothing configured
  }

  const params: unknown[] = [limit];
  let teamFilter = "";
  if (teamIds) {
    params.push(teamIds);
    teamFilter = ` and i.team_id = any($2)`;
  }
  const pending = await runSql<{
    id: string;
    team_id: string;
    body: string;
    access: "team" | "external";
    content_sha256: string;
  }>(
    `select i.id, i.team_id, i.body, i.access, i.content_sha256
       from items i
       left join (select item_id, min(content_sha256) as sha from item_chunks group by item_id) c
         on c.item_id = i.id
      where i.body <> '' and (c.item_id is null or c.sha <> i.content_sha256)${teamFilter}
      order by i.updated_at desc
      limit $1`,
    params
  );

  let scanned = 0;
  let indexed = 0;
  let chunks = 0;
  let failed = 0;
  let errorSample: string | undefined;
  // Seeded with the backends already resolved in the eligibility pass (env-unset case); env-tier teams
  // resolve lazily here (their pick can still override the env endpoint).
  const backendByTeam = new Map<string, EmbeddingBackend | null>(seeded);
  for (const it of pending.rows) {
    let backend = backendByTeam.get(it.team_id);
    if (backend === undefined) {
      backend = await resolveEmbeddingBackend(it.team_id);
      backendByTeam.set(it.team_id, backend);
    }
    if (!backend) continue; // no working backend for this team — skip, don't count (not a failure)
    scanned++;
    try {
      const r = await indexItem(
        { id: it.id, teamId: it.team_id, body: it.body, access: it.access, contentSha256: it.content_sha256 },
        backend
      );
      if (!r.skipped) {
        indexed++;
        chunks += r.chunks;
      }
    } catch (err) {
      // An embeddings error (quota/outage/auth) on one item — skip it, continue the batch, but COUNT
      // it and keep the first message so the caller can surface a degraded stack instead of the old
      // silent "indexed: 0". A whole-batch failure (every item errored) is how a provider outage looks.
      failed++;
      if (!errorSample) errorSample = err instanceof Error ? err.message : String(err);
    }
  }
  return { scanned, indexed, chunks, skipped: false, failed, errorSample };
}
