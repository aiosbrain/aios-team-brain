import "server-only";
import type { DbClient } from "@/lib/db/types";
import { runSql } from "@/lib/db/pg/pool";

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
      // SINGLE-STATEMENT MIRROR (AUDITFIX-4, Fable diff review HIGH 1). The audience written is read
      // from `items` INSIDE the same statement, and the value the caller routes on is the one
      // RETURNED — so the placement is bound to the item version that authorized it.
      //
      // A compare-and-set on the UNIT's audience is not enough, and shipping one was the defect the
      // review caught: it binds the write to the mirror, while the value being written comes from an
      // `items` read one statement earlier. That leaves this interleaving open —
      //   S reads items.access='external'; the item flips to 'team'; N completes fully (unit→'team',
      //   closes external-shared, opens General); S then reads the unit and sees the FRESH 'team',
      //   so its CAS keyed on 'team' PASSES and writes 'external' back; S routes on its stale
      //   item.access and re-opens external-shared while closing N's General include.
      // Final state: items.access='team', current include only in external-shared, both reconcilers
      // reporting success, no read having failed. Reading `items` inside the write closes it.
      // `runSql` awaits `pool.query` DIRECTLY and THROWS on a SQL or connection failure, where the
      // adapter this replaced RETURNED `{ok:false, error}` (Codex diff review HIGH). Unwrapped, a
      // statement timeout would reject the whole backfill instead of letting it return its
      // structured failure with the last-good cursor — `lib/projects/context/backfill.ts` does not
      // catch. Restoring the contract is the point of this try/catch, not defensiveness.
      let mirrored;
      try {
        mirrored = await runSql<{ audience: "team" | "external" }>(
          `update project_context_units u
              set audience = i.access,
                  content_sha256 = i.content_sha256,
                  occurred_at = i.work_at,
                  updated_at = now()
             from items i
            where u.id = $1 and u.team_id = $2 and i.id = $3 and i.team_id = $2
              and u.source_item_id = i.id and u.unit_kind = 'item'
          returning u.audience`,
          [row.id, teamId, itemId]
        );
      } catch (e) {
        return { ok: false, error: `unit mirror failed: ${e instanceof Error ? e.message : String(e)}` };
      }
      const mirroredRow = mirrored.rows[0];
      if (!mirroredRow) {
        // The unit or the item vanished under us (a delete cascade, a concurrent purge). Not an
        // error to shout about, but emphatically not convergence: restart on fresh state.
        return { ok: false, stale: true, error: "unit or item vanished during mirror" };
      }
      // ROUTE ON THE RETURNED VALUE, never on the earlier `item.access` read.
      return { ok: true, unitId: row.id, created: false, audience: mirroredRow.audience };
    }
    return { ok: true, unitId: row.id, created: false, audience: row.audience as "team" | "external" };
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
