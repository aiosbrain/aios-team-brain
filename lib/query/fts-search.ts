import "server-only";
import { runSql } from "@/lib/db/pg/pool";
import { isRestrictedTier } from "@/lib/auth/visibility";

/**
 * Ranked keyword (FTS) retrieval over `items.search`. The builder path emits a bare
 * `search @@ websearch_to_tsquery(...)` filter with a plain `LIMIT` and NO ordering, so at scale the
 * top-N is "any N matching rows" in physical order — a highly-relevant doc that matches five query
 * terms has no priority over one that incidentally matches a single common word. This runs the same
 * match but orders by `ts_rank` DESC, so the capped window is the *best* N, not an arbitrary N (Gap
 * #2 from the multi-channel adversarial suite). Postgres-only, same raw-SQL precedent as dense-search.
 *
 * `rank` is returned so callers can reason about match strength. Tier is enforced in-DB on the live
 * `items.access` (external callers never get team content) — the sole enforcement, no RLS backstop.
 */

export interface FtsHit {
  id: string;
  path: string;
  kind: string;
  body: string;
  synced_at: string;
  project: string;
  rank: number;
}

export async function rankedFtsSearch(
  teamId: string,
  tier: "team" | "external",
  orQuery: string,
  limit = 20,
  channel?: string | null
): Promise<FtsHit[]> {
  if (!orQuery.trim()) return [];
  const params: unknown[] = [orQuery, teamId];
  let where = "i.team_id = $2 and i.search @@ websearch_to_tsquery('english', $1)";
  if (isRestrictedTier(tier)) where += " and i.access = 'external'";
  if (channel) {
    // Channel scope (Gap #4): the channel is a path's 2nd segment, `<source>/<name>/…`.
    params.push(channel);
    where += ` and split_part(i.path, '/', 2) = $${params.length}`;
  }
  params.push(limit);
  const limitIdx = params.length;

  const sql = `
    select i.id, i.path, i.kind, i.body, i.synced_at, coalesce(p.slug, '') as project,
           ts_rank(i.search, websearch_to_tsquery('english', $1)) as rank
    from items i
    left join projects p on p.id = i.project_id
    where ${where}
    order by rank desc, i.synced_at desc
    limit $${limitIdx}`;

  const res = await runSql<{
    id: string;
    path: string;
    kind: string;
    body: string | null;
    synced_at: string | Date;
    project: string;
    rank: number | string;
  }>(sql, params);

  return res.rows.map((r) => ({
    id: r.id,
    path: r.path,
    kind: r.kind,
    body: r.body ?? "",
    synced_at: r.synced_at instanceof Date ? r.synced_at.toISOString() : String(r.synced_at ?? ""),
    project: r.project,
    rank: typeof r.rank === "number" ? r.rank : Number(r.rank) || 0,
  }));
}
