import "server-only";

import { withTransaction } from "@/lib/db/pg/tx";
import type { SqlExecutor } from "@/lib/db/types";

const PAGE_SIZE = 512;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type SlackWorkspaceObservationRow = {
  id: string;
  teamId: string;
  integrationId: string;
  workspaceId: string;
  firstObservedAt: string;
  provenanceKind: string;
};

/**
 * Read one team's recorded auth.test workspace observations for future attended discovery.
 * This is evidence of recorded observations, not a complete historical source census:
 * earlier rotations or deleted integrations may never have been observed, and privileged
 * table mutation remains possible. No caller may use this snapshot to authorize cutover.
 */
export async function readSlackWorkspaceObservationRows(
  teamId: string,
  // afterPage is a test seam for concurrent commits and failed-query verification.
  options: { pageSize?: number; afterPage?: (pageNumber: number, query: SqlExecutor) => Promise<void> } = {}
): Promise<SlackWorkspaceObservationRow[]> {
  if (typeof teamId !== "string" || !UUID.test(teamId)) {
    throw new Error("slack workspace observations: invalid team ID");
  }
  const pageSize = options.pageSize ?? PAGE_SIZE;
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > PAGE_SIZE) {
    throw new Error("slack workspace observations: invalid page size");
  }

  return withTransaction(async (client) => {
    await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
    const query: SqlExecutor = async <T>(sql: string, params: unknown[] = []) => {
      const page = await client.query(sql, params);
      return { rows: page.rows as T[], rowCount: page.rowCount ?? 0 };
    };
    const rows: SlackWorkspaceObservationRow[] = [];
    let cursor: string | null = null;
    let pageNumber = 0;
    for (;;) {
      const page: { rows: SlackWorkspaceObservationRow[] } = await query<SlackWorkspaceObservationRow>(
        `select id, team_id as "teamId", integration_id as "integrationId",
                workspace_id as "workspaceId", first_observed_at as "firstObservedAt",
                provenance_kind as "provenanceKind"
           from slack_workspace_observations
          where team_id = $1::uuid and ($2::uuid is null or id > $2::uuid)
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
