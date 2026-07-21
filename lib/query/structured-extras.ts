import "server-only";
import { runSql } from "@/lib/db/pg/pool";
import { isRestrictedTier } from "@/lib/auth/visibility";

/**
 * Structured-context helpers that fix the "digests are recency-capped" scaling gaps (Gaps #5, #6).
 *
 * The task digest lists at most 80 rows and the decisions digest at most 50 (newest first), so in a
 * busy multi-channel org an aggregate question ("how many open tasks?") undercounts and an older
 * decision ("which vendor did we pick in Q1?") is simply absent. These two queries add (a) a
 * FULL-corpus task count by status and (b) a keyword search over ALL decisions, so counts are
 * complete and a relevant old decision surfaces regardless of the recency window. Both tier-scoped
 * via `audience`; best-effort (empty on error). Postgres-only, same raw-SQL precedent as dense-search.
 */

export interface TaskCounts {
  total: number;
  open: number; // anything not `done`
  byStatus: Record<string, number>;
}

/** Count ALL tasks by status (uncapped), tier-scoped. Powers a correct "how many open tasks" answer. */
export async function taskStatusCounts(teamId: string, tier: "team" | "external"): Promise<TaskCounts> {
  try {
    const access = isRestrictedTier(tier) ? "and audience = 'external'" : "";
    const sql = `select status, count(*)::int as n from tasks where team_id = $1 ${access} group by status`;
    const res = await runSql<{ status: string; n: number }>(sql, [teamId]);
    const byStatus: Record<string, number> = {};
    let total = 0;
    let open = 0;
    for (const r of res.rows) {
      byStatus[r.status] = r.n;
      total += r.n;
      if (r.status !== "done") open += r.n;
    }
    return { total, open, byStatus };
  } catch {
    return { total: 0, open: 0, byStatus: {} };
  }
}

export interface DecisionMatch {
  row_key: string;
  decided_at: string | null;
  title: string;
  decided_by: string;
  still_valid: boolean;
  slug: string;
}

/**
 * Keyword-search ALL decisions (title + rationale) for the query terms, tier-scoped, ranked. This is
 * the only path to a decision that has scrolled past the recency-50 window — without it, "which
 * vendor did we pick back in Q1?" has no grounding once ~50 newer decisions exist. Decisions have no
 * FTS column, so we compute the tsvector inline (small table; a generated column + GIN is the
 * durable optimization if this ever gets hot).
 */
export async function matchingDecisions(
  teamId: string,
  tier: "team" | "external",
  orQuery: string,
  limit = 10
): Promise<DecisionMatch[]> {
  if (!orQuery.trim()) return [];
  try {
    const access = isRestrictedTier(tier) ? "and d.audience = 'external'" : "";
    const params: unknown[] = [orQuery, teamId, limit];
    const sql = `
      select d.row_key, d.decided_at, d.title, d.decided_by, d.still_valid, coalesce(p.slug, '') as slug,
             ts_rank(to_tsvector('english', coalesce(d.title,'') || ' ' || coalesce(d.rationale,'')),
                     websearch_to_tsquery('english', $1)) as rank
      from decisions d
      left join projects p on p.id = d.project_id
      where d.team_id = $2 ${access}
        and to_tsvector('english', coalesce(d.title,'') || ' ' || coalesce(d.rationale,''))
            @@ websearch_to_tsquery('english', $1)
      order by rank desc, d.decided_at desc
      limit $3`;
    const res = await runSql<{
      row_key: string;
      decided_at: string | Date | null;
      title: string;
      decided_by: string;
      still_valid: boolean;
      slug: string;
    }>(sql, params);
    return res.rows.map((r) => ({
      row_key: r.row_key,
      decided_at: r.decided_at instanceof Date ? r.decided_at.toISOString().slice(0, 10) : (r.decided_at as string | null),
      title: r.title,
      decided_by: r.decided_by,
      still_valid: r.still_valid,
      slug: r.slug,
    }));
  } catch {
    return [];
  }
}
