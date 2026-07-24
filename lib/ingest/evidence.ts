import "server-only";

import { z } from "zod";
import type { DbClient } from "@/lib/db/types";
import type { FactRow, StakeholderMentionRow } from "@/lib/api/item-payload-schema";

type Audience = "team" | "external";

const storedEvidenceRowsSchema = z.array(
  z.object({
    id: z.string(),
    row_key: z.string(),
  })
);

async function deleteMissingRows(
  db: DbClient,
  table: "extracted_facts" | "stakeholder_mentions",
  teamId: string,
  projectId: string,
  itemId: string,
  incomingKeys: ReadonlySet<string>
): Promise<void> {
  const { data, error } = await db
    .from(table)
    .select("id, row_key")
    .eq("team_id", teamId)
    .eq("project_id", projectId)
    .eq("source_item_id", itemId);
  if (error) throw new Error(`${table} snapshot: ${error.message}`);

  const storedRows = storedEvidenceRowsSchema.parse(data ?? []);
  for (const row of storedRows) {
    if (incomingKeys.has(row.row_key)) continue;
    const { error: deleteError } = await db.from(table).delete().eq("id", row.id);
    if (deleteError) throw new Error(`${table} delete ${row.row_key}: ${deleteError.message}`);
  }
}

export async function materializeFacts(
  db: DbClient,
  teamId: string,
  projectId: string,
  itemId: string,
  rows: readonly FactRow[],
  syncedAt: string,
  audience: Audience
): Promise<void> {
  const incomingKeys = new Set(rows.map((row) => row.row_key));

  for (const row of rows) {
    const { error } = await db.from("extracted_facts").upsert(
      {
        team_id: teamId,
        project_id: projectId,
        source_item_id: itemId,
        row_key: row.row_key,
        title: row.title,
        occurred_at: row.occurred_at ?? null,
        fact_type: row.fact_type,
        source_path: row.source_path,
        source_quote: row.source_quote,
        audience,
        updated_at: syncedAt,
      },
      { onConflict: "team_id,project_id,row_key" }
    );
    if (error) throw new Error(`fact row ${row.row_key}: ${error.message}`);
  }

  await deleteMissingRows(db, "extracted_facts", teamId, projectId, itemId, incomingKeys);
}

export async function materializeStakeholderMentions(
  db: DbClient,
  teamId: string,
  projectId: string,
  itemId: string,
  rows: readonly StakeholderMentionRow[],
  syncedAt: string,
  audience: Audience
): Promise<void> {
  const incomingKeys = new Set(rows.map((row) => row.row_key));

  for (const row of rows) {
    const { error } = await db.from("stakeholder_mentions").upsert(
      {
        team_id: teamId,
        project_id: projectId,
        source_item_id: itemId,
        row_key: row.row_key,
        name: row.name,
        role: row.role ?? null,
        context: row.context ?? null,
        source_path: row.source_path,
        source_quote: row.source_quote,
        audience,
        updated_at: syncedAt,
      },
      { onConflict: "team_id,project_id,row_key" }
    );
    if (error) throw new Error(`stakeholder mention ${row.row_key}: ${error.message}`);
  }

  await deleteMissingRows(db, "stakeholder_mentions", teamId, projectId, itemId, incomingKeys);
}
