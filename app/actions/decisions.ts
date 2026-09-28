"use server";

import { serverClient } from "@/lib/db/server";
import { currentMember } from "@/lib/auth/guard";
import { createDashboardDecision } from "@/lib/decisions/service";

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

  try {
    const decision = await createDashboardDecision(await serverClient(), { ...input, memberId: me.id });
    return { ok: true, decision };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "could not create decision" };
  }
}

/**
 * Toggle a decision's validity. Admins/leads only — enforced server-side
 * (replaces the decisions_lead_update RLS policy in postgres mode).
 */
export async function setDecisionValidityAction(
  decisionId: string,
  stillValid: boolean
): Promise<{ ok: boolean; error?: string }> {
  const db = await serverClient();
  const { data: decision } = await db
    .from("decisions")
    .select("team_id")
    .eq("id", decisionId)
    .maybeSingle();
  if (!decision) return { ok: false, error: "decision not found" };

  const { data: origin, error: originError } = await db.from("governed_item_origins")
    .select("item_id").eq("kind", "decision").eq("entity_id", decisionId).maybeSingle();
  if (originError) return { ok: false, error: "decision authority unavailable" };
  if (origin) return { ok: false, error: "This governed record is immutable; refresh the read-only mirror." };

  const me = await currentMember((decision as { team_id: string }).team_id);
  if (!me || (me.role !== "admin" && me.role !== "lead")) {
    return { ok: false, error: "admins and leads only" };
  }

  const { error } = await db
    .from("decisions")
    .update({ still_valid: stillValid, updated_at: new Date().toISOString() })
    .eq("id", decisionId);
  return error ? { ok: false, error: error.message } : { ok: true };
}
