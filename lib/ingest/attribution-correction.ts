import "server-only";
import type { DbClient } from "@/lib/db/types";
import { audit } from "@/lib/api/audit";
import { resolveCorrection, type CorrectionPlan } from "@/lib/attribution/correction";

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

export async function applyAttributionCorrection(
  db: DbClient,
  teamId: string,
  plan: CorrectionPlan,
  actor: { memberId: string },
  // The count the admin saw at preview. Apply re-resolves live (items may have changed since), so if the
  // match no longer matches what was shown we ABORT rather than silently touch a different set (TOCTOU).
  expectedCount?: number
): Promise<CorrectionResult> {
  const r = await resolveCorrection(teamId, plan);
  if (r.error) return { ok: false, updated: 0, target: r.target.label, error: r.error };
  if (typeof expectedCount === "number" && r.matched.length !== expectedCount) {
    return { ok: false, updated: 0, target: r.target.label, error: `the match changed since preview (now ${r.matched.length}) — preview again before applying` };
  }
  if (r.matched.length === 0) return { ok: true, updated: 0, target: r.target.label };

  const ids = r.matched.map((m) => m.id);
  const { error } = await db.from("items").update({ member_id: r.target.memberId }).eq("team_id", teamId).in("id", ids);
  if (error) return { ok: false, updated: 0, target: r.target.label, error: error.message };

  await audit(db, {
    team_id: teamId,
    actor_kind: "member",
    member_id: actor.memberId,
    action: "attribution.corrected",
    target_type: "items",
    target_id: null,
    meta: { plan, updated: ids.length, target: r.target.clear ? null : r.target.memberId },
  });
  return { ok: true, updated: ids.length, target: r.target.label, capped: r.capped };
}
