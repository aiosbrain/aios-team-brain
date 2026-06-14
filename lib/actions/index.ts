import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { authorize, fileApprovalRequest } from "@/lib/policy";
import type { Principal } from "@/lib/policy/evaluate";
import { audit } from "@/lib/api/audit";
import { handlerRegistry } from "./handlers";
import {
  type ActionHandler,
  type ActionRequest,
  type SandboxRunner,
  unconfiguredSandbox,
} from "./types";

export * from "./types";
export { BUILTIN_HANDLERS } from "./handlers";

/**
 * runAction is Organ 4's choke point: it records the request, authorizes it through the
 * policy engine (Organ 6), then denies / queues for approval / executes accordingly, and
 * audits every outcome. It is the only place actions transition state.
 */

export type RunActionInput = {
  teamId: string;
  principal: Principal;
  memberId?: string | null;
  apiKeyId?: string | null;
  request: ActionRequest;
};

export type RunActionOutcome = {
  actionId: string;
  status: "denied" | "pending_approval" | "succeeded" | "failed";
  decision: "allow" | "deny" | "require_approval";
  approvalRequestId?: string;
  result?: Record<string, unknown>;
  error?: string;
};

export async function runAction(
  supabase: SupabaseClient,
  input: RunActionInput,
  opts: { handlers?: ActionHandler[]; sandbox?: SandboxRunner } = {}
): Promise<RunActionOutcome> {
  const { teamId, principal, request } = input;
  const memberId = input.memberId ?? null;
  const apiKeyId = input.apiKeyId ?? null;

  // 1. record the request
  const { data: row, error: insErr } = await supabase
    .from("actions")
    .insert({
      team_id: teamId,
      member_id: memberId,
      actor: principal.actor,
      action_type: request.type,
      resource: request.resource,
      params: request.params,
      status: "requested",
    })
    .select("id")
    .single();
  if (insErr || !row) throw new Error(`action insert failed: ${insErr?.message}`);
  const actionId: string = row.id;

  const auditAction = (action: string, meta: Record<string, unknown>) =>
    audit(supabase, {
      team_id: teamId,
      actor_kind: apiKeyId ? "api_key" : "member",
      member_id: memberId,
      api_key_id: apiKeyId,
      action,
      target_type: "action",
      target_id: actionId,
      meta,
    });

  // 2. authorize through the policy engine
  const decision = await authorize(supabase, teamId, {
    principal,
    action: request.type,
    resource: request.resource,
  });

  if (decision.effect === "deny") {
    await supabase
      .from("actions")
      .update({ status: "denied", decision: "deny", matched_policy_id: decision.matchedRuleId, updated_at: now() })
      .eq("id", actionId);
    await auditAction("action.denied", { type: request.type, reason: decision.reason });
    return { actionId, status: "denied", decision: "deny", error: decision.reason };
  }

  if (decision.effect === "require_approval") {
    const approvalRequestId = await fileApprovalRequest(supabase, {
      teamId,
      request: { principal, action: request.type, resource: request.resource },
      decision,
      memberId,
      context: { params: request.params, action_id: actionId },
    });
    await supabase
      .from("actions")
      .update({
        status: "pending_approval",
        decision: "require_approval",
        matched_policy_id: decision.matchedRuleId,
        approval_request_id: approvalRequestId,
        updated_at: now(),
      })
      .eq("id", actionId);
    await auditAction("action.pending_approval", { type: request.type, approval_request_id: approvalRequestId });
    return { actionId, status: "pending_approval", decision: "require_approval", approvalRequestId };
  }

  // 3. allowed → execute
  await supabase.from("actions").update({ status: "running", decision: "allow", matched_policy_id: decision.matchedRuleId, updated_at: now() }).eq("id", actionId);

  const handler = handlerRegistry(opts.handlers).get(request.type);
  if (!handler) {
    const error = `no handler for action type '${request.type}'`;
    await finish(supabase, actionId, "failed", { error });
    await auditAction("action.failed", { type: request.type, error });
    return { actionId, status: "failed", decision: "allow", error };
  }

  try {
    const res = await handler.execute(
      { supabase, teamId, memberId, apiKeyId, principal, sandbox: opts.sandbox ?? unconfiguredSandbox },
      request.params
    );
    const status = res.ok ? "succeeded" : "failed";
    await finish(supabase, actionId, status, res.ok ? { output: res.output ?? {} } : { error: res.error ?? "failed" });
    await auditAction(`action.${status}`, { type: request.type });
    return { actionId, status, decision: "allow", result: res.output, error: res.error };
  } catch (e) {
    const error = e instanceof Error ? e.message : "handler threw";
    await finish(supabase, actionId, "failed", { error });
    await auditAction("action.failed", { type: request.type, error });
    return { actionId, status: "failed", decision: "allow", error };
  }
}

function now(): string {
  return new Date().toISOString();
}

async function finish(
  supabase: SupabaseClient,
  actionId: string,
  status: "succeeded" | "failed",
  result: Record<string, unknown>
): Promise<void> {
  await supabase.from("actions").update({ status, result, updated_at: now() }).eq("id", actionId);
}
