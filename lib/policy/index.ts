import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  evaluatePolicy,
  type PolicyDecision,
  type PolicyRequest,
  type PolicyRule,
} from "./evaluate";

export * from "./evaluate";

/**
 * Server entry to the policy engine. `authorize()` is the choke point the action layer
 * (Organ 4) calls before acting: it loads the team's enabled rules and evaluates them.
 * When the decision is `require_approval`, `fileApprovalRequest()` records a pending item
 * in the queue for an admin/lead to decide. Reads use whatever client is passed — the
 * service role for machine paths, the RLS client for session paths.
 */

type PolicyRow = {
  id: string;
  priority: number;
  subject_role: PolicyRule["subjectRole"];
  subject_tier: PolicyRule["subjectTier"];
  subject_actor: string | null;
  action: string;
  resource: string;
  effect: PolicyRule["effect"];
  enabled: boolean;
};

function mapRow(r: PolicyRow): PolicyRule {
  return {
    id: r.id,
    priority: r.priority,
    subjectRole: r.subject_role,
    subjectTier: r.subject_tier,
    subjectActor: r.subject_actor,
    action: r.action,
    resource: r.resource,
    effect: r.effect,
    enabled: r.enabled,
  };
}

export async function loadPolicies(
  supabase: SupabaseClient,
  teamId: string
): Promise<PolicyRule[]> {
  const { data, error } = await supabase
    .from("policies")
    .select(
      "id, priority, subject_role, subject_tier, subject_actor, action, resource, effect, enabled"
    )
    .eq("team_id", teamId)
    .eq("enabled", true)
    .order("priority", { ascending: false });
  if (error) throw new Error(`policy load failed: ${error.message}`);
  return (data ?? []).map(mapRow as (r: unknown) => PolicyRule);
}

export async function authorize(
  supabase: SupabaseClient,
  teamId: string,
  request: PolicyRequest
): Promise<PolicyDecision> {
  const rules = await loadPolicies(supabase, teamId);
  return evaluatePolicy(rules, request);
}

/**
 * Record a pending approval for a `require_approval` decision. Returns the request id.
 */
export async function fileApprovalRequest(
  supabase: SupabaseClient,
  args: {
    teamId: string;
    request: PolicyRequest;
    decision: PolicyDecision;
    memberId?: string | null;
    context?: Record<string, unknown>;
  }
): Promise<string> {
  const { data, error } = await supabase
    .from("approval_requests")
    .insert({
      team_id: args.teamId,
      requested_by_member: args.memberId ?? null,
      requested_by_actor: args.request.principal.actor,
      action: args.request.action,
      resource: args.request.resource,
      context: args.context ?? {},
      matched_policy_id: args.decision.matchedRuleId,
      status: "pending",
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`approval request failed: ${error?.message}`);
  return data.id;
}
