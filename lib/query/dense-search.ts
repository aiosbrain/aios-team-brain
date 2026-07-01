import "server-only";
import { runSql } from "@/lib/db/pg/pool";
import { embed, toVectorLiteral } from "./embeddings";
import { denseIndexAvailable } from "./dense-index";
import { resolveEmbeddingKey } from "./embedding-key";
import type { Source } from "./provider";

/**
 * Query-time dense (semantic) passage retrieval over `item_chunks`. Embeds the question, runs an
 * HNSW cosine-distance search (best chunk per item), and returns hits in ascending distance. Tier is
 * enforced in-DB on the LIVE `items.access` (the authoritative copy) — external callers never get
 * team content. Best-effort + optional: returns [] unless EMBEDDINGS_URL is set AND the pgvector
 * schema is loaded, and on any error, so retrieval degrades to keyword FTS + Graphiti.
 */

export interface DenseHit {
  item_id: string;
  content: string; // the best-matching chunk (surfaced as the source text)
  path: string;
  kind: string;
  synced_at: string;
  project: string;
}

export async function denseSearch(
  teamId: string,
  tier: "team" | "external",
  question: string,
  projectSlug?: string | null,
  limit = 20,
  apiKey?: string | null
): Promise<DenseHit[]> {
  if (!question.trim() || !(await denseIndexAvailable())) return [];
  try {
    // Key from AI model settings (integrations store), same as the LLM; embed() falls back to env.
    const key = apiKey ?? (await resolveEmbeddingKey(teamId));
    const vecs = await embed([question], key);
    if (!vecs || !vecs[0]) return [];
    const qv = toVectorLiteral(vecs[0]);

    const params: unknown[] = [qv, teamId];
    let where = "c.team_id = $2";
    if (tier === "external") where += " and i.access = 'external'";
    if (projectSlug) {
      params.push(projectSlug);
      where += ` and p.slug = $${params.length}`;
    }
    params.push(limit);
    const limitIdx = params.length;

    const sql = `
      select item_id, content, path, kind, synced_at, project from (
        select distinct on (c.item_id)
          c.item_id, c.content, i.path, i.kind, i.synced_at, coalesce(p.slug, '') as project,
          (c.embedding <=> $1::vector) as dist
        from item_chunks c
        join items i on i.id = c.item_id
        left join projects p on p.id = i.project_id
        where ${where}
        order by c.item_id, (c.embedding <=> $1::vector)
      ) best
      order by dist asc
      limit $${limitIdx}`;

    const res = await runSql<{
      item_id: string;
      content: string;
      path: string;
      kind: string;
      synced_at: string | Date;
      project: string;
    }>(sql, params);

    return res.rows.map((r) => ({
      item_id: r.item_id,
      content: r.content,
      path: r.path,
      kind: r.kind,
      synced_at:
        r.synced_at instanceof Date ? r.synced_at.toISOString() : String(r.synced_at ?? ""),
      project: r.project,
    }));
  } catch {
    return []; // degrade to keyword FTS + Graphiti
  }
}

const RRF_K = 60;

/**
 * Reciprocal-Rank Fusion of the keyword (FTS) and dense rankings into a single source order. Each
 * item scores `Σ 1/(k + rank)` across the lists it appears in; a source in both ranks above one in
 * only one, which ranks above recency/augment padding (score 0). Stable for ties (keeps prior order).
 * Pure: returns a new array with reassigned sids. `k`=60 is the standard RRF constant.
 */
export function fuseByRrf(sources: Source[], ftsIds: string[], denseIds: string[], k = RRF_K): Source[] {
  const rankMap = (ids: string[]): Map<string, number> => {
    const m = new Map<string, number>();
    ids.forEach((id, i) => {
      if (!m.has(id)) m.set(id, i);
    });
    return m;
  };
  const fts = rankMap(ftsIds);
  const dense = rankMap(denseIds);
  const score = (s: Source): number => {
    if (!s.item_id) return 0;
    let x = 0;
    const fr = fts.get(s.item_id);
    if (fr !== undefined) x += 1 / (k + fr);
    const dr = dense.get(s.item_id);
    if (dr !== undefined) x += 1 / (k + dr);
    return x;
  };
  return sources
    .map((s, i) => ({ s, i, sc: score(s) }))
    .sort((a, b) => b.sc - a.sc || a.i - b.i)
    .map((w, i) => ({ ...w.s, sid: `S${i + 1}` }));
}
