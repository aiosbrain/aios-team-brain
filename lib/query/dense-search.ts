import "server-only";
import { runSql } from "@/lib/db/pg/pool";
import { isRestrictedTier } from "@/lib/auth/visibility";
import { embed, toVectorLiteral } from "./embeddings";
import { itemChunksTablePresent } from "./dense-index";
import { resolveEmbeddingBackend } from "./embedding-key";
import type { EmbeddingBackend } from "./embeddings-backend";
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
  dist: number; // cosine distance to the query (0 = identical … 2 = opposite); lower = more relevant
}

// Relevance floor for the vector search: nearest-neighbor ALWAYS returns its N closest chunks no
// matter how far away, so an absent topic still yields "matches". Without a ceiling those far hits
// (a) become junk context and (b) flip retrieve()'s grounding signal true — defeating the IDF
// grounding safety. Only hits within this cosine distance are returned, so a dense hit is a REAL
// semantic match. 0.6 (~similarity 0.4) keeps genuine paraphrase matches while rejecting the
// unrelated tail; tune per embedding model via DENSE_MAX_DISTANCE.
const DENSE_MAX_DISTANCE = Number(process.env.DENSE_MAX_DISTANCE ?? 0.6);

export async function denseSearch(
  teamId: string,
  tier: "team" | "external",
  question: string,
  projectSlug?: string | null,
  limit = 20,
  backend?: EmbeddingBackend | null
): Promise<DenseHit[]> {
  if (!question.trim() || !(await itemChunksTablePresent())) return [];
  try {
    // Resolve the team's embeddings backend (Admin pick or env); off → no dense leg. The QUERY
    // embedding uses the SAME backend that indexed the chunks, so the vector spaces match.
    const b = backend ?? (await resolveEmbeddingBackend(teamId));
    if (!b) return [];
    const vecs = await embed([question], b);
    if (!vecs[0]) return [];
    const qv = toVectorLiteral(vecs[0]);

    const params: unknown[] = [qv, teamId];
    let where = "c.team_id = $2";
    if (isRestrictedTier(tier)) where += " and i.access = 'external'";
    if (projectSlug) {
      params.push(projectSlug);
      where += ` and p.slug = $${params.length}`;
    }
    params.push(DENSE_MAX_DISTANCE);
    const distIdx = params.length;
    params.push(limit);
    const limitIdx = params.length;

    const sql = `
      select item_id, content, path, kind, synced_at, project, dist from (
        select distinct on (c.item_id)
          c.item_id, c.content, i.path, i.kind, i.synced_at, coalesce(p.slug, '') as project,
          (c.embedding <=> $1::vector) as dist
        from item_chunks c
        join items i on i.id = c.item_id
        left join projects p on p.id = i.project_id
        where ${where}
        order by c.item_id, (c.embedding <=> $1::vector)
      ) best
      where dist <= $${distIdx}
      order by dist asc
      limit $${limitIdx}`;

    const res = await runSql<{
      item_id: string;
      content: string;
      path: string;
      kind: string;
      synced_at: string | Date;
      project: string;
      dist: number | string;
    }>(sql, params);

    return res.rows.map((r) => ({
      item_id: r.item_id,
      content: r.content,
      path: r.path,
      kind: r.kind,
      synced_at:
        r.synced_at instanceof Date ? r.synced_at.toISOString() : String(r.synced_at ?? ""),
      project: r.project,
      dist: typeof r.dist === "number" ? r.dist : Number(r.dist) || 0,
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
