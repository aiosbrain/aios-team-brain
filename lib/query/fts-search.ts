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
  /** Persisted work-time (R1) — what the answering prompt shows, and the rank tiebreak. */
  work_at: string;
  project: string;
  rank: number;
}

export async function rankedFtsSearch(
  teamId: string,
  tier: "team" | "external",
  orQuery: string,
  limit = 20,
  channel?: string | null,
  // Access enforcement (Phase B slice 2, Codex fold): the membership-visible item set, applied
  // IN-QUERY so `limit` ranks over VISIBLE rows only — a post-filter would let invisible rows
  // crowd visible ones out of the top-N (under-return) and leak an abstention side channel. Null
  // = permissive (no filter). Empty = enforcing-but-sees-nothing → the SQL returns zero rows.
  visibleIds?: readonly string[] | null
): Promise<FtsHit[]> {
  if (!orQuery.trim()) return [];
  if (visibleIds && visibleIds.length === 0) return []; // enforcing, sees nothing
  const params: unknown[] = [orQuery, teamId];
  let where = "i.team_id = $2 and i.search @@ websearch_to_tsquery('english', $1)";
  // Mode-keyed (PRET-4 §1b): enforcing (visibleIds present) → the oracle set alone; permissive
  // → the posture wall alone. Both at once would re-block ruling 2's granted team rows.
  if (visibleIds) {
    params.push(visibleIds);
    where += ` and i.id = any($${params.length}::uuid[])`;
  } else if (isRestrictedTier(tier)) {
    where += " and i.access = 'external'";
  }
  if (channel) {
    // Channel scope (Gap #4). The channel NAME appears in a path's 2nd segment for sources that key
    // paths by name (`linear/aio/…`) — but NOT for Slack, whose path is keyed on the immutable
    // channel ID so a rename can't re-key every thread into duplicate items. Slack carries its
    // readable name in `frontmatter.channel`, so match EITHER. Without the frontmatter arm a
    // "#growth" question silently retrieves zero Slack threads (and the scope phrase is stripped
    // from the query, so the word doesn't even survive as a content term).
    params.push(channel);
    const idx = params.length;
    where += ` and (split_part(i.path, '/', 2) = $${idx} or lower(i.frontmatter->>'channel') = lower($${idx}))`;
  }
  params.push(limit);
  const limitIdx = params.length;

  const sql = `
    select i.id, i.path, i.kind, i.body, i.synced_at, i.work_at, coalesce(p.slug, '') as project,
           ts_rank(i.search, websearch_to_tsquery('english', $1)) as rank
    from items i
    left join projects p on p.id = i.project_id
    where ${where}
    order by rank desc, i.work_at desc, i.id desc
    limit $${limitIdx}`;

  const res = await runSql<{
    id: string;
    path: string;
    kind: string;
    body: string | null;
    synced_at: string | Date;
    work_at: string | Date;
    project: string;
    rank: number | string;
  }>(sql, params);

  return res.rows.map((r) => ({
    id: r.id,
    path: r.path,
    kind: r.kind,
    body: r.body ?? "",
    synced_at: r.synced_at instanceof Date ? r.synced_at.toISOString() : String(r.synced_at ?? ""),
    work_at: r.work_at instanceof Date ? r.work_at.toISOString() : String(r.work_at ?? ""),
    project: r.project,
    rank: typeof r.rank === "number" ? r.rank : Number(r.rank) || 0,
  }));
}
