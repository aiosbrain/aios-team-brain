import "server-only";
import type { DbClient } from "@/lib/db/types";

/**
 * THE single writer for `project_context_units` (spec §"project_context_units"; guarded by
 * test/guards/access-single-writer.test.ts). This slice reconciles the ITEM grain only: one
 * `unit_kind='item'` unit per item, `audience` inherited verbatim from `items.access` (never
 * accepted from a classifier — the persistence contract's hard rule), `content_sha256` mirrored
 * so a later change is detectable. Task/decision/meeting-segment grains arrive in Phase D.
 */

export interface ReconcileResult {
  ok: boolean;
  error?: string;
  /** AUDITFIX-4: the audience CAS lost — another reconciler re-mirrored this unit. Distinct from a
   *  failure: the caller should RESTART against fresh state, and the sweep's retry converges. */
  stale?: boolean;
  unitId?: string;
  created?: boolean;
  /** The audience the unit now carries — mirrored from the item's CURRENT access. Callers must
   *  route placement by THIS, never by a separately-read item.access, so a tier flip between the
   *  two reads can't create a team unit routed to an external project (slice-4 Codex H3). */
  audience?: "team" | "external";
}

type ItemRow = { id: string; access: "team" | "external"; content_sha256: string; work_at: string };

/**
 * Reconcile one item into its item-grain unit. Idempotent: creates the unit if absent, and
 * refreshes audience/content_sha256/occurred_at if the item changed (audience ALWAYS re-mirrors
 * `items.access` so a tier reclassification propagates to the unit). The unit's audience is an
 * inherited no-widening/index input — Phase-B visibility comes from the project memberships +
 * oracle, NOT from this column; it is never set by anything but the item's own access.
 */
export async function reconcileItemUnit(
  db: DbClient,
  teamId: string,
  itemId: string
): Promise<ReconcileResult> {
  const { data: itemData, error: iErr } = await db
    .from("items")
    .select("id, access, content_sha256, work_at")
    .eq("team_id", teamId)
    .eq("id", itemId)
    .maybeSingle();
  if (iErr) return { ok: false, error: iErr.message };
  const item = itemData as ItemRow | null;
  if (!item) return { ok: false, error: "item not found" };

  const { data: existing } = await db
    .from("project_context_units")
    .select("id, audience, content_sha256, occurred_at")
    .eq("team_id", teamId)
    .eq("source_item_id", itemId)
    .eq("unit_kind", "item")
    .maybeSingle();

  if (existing) {
    const row = existing as { id: string; audience: string; content_sha256: string; occurred_at: string };
    const workAtDrift = new Date(row.occurred_at).getTime() !== new Date(item.work_at).getTime();
    if (row.audience !== item.access || row.content_sha256 !== item.content_sha256 || workAtDrift) {
      // COMPARE-AND-SET on `audience` (AUDITFIX-4 round 2). Without it a STALE reconciler wins:
      //   S reads items.access='external'; the item flips to 'team'; N reads 'team' and writes the
      //   unit 'team'; S then overwrites it back to 'external' — and the no-widening gate, which
      //   rereads the unit, now sees S's stale value and PERMITS an external-shared placement. The
      //   item ends current in BOTH system projects with both reconcilers reporting success, and no
      //   read ever failed. Ordering cannot fix a LATER stale open; only binding the write to the
      //   audience version that authorized it can.
      const { data: affected, error } = await db
        .from("project_context_units")
        .update({
          audience: item.access,
          content_sha256: item.content_sha256,
          occurred_at: item.work_at,
          updated_at: new Date().toISOString(),
        })
        .eq("id", row.id)
        .eq("team_id", teamId)
        .eq("audience", row.audience) // ← the CAS: only if nobody moved it since we read it
        .select("id");
      if (error) return { ok: false, error: error.message };
      if (((affected ?? []) as unknown[]).length === 0) {
        // Someone re-mirrored this unit between our read and our write. Do NOT proceed on the
        // audience we thought we had — every downstream placement decision is derived from it.
        // `stale` is not an error: the caller restarts and the retry converges on fresh state.
        return { ok: false, stale: true, error: "unit audience changed under this reconcile (CAS)" };
      }
    }
    return { ok: true, unitId: row.id, created: false, audience: item.access };
  }

  const { data, error } = await db
    .from("project_context_units")
    .insert({
      team_id: teamId,
      unit_kind: "item",
      source_item_id: itemId,
      unit_key: "item",
      audience: item.access,
      content_sha256: item.content_sha256,
      occurred_at: item.work_at,
    })
    .select("id")
    .single();
  if (error || !data) {
    // Race loser on pcu_item_key_idx: converge on the winner.
    const { data: winner } = await db
      .from("project_context_units")
      .select("id")
      .eq("team_id", teamId)
      .eq("source_item_id", itemId)
      .eq("unit_kind", "item")
      .maybeSingle();
    if (winner) return { ok: true, unitId: (winner as { id: string }).id, created: false, audience: item.access };
    return { ok: false, error: error?.message ?? "insert failed" };
  }
  return { ok: true, unitId: data.id as string, created: true, audience: item.access };
}
