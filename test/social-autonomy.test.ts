import { describe, expect, it } from "vitest";
import { approvalOutcome, AUTONOMY_LEVELS, DEFAULT_AUTONOMY } from "@/lib/social/autonomy";

/**
 * Spec for the autonomy routing rule (M4). Derived from the policy: conservative by default;
 * low-risk auto-approve only for clean + internal content; public/flagged always needs a human.
 */
describe("approvalOutcome", () => {
  const clean = { validationOk: true };

  it("draft_only blocks everything (default)", () => {
    expect(DEFAULT_AUTONOMY).toBe("draft_only");
    expect(approvalOutcome("draft_only", { ...clean, access: "team" })).toBe("blocked");
    expect(approvalOutcome("draft_only", { ...clean, access: "external" })).toBe("blocked");
  });

  it("approval_required always queues for a human", () => {
    expect(approvalOutcome("approval_required", { ...clean, access: "team" })).toBe("pending");
    expect(approvalOutcome("approval_required", { ...clean, access: "external" })).toBe("pending");
  });

  it("auto_publish_low_risk auto-approves only clean + internal content", () => {
    expect(approvalOutcome("auto_publish_low_risk", { validationOk: true, access: "team" })).toBe("auto_approved");
    expect(approvalOutcome("auto_publish_low_risk", { validationOk: true, access: "external" })).toBe("pending");
    expect(approvalOutcome("auto_publish_low_risk", { validationOk: false, access: "team" })).toBe("pending");
  });

  it("fully_autonomous auto-approves everything", () => {
    expect(approvalOutcome("fully_autonomous", { validationOk: true, access: "external" })).toBe("auto_approved");
  });

  it("exposes the four levels", () => {
    expect(AUTONOMY_LEVELS).toEqual(["draft_only", "approval_required", "auto_publish_low_risk", "fully_autonomous"]);
  });
});
