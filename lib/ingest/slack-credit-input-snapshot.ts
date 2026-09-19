import "server-only";

import { withTransaction } from "@/lib/db/pg/tx";
import type { SqlExecutor } from "@/lib/db/types";
import type { SlackAccountMapping } from "@/lib/identity/resolve";
import type { SlackTeamGenerations } from "./slack-message-ledger";
import {
  readSlackItemCreditLedgerInSession,
  validateSlackItemCreditRequest,
  type SlackItemCreditLedger,
} from "./slack-item-credit-ledger-read";

export interface SlackCreditInputSnapshot {
  /** Bound by the reader even when every result collection is empty. */
  teamId: string;
  ledgers: SlackItemCreditLedger[];
  mappings: SlackAccountMapping[];
  humanMemberIds: ReadonlySet<string>;
  generations: SlackTeamGenerations;
}

type PagePart = "messages" | "identities" | "members";
interface SnapshotReadOptions {
  pageSize?: number;
  /** Test seam for committed writes, failed pages, and read-only enforcement. */
  afterPage?: (part: PagePart, pageNumber: number, query: SqlExecutor) => Promise<void>;
}

/** Inactive input read. The caller must authorize requested items and revalidate generations at
 * cache publication. This snapshot does not prove historical discovery, visibility or credit.
 */
export async function readSlackCreditInputSnapshot(
  teamId: string,
  itemIds: readonly string[] | ReadonlySet<string>,
  options: SnapshotReadOptions = {}
): Promise<SlackCreditInputSnapshot> {
  // Validate every caller-controlled bound before opening a transaction.
  const { requested, pageSize } = validateSlackItemCreditRequest(teamId, itemIds, options.pageSize);
  return withTransaction(async (client) => {
    await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
    const query: SqlExecutor = async <T>(sql: string, params: unknown[] = []) => {
      const result = await client.query(sql, params);
      return { rows: result.rows as T[], rowCount: result.rowCount ?? 0 };
    };
    const ledgers = await readSlackItemCreditLedgerInSession(query, teamId, requested, pageSize,
      (page, sql) => options.afterPage?.("messages", page, sql) ?? Promise.resolve());

    const mappings: SlackAccountMapping[] = [];
    let identityCursor: string | null = null;
    let identityPage = 0;
    for (;;) {
      // Use the same database classifier as the cutover guard. Keep the exact stored spelling:
      // lookupSlackAccount treats noncanonical rows as collision evidence, never candidates.
      const page: { rows: {
        id: string; teamId: string; provider: string; externalId: string; memberId: string;
      }[] } = await query<{
        id: string; teamId: string; provider: string; externalId: string; memberId: string;
      }>(
        `select id, team_id as "teamId", provider, external_id as "externalId",
                member_id as "memberId"
           from member_identities
          where team_id = $1::uuid and is_slack_identity_provider(provider)
            and ($2::uuid is null or id > $2::uuid)
          order by id
          limit $3`,
        [teamId, identityCursor, pageSize]
      );
      const rows = page.rows;
      mappings.push(...rows.map(({ teamId: rowTeamId, provider, externalId, memberId }) => ({
        teamId: rowTeamId, provider, externalId, memberId, state: "live" as const,
      })));
      if (rows.length < pageSize) break;
      identityCursor = rows[rows.length - 1].id;
      await options.afterPage?.("identities", ++identityPage, query);
    }

    const humanMemberIds = new Set<string>();
    let memberCursor: string | null = null;
    let memberPage = 0;
    for (;;) {
      const page: { rows: { id: string }[] } = await query<{ id: string }>(
        `select id from members
          where team_id = $1::uuid and kind = 'human' and is_connector = false
            and ($2::uuid is null or id > $2::uuid)
          order by id
          limit $3`,
        [teamId, memberCursor, pageSize]
      );
      const rows = page.rows;
      for (const row of rows) humanMemberIds.add(row.id);
      if (rows.length < pageSize) break;
      memberCursor = rows[rows.length - 1].id;
      await options.afterPage?.("members", ++memberPage, query);
    }

    const { rows: stateRows } = await query<{
      dataGeneration: string; identityGeneration: string; presentationGeneration: string;
    }>(
      `select data_generation::text as "dataGeneration",
              identity_generation::text as "identityGeneration",
              presentation_generation::text as "presentationGeneration"
         from slack_team_state where team_id = $1::uuid`,
      [teamId]
    );
    const generations = stateRows[0] ?? {
      dataGeneration: "0", identityGeneration: "0", presentationGeneration: "0",
    };
    // PostgreSQL UUID projections use lowercase; keep the snapshot binding in the same form
    // even if the validated caller supplied uppercase UUID hex.
    return { teamId: teamId.toLowerCase(), ledgers, mappings, humanMemberIds, generations };
  });
}
