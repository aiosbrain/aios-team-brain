import type { AccessTier } from "./types";

/**
 * Autonomy levels + the approval-routing rule (Social Brain M4). Pure so it's unit-testable and
 * the same decision drives the server + any preview. Conservative by default: nothing advances
 * past a draft under `draft_only` until a team explicitly raises autonomy.
 */

export type AutonomyLevel = "draft_only" | "approval_required" | "auto_publish_low_risk" | "fully_autonomous";

export const AUTONOMY_LEVELS: AutonomyLevel[] = [
  "draft_only",
  "approval_required",
  "auto_publish_low_risk",
  "fully_autonomous",
];

export const DEFAULT_AUTONOMY: AutonomyLevel = "draft_only";

/** What submitting a generated variant does under the team's autonomy. */
export type ApprovalOutcome = "blocked" | "pending" | "auto_approved";

/**
 * Route a generated variant given the team autonomy and its risk. `draft_only` blocks (a human
 * must raise autonomy first). `fully_autonomous` auto-approves. `auto_publish_low_risk`
 * auto-approves only LOW-RISK variants — clean governance gate AND internal (`team`) tier; a
 * public (`external`) or gate-flagged variant still needs a human. `approval_required` always
 * queues for a human.
 */
export function approvalOutcome(
  autonomy: AutonomyLevel,
  variant: { access: AccessTier; validationOk: boolean }
): ApprovalOutcome {
  switch (autonomy) {
    case "draft_only":
      return "blocked";
    case "fully_autonomous":
      return "auto_approved";
    case "auto_publish_low_risk":
      return variant.validationOk && variant.access === "team" ? "auto_approved" : "pending";
    case "approval_required":
    default:
      return "pending";
  }
}
