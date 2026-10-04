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
 *
 * AIO-1217: every transition here is bound to its team, id and expected prior state, and is
 * confirmed by the row it returns. There is no RLS and no composite tenant constraint behind
 * these tables, so an unchecked or unscoped write has no backstop. A transition that errors or
 * matches no row is a LegacyActionPersistenceFault, never a settled outcome.
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

// ── persistence faults ────────────────────────────────────────────────────────
type FaultPhase =
  | "approval_ownership"
  | "action_ownership"
  | "approval_claim"
  | "action_prepare"
  | "action_deny"
  | "request_deny"
  | "request_approval_link"
  | "request_running"
  | "action_finish";
type Dispatch = "not_started" | "attempted";
type HandlerOutcome = "succeeded" | "returned_failure" | "threw" | "missing_handler";

type FaultEvent = {
  phase: FaultPhase;
  teamId: string;
  actionId: string | null;
  approvalRequestId?: string;
  dispatch: Dispatch;
  outcome?: HandlerOutcome;
};

/**
 * A checked ownership read or state transition did not complete. The message is fixed: no driver
 * text, SQL, params or handler output reaches the caller (the v1 route returns it in its 500
 * envelope; the dashboard maps it to "could not decide").
 */
export class LegacyActionPersistenceFault extends Error {
  constructor() {
    super("action persistence unavailable");
    this.name = "LegacyActionPersistenceFault";
  }
}

/**
 * Emit the one operator event for a fault and return the error to throw. The payload is rebuilt
 * field by field so nothing beyond the allowlist can ride along; `dispatch` says whether the
 * handler was actually invoked, which is what an operator needs before retrying anything.
 */
function persistenceFault(event: FaultEvent): LegacyActionPersistenceFault {
  const fields: Record<string, string | null> = {
    phase: event.phase,
    teamId: event.teamId,
    actionId: event.actionId,
  };
  if (event.approvalRequestId !== undefined) fields.approvalRequestId = event.approvalRequestId;
  fields.dispatch = event.dispatch;
  if (event.outcome !== undefined) fields.outcome = event.outcome;
  console.error("[legacy_action_persistence_fault]", fields);
  return new LegacyActionPersistenceFault();
}

type Row = Record<string, unknown>;
type Envelope = { data: unknown; error: { message: string } | null };

/** Await one statement; a returned error or a throw is the fault, never an empty result. */
async function checked(event: FaultEvent, statement: PromiseLike<Envelope>): Promise<unknown> {
  let res: Envelope;
  try {
    res = await statement;
  } catch {
    throw persistenceFault(event);
  }
  if (res.error) throw persistenceFault(event);
  return res.data;
}

const rowsOf = (data: unknown): Row[] => (Array.isArray(data) ? (data as Row[]) : []);

/**
 * Move one action row out of `expected`, confirmed by exactly one returned row. A queued action
 * is additionally matched on the approval that queued it. Zero rows means the state this caller
 * relied on is gone, so nothing downstream (dispatch, terminal audit, a settled response) may run.
 */
async function transitionAction(
  db: DbClient,
  event: FaultEvent & { actionId: string },
  expected: "requested" | "pending_approval" | "running",
  patch: Row,
  returning = "id"
): Promise<Row> {
  let update = db
    .from("actions")
    .update({ ...patch, updated_at: now() })
    .eq("team_id", event.teamId)
    .eq("id", event.actionId)
    .eq("status", expected);
  if (expected === "pending_approval") update = update.eq("approval_request_id", event.approvalRequestId);
  const rows = rowsOf(await checked(event, update.select(returning)));
  if (rows.length !== 1) throw persistenceFault(event);
  return rows[0];
}

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
    await transitionAction(
      db,
      { phase: "request_deny", teamId, actionId, dispatch: "not_started" },
      "requested",
      { status: "denied", decision: "deny", matched_policy_id: decision.matchedRuleId }
    );
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
    // The approval is already visible in the queue here. If this link fails it stays pending
    // against a `requested` action — resolveApproval refuses that tuple as not ready — and the
    // caller gets the fault, not a pending-approval response for a link that never landed.
    await transitionAction(
      db,
      { phase: "request_approval_link", teamId, actionId, approvalRequestId, dispatch: "not_started" },
      "requested",
      {
        status: "pending_approval",
        decision: "require_approval",
        matched_policy_id: decision.matchedRuleId,
        approval_request_id: approvalRequestId,
      }
    );
    await auditAction("action.pending_approval", { type: request.type, approval_request_id: approvalRequestId });
    return { actionId, status: "pending_approval", decision: "require_approval", approvalRequestId };
  }

  // 3. allowed → execute, only once `running` is confirmed
  await transitionAction(
    db,
    { phase: "request_running", teamId, actionId, dispatch: "not_started" },
    "requested",
    { status: "running", decision: "allow", matched_policy_id: decision.matchedRuleId }
  );

  const exec = await executeHandler(
    db,
    { teamId, actionId },
    { db, teamId, memberId, apiKeyId, principal, sandbox: opts.sandbox ?? unconfiguredSandbox },
    request,
    opts.handlers,
    auditAction
  );
  return { actionId, decision: "allow", status: exec.status, result: exec.result, error: exec.error };
}

