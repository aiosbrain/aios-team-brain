"use server";

import { revalidatePath } from "next/cache";
import { adminClient } from "@/lib/db/admin";
import { requireTeamAdmin as requireAdmin } from "@/lib/auth/guard";
import { resolveApproval } from "@/lib/actions";
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
 */
export async function decideApproval(
  teamSlug: string,
  approvalRequestId: string,
  decision: "approved" | "denied",
  note?: string
): Promise<{ ok: boolean; error?: string; message?: string }> {
  const ctx = await requireAdmin(teamSlug);
  if (!ctx) return { ok: false, error: "admins only" };
  if (decision !== "approved" && decision !== "denied") return { ok: false, error: "invalid decision" };
  try {
    const outcome = await resolveApproval(
      adminClient(),
      { approvalRequestId, decision, deciderMemberId: ctx.memberId, note },
      { sandbox: createE2BSandbox() }
    );
    revalidatePath(`/t/${teamSlug}/admin/approvals`);
    if (outcome.status === "not_found") return { ok: false, error: "approval not found" };
    if (outcome.status === "already_decided") return { ok: false, error: "already decided by someone else" };
    if (outcome.status === "denied") return { ok: true, message: "Denied." };
    return { ok: true, message: `Approved${outcome.actionStatus ? ` — action ${outcome.actionStatus}` : ""}.` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "could not decide" };
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
    await decideGatewayApproval(
      ctx,
      approvalId,
      decision,
      correlationId,
    );
    revalidatePath(`/t/${teamSlug}/admin/approvals`);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof GatewayAdminError
          ? error.code
          : "could not decide",
    };
  }
}
