import "server-only";

import { withTransaction } from "@/lib/db/pg/tx";
import type { SqlExecutor } from "@/lib/db/types";
import type { SlackCutoverIdentityRow } from "./slack-cutover-provenance";

const PAGE_SIZE = 512;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Load the complete existing Slack identity map for one team's future attended discovery.
 * The database's provider classifier matches the cutover guard, including Unicode trim variants.
 * This snapshot does not authorize migration: the attendee must drain old writers, acquire the
 * team advisory lock, and reread/validate the rows in its own marker-setting transaction.
 */
export async function readSlackCutoverIdentityRows(
  teamId: string,
  // afterPage is a test seam for concurrent commits and failed-page verification.
  options: { pageSize?: number; afterPage?: (pageNumber: number, query: SqlExecutor) => Promise<void> } = {}
): Promise<SlackCutoverIdentityRow[]> {
  if (typeof teamId !== "string" || !UUID.test(teamId)) {
    throw new Error("slack cutover rows: invalid team ID");
  }
  const pageSize = options.pageSize ?? PAGE_SIZE;
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > PAGE_SIZE) {
    throw new Error("slack cutover rows: invalid page size");
  }

  return withTransaction(async (client) => {
    await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
    const query: SqlExecutor = async <T>(sql: string, params: unknown[] = []) => {
      const page = await client.query(sql, params);
      return { rows: page.rows as T[], rowCount: page.rowCount ?? 0 };
    };
    const rows: SlackCutoverIdentityRow[] = [];
    let cursor: string | null = null;
    let pageNumber = 0;
    for (;;) {
      const page: { rows: SlackCutoverIdentityRow[] } = await query<SlackCutoverIdentityRow>(
        `select id, team_id as "teamId", provider, member_id as "memberId",
                external_id as "externalId"
           from member_identities
          where team_id = $1::uuid and is_slack_identity_provider(provider)
            and ($2::uuid is null or id > $2::uuid)
          order by id
          limit $3`,
        [teamId, cursor, pageSize]
      );
      if (page.rows.length === 0) return rows;
      rows.push(...page.rows);
      if (page.rows.length < pageSize) return rows;
      cursor = page.rows[page.rows.length - 1].id;
      await options.afterPage?.(++pageNumber, query);
    }
  });
}
