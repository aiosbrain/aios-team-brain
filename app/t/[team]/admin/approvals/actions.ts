"use server";

import { revalidatePath } from "next/cache";
import { adminClient } from "@/lib/db/admin";
import { requireTeamAdmin as requireAdmin } from "@/lib/auth/guard";
import { resolveApproval, resolveApprovalOwner } from "@/lib/actions";
import { governedActions, GovernedError } from "@/lib/actions/governed";
import { createE2BSandbox } from "@/lib/actions/sandbox/e2b";
import { getSessionUser } from "@/lib/auth/session";
import {
  authorizeGatewayAdmin,
  decideGatewayApproval,
  GatewayAdminError,
} from "@/lib/gateway/admin-persistence";
import { isUuid } from "@/lib/gateway/http";

/**
 * Decide a queued approval (admins only). Approve → `resolveApproval` resumes & runs the action's
 * handler (with the same E2B sandbox the action route uses, so an approved `code.run` can execute —
 * fails closed if E2B isn't configured); deny → marks it denied. Both audited inside resolveApproval.
 *
 * The approval id is browser input and proves nothing: it is bound to the admin's own team before
 * anything is routed, so another team's approval (legacy or governed) answers exactly like an
 * absent one. Only a confirmed decision revalidates; every refusal and fault leaves the cache alone.
 */
export async function decideApproval(
  teamSlug: string,
  approvalRequestId: string,
  decision: "approved" | "denied",
  note?: string,
): Promise<{ ok: boolean; error?: string; message?: string }> {
  const ctx = await requireAdmin(teamSlug);
  if (!ctx) return { ok: false, error: "admins only" };
  if (decision !== "approved" && decision !== "denied")
    return { ok: false, error: "invalid decision" };
  if (!isUuid(approvalRequestId)) return { ok: false, error: "invalid request" };
  try {
    // New approval ownership is explicit; never let the legacy resolver decide one.
    const db = adminClient();
    const owner = await resolveApprovalOwner(db, {
      teamId: ctx.teamId,
      approvalRequestId,
    });
    if (owner.owner === "not_found")
      return { ok: false, error: "approval not found" };
    if (owner.owner === "malformed_links")
      return { ok: false, error: "could not decide" };
    if (owner.owner === "governed") {
      const result = await governedActions.decide({
        teamId: ctx.teamId,
        deciderMemberId: ctx.memberId,
        approvalRequestId,
        decision,
        note,
      });
      revalidatePath(`/t/${teamSlug}/admin/approvals`);
      return { ok: true, message: `Action ${result.status}.` };
    }
    const outcome = await resolveApproval(
      db,
      {
        teamId: ctx.teamId,
        approvalRequestId,
        decision,
        deciderMemberId: ctx.memberId,
        note,
      },
      { sandbox: createE2BSandbox() },
    );
    if (outcome.status === "not_found")
      return { ok: false, error: "approval not found" };
    if (outcome.status === "already_decided")
      return { ok: false, error: "already decided by someone else" };
    if (outcome.status === "not_ready")
      return { ok: false, error: "approval not ready" };
    if (
      outcome.status === "malformed_links" ||
      outcome.status === "ambiguous_links"
    )
      return { ok: false, error: "could not decide" };
    revalidatePath(`/t/${teamSlug}/admin/approvals`);
    if (outcome.status === "denied") return { ok: true, message: "Denied." };
    return {
      ok: true,
      message: `Approved${outcome.actionStatus ? ` — action ${outcome.actionStatus}` : ""}.`,
    };
  } catch (e) {
    // A LegacyActionPersistenceFault lands here too: its fixed message stays server-side.
    return {
      ok: false,
      error: e instanceof GovernedError ? e.message : "could not decide",
    };
  }
}

export async function decideManagedGatewayApproval(
  teamSlug: string,
  approvalId: string,
  decision: "approve" | "deny",
  correlationId: string,
): Promise<{ ok: boolean; error?: string }> {
  if (process.env.AIOS_GATEWAY_INTERNAL_ENABLED !== "true")
    return { ok: false, error: "approval not found" };
  if (
    !isUuid(approvalId) ||
    !isUuid(correlationId) ||
    (decision !== "approve" && decision !== "deny")
  )
    return { ok: false, error: "invalid request" };
  const user = await getSessionUser();
  if (!user) return { ok: false, error: "admins only" };
  try {
    const ctx = await authorizeGatewayAdmin(teamSlug, user.id);
    await decideGatewayApproval(ctx, approvalId, decision, correlationId);
    revalidatePath(`/t/${teamSlug}/admin/approvals`);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof GatewayAdminError ? error.code : "could not decide",
    };
  }
}
