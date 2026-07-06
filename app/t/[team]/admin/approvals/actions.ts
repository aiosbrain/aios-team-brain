"use server";

import { revalidatePath } from "next/cache";
import { serverClient } from "@/lib/db/server";
import { adminClient } from "@/lib/db/admin";
import { getSessionUser } from "@/lib/auth/session";
import { resolveIntegrationsAdmin } from "@/lib/integrations/read";
import { resolveApproval } from "@/lib/actions";
import { createE2BSandbox } from "@/lib/actions/sandbox/e2b";

async function requireAdmin(teamSlug: string) {
  const db = await serverClient();
  const user = await getSessionUser();
  if (!user) return null;
  return resolveIntegrationsAdmin(db, teamSlug, user.id);
}

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
