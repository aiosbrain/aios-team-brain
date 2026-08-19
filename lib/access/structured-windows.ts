import "server-only";
import { runSql } from "@/lib/db/pg/pool";
import { newSqlParams, provenanceRowSqlFromIds } from "@/lib/access/provenance-sql";

/**
 * The app-layer structured WINDOWS (ENFB-2 §2.2) — capped task/decision reads whose
 * provenance predicate (and, for the task feed, every mode filter) compiles in-query, so a
 * window fills with rows its caller may actually serve. Lives in lib/ because app/ may not
 * import the pg pool (lint-enforced layering); each function is one surface's read, named for
 * it, and pinned by the guard's TITLE_SURFACE_WIRING.
 */

export interface ProvenanceCtx {
  visibleItemIds: ReadonlySet<string>;
  teamPosture: boolean;
}

/** The tasks BOARD's 500-row window (app/t/[team]/tasks) — column list matches the board's
 *  previous builder select verbatim; audience conjunct preserved. */
export async function boardTaskWindow<T>(teamId: string, ctx: ProvenanceCtx, externalAudienceOnly: boolean): Promise<T[]> {
  const p = newSqlParams();
  const access = externalAudienceOnly ? `and t.audience = 'external'` : "";
  const res = await runSql<T>(
    `select t.id, t.row_key, t.title, t.assignee, t.status, t.sprint, t.due_date, t.origin, t.project_id,
            t.updated_at, t.parent_row_key, t.labels, t.priority, t.body, t.source_item_id, t.created_by
       from tasks t
      where t.team_id = ${p.add(teamId)} ${access}
        and ${provenanceRowSqlFromIds("t", p, ctx)}
      order by t.updated_at desc
      limit 500`,
    p.values
  );
  return res.rows;
}

/** The Pulse decisions card's 8-row window — 8 VISIBLE rows (a post-filter starved the card),
 *  with `created_by` selected so hand-typed decisions survive (the PRET-5 H2 class). */
export async function decisionsCardWindow(
  teamId: string,
  ctx: ProvenanceCtx,
  externalAudienceOnly: boolean
): Promise<{ id: string; title: string | null; decided_at: string | null; tier: string | null; still_valid: boolean | null; source_item_id: string | null; created_by: string | null }[]> {
  const p = newSqlParams();
  const access = externalAudienceOnly ? `and d.audience = 'external'` : "";
  const res = await runSql<{ id: string; title: string | null; decided_at: string | null; tier: string | null; still_valid: boolean | null; source_item_id: string | null; created_by: string | null }>(
    `select d.id, d.title, d.decided_at::text as decided_at, d.tier, d.still_valid, d.source_item_id, d.created_by
       from decisions d
      where d.team_id = ${p.add(teamId)} ${access}
        and ${provenanceRowSqlFromIds("d", p, ctx)}
      order by d.decided_at desc limit 8`,
    p.values
  );
  return res.rows;
}

export interface TaskFeedWindowOpts {
  since: string;
  externalAudienceOnly: boolean;
  projectId?: string | null;
  keys?: readonly string[] | null;
  /** sync-origin mode: only workspace-pushed rows. */
  syncOriginOnly?: boolean;
  /** writeback mode: dashboard-origin rows OR synced rows edited after their push. */
  writebackOnly?: boolean;
  page: number;
}

export interface TaskFeedRow {
  row_key: string | null;
  title: string;
  assignee: string;
  status: string;
  raw_status: string | null;
  sprint: string;
  due_date: string | Date | null;
  parent_row_key: string | null;
  labels: string[] | null;
  priority: string | null;
  origin: string;
  updated_at: string;
  project_slug: string | null;
}

/** `GET /api/v1/tasks`' window — EVERY serving filter (provenance, audience, mode) compiles
 *  in-query, so `unknown_keys`/`truncated` describe the same set the caller receives. */
export async function taskFeedWindow(teamId: string, ctx: ProvenanceCtx, opts: TaskFeedWindowOpts): Promise<TaskFeedRow[]> {
  const p = newSqlParams();
  const conds = [
    `t.team_id = ${p.add(teamId)}`,
    `t.updated_at > ${p.add(opts.since)}::timestamptz`,
    `t.row_key is not null`,
    provenanceRowSqlFromIds("t", p, ctx),
  ];
  if (opts.externalAudienceOnly) conds.push(`t.audience = 'external'`);
  if (opts.projectId) conds.push(`t.project_id = ${p.add(opts.projectId)}`);
  if (opts.keys) conds.push(`t.row_key = any(${p.add([...opts.keys])})`);
  if (opts.syncOriginOnly) conds.push(`t.origin = 'sync'`);
  if (opts.writebackOnly)
    conds.push(`(t.origin = 'ui' or (i.synced_at is not null and t.updated_at > i.synced_at))`);

  const res = await runSql<TaskFeedRow>(
    `select t.row_key, t.title, t.assignee, t.status, t.raw_status, t.sprint, t.due_date, t.parent_row_key,
            t.labels, t.priority, t.origin, t.updated_at, p.slug as project_slug
       from tasks t
       left join projects p on p.id = t.project_id
       left join items i on i.id = t.source_item_id
      where ${conds.join(" and ")}
      order by t.updated_at asc
      limit ${p.add(opts.page)}`,
    p.values
  );
  return res.rows;
}
