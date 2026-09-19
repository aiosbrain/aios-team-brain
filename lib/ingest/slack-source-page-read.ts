import "server-only";

import { withTransaction } from "@/lib/db/pg/tx";
import type { SqlExecutor } from "@/lib/db/types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PRECISE_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const MAX_PAGE_SIZE = 512;

/** The exact Postgres instant and UUID ordering tuple from a previous page. */
export interface SlackSourcePageCursor {
  occurredAt: string;
  itemId: string;
}

export interface SlackSourcePageRequest {
  teamId: string;
  /** Complete, currently authorized item IDs. The set itself has no page-size cap. */
  visibleItemIds: ReadonlySet<string>;
  /** Inclusive fixed UTC bounds, captured before the first database await. */
  since: Date;
  asOf: Date;
  pageSize: number;
  cursor?: SlackSourcePageCursor;
}

export interface SlackSourcePage {
  itemIds: string[];
  nextCursor: SlackSourcePageCursor | null;
  hasMore: boolean;
}

function preciseUtc(value: unknown): value is string {
  if (typeof value !== "string" || !PRECISE_UTC.test(value)) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) &&
    date.toISOString().slice(0, 23) === value.slice(0, 23);
}

/**
 * One inactive, source-only keyset page. The future caller owns access rechecks, generation
 * binding and restart policy. A failed SQL read rejects; it never means an empty page.
 */
export async function readSlackSourcePage(
  input: SlackSourcePageRequest,
  // Test seam for observing the read-only transaction and deterministic failure injection.
  options: { beforeRead?: (query: SqlExecutor) => Promise<void> } = {}
): Promise<SlackSourcePage> {
  if (!input || typeof input.teamId !== "string" || !UUID.test(input.teamId)) {
    throw new TypeError("slack source page: invalid team ID");
  }
  if (!(input.visibleItemIds instanceof Set)) {
    throw new TypeError("slack source page: visible item IDs must be a Set");
  }
  // Clone before any await; caller mutation cannot change a later query parameter.
  const visibleItemIds = [...input.visibleItemIds];
  if (visibleItemIds.some((id) => typeof id !== "string" || !UUID.test(id))) {
    throw new TypeError("slack source page: invalid visible item ID");
  }
  if (!(input.since instanceof Date) || !(input.asOf instanceof Date) ||
      !Number.isFinite(input.since.getTime()) || !Number.isFinite(input.asOf.getTime()) ||
      input.since.getTime() > input.asOf.getTime()) {
    throw new TypeError("slack source page: invalid UTC window");
  }
  if (!Number.isSafeInteger(input.pageSize) || input.pageSize < 1 ||
      input.pageSize > MAX_PAGE_SIZE) {
    throw new TypeError("slack source page: invalid page size");
  }

  const teamId = input.teamId.toLowerCase();
  const ids = visibleItemIds.map((id) => id.toLowerCase());
  const pageSize = input.pageSize;
  const since = new Date(input.since.getTime());
  const asOf = new Date(input.asOf.getTime());
  let cursor: SlackSourcePageCursor | undefined;
  if (input.cursor !== undefined) {
    const candidate = input.cursor;
    if (!candidate || !preciseUtc(candidate.occurredAt) ||
        typeof candidate.itemId !== "string" || !UUID.test(candidate.itemId) ||
        !ids.includes(candidate.itemId.toLowerCase()) ||
        candidate.occurredAt < since.toISOString().replace("Z", "000Z") ||
        candidate.occurredAt > asOf.toISOString().replace("Z", "000Z")) {
      throw new TypeError("slack source page: invalid cursor");
    }
    cursor = { occurredAt: candidate.occurredAt, itemId: candidate.itemId.toLowerCase() };
  }

  return withTransaction(async (client) => {
    await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
    const query: SqlExecutor = async <T>(sql: string, params: unknown[] = []) => {
      const result = await client.query(sql, params);
      return { rows: result.rows as T[], rowCount: result.rowCount ?? 0 };
    };
    await options.beforeRead?.(query);
    const page = await query<SlackSourcePageCursor>(
      `select m.item_id as "itemId",
              to_char(max(m.occurred_at) at time zone 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "occurredAt"
         from slack_messages m
         join items i on i.id = m.item_id and i.team_id = m.team_id
        where m.team_id = $1::uuid
          and m.item_id = any($2::uuid[])
          and i.frontmatter->>'source' = 'slack'
          and m.eligible = true and m.deleted_at is null
          and m.occurred_at >= $3::timestamptz
          and m.occurred_at <= $4::timestamptz
        group by m.item_id
       having $5::timestamptz is null
           or (max(m.occurred_at), m.item_id) < ($5::timestamptz, $6::uuid)
        order by max(m.occurred_at) desc, m.item_id desc
        limit $7`,
      [teamId, ids, since.toISOString(), asOf.toISOString(),
        cursor?.occurredAt ?? null, cursor?.itemId ?? null, pageSize + 1]
    );
    const hasMore = page.rows.length > pageSize;
    const rows = page.rows.slice(0, pageSize);
    const last = rows.at(-1);
    return {
      itemIds: rows.map((row) => row.itemId),
      hasMore,
      nextCursor: hasMore && last
        ? { occurredAt: last.occurredAt, itemId: last.itemId }
        : null,
    };
  });
}
