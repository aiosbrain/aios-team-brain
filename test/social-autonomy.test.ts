import { describe, expect, it } from "vitest";
import { approvalOutcome, AUTONOMY_LEVELS, DEFAULT_AUTONOMY } from "@/lib/social/autonomy";

/**
 * Spec for the autonomy routing rule (M4, hardened by the 2026-07-16 audit #1). Auto-approval is a
 * step toward publishing, and ONLY public (`external`) content is ever publishable — internal
 * (`team`) content is fail-closed at the publish door. So auto-approval must never apply to internal
 * content: `fully_autonomous` and `auto_publish_low_risk` auto-approve external variants only;
 * internal always routes to a human. (Before the fix, internal content was auto-approved — the risk
 * was inverted.)
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

  it("auto_publish_low_risk auto-approves only clean + EXTERNAL content; internal always queues", () => {
    expect(approvalOutcome("auto_publish_low_risk", { validationOk: true, access: "external" })).toBe("auto_approved");
    // internal content is never auto-approved for publish (it can't be published at all)
    expect(approvalOutcome("auto_publish_low_risk", { validationOk: true, access: "team" })).toBe("pending");
    // a gate-flagged external variant still needs a human
    expect(approvalOutcome("auto_publish_low_risk", { validationOk: false, access: "external" })).toBe("pending");
  });

  it("fully_autonomous auto-approves external content, but never internal", () => {
    expect(approvalOutcome("fully_autonomous", { validationOk: true, access: "external" })).toBe("auto_approved");
    expect(approvalOutcome("fully_autonomous", { validationOk: true, access: "team" })).toBe("pending");
  });

  it("exposes the four levels", () => {
    expect(AUTONOMY_LEVELS).toEqual(["draft_only", "approval_required", "auto_publish_low_risk", "fully_autonomous"]);
  });
});
