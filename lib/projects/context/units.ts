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
    // The mirror copies the item's audience, hash and work time. It never touches `state`: a unit a
    // Drive revocation retracted stays retracted through any ordinary reconcile, and only the claim
    // owner reverses it (`reconcileItemUnit` with `reactivate`).
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

/**
 * Standalone compatibility entry: takes the shared item lock and never recursively checks out.
 *
 * `reactivate` is for the Drive claim owner alone (`reconcileGdriveItemClaims`), which calls it
 * while it re-derives a document's context from its SURVIVING claims and fails the surrounding
 * transaction when there are none. It reverses a retraction under the same item lock as the mirror.
 * No other caller may pass it: an ordinary reconcile of a revoked document must leave it suppressed.
 */
export async function reconcileItemUnit(
  db: DbClient,
  teamId: string,
  itemId: string,
  opts: { reactivate?: boolean } = {}
): Promise<ReconcileResult> {
  try {
    return await runContextTransaction(db, async (session) => {
      const context = await lockItemContext(session, teamId, itemId);
      if (!context) return { ok: false, error: "item not found" };
      const reconciled = await reconcileItemUnitLocked(context);
      if (!opts.reactivate || !reconciled.ok || !reconciled.unitId) return reconciled;
      const { error } = await session.db
        .from("project_context_units")
        .update({ state: "active", updated_at: new Date().toISOString() })
        .eq("team_id", teamId)
        .eq("id", reconciled.unitId)
        .eq("state", "retracted");
      if (error) return { ok: false, error: `unit reactivation failed: ${error.message}` };
      return reconciled;
    });
  } catch (error) {
    return { ok: false, error: contextFailureMessage(error) };
  }
}

/**
 * Durable visibility suppression used by source revocation. Retraction leaves membership history
 * intact but every enforced reader rejects the unit until a surviving claim reactivates it through
 * `reconcileItemUnit(…, { reactivate: true })`.
 */
export async function retractItemUnit(
  db: DbClient,
  teamId: string,
  itemId: string
): Promise<ReconcileResult> {
  try {
    // Same item lock as every other unit write, so a retraction cannot interleave with a mirror.
    return await runContextTransaction(db, async (session) => {
      const context = await lockItemContext(session, teamId, itemId);
      if (!context) return { ok: false, error: "item not found" };
      const { data, error } = await session.db
        .from("project_context_units")
        .update({ state: "retracted", updated_at: new Date().toISOString() })
        .eq("team_id", teamId)
        .eq("source_item_id", itemId)
        .eq("unit_kind", "item")
        .select("id")
        .maybeSingle();
      if (error) return { ok: false, error: error.message };
      if (!data) return { ok: false, error: "context unit not found" };
      return { ok: true, unitId: (data as { id: string }).id, created: false };
    });
  } catch (error) {
    return { ok: false, error: contextFailureMessage(error) };
  }
}
