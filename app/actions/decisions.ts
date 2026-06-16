"use server";

import { serverClient } from "@/lib/supabase/server";
import { currentMember } from "@/lib/auth/guard";

/**
 * Toggle a decision's validity. Admins/leads only — enforced server-side
 * (replaces the decisions_lead_update RLS policy in postgres mode).
 */
export async function setDecisionValidityAction(
  decisionId: string,
  stillValid: boolean
): Promise<{ ok: boolean; error?: string }> {
  const supabase = await serverClient();
  const { data: decision } = await supabase
    .from("decisions")
    .select("team_id")
    .eq("id", decisionId)
    .maybeSingle();
  if (!decision) return { ok: false, error: "decision not found" };

  const me = await currentMember((decision as { team_id: string }).team_id);
  if (!me || (me.role !== "admin" && me.role !== "lead")) {
    return { ok: false, error: "admins and leads only" };
  }

  const { error } = await supabase
    .from("decisions")
    .update({ still_valid: stillValid, updated_at: new Date().toISOString() })
    .eq("id", decisionId);
  return error ? { ok: false, error: error.message } : { ok: true };
}
