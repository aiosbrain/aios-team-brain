import "server-only";
import type { DbClient } from "@/lib/db/types";
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
 * audits every outcome. resolveApproval resumes (or rejects) a queued action once a human
 * decides. Both share executeHandler. It is the only place actions transition state.
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

type ExecOpts = { handlers?: ActionHandler[]; sandbox?: SandboxRunner };

export async function runAction(
  db: DbClient,
  input: RunActionInput,
  opts: ExecOpts = {}
): Promise<RunActionOutcome> {
  const { teamId, principal, request } = input;
  const memberId = input.memberId ?? null;
  const apiKeyId = input.apiKeyId ?? null;

  // 1. record the request
  const { data: row, error: insErr } = await db
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
  const auditAction = makeAuditAction(db, { teamId, memberId, apiKeyId, actionId });

  // 2. authorize through the policy engine
  const decision = await authorize(db, teamId, {
    principal,
    action: request.type,
    resource: request.resource,
  });

  if (decision.effect === "deny") {
    await db
      .from("actions")
      .update({ status: "denied", decision: "deny", matched_policy_id: decision.matchedRuleId, updated_at: now() })
      .eq("id", actionId);
    await auditAction("action.denied", { type: request.type, reason: decision.reason });
    return { actionId, status: "denied", decision: "deny", error: decision.reason };
  }

  if (decision.effect === "require_approval") {
    const approvalRequestId = await fileApprovalRequest(db, {
      teamId,
      request: { principal, action: request.type, resource: request.resource },
      decision,
      memberId,
      context: { params: request.params, action_id: actionId },
    });
    await db
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
  await db
    .from("actions")
    .update({ status: "running", decision: "allow", matched_policy_id: decision.matchedRuleId, updated_at: now() })
    .eq("id", actionId);

  const exec = await executeHandler(
    db,
    actionId,
    { db, teamId, memberId, apiKeyId, principal, sandbox: opts.sandbox ?? unconfiguredSandbox },
    request,
    opts.handlers,
    auditAction
  );
  return { actionId, decision: "allow", status: exec.status, result: exec.result, error: exec.error };
}

export type ResolveApprovalInput = {
  approvalRequestId: string;
  decision: "approved" | "denied";
  deciderMemberId: string;
  note?: string;
};

export type ResolveApprovalOutcome = {
  approvalRequestId: string;
  status: "approved" | "denied" | "already_decided" | "not_found";
  actionId?: string | null;
  actionStatus?: "succeeded" | "failed" | "denied";
  result?: Record<string, unknown>;
  error?: string;
};

/**
 * Resolve a queued (`require_approval`) action. Approve → resume and execute its handler;
 * deny → mark the action denied. Caller (the session-authed dashboard) MUST have verified
 * the decider is an admin/lead — RLS enforces that on the session client; this runs with
 * the service role to perform the resumed handler's writes.
 */
export async function resolveApproval(
  db: DbClient,
  input: ResolveApprovalInput,
  opts: ExecOpts = {}
): Promise<ResolveApprovalOutcome> {
  const { approvalRequestId, decision, deciderMemberId, note } = input;

  const { data: appr } = await db
    .from("approval_requests")
    .select("id, team_id, status")
    .eq("id", approvalRequestId)
    .maybeSingle();
  if (!appr) return { approvalRequestId, status: "not_found" };
  if (appr.status !== "pending") return { approvalRequestId, status: "already_decided" };

  const { data: action } = await db
    .from("actions")
    .select("id, action_type, resource, params, actor, member_id")
    .eq("approval_request_id", approvalRequestId)
    .maybeSingle();

  // Record the human decision on the approval request.
  await db
    .from("approval_requests")
    .update({
      status: decision,
      decided_by: deciderMemberId,
      decided_at: now(),
      decision_note: note ?? "",
    })
    .eq("id", approvalRequestId);

  const auditAction = makeAuditAction(db, {
    teamId: appr.team_id,
    memberId: deciderMemberId,
    apiKeyId: null,
    actionId: action?.id ?? approvalRequestId,
  });
  await auditAction(`approval.${decision}`, { approval_request_id: approvalRequestId });

  if (decision === "denied") {
    if (action) {
      await db.from("actions").update({ status: "denied", updated_at: now() }).eq("id", action.id);
    }
    return { approvalRequestId, status: "denied", actionId: action?.id ?? null, actionStatus: action ? "denied" : undefined };
  }

  // approved → resume the action
  if (!action) return { approvalRequestId, status: "approved", actionId: null };

  await db.from("actions").update({ status: "running", updated_at: now() }).eq("id", action.id);
  const principal: Principal = { role: "member", tier: "team", actor: action.actor };
  const exec = await executeHandler(
    db,
    action.id,
    { db, teamId: appr.team_id, memberId: action.member_id, apiKeyId: null, principal, sandbox: opts.sandbox ?? unconfiguredSandbox },
    { type: action.action_type, resource: action.resource, params: action.params ?? {} },
    opts.handlers,
    auditAction
  );
  return {
    approvalRequestId,
    status: "approved",
    actionId: action.id,
    actionStatus: exec.status,
    result: exec.result,
    error: exec.error,
  };
}

// ── shared execution ──────────────────────────────────────────────────────────
type ExecResult = { status: "succeeded" | "failed"; result?: Record<string, unknown>; error?: string };

async function executeHandler(
  db: DbClient,
  actionId: string,
  ctx: Parameters<ActionHandler["execute"]>[0],
  request: ActionRequest,
  handlers: ActionHandler[] | undefined,
  auditAction: (action: string, meta: Record<string, unknown>) => Promise<void>
): Promise<ExecResult> {
  const handler = handlerRegistry(handlers).get(request.type);
  if (!handler) {
    const error = `no handler for action type '${request.type}'`;
    await finish(db, actionId, "failed", { error });
    await auditAction("action.failed", { type: request.type, error });
    return { status: "failed", error };
  }
  try {
    const res = await handler.execute(ctx, request.params);
    const status = res.ok ? "succeeded" : "failed";
    await finish(db, actionId, status, res.ok ? { output: res.output ?? {} } : { error: res.error ?? "failed" });
    await auditAction(`action.${status}`, { type: request.type });
    return { status, result: res.output, error: res.error };
  } catch (e) {
    const error = e instanceof Error ? e.message : "handler threw";
    await finish(db, actionId, "failed", { error });
    await auditAction("action.failed", { type: request.type, error });
    return { status: "failed", error };
  }
}

function makeAuditAction(
  db: DbClient,
  ids: { teamId: string; memberId: string | null; apiKeyId: string | null; actionId: string }
) {
  return (action: string, meta: Record<string, unknown>) =>
    audit(db, {
      team_id: ids.teamId,
      actor_kind: ids.apiKeyId ? "api_key" : "member",
      member_id: ids.memberId,
      api_key_id: ids.apiKeyId,
      action,
      target_type: "action",
      target_id: ids.actionId,
      meta,
    });
}

function now(): string {
  return new Date().toISOString();
}

async function finish(
  db: DbClient,
  actionId: string,
  status: "succeeded" | "failed",
  result: Record<string, unknown>
): Promise<void> {
  await db.from("actions").update({ status, result, updated_at: now() }).eq("id", actionId);
}
