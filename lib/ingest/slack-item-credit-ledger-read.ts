import "server-only";

import { withTransaction } from "@/lib/db/pg/tx";
import type { SqlExecutor } from "@/lib/db/types";
import { parseSlackTimestamp } from "./sources/slack-message-evidence";

export const SLACK_CREDIT_READ_PAGE_SIZE = 512;
const PAGE_SIZE = SLACK_CREDIT_READ_PAGE_SIZE;
const MAX_ITEM_IDS = 512;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Match the shared Slack account lookup's exact USER component syntax.
const RAW_ID = /^[A-Z0-9]+$/;

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Source identity only. A later authorized caller must resolve this account and exclude connectors. */
export interface SlackItemCreditAuthor {
  workspaceId: string;
  channelId: string;
  messageTs: string;
  rootTs: string;
  rawUserId: string;
  occurredAt: string;
  isRoot: boolean;
}

export type SlackItemCreditLedger =
  | { itemId: string; status: "absent" }
  | { itemId: string; status: "present"; authors: SlackItemCreditAuthor[] };

export interface SlackItemCreditReadOptions {
  pageSize?: number;
  afterPage?: (pageNumber: number, query: SqlExecutor) => Promise<void>;
}

type StoredRow = {
  id: string;
  itemId: string;
  workspaceId: string;
  channelId: string;
  messageTs: string;
  rootTs: string;
  rawUserId: string | null;
  occurredAt: string | null;
  isRoot: boolean;
  eligible: boolean;
  deleted: boolean;
};

/**
 * Inactive, source-only credit evidence for explicitly supplied item IDs. Presence is established
 * from every scoped message row, including deleted and excluded rows. No access or credit decision
 * is made here; a future caller must authorize the items and resolve current account mappings.
 */
/** Shared pre-transaction validation for the standalone and atomic snapshot readers. */
export function validateSlackItemCreditRequest(
  teamId: string,
  itemIds: readonly string[] | ReadonlySet<string>,
  pageSizeInput?: number
): { requested: string[]; pageSize: number } {
  if (typeof teamId !== "string" || !UUID.test(teamId)) {
    throw new TypeError("slack item credit ledger: invalid team ID");
  }
  if (!Array.isArray(itemIds) && !(itemIds instanceof Set)) {
    throw new TypeError("slack item credit ledger: invalid item IDs");
  }
  const supplied = [...itemIds];
  if (supplied.length > MAX_ITEM_IDS) {
    throw new RangeError("slack item credit ledger: too many item IDs");
  }
  if (supplied.some((id) => typeof id !== "string" || !UUID.test(id))) {
    throw new TypeError("slack item credit ledger: invalid item ID");
  }
  const pageSize = pageSizeInput === undefined ? PAGE_SIZE : pageSizeInput;
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > PAGE_SIZE) {
    throw new RangeError("slack item credit ledger: invalid page size");
  }
  const requested = [...new Set(supplied.map((id) => id.toLowerCase()))];
  return { requested, pageSize };
}

/** The caller owns a read-only repeatable-read transaction. No partial ledger escapes on failure. */
export async function readSlackItemCreditLedgerInSession(
  query: SqlExecutor,
  teamId: string,
  requested: readonly string[],
  pageSize: number,
  afterPage?: SlackItemCreditReadOptions["afterPage"]
): Promise<SlackItemCreditLedger[]> {
    if (requested.length === 0) return [];
    const byItem = new Map<string, SlackItemCreditAuthor[] | null>(requested.map((id) => [id, null]));
    const bindings = new Map<string, Pick<StoredRow, "workspaceId" | "channelId" | "rootTs">>();
    let cursor: string | null = null;
    let pageNumber = 0;
    for (;;) {
      // The UUID primary key is unique even when source timestamps and source IDs tie. Reading
      // all rows before filtering authors preserves present-with-no-credit evidence.
      const page: { rows: StoredRow[] } = await query<StoredRow>(
        `select id, item_id as "itemId", workspace_id as "workspaceId",
                channel_id as "channelId", message_ts as "messageTs", root_ts as "rootTs",
                author_external_id as "rawUserId",
                to_char(occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "occurredAt",
                is_root as "isRoot", eligible, (deleted_at is not null) as deleted
           from slack_messages
          where team_id = $1::uuid and item_id = any($2::uuid[])
            and ($3::uuid is null or id > $3::uuid)
          order by id
          limit $4`,
        [teamId, requested, cursor, pageSize]
      );
      for (const row of page.rows) {
        const authors = byItem.get(row.itemId);
        if (authors === undefined) throw new Error("slack item credit ledger: unrequested item row");
        const binding = bindings.get(row.itemId);
        if (binding && (binding.workspaceId !== row.workspaceId ||
            binding.channelId !== row.channelId || binding.rootTs !== row.rootTs)) {
          throw new Error("slack item credit ledger: item spans multiple source threads");
        }
        if (!binding) bindings.set(row.itemId, {
          workspaceId: row.workspaceId, channelId: row.channelId, rootTs: row.rootTs,
        });
        const current = authors ?? [];
        if (authors === null) byItem.set(row.itemId, current);
        if (!row.eligible || row.deleted) continue;
        // The writer validates this equality. Check it again because the schema guarantees only
        // nullability of the occurrence instant, not equality with the source timestamp.
        if (row.rawUserId === null || !RAW_ID.test(row.rawUserId) || row.occurredAt === null ||
            parseSlackTimestamp(row.messageTs)?.iso !== row.occurredAt) {
          throw new Error("slack item credit ledger: invalid eligible source identity or instant");
        }
        current.push({ workspaceId: row.workspaceId, channelId: row.channelId,
          messageTs: row.messageTs, rootTs: row.rootTs, rawUserId: row.rawUserId,
          occurredAt: row.occurredAt, isRoot: row.isRoot });
      }
      if (page.rows.length < pageSize) break;
      cursor = page.rows[page.rows.length - 1].id;
      await afterPage?.(++pageNumber, query);
    }
    return requested.map((itemId): SlackItemCreditLedger => {
      const authors = byItem.get(itemId);
      if (authors === null || authors === undefined) return { itemId, status: "absent" };
      authors.sort((a, b) => compareText(a.occurredAt, b.occurredAt) ||
        compareText(a.workspaceId, b.workspaceId) || compareText(a.channelId, b.channelId) ||
        compareText(a.messageTs, b.messageTs));
      return { itemId, status: "present", authors };
    });
}

export async function readSlackItemCreditLedger(
  teamId: string,
  itemIds: readonly string[] | ReadonlySet<string>,
  // Test seam for committed writes and failures between pages of one snapshot.
  options: SlackItemCreditReadOptions = {}
): Promise<SlackItemCreditLedger[]> {
  const { requested, pageSize } = validateSlackItemCreditRequest(teamId, itemIds, options.pageSize);
  return withTransaction(async (client) => {
    await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
    const query: SqlExecutor = async <T>(sql: string, params: unknown[] = []) => {
      const page = await client.query(sql, params);
      return { rows: page.rows as T[], rowCount: page.rowCount ?? 0 };
    };
    return readSlackItemCreditLedgerInSession(query, teamId, requested, pageSize, options.afterPage);
  });
}
