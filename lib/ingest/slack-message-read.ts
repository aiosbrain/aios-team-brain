import "server-only";

import { withTransaction } from "@/lib/db/pg/tx";
import type { SqlExecutor } from "@/lib/db/types";

/** Source evidence only. The caller supplies item IDs from the current access oracle and resolves
 * qualified authors through the shared identity oracle; this reader grants neither access nor credit.
 * Nothing in the active timeline imports it yet.
 */
export interface VisibleSlackMessage {
  itemId: string;
  workspaceId: string;
  channelId: string;
  messageTs: string;
  rootTs: string;
  authorExternalId: string;
  occurredAt: string;
  isRoot: boolean;
}

export interface SlackMessageReadWindow {
  teamId: string;
  /** Inclusive rolling UTC start and inclusive fixed request as-of instant. */
  since: Date;
  asOf: Date;
  /** IDs already authorized by the current item-visibility oracle. */
  visibleItemIds: ReadonlySet<string>;
}

const PAGE_SIZE = 512;

/** Exhaust one source-ledger snapshot. The later caller must reauthorize visibleItemIds before use.
 * No total-row cap: a failed page rejects the entire result.
 */
export async function readVisibleSlackMessages(
  input: SlackMessageReadWindow,
  // afterPage is a test seam for deterministic writes/failures between full pages.
  options: { pageSize?: number; afterPage?: (pageNumber: number, query: SqlExecutor) => Promise<void> } = {}
): Promise<VisibleSlackMessage[]> {
  const { teamId, since, asOf, visibleItemIds } = input;
  if (!teamId || !Number.isFinite(since.getTime()) || !Number.isFinite(asOf.getTime()) || since > asOf) {
    throw new Error("slack message read: invalid team or UTC window");
  }
  const pageSize = options.pageSize ?? PAGE_SIZE;
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > PAGE_SIZE) {
    throw new Error("slack message read: invalid page size");
  }
  if (visibleItemIds.size === 0) return [];

  const itemIds = [...visibleItemIds];
  return withTransaction(async (client) => {
    // Every page must see one committed ledger state. SET precedes the first SELECT, which
    // establishes the repeatable-read snapshot; the transaction helper owns rollback/release.
    await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
    const query: SqlExecutor = async <T>(sql: string, params: unknown[] = []) => {
      const page = await client.query(sql, params);
      return { rows: page.rows as T[], rowCount: page.rowCount ?? 0 };
    };
    const result: VisibleSlackMessage[] = [];
    let cursor: { occurredAt: string; itemId: string; messageTs: string;
      workspaceId: string; channelId: string } | null = null;
    let pageNumber = 0;
    for (;;) {
      // Visibility and window predicates precede LIMIT. Keep the keyset instant as timestamptz;
      // to_char returns full microseconds rather than a JS Date's milliseconds. The scope fields
      // complete the order because the ledger key is (team, workspace, channel, message_ts).
      const page: { rows: VisibleSlackMessage[] } = await query<VisibleSlackMessage>(
        `select m.item_id as "itemId", m.workspace_id as "workspaceId",
                m.channel_id as "channelId", m.message_ts as "messageTs",
                m.root_ts as "rootTs", m.author_external_id as "authorExternalId",
                to_char(m.occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "occurredAt",
                m.is_root as "isRoot"
           from slack_messages m
          where m.team_id = $1::uuid
            and m.item_id = any($2::uuid[])
            and m.eligible = true and m.deleted_at is null
            and m.occurred_at >= $3::timestamptz and m.occurred_at <= $4::timestamptz
            and ($5::timestamptz is null or
                 (m.occurred_at, m.item_id, m.message_ts, m.workspace_id, m.channel_id) >
                 ($5::timestamptz, $6::uuid, $7::text, $8::text, $9::text))
          order by m.occurred_at, m.item_id, m.message_ts, m.workspace_id, m.channel_id
          limit $10`,
        [teamId, itemIds, since.toISOString(), asOf.toISOString(),
          cursor?.occurredAt ?? null, cursor?.itemId ?? null, cursor?.messageTs ?? null,
          cursor?.workspaceId ?? null, cursor?.channelId ?? null, pageSize]
      );
      if (page.rows.length === 0) return result;
      result.push(...page.rows);
      if (page.rows.length < pageSize) return result;
      const last = page.rows[page.rows.length - 1];
      cursor = { occurredAt: last.occurredAt, itemId: last.itemId, messageTs: last.messageTs,
        workspaceId: last.workspaceId, channelId: last.channelId };
      await options.afterPage?.(++pageNumber, query);
    }
  });
}
