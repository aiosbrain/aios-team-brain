import "server-only";

import type { DecisionRow } from "@/lib/api/item-payload-schema";
import type { DbClient } from "@/lib/db/types";

export async function materializeDecisions(
  db: DbClient,
  teamId: string,
  projectId: string,
  itemId: string,
  rows: readonly DecisionRow[],
  syncedAt: string
): Promise<void> {
  for (const row of rows) {
    const { error } = await db.from("decisions").upsert(
      {
        team_id: teamId,
        project_id: projectId,
        source_item_id: itemId,
        row_key: row.row_key,
        decided_at: row.decided_at || null,
        title: row.title,
        rationale: row.rationale,
        decided_by: row.decided_by,
        impact: row.impact,
        tier: row.tier ?? null,
        audience: row.audience,
        updated_at: syncedAt,
      },
      { onConflict: "team_id,project_id,row_key" }
    );
    if (error) throw new Error(`decision row ${row.row_key}: ${error.message}`);
  }
}
