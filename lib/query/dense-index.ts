import "server-only";
import { runSql } from "@/lib/db/pg/pool";
import { embed, embeddingsConfigured, toVectorLiteral } from "./embeddings";
import { chunkText } from "./chunk";
import { resolveEmbeddingKey } from "./embedding-key";

/**
 * Single writer for `item_chunks` — chunks an item's body, embeds each chunk, and REPLACES the
 * item's chunk set. Idempotent on the item's `content_sha256`: an unchanged body is a no-op, so
 * re-running the backfill / scheduler never re-embeds (and never double-charges the embeddings API).
 *
 * Optional + best-effort: a no-op unless `EMBEDDINGS_URL` is set AND the pgvector schema is loaded
 * (`item_chunks` exists). With either absent, dense indexing skips and retrieval falls back to FTS.
 * Postgres-target only (uses the raw `runSql` escape hatch for the `vector` cast). Guarded by
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

/** True when dense indexing can run: embeddings configured AND the optional `item_chunks` exists. */
export async function denseIndexAvailable(): Promise<boolean> {
  if (!embeddingsConfigured()) return false;
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
 * Chunk + embed one item and replace its chunk set. Returns `{skipped:true}` when dense indexing is
 * off or the body is unchanged. An empty body clears any stale chunks. Throws only on a hard DB
 * error (embedding transport errors propagate so the caller can log + continue with the next item).
 */
export async function indexItem(item: IndexItemInput, apiKey?: string | null): Promise<IndexResult> {
  if (!(await denseIndexAvailable())) return { itemId: item.id, chunks: 0, skipped: true };
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

  const vectors = await embed(chunks, apiKey);
  if (!vectors) return { itemId: item.id, chunks: 0, skipped: true }; // config raced away

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
 * Embed items whose chunk set is MISSING or STALE (content hash differs), bounded per call. A no-op
 * when dense retrieval is off. Used by the ingest scheduler for incremental indexing each cycle and
 * by the backfill script. Empty-body items are excluded (nothing to embed). One item failing (e.g. a
 * transient embeddings error) is skipped so the rest of the batch still indexes.
 */
export async function indexPendingItems(limit = 100, apiKey?: string | null): Promise<BatchIndexResult> {
  if (!(await denseIndexAvailable())) return { scanned: 0, indexed: 0, chunks: 0, skipped: true, failed: 0 };
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
      where i.body <> '' and (c.item_id is null or c.sha <> i.content_sha256)
      order by i.updated_at desc
      limit $1`,
    [limit]
  );
  let indexed = 0;
  let chunks = 0;
  let failed = 0;
  let errorSample: string | undefined;
  const keyByTeam = new Map<string, string | null>(); // resolve each team's embedding key once
  for (const it of pending.rows) {
    try {
      let key: string | null;
      if (apiKey !== undefined) key = apiKey;
      else if (keyByTeam.has(it.team_id)) key = keyByTeam.get(it.team_id)!;
      else {
        key = await resolveEmbeddingKey(it.team_id);
        keyByTeam.set(it.team_id, key);
      }
      const r = await indexItem(
        { id: it.id, teamId: it.team_id, body: it.body, access: it.access, contentSha256: it.content_sha256 },
        key
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
  return { scanned: pending.rows.length, indexed, chunks, skipped: false, failed, errorSample };
}
