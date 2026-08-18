import "server-only";
import { runSql } from "@/lib/db/pg/pool";

/**
 * The okf-bundle's keyset pager (ENFB-1 §2.5). Raw SQL because the page needs a COMPOSITE row
 * comparison — `(updated_at, id) > (cursor_ts, cursor_id)` — which the pg adapter's builder
 * cannot express, and without it 501 visible rows sharing one timestamp silently skip row 501
 * (the pre-existing keyset bug this slice fixes; `path` cannot tiebreak either — items are
 * unique per (team_id, project_id, path), so two projects can hold the same path).
 *
 * The page also intersects with the caller's MEMBERSHIP-visible id set in-query
 * (`i.id = any(...)`) — the ENFB-1 oracle gate, same fail-closed shape as the items list
 * (empty set → the caller passes [] and gets no rows without touching this function).
 */

export interface OkfPageRow {
  id: string;
  path: string;
  kind: string;
  access: string;
  frontmatter: Record<string, unknown>;
  body: string | null;
  content_sha256: string | null;
  updated_at: string;
  slug: string;
}

export interface OkfCursor {
  ts: string;
  /** null = a LEGACY bare-timestamp cursor (pre-ENFB-1): strictly-after that timestamp. */
  id: string | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Greater than every real uuid — encodes the legacy "strictly after this timestamp" semantic
 *  as a composite bound, so one predicate shape serves both cursor generations. */
const MAX_UUID = "ffffffff-ffff-ffff-ffff-ffffffffffff";

/** Accepts the new `<updated_at>|<id>` form and the legacy bare-timestamp form (no `|`). */
export function parseOkfCursor(raw: string): OkfCursor | null {
  if (!raw) return null;
  const bar = raw.indexOf("|");
  if (bar === -1) return { ts: raw, id: null };
  const ts = raw.slice(0, bar);
  const id = raw.slice(bar + 1);
  if (!UUID_RE.test(id)) return null; // malformed composite — refuse rather than guess
  return { ts, id };
}

export function formatOkfCursor(ts: string | Date, id: string): string {
  const iso = ts instanceof Date ? ts.toISOString() : new Date(ts).toISOString();
  return `${iso}|${id}`;
}

export async function pageVisibleOkfItems(opts: {
  teamId: string;
  /** The caller's membership-visible item ids — ALREADY resolved via the oracle. */
  visibleIds: readonly string[];
  /** Exclusive lower bound: a parsed cursor, or a bare `since` timestamp (legacy semantic). */
  after: OkfCursor;
  /** Optional single-project scope (the route's ?project= filter). */
  projectId: string | null;
  /** Posture ceiling: external callers see only access='external' rows (unchanged wall). */
  externalOnly: boolean;
  limit: number;
}): Promise<OkfPageRow[]> {
  if (opts.visibleIds.length === 0) return [];
  const boundId = opts.after.id ?? MAX_UUID;
  const params: unknown[] = [opts.teamId, [...opts.visibleIds], opts.after.ts, boundId, opts.limit];
  let where = `i.team_id = $1 and i.id = any($2::uuid[]) and (i.updated_at, i.id) > ($3::timestamptz, $4::uuid)`;
  if (opts.externalOnly) where += ` and i.access = 'external'`;
  if (opts.projectId) {
    params.push(opts.projectId);
    where += ` and i.project_id = $${params.length}`;
  }
  const r = await runSql<OkfPageRow>(
    `select i.id, i.path, i.kind, i.access, i.frontmatter, i.body, i.content_sha256,
            i.updated_at::text as updated_at, p.slug
       from items i
       join projects p on p.id = i.project_id
      where ${where}
      order by i.updated_at asc, i.id asc
      limit $5`,
    params
  );
  return r.rows;
}
