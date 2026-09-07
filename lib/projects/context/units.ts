import "server-only";
import type { DbClient } from "@/lib/db/types";
import {
  contextFailureMessage,
  lockItemContext,
  runContextTransaction,
  type LockedItemContext,
} from "@/lib/projects/context/transaction";

/** THE single writer for `project_context_units` (guarded by access-single-writer). */
export interface ReconcileResult {
  ok: boolean;
  error?: string;
  stale?: boolean;
  unitId?: string;
  created?: boolean;
  audience?: "team" | "external";
}

type UnitRow = {
  id: string;
  audience: string;
  content_sha256: string;
  occurred_at: string;
};

/**
 * Locked core. The raw mirror deliberately uses `context.session.executeSql`; routing and all
 * no-drift/create returns use the same freshly locked item authority.
 */
export async function reconcileItemUnitLocked(
  context: LockedItemContext
): Promise<ReconcileResult> {
  const { db } = context.session;
  const item = context.item;
  const { data: existing, error: existingError } = await db
    .from("project_context_units")
    .select("id, audience, content_sha256, occurred_at")
    .eq("team_id", context.teamId)
    .eq("source_item_id", context.itemId)
    .eq("unit_kind", "item")
    .maybeSingle();
  if (existingError) return { ok: false, error: `unit read failed: ${existingError.message}` };

  if (existing) {
    const row = existing as UnitRow;
    const workAtDrift = new Date(row.occurred_at).getTime() !== new Date(item.work_at).getTime();
    if (
      row.audience !== item.access ||
      row.content_sha256 !== item.content_sha256 ||
      workAtDrift
    ) {
      const mirrored = await context.session.executeSql<{ audience: "team" | "external" }>(
        `update project_context_units u
            set audience = i.access,
                content_sha256 = i.content_sha256,
                occurred_at = i.work_at,
                updated_at = now()
           from items i
          where u.id = $1 and u.team_id = $2 and i.id = $3 and i.team_id = $2
            and u.source_item_id = i.id and u.unit_kind = 'item'
        returning u.audience`,
        [row.id, context.teamId, context.itemId]
      );
      const mirroredRow = mirrored.rows[0];
      if (!mirroredRow) {
        return { ok: false, stale: true, error: "unit or item vanished during mirror" };
      }
      return {
        ok: true,
        unitId: row.id,
        created: false,
        audience: mirroredRow.audience,
      };
    }
    return {
      ok: true,
      unitId: row.id,
      created: false,
      audience: item.access,
    };
  }

  const { data, error } = await db
    .from("project_context_units")
    .insert({
      team_id: context.teamId,
      unit_kind: "item",
      source_item_id: context.itemId,
      unit_key: "item",
      audience: item.access,
      content_sha256: item.content_sha256,
      occurred_at: item.work_at,
    })
    .select("id")
    .single();
  if (error || !data) return { ok: false, error: error?.message ?? "unit insert failed" };
  return {
    ok: true,
    unitId: data.id as string,
    created: true,
    audience: item.access,
  };
}

/** Standalone compatibility entry: takes the shared item lock and never recursively checks out. */
export async function reconcileItemUnit(
  db: DbClient,
  teamId: string,
  itemId: string
): Promise<ReconcileResult> {
  try {
    return await runContextTransaction(db, async (session) => {
      const context = await lockItemContext(session, teamId, itemId);
      if (!context) return { ok: false, error: "item not found" };
      return reconcileItemUnitLocked(context);
    });
  } catch (error) {
    return { ok: false, error: contextFailureMessage(error) };
  }
}
