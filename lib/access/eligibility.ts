/**
 * Principal-eligibility predicates for the access chain (spec §4) — pure, dependency-free, and
 * deliberately TWO named predicates rather than one stretched one: a "single predicate reused
 * verbatim" formulation would either deny every standing agent at the enforcement layer or
 * silently admit off-roster actors (the spec's round-3 Codex finding).
 *
 * Used verbatim by the oracle (lib/access/oracle.ts), the groups single writer
 * (lib/access/groups.ts), and — when Phase B lands — the RLS policies.
 */

export type MemberKind = "human" | "agent" | "offroster";

/** The member columns eligibility is a function of — a structural subset of a `members` row. */
export interface EligibilityMember {
  kind: string;
  is_connector: boolean;
  status: string;
  tier?: string;
}

/**
 * Who may hold group memberships and resolve visibility: active humans and standing agents.
 * Connectors (service-account ingest actors) and `offroster` rows (attribution-only actors —
 * clients/collaborators who author content but must never see any) are NOT principals: the
 * groups writer refuses to create a membership for them, and the oracle resolves them to the
 * empty set even if a membership row sneaks in (write-side AND read-side enforcement).
 */
export function isPrincipal(m: EligibilityMember): boolean {
  return m.status === "active" && !m.is_connector && (m.kind === "human" || m.kind === "agent");
}

/**
 * Who the built-ins auto-admit. Everyone/External membership is machine-maintained from this
 * predicate + tier — agents are principals but are NEVER auto-admitted anywhere (a new agent
 * sees nothing until an admin places it; auto-admitting an external-tier agent to External
 * would hand it external-shared with no explicit grant — the spec's round-3 Critical).
 */
export function isBuiltinEligible(m: EligibilityMember): boolean {
  return isPrincipal(m) && m.kind === "human";
}
