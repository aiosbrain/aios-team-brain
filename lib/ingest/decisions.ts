import "server-only";

import type { DecisionRow } from "@/lib/api/item-payload-schema";
import type { DbClient } from "@/lib/db/types";
import { ImmutableOriginError } from "@/lib/ingest/governed-origin";

/** Preflight before item ingress effects, and again at the row writer as a backstop. */
export async function assertGovernedDecisionEcho(
  db: DbClient, teamId: string, projectId: string, rows: readonly DecisionRow[],
): Promise<Set<string>> {
  const { data: origins, error: originError } = await db.from("governed_item_origins")
    .select("entity_id").eq("team_id", teamId).eq("project_id", projectId).eq("kind", "decision");
  if (originError) throw new Error("Decision origin lookup failed");
  const ids = (origins ?? []).map((r: { entity_id: string }) => r.entity_id);
  if (!ids.length) return new Set();
  const protectedRows: Record<string, unknown>[] = [];
  // Keep adapter bind counts bounded for projects with substantial history.
  for (let offset = 0; offset < ids.length; offset += 500) {
    const { data, error } = await db.from("decisions")
      .select("id,row_key,title,rationale,impact,decided_by,decided_at,audience,tier")
      .eq("team_id", teamId).eq("project_id", projectId).in("id", ids.slice(offset, offset + 500));
    if (error) throw new Error("Decision echo lookup failed");
    protectedRows.push(...(data ?? []));
  }
  const byKey = new Map(protectedRows.map(row => [String(row.row_key), row]));
  const day = (value: unknown) => value instanceof Date ? value.toISOString().slice(0, 10) : value || null;
  for (const row of rows) {
    const original = byKey.get(row.row_key);
    if (!original) continue;
    if (["title", "rationale", "impact", "decided_by", "audience"].some(key =>
      original[key] !== row[key as keyof DecisionRow]) ||
      day(original.decided_at) !== day(row.decided_at) || (original.tier ?? null) !== (row.tier ?? null))
      throw new ImmutableOriginError();
  }
  return new Set(byKey.keys());
}

export async function materializeDecisions(
  db: DbClient,
  teamId: string,
  projectId: string,
  itemId: string,
  rows: readonly DecisionRow[],
  syncedAt: string
): Promise<void> {
  const protectedKeys = await assertGovernedDecisionEcho(db, teamId, projectId, rows);
  for (const row of rows) {
    if (protectedKeys.has(row.row_key)) continue;
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

  // DIFF-DELETE, mirroring tasks: a decision this item used to carry but no longer does is gone at the
  // source, so it must stop being served as CURRENT. Without this a removed/retracted decision lived
  // forever — still cited by retrieval and still shown on the dashboard — and the docs already claimed
  // the behavior existed. Scoped to THIS item's own rows (`source_item_id`), so a UI-created decision
  // (`source_item_id` null) and other items' rows are never touched.
  const incomingKeys = new Set(rows.map((r) => r.row_key));
  const { data: current, error: readError } = await db
    .from("decisions")
    .select("id, row_key")
    .eq("team_id", teamId)
    .eq("project_id", projectId)
    .eq("source_item_id", itemId);
  if (readError) throw new Error(`decision diff read: ${readError.message}`);
  for (const existing of (current ?? []) as { id: string; row_key: string | null }[]) {
    if (!existing.row_key || incomingKeys.has(existing.row_key) || protectedKeys.has(existing.row_key)) continue;
    const { error: deleteError } = await db.from("decisions").delete().eq("id", existing.id);
    if (deleteError) throw new Error(`decision delete ${existing.row_key}: ${deleteError.message}`);
  }
}
