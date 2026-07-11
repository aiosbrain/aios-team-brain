import "server-only";
import type { DbClient } from "@/lib/db/types";
import { audit } from "@/lib/api/audit";
import { getVariant, setVariantStatus } from "./store";
import { getAutonomy } from "./settings";
import { approvalOutcome, type ApprovalOutcome } from "./autonomy";
import type { AccessTier } from "./types";

/**
 * SINGLE WRITER for the `content_approvals` table (CLAUDE.md §2) — the Social Brain approval queue.
 * A generated variant is submitted here; the team autonomy (lib/social/autonomy) routes it to
 * BLOCKED (draft_only), a PENDING human decision, or AUTO_APPROVED. Deciding advances the variant
 * (`approved` / `rejected`) through the store (the content_variants single writer). Variant status
 * transitions live in lib/social/store; only the approval rows are written here. Guarded by
 * test/guards/single-writer-content-approvals.
 */

export interface ApprovalRow {
  id: string;
  variant_id: string;
  access: AccessTier;
  status: "pending" | "approved" | "denied" | "expired";
  decided_by: string | null;
  decided_at: string | null;
  decision_note: string;
  created_at: string;
}

const COLS = "id, variant_id, access, status, decided_by, decided_at, decision_note, created_at";

export class ApprovalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApprovalError";
  }
}

export interface SubmitResult {
  approval: ApprovalRow;
  outcome: ApprovalOutcome;
}

/**
 * Submit a generated variant for approval. Idempotent (an existing pending approval is returned).
 * Throws ApprovalError if the variant isn't `generated` or autonomy is `draft_only`.
 */
export async function submitForApproval(
  db: DbClient,
  teamId: string,
  variantId: string,
  actor: { memberId?: string | null } = {}
): Promise<SubmitResult> {
  const variant = await getVariant(db, teamId, variantId);
  if (!variant) throw new Error(`submitForApproval: variant ${variantId} not found for team`);

  // Idempotent FIRST: an already-open pending request is returned as-is (the variant will by then
  // be 'awaiting_approval', not 'generated', so this must precede the status guard).
  const { data: existing } = await db
    .from("content_approvals")
    .select(COLS)
    .eq("team_id", teamId)
    .eq("variant_id", variantId)
    .eq("status", "pending")
    .maybeSingle();
  if (existing) return { approval: existing as ApprovalRow, outcome: "pending" };

  if (variant.status !== "generated") {
    throw new ApprovalError(`variant must be 'generated' to submit for approval (is '${variant.status}')`);
  }

  const validationOk = !(((variant.validation as { violations?: unknown[] })?.violations ?? []).length > 0);
  const outcome = approvalOutcome(await getAutonomy(db, teamId), { access: variant.access, validationOk });
  if (outcome === "blocked") {
    throw new ApprovalError("autonomy is 'draft_only' — raise it in Social settings before requesting approval");
  }

  const now = new Date().toISOString();
  const autoApproved = outcome === "auto_approved";
  const { data, error } = await db
    .from("content_approvals")
    .insert({
      team_id: teamId,
      variant_id: variantId,
      access: variant.access,
      status: autoApproved ? "approved" : "pending",
      decided_by: autoApproved ? actor.memberId ?? null : null,
      decided_at: autoApproved ? now : null,
      decision_note: autoApproved ? "auto-approved by autonomy policy" : "",
    })
    .select(COLS)
    .single();
  if (error || !data) throw new Error(`submitForApproval failed: ${error?.message ?? "no row"}`);

  await setVariantStatus(db, teamId, variantId, autoApproved ? "approved" : "awaiting_approval");
  await audit(db, {
    team_id: teamId,
    actor_kind: "member",
    member_id: actor.memberId ?? null,
    action: autoApproved ? "content.auto_approved" : "content.submitted",
    target_type: "content_approval",
    target_id: (data as ApprovalRow).id,
    meta: { outcome },
  });
  return { approval: data as ApprovalRow, outcome };
}

/** Decide a pending approval (admin). Advances the variant to `approved` or `rejected`. */
export async function decideApproval(
  db: DbClient,
  teamId: string,
  approvalId: string,
  decision: "approved" | "denied",
  note: string,
  actor: { memberId?: string | null } = {}
): Promise<void> {
  const { data: appr } = await db
    .from("content_approvals")
    .select("id, variant_id, status")
    .eq("team_id", teamId)
    .eq("id", approvalId)
    .maybeSingle();
  if (!appr) throw new ApprovalError("approval not found");
  if ((appr as { status: string }).status !== "pending") throw new ApprovalError("already decided");

  const { error } = await db
    .from("content_approvals")
    .update({
      status: decision,
      decided_by: actor.memberId ?? null,
      decided_at: new Date().toISOString(),
      decision_note: (note ?? "").slice(0, 2000),
    })
    .eq("team_id", teamId)
    .eq("id", approvalId);
  if (error) throw new Error(`decideApproval failed: ${error.message}`);

  await setVariantStatus(db, teamId, (appr as { variant_id: string }).variant_id, decision === "approved" ? "approved" : "rejected");
  await audit(db, {
    team_id: teamId,
    actor_kind: "member",
    member_id: actor.memberId ?? null,
    action: decision === "approved" ? "content.approved" : "content.denied",
    target_type: "content_approval",
    target_id: approvalId,
    meta: {},
  });
}

/** Pending approvals for the team, newest first. */
export async function listPendingApprovals(db: DbClient, teamId: string, limit = 50): Promise<ApprovalRow[]> {
  const { data } = await db
    .from("content_approvals")
    .select(COLS)
    .eq("team_id", teamId)
    .eq("status", "pending")
    .order("created_at", { ascending: false })
    .limit(limit);
  return (data ?? []) as ApprovalRow[];
}
