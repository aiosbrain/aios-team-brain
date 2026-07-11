import { describe, expect, it } from "vitest";
import { createOpportunity, getVariant, setVariantGeneration } from "@/lib/social/store";
import { planOpportunity } from "@/lib/social/plan";
import { setAutonomy } from "@/lib/social/settings";
import { submitForApproval, decideApproval, listPendingApprovals, ApprovalError } from "@/lib/social/approvals";
import { db, seedTeam } from "./helpers";

/**
 * Spec for the approval workflow + autonomy on real Postgres (M4). Derived from the policy:
 * draft_only blocks; approval_required queues for a human decision that advances the variant;
 * auto_publish_low_risk auto-approves clean + internal content only; deciding is idempotent.
 */
async function generatedVariant(access: "team" | "external" = "team") {
  const seed = await seedTeam();
  const opp = await createOpportunity(db(), seed.teamId, { access, sourceType: "manual", title: "Shipped the queue" });
  const { variants } = await planOpportunity(db(), seed.teamId, opp.id, { memberId: seed.memberId });
  const v = variants[0];
  await setVariantGeneration(db(), seed.teamId, v.id, {
    body: "We shipped a durable job queue.",
    status: "generated",
    validation: { violations: [], warnings: [] },
  });
  return { seed, variantId: v.id };
}

describe("content approvals + autonomy (real Postgres)", () => {
  it("blocks submission under the default draft_only autonomy", async () => {
    const { seed, variantId } = await generatedVariant();
    await expect(submitForApproval(db(), seed.teamId, variantId)).rejects.toBeInstanceOf(ApprovalError);
  });

  it("queues then approves under approval_required, advancing the variant", async () => {
    const { seed, variantId } = await generatedVariant();
    await setAutonomy(db(), seed.teamId, "approval_required", { memberId: seed.memberId });

    const r = await submitForApproval(db(), seed.teamId, variantId, { memberId: seed.memberId });
    expect(r.outcome).toBe("pending");
    expect((await getVariant(db(), seed.teamId, variantId))!.status).toBe("awaiting_approval");

    const pending = await listPendingApprovals(db(), seed.teamId);
    expect(pending.length).toBe(1);

    await decideApproval(db(), seed.teamId, pending[0].id, "approved", "looks good", { memberId: seed.memberId });
    expect((await getVariant(db(), seed.teamId, variantId))!.status).toBe("approved");
    expect((await listPendingApprovals(db(), seed.teamId)).length).toBe(0);
  });

  it("denying sends the variant to rejected", async () => {
    const { seed, variantId } = await generatedVariant();
    await setAutonomy(db(), seed.teamId, "approval_required");
    const r = await submitForApproval(db(), seed.teamId, variantId);
    await decideApproval(db(), seed.teamId, r.approval.id, "denied", "off-brand");
    expect((await getVariant(db(), seed.teamId, variantId))!.status).toBe("rejected");
  });

  it("auto-approves clean internal content under auto_publish_low_risk, but queues external", async () => {
    const internal = await generatedVariant("team");
    await setAutonomy(db(), internal.seed.teamId, "auto_publish_low_risk");
    const ri = await submitForApproval(db(), internal.seed.teamId, internal.variantId, { memberId: internal.seed.memberId });
    expect(ri.outcome).toBe("auto_approved");
    expect((await getVariant(db(), internal.seed.teamId, internal.variantId))!.status).toBe("approved");

    const external = await generatedVariant("external");
    await setAutonomy(db(), external.seed.teamId, "auto_publish_low_risk");
    const re = await submitForApproval(db(), external.seed.teamId, external.variantId);
    expect(re.outcome).toBe("pending");
  });

  it("is idempotent on submit and refuses a second decision", async () => {
    const { seed, variantId } = await generatedVariant();
    await setAutonomy(db(), seed.teamId, "approval_required");
    const a = await submitForApproval(db(), seed.teamId, variantId);
    const b = await submitForApproval(db(), seed.teamId, variantId);
    expect(b.approval.id).toBe(a.approval.id);
    expect((await listPendingApprovals(db(), seed.teamId)).length).toBe(1);

    await decideApproval(db(), seed.teamId, a.approval.id, "approved", "");
    await expect(decideApproval(db(), seed.teamId, a.approval.id, "denied", "")).rejects.toBeInstanceOf(ApprovalError);
  });
});