// ── approval ownership ────────────────────────────────────────────────────────
// Same shape as lib/gateway/http's isUuid; kept local so this owner does not import the gateway.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const isRecord = (value: unknown): value is Row =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export type ApprovalOwner =
  | { owner: "not_found" }
  | { owner: "malformed_links" }
  | { owner: "governed" }
  | {
      owner: "legacy";
      status: string;
      /** `context.action_id` is present, whatever it holds. */
      hasForwardMarker: boolean;
      /** The forward action id when the marker is a well-formed id; null when absent or malformed. */
      forwardActionId: string | null;
    };

/**
 * Decide who owns an approval, from the caller's authenticated team outward. The approval is read
 * by (team, id), so an absent id and another team's id are the same `not_found`. Governed
 * ownership is then established from minimal identifiers: `governed_actions` has no team column,
 * its tenant is `governed_action_identities.team_id`. A governed marker is governed intent even
 * when its owner row is missing — that is `malformed_links`, never a legacy or standalone
 * approval. Only minimal ids and status leave this function; the approval's params do not.
 */
export async function resolveApprovalOwner(
  db: DbClient,
  input: { teamId: string; approvalRequestId: string }
): Promise<ApprovalOwner> {
  const { teamId, approvalRequestId } = input;
  if (!UUID.test(approvalRequestId)) return { owner: "not_found" };
  const fault: FaultEvent = {
    phase: "approval_ownership",
    teamId,
    actionId: null,
    approvalRequestId,
    dispatch: "not_started",
  };

  const appr = (await checked(
    fault,
    db
      .from("approval_requests")
      .select("id, status, context")
      .eq("team_id", teamId)
      .eq("id", approvalRequestId)
      .maybeSingle()
  )) as { status: string; context: unknown } | null;
  if (!appr) return { owner: "not_found" };
  const context = isRecord(appr.context) ? appr.context : {};
  const hasGovernedMarker = "governed_action_id" in context;

  // Governed approvals have their own transactional resolver, never the legacy registry.
  const governed = (await checked(
    fault,
    db.from("governed_actions").select("id, identity_id").eq("approval_request_id", approvalRequestId).maybeSingle()
  )) as { id: string; identity_id: string } | null;
  if (governed) {
    const identity = (await checked(
      fault,
      db.from("governed_action_identities").select("id, team_id").eq("id", governed.identity_id).maybeSingle()
    )) as { team_id: string } | null;
    if (!identity) return { owner: "malformed_links" };
    if (identity.team_id !== teamId) return { owner: "not_found" };
    if (hasGovernedMarker && context.governed_action_id !== governed.id) return { owner: "malformed_links" };
    return { owner: "governed" };
  }
  if (hasGovernedMarker) return { owner: "malformed_links" };

  const forward = context.action_id;
  return {
    owner: "legacy",
    status: appr.status,
    hasForwardMarker: "action_id" in context,
    forwardActionId: typeof forward === "string" && UUID.test(forward) ? forward : null,
  };
}

type LegacyLink =
  | { link: "standalone" }
  | { link: "ready"; actionId: string }
  | { link: "malformed_links" }
  | { link: "ambiguous_links" }
  | { link: "not_ready" };

/**
 * Establish which action, if any, a pending legacy approval may resume. Only minimal identifiers
 * are read here, and unscoped on purpose: a reverse link from another team's action is a
 * contradiction to refuse, not a row to overlook. The execution payload is loaded later, by the
 * team-bound prepare statement.
 *
 * runAction inserts the approval (carrying `context.action_id`) before it links the action, so a
 * forward marker with no reverse link is a producer mid-flight, not an orphan: `not_ready`. A
 * linked action that is no longer `pending_approval` is `not_ready` too — it is never replayed.
 * Standalone means no forward marker AND no reverse-linked action.
 */
