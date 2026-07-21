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
 * must raise autonomy first). `approval_required` always queues for a human.
 *
 * Auto-approval is a step toward PUBLISHING, and only `external` (public) content is ever
 * publishable — an `internal` (`team`) variant is fail-closed at the publish door (lib/social/publish)
 * and must never leak to a public network. So per the 2026-07-16 audit (finding #1: internal content
 * was auto-approved, inverting the risk), auto-approval NEVER applies to internal content:
 *   • `fully_autonomous` auto-approves only `external` variants (internal → a human still decides).
 *   • `auto_publish_low_risk` auto-approves only `external` variants that ALSO passed the gate.
 * An internal variant therefore always routes to a human — and even then can't be published.
 */
export function approvalOutcome(
  autonomy: AutonomyLevel,
  variant: { access: AccessTier; validationOk: boolean }
): ApprovalOutcome {
  switch (autonomy) {
    case "draft_only":
      return "blocked";
    case "fully_autonomous":
      return variant.access === "external" ? "auto_approved" : "pending";
    case "auto_publish_low_risk":
      return variant.validationOk && variant.access === "external" ? "auto_approved" : "pending";
    case "approval_required":
    default:
      return "pending";
  }
}
