"use server";

import { serverClient } from "@/lib/supabase/server";
import { currentMember } from "@/lib/auth/guard";
import { uiRowKey, isUniqueViolation } from "@/lib/ids";

export interface NewDecisionInput {
  teamId: string;
  projectId: string;
  title: string;
  rationale: string;
  decidedBy: string;
  impact: string;
  audience: "team" | "external";
  decidedAt: string | null;
}

export interface DecisionRow {
  id: string;
  row_key: string;
  title: string;
}

/**
 * Create a decision from the dashboard. Admins/leads only. UI-created rows carry a
 * `ui-` row_key and a NULL `source_item_id` — that null is the discriminator the
 * decisions writeback (`GET /api/v1/decisions`) uses to surface them to `aios pull`,
 * which merges them into `3-log/decision-log.md`. Decisions are never diff-deleted on
 * push, so a UI row is safe until it is written back and re-pushed.
 */
export async function createDecisionAction(
  input: NewDecisionInput
): Promise<{ ok: boolean; decision?: DecisionRow; error?: string }> {
  const title = input.title.trim();
  if (!title || !input.projectId) return { ok: false, error: "title and project required" };

  const me = await currentMember(input.teamId);
  if (!me || (me.role !== "admin" && me.role !== "lead")) {
    return { ok: false, error: "admins and leads only" };
  }

  const supabase = await serverClient();
  for (let attempt = 0; attempt < 2; attempt++) {
    const { data, error } = await supabase
      .from("decisions")
      .insert({
        team_id: input.teamId,
        project_id: input.projectId,
        source_item_id: null,
        row_key: uiRowKey(),
        decided_at: input.decidedAt || null,
        title,
        rationale: input.rationale.trim(),
        decided_by: input.decidedBy.trim(),
        impact: input.impact.trim(),
        audience: input.audience === "external" ? "external" : "team",
      })
      .select("id, row_key, title")
      .single();
    if (!error && data) return { ok: true, decision: data as DecisionRow };
    if (attempt === 0 && isUniqueViolation(error?.message)) continue;
    return { ok: false, error: error?.message ?? "could not create decision" };
  }
  return { ok: false, error: "could not create decision" };
}

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