async function legacyLink(
  db: DbClient,
  teamId: string,
  approvalRequestId: string,
  owner: Extract<ApprovalOwner, { owner: "legacy" }>
): Promise<LegacyLink> {
  if (owner.hasForwardMarker && !owner.forwardActionId) return { link: "malformed_links" };
  const fault: FaultEvent = {
    phase: "action_ownership",
    teamId,
    actionId: null,
    approvalRequestId,
    dispatch: "not_started",
  };

  // actions.approval_request_id is not unique and maybeSingle() returns the first of several
  // rows, so cardinality is read explicitly.
  const reverse = rowsOf(
    await checked(
      fault,
      db.from("actions").select("id, team_id, status").eq("approval_request_id", approvalRequestId).limit(2)
    )
  );
  if (reverse.length > 1) return { link: "ambiguous_links" };
  if (reverse.length === 1) {
    const linked = reverse[0];
    if (linked.team_id !== teamId) return { link: "malformed_links" };
    if (owner.forwardActionId && owner.forwardActionId !== linked.id) return { link: "malformed_links" };
    if (linked.status !== "pending_approval") return { link: "not_ready" };
    return { link: "ready", actionId: linked.id as string };
  }
  if (!owner.forwardActionId) return { link: "standalone" };

  const forward = (await checked(
    fault,
    db.from("actions").select("id, team_id, approval_request_id").eq("id", owner.forwardActionId).maybeSingle()
  )) as { team_id: string; approval_request_id?: string | null } | null;
  if (!forward || forward.team_id !== teamId) return { link: "malformed_links" };
  const linkedTo = forward.approval_request_id ?? null;
  if (linkedTo !== null && linkedTo !== approvalRequestId) return { link: "malformed_links" };
  return { link: "not_ready" };
}

export type ResolveApprovalInput = {
  /** The decider's authenticated team — never derived from the approval row. */
  teamId: string;
  approvalRequestId: string;
  decision: "approved" | "denied";
  deciderMemberId: string;
  note?: string;
};

export type ResolveApprovalOutcome = {
  approvalRequestId: string;
  status:
    | "approved"
    | "denied"
    | "already_decided"
    | "not_found"
    | "malformed_links"
    | "ambiguous_links"
    | "not_ready";
  actionId?: string | null;
  actionStatus?: "succeeded" | "failed" | "denied";
  result?: Record<string, unknown>;
  error?: string;
};

/**
 * Resolve a queued (`require_approval`) action. Approve → resume and execute its handler;
 * deny → mark the action denied. The caller (the session-authed dashboard) MUST have verified
 * the decider is a current admin of `teamId`; nothing in the database enforces that, and this
 * runs with the service client to perform the resumed handler's writes.
 *
 * Order: ownership (absent/foreign/governed) → an owned non-pending approval is already decided →
 * link readiness → atomic pending claim → checked prepare/deny → dispatch → checked completion.
 * The named refusals (`not_found`, `already_decided`, `malformed_links`, `ambiguous_links`,
 * `not_ready`) are results, not faults: they write nothing, audit nothing and dispatch nothing.
 *
 * Once the claim is won the human decision is durable and is not undone. A prepare/deny fault
 * after it leaves the approval decided and the action where it was — known not dispatched. A
 * completion fault after dispatch leaves the action `running` — completion uncertain; the handler
 * is not replayed and its outcome is not rewritten. Both are for an operator to reconcile.
 */
