import "server-only";
import type { DbClient } from "@/lib/db/types";
import { audit } from "@/lib/api/audit";
import { recordCorrectionReassignments } from "@/lib/ingest/reassignment-log";
import { resolveCorrection, type CorrectionPlan } from "@/lib/attribution/correction";
import { runSql, withTransaction } from "@/lib/db/pg/pool";
import { lockItemAttribution } from "@/lib/ingest/item-attribution-lock";
import { lockIdentityAuthority } from "@/lib/identity/authority";

/**
 * Apply a natural-language attribution correction (parsed + previewed in `lib/attribution/correction`).
 * Lives in `lib/ingest` because it writes `items.member_id` — the single-writer guard (only `lib/ingest`
 * may mutate `items`). Re-resolves the plan from scratch (never trusts a client-supplied item set),
 * re-points the matched items to the target member (or clears to null for "nobody"), and audits it.
 */

export interface CorrectionResult {
  ok: boolean;
  updated: number;
  target: string;
  /** True when the match hit the 5000 cap — more items still match and a re-run would catch them. */
  capped?: boolean;
  error?: string;
}

export interface CorrectionConcurrencyHooks {
  beforeIdentityLock?: () => Promise<void>;
  afterIdentityLock?: () => Promise<void>;
  beforeItemLock?: (itemId: string) => Promise<void>;
  afterItemLock?: (itemId: string) => Promise<void>;
}

export async function applyAttributionCorrection(
  db: DbClient,
  teamId: string,
  plan: CorrectionPlan,
  actor: { memberId: string },
  // The count the admin saw at preview. Apply re-resolves live (items may have changed since), so if the
  // match no longer matches what was shown we ABORT rather than silently touch a different set (TOCTOU).
  expectedCount?: number,
  hooks: CorrectionConcurrencyHooks = {},
): Promise<CorrectionResult> {
  const r = await resolveCorrection(teamId, plan);
  if (r.error) return { ok: false, updated: 0, target: r.target.label, error: r.error };
  if (typeof expectedCount === "number" && r.matched.length !== expectedCount) {
    return { ok: false, updated: 0, target: r.target.label, error: `the match changed since preview (now ${r.matched.length}) — preview again before applying` };
  }
  if (r.matched.length === 0) return { ok: true, updated: 0, target: r.target.label };

  const ids = r.matched.map((m) => m.id);
  await withTransaction(async () => {
    // Global attribution lock order: team identity authority -> sorted item advisories -> item rows ->
    // target-member validation -> versions -> contribution evidence. In particular, never hold a
    // member FOR UPDATE while waiting for an item: ingest may own that item and need the member FK's
    // KEY SHARE lock to insert its version. Lifecycle/mapping writers take identity authority first.
    await hooks.beforeIdentityLock?.();
    await lockIdentityAuthority(teamId);
    await hooks.afterIdentityLock?.();
    for (const id of [...ids].sort()) {
      await hooks.beforeItemLock?.(id);
      await lockItemAttribution(teamId,id);
      await hooks.afterItemLock?.(id);
    }
    const { rows: priorRows } = await runSql<{ id:string;member_id:string|null }>(
      `select id,member_id from items where team_id=$1 and id=any($2::uuid[]) order by id for update`,
      [teamId,ids],
    );
    if (priorRows.length !== ids.length) throw new Error("the matched items changed before correction; preview again");
    if (r.target.memberId) {
      // SHARE is sufficient to keep the validated status/connector fields stable until commit and
      // blocks deactivation/DELETE, while remaining compatible with ingest's FK KEY SHARE lock.
      const { rows: targets }=await runSql<{id:string;status:string;is_connector:boolean}>(
        `select id,status,is_connector from members where team_id=$1 and id=$2 for share`,
        [teamId,r.target.memberId],
      );
      if (!targets[0] || targets[0].status === "disabled" || targets[0].is_connector) {
        throw new Error("the correction target is no longer an active human member");
      }
    }
    // Item -> versions -> contribution evidence is the shared lock order used by ingest and repair.
    // A manual correction governs retained history too; otherwise old versions can keep stale credit
    // after the current item has been explicitly locked to nobody/a named member.
    await runSql(
      `select v.id from item_versions v
        where v.item_id=any($1::uuid[]) order by v.item_id,v.created_at,v.id for update`,
      [ids],
    );
    await runSql(
      `select evidence_key from gdrive_contribution_evidence
        where team_id=$1 and item_id=any($2::uuid[]) for update`,
      [teamId,ids],
    );
    const priorOwner=new Map(priorRows.map((row)=>[row.id,row.member_id]));
    const update=await runSql(
      `update items set member_id=$3,member_id_locked=true,updated_at=now()
        where team_id=$1 and id=any($2::uuid[])`,
      [teamId,ids,r.target.memberId],
    );
    if (update.rowCount !== ids.length) throw new Error("attribution correction did not update every matched item");
    await runSql(
      `update item_versions set member_id=$2 where item_id=any($1::uuid[])`,
      [ids,r.target.memberId],
    );
    await runSql(
      `update gdrive_contribution_evidence set member_id=$3,mapping_revision=null,authority_revision=null,
              diagnostic=case when $3::uuid is null then 'manual_credit_nobody' else 'manual_attribution' end,
              updated_at=now()
        where team_id=$1 and item_id=any($2::uuid[])`,
      [teamId,ids,r.target.memberId],
    );
    const changes=ids
      .map((id)=>({itemId:id,from:priorOwner.get(id) ?? null,to:r.target.memberId}))
      .filter((change): change is {itemId:string;from:string;to:string|null}=>(
        change.from !== null && change.from !== r.target.memberId
      ));
    await recordCorrectionReassignments(db,teamId,actor.memberId,changes);
    await audit(db, {
      team_id:teamId,actor_kind:"member",member_id:actor.memberId,
      action:"attribution.corrected",target_type:"items",target_id:null,
      meta:{plan,updated:ids.length,reassigned:changes.length,target:r.target.clear ? null : r.target.memberId},
    });
  });
  return { ok: true, updated: ids.length, target: r.target.label, capped: r.capped };
}