export async function resolveApproval(
  db: DbClient,
  input: ResolveApprovalInput,
  opts: ExecOpts = {}
): Promise<ResolveApprovalOutcome> {
  const { teamId, approvalRequestId, decision, deciderMemberId, note } = input;

  const owner = await resolveApprovalOwner(db, { teamId, approvalRequestId });
  if (owner.owner === "not_found" || owner.owner === "governed") return { approvalRequestId, status: "not_found" };
  if (owner.owner === "malformed_links") return { approvalRequestId, status: "malformed_links" };
  if (owner.status !== "pending") return { approvalRequestId, status: "already_decided" };

  const link = await legacyLink(db, teamId, approvalRequestId, owner);
  if (link.link !== "standalone" && link.link !== "ready") return { approvalRequestId, status: link.link };
  const actionId = link.link === "ready" ? link.actionId : null;

  // Record the human decision: one winner. A lost claim neither audits nor dispatches.
  const claimFault: FaultEvent = { phase: "approval_claim", teamId, actionId, approvalRequestId, dispatch: "not_started" };
  const claimed = rowsOf(
    await checked(
      claimFault,
      db
        .from("approval_requests")
        .update({
          status: decision,
          decided_by: deciderMemberId,
          decided_at: now(),
          decision_note: note ?? "",
        })
        .eq("team_id", teamId)
        .eq("id", approvalRequestId)
        .eq("status", "pending")
        .select("id")
    )
  );
  if (claimed.length === 0) return { approvalRequestId, status: "already_decided" };
  if (claimed.length !== 1) throw persistenceFault(claimFault);

  const auditAction = makeAuditAction(db, {
    teamId,
    memberId: deciderMemberId,
    apiKeyId: null,
    actionId: actionId ?? approvalRequestId,
  });
  await auditAction(`approval.${decision}`, { approval_request_id: approvalRequestId });

  if (decision === "denied") {
    if (actionId) {
      await transitionAction(
        db,
        { phase: "action_deny", teamId, actionId, approvalRequestId, dispatch: "not_started" },
        "pending_approval",
        { status: "denied" }
      );
    }
    return { approvalRequestId, status: "denied", actionId, actionStatus: actionId ? "denied" : undefined };
  }

  // approved → resume the action
  if (!actionId) return { approvalRequestId, status: "approved", actionId: null };

  // Confirming `running` and loading the execution payload are one team-bound statement.
  const action = (await transitionAction(
    db,
    { phase: "action_prepare", teamId, actionId, approvalRequestId, dispatch: "not_started" },
    "pending_approval",
    { status: "running" },
    "id, action_type, resource, params, actor, member_id"
  )) as {
    action_type: string;
    resource: string;
    params: Record<string, unknown> | null;
    actor: string;
    member_id: string | null;
  };
  // The stored requester resumes as role member / tier team, as before; it is not re-derived.
  const principal: Principal = { role: "member", tier: "team", actor: action.actor };
  const exec = await executeHandler(
    db,
    { teamId, actionId, approvalRequestId },
    { db, teamId, memberId: action.member_id, apiKeyId: null, principal, sandbox: opts.sandbox ?? unconfiguredSandbox },
    { type: action.action_type, resource: action.resource, params: action.params ?? {} },
    opts.handlers,
    auditAction
  );
  return {
    approvalRequestId,
    status: "approved",
    actionId,
    actionStatus: exec.status,
    result: exec.result,
    error: exec.error,
  };
}

// ── shared execution ──────────────────────────────────────────────────────────
type ExecResult = { status: "succeeded" | "failed"; result?: Record<string, unknown>; error?: string };

/** What the handler did, kept apart from whether that could be persisted. */
type Settled = ExecResult & {
  outcome: HandlerOutcome;
  dispatch: Dispatch;
  stored: Record<string, unknown>;
  auditMeta: Record<string, unknown>;
};

async function invokeHandler(
  ctx: Parameters<ActionHandler["execute"]>[0],
  request: ActionRequest,
  handlers: ActionHandler[] | undefined
): Promise<Settled> {
  const handler = handlerRegistry(handlers).get(request.type);
  if (!handler) {
    const error = `no handler for action type '${request.type}'`;
    return {
      outcome: "missing_handler",
      dispatch: "not_started",
      status: "failed",
      error,
      stored: { error },
      auditMeta: { type: request.type, error },
    };
  }
  try {
    const res = await handler.execute(ctx, request.params);
    const status = res.ok ? "succeeded" : "failed";
    return {
      outcome: res.ok ? "succeeded" : "returned_failure",
      dispatch: "attempted",
      status,
      result: res.output,
      error: res.error,
      stored: res.ok ? { output: res.output ?? {} } : { error: res.error ?? "failed" },
      auditMeta: { type: request.type },
    };
  } catch (e) {
    const error = e instanceof Error ? e.message : "handler threw";
    return {
      outcome: "threw",
      dispatch: "attempted",
      status: "failed",
      error,
      stored: { error },
      auditMeta: { type: request.type, error },
    };
  }
}

/**
 * Run the handler for a confirmed-`running` action, then persist its outcome. The handler's catch
 * does not span the terminal write: a completion that cannot be confirmed throws the fault as-is —
 * no second "failed" write over a handler that succeeded, no terminal audit, no replay.
 */
async function executeHandler(
  db: DbClient,
  target: { teamId: string; actionId: string; approvalRequestId?: string },
  ctx: Parameters<ActionHandler["execute"]>[0],
  request: ActionRequest,
  handlers: ActionHandler[] | undefined,
  auditAction: (action: string, meta: Record<string, unknown>) => Promise<void>
): Promise<ExecResult> {
  const settled = await invokeHandler(ctx, request, handlers);
  await transitionAction(
    db,
    { phase: "action_finish", ...target, dispatch: settled.dispatch, outcome: settled.outcome },
    "running",
    { status: settled.status, result: settled.stored }
  );
  await auditAction(`action.${settled.status}`, settled.auditMeta);
  return { status: settled.status, result: settled.result, error: settled.error };
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
