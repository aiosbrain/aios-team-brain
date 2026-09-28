import { noteConsumer } from "./consumers/note";
import { decisionConsumer } from "./consumers/decision";
import "server-only";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { ApiAuth } from "@/lib/api/auth";
import type { DbClient } from "@/lib/db/types";
import { PgClient } from "@/lib/db/pg/client";
import type { SqlResult } from "@/lib/db/pg/pool";
import {
  governedTransaction,
  transactionGuard,
  MAX_TRANSACTION_MS,
} from "./transaction";
import { visibleProjectsWithError } from "@/lib/access/oracle";
import { resolveViewerPosture } from "@/lib/access/posture";
import { isPrincipal } from "@/lib/access/eligibility";
import { loadPolicies, evaluatePolicy, type Principal } from "@/lib/policy";
import {
  parseSubmitRequest,
  canonicalRequest,
  operationKey,
  hash,
  effectSchema,
  validateStatus,
  type SubmitRequest,
  type ActionType,
  type ActionStatus,
  type ConsumerResult,
} from "./contract";
import { actionError, DomainFailure, GovernedError } from "./errors";
export * from "./contract";
export * from "./errors";
export type TransactionQuery = <T = Record<string, unknown>>(
  sql: string,
  values?: unknown[],
) => Promise<SqlResult<T>>;
export interface GovernedContext {
  readonly db: DbClient;
  readonly query: TransactionQuery;
  readonly teamId: string;
  readonly memberId: string;
  readonly projectId: string;
  readonly principal: Principal;
}
/**
 * Database effects only, awaited before return. Do not manage transactions or
 * mutate authority tables (teams/members/credentials/projects/access/policies).
 * Remote delivery must be represented by a transactional outbox write.
 */
export interface GovernedConsumer {
  readonly type: ActionType;
  execute(
    ctx: GovernedContext,
    request: SubmitRequest,
  ): Promise<ConsumerResult>;
}
export interface ApprovalDecision {
  teamId: string;
  deciderMemberId: string;
  approvalRequestId: string;
  decision: "approved" | "denied";
  note?: string;
}
type Identity = {
  id: string;
  team_id: string;
  member_id: string;
  project_id: string;
  operation_key: string;
  canonical_request: string;
  request_hash: string;
};
type Action = {
  id: string;
  identity_id: string;
  attempt: number;
  credential_id: string;
  credential_fingerprint: string;
  request: SubmitRequest;
  status: ActionStatus["status"];
  result: ActionStatus;
  approval_request_id: string | null;
  authorization_fingerprint: string | null;
};
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
function txDb(c: PoolClient): { db: DbClient; query: TransactionQuery } {
  const assertActive = transactionGuard(c);
  const query: TransactionQuery = async <T>(
    sql: string,
    values: unknown[] = [],
  ) => {
    assertActive();
    const r = await c.query(sql, values);
    return { rows: r.rows as T[], rowCount: r.rowCount ?? 0 };
  };
  return { query, db: new PgClient(query) };
}
async function identityLock(c: PoolClient, key: string) {
  return (
    await c.query<{ held: boolean }>(
      "select pg_try_advisory_xact_lock(hashtextextended($1,0)) as held",
      ["governed:" + key],
    )
  ).rows[0].held;
}
function lockKey(
  i: Pick<Identity, "team_id" | "member_id" | "project_id" | "operation_key">,
) {
  return canonicalRequest([
    i.team_id,
    i.member_id,
    i.project_id,
    i.operation_key,
  ]);
}
/**
 * SHARE locks fence policy/grant insertions as well as existing-row changes.
 * Readers and other governed identities can coexist. Authority administration
 * waits instance-wide until commit/rollback (maximum transaction deadline 15s).
 * This conservative foundation tradeoff avoids changing every authority writer;
 * consumers must not update these tables or perform provider/network work.
 * All governed paths acquire them after identity/action/approval.
 */
async function authorityLock(c: PoolClient) {
  await c.query(
    "LOCK TABLE teams, members, api_keys, projects, groups, group_members, project_groups, policies IN SHARE MODE",
  );
}
async function authority(
  c: PoolClient,
  auth: Pick<
    ApiAuth,
    "teamId" | "memberId" | "apiKeyId" | "credentialFingerprint"
  >,
  projectId: string,
  execution: boolean,
): Promise<GovernedContext> {
  const { db, query } = txDb(c);
  const key = (
    await c.query(
      "select k.key_hash,k.revoked_at,m.* from api_keys k join members m on m.id=k.member_id and m.team_id=k.team_id join teams t on t.id=k.team_id where k.id=$1 and k.team_id=$2 and k.member_id=$3",
      [auth.apiKeyId, auth.teamId, auth.memberId],
    )
  ).rows[0];
  if (
    !key ||
    key.revoked_at ||
    !auth.credentialFingerprint ||
    key.key_hash !== auth.credentialFingerprint ||
    !isPrincipal(key)
  )
    throw new GovernedError("unauthorized", 401);
  const posture = await resolveViewerPosture(db, auth.teamId, auth.memberId);
  if (execution && posture !== "team")
    throw new GovernedError("forbidden", 403);
  const { set, error } = await visibleProjectsWithError(db, {
    teamId: auth.teamId,
    memberId: auth.memberId,
  });
  if (error) throw new GovernedError("unavailable", 503);
  if (!set.projectIds.has(projectId)) throw new GovernedError("not_found", 404);
  const project = (
    await c.query("select id from projects where id=$1 and team_id=$2", [
      projectId,
      auth.teamId,
    ])
  ).rows[0];
  if (!project) throw new GovernedError("not_found", 404);
  return {
    db,
    query,
    teamId: auth.teamId,
    memberId: auth.memberId,
    projectId,
    principal: { role: "member", tier: posture, actor: key.actor_handle },
  };
}
async function policy(
  c: PoolClient,
  ctx: GovernedContext,
  request: SubmitRequest,
) {
  let resource = `project:${ctx.projectId}`;
  if (request.type === "task.update") {
    if (!uuid.test(request.params.task_id))
      throw new GovernedError("not_found", 404);
    const task = (
      await c.query(
        "select id from tasks where id=$1 and team_id=$2 and project_id=$3",
        [request.params.task_id, ctx.teamId, ctx.projectId],
      )
    ).rows[0];
    if (!task) throw new GovernedError("not_found", 404);
    resource += `/task:${task.id}`;
  }
  const rules = await loadPolicies(ctx.db, ctx.teamId);
  const requestPolicy = {
    principal: ctx.principal,
    action: request.type,
    resource,
  };
  return {
    resource,
    decision: evaluatePolicy(rules, requestPolicy),
    fingerprint: hash(
      canonicalRequest({
        ...requestPolicy,
        rules: [...rules].sort((a, b) => a.id.localeCompare(b.id)),
      }),
    ),
  };
}
async function audit(
  c: PoolClient,
  i: Identity,
  actionId: string,
  event: string,
  actorId = i.member_id,
) {
  const r = await c.query<{ id: string }>(
    `insert into audit_log(team_id,actor_kind,member_id,action,target_type,target_id,meta) values($1,'member',$2,$3,'governed_action',$4,'{}') returning id`,
    [i.team_id, actorId, event, actionId],
  );
  return String(r.rows[0].id);
}
async function settle(
  c: PoolClient,
  i: Identity,
  a: Action,
  body: Record<string, unknown>,
  event: string,
  actorId?: string,
): Promise<ActionStatus> {
  const audit_ref = await audit(c, i, a.id, event, actorId);
  const result = validateStatus({
    contract_version: "mcp-next/1",
    action_id: a.id,
    audit_ref,
    ...body,
  });
  await c.query(
    "update governed_actions set status=$2,result=$3, audit_ref=$4,updated_at=now() where id=$1",
    [a.id, result.status, JSON.stringify(result), audit_ref],
  );
  return result;
}
function decodeAction(a: Action): Action {
  return {
    ...a,
    request:
      typeof a.request === "string"
        ? parseSubmitRequest(JSON.parse(a.request))
        : a.request,
  };
}
const terminal = (s: ActionStatus["status"]) =>
  ["succeeded", "denied", "failed", "conflict"].includes(s);
export function createGovernedActionService(
  opts: {
    consumers?: readonly GovernedConsumer[];
    enabled?: () => boolean;
    /** May shorten, never extend, the connection deadline in server composition. */
    transactionTimeoutMs?: number;
  } = {},
) {
  const timeoutMs = opts.transactionTimeoutMs ?? MAX_TRANSACTION_MS;
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > MAX_TRANSACTION_MS
  )
    throw new Error("Invalid governed transaction deadline");
  const transaction = <T>(fn: (c: PoolClient) => Promise<T>) =>
    governedTransaction(fn, timeoutMs);
  const consumers = new Map((opts.consumers ?? []).map((c) => [c.type, c]));
  const enabled =
    opts.enabled ??
    (() => process.env.AIOS_GOVERNED_ACTIONS_ENABLED === "true");
  const available = (t: ActionType) => enabled() && consumers.has(t);
  async function execute(
    c: PoolClient,
    i: Identity,
    a: Action,
    approval?: ApprovalDecision,
  ): Promise<ActionStatus> {
    a = decodeAction(a);
    if (terminal(a.status)) return validateStatus(a.result);
    if (!available(a.request.type))
      throw new GovernedError("capability_unavailable", 503);
    let ctx: GovernedContext;
    let p: Awaited<ReturnType<typeof policy>>;
    try {
      ctx = await authority(
        c,
        {
          teamId: i.team_id,
          memberId: i.member_id,
          apiKeyId: a.credential_id,
          credentialFingerprint: a.credential_fingerprint,
        },
        i.project_id,
        true,
      );
      p = await policy(c, ctx, a.request);
    } catch (e) {
      if (
        e instanceof GovernedError &&
        ["unauthorized", "forbidden", "not_found"].includes(e.code)
      )
        return settle(
          c,
          i,
          a,
          { status: "denied", error: actionError("revoked_authorization") },
          "governed.revoked",
        );
      throw e;
    }
    if (approval) {
      if (approval.decision === "denied")
        return settle(
          c,
          i,
          a,
          { status: "denied", error: actionError("forbidden") },
          "governed.denied",
          approval.deciderMemberId,
        );
      if (a.authorization_fingerprint !== p.fingerprint)
        return settle(
          c,
          i,
          a,
          { status: "denied", error: actionError("revoked_authorization") },
          "governed.stale_approval",
          approval.deciderMemberId,
        );
    }
    if (p.decision.effect === "deny")
      return settle(
        c,
        i,
        a,
        { status: "denied", error: actionError("forbidden") },
        "governed.denied",
      );
    if (p.decision.effect === "require_approval" && !approval) {
      if (a.status === "pending_approval") return validateStatus(a.result);
      const ar = await c.query<{ id: string }>(
        `insert into approval_requests(team_id,requested_by_member,requested_by_actor,action,resource,matched_policy_id,context) values($1,$2,$3,$4,$5,$6,$7) returning id`,
        [
          i.team_id,
          i.member_id,
          ctx.principal.actor,
          a.request.type,
          p.resource,
          p.decision.matchedRuleId,
          JSON.stringify({ governed_action_id: a.id }),
        ],
      );
      await c.query(
        "update governed_actions set approval_request_id=$2,authorization_fingerprint=$3 where id=$1",
        [a.id, ar.rows[0].id, p.fingerprint],
      );
      return settle(
        c,
        i,
        a,
        { status: "pending_approval", approval_request_id: ar.rows[0].id },
        "governed.pending_approval",
      );
    }
    // Savepoint is AFTER identity/action/approval/authority claims. Rolling back callback writes retains every claim.
    await c.query("SAVEPOINT governed_effect");
    let effect: ConsumerResult;
    try {
      effect = effectSchema.parse(
        await consumers.get(a.request.type)!.execute(ctx, a.request),
      );
    } catch (e) {
      await c.query("ROLLBACK TO SAVEPOINT governed_effect");
      if (!(e instanceof DomainFailure)) throw e;
      return settle(
        c,
        i,
        a,
        { status: e.status, error: actionError(e.code) },
        "governed." + e.status,
      );
    }
    // Audit/result failures must roll back the WHOLE execution, including callback and approval decision.
    return settle(
      c,
      i,
      a,
      { status: "succeeded", ...effect },
      "governed.succeeded",
    );
  }
  async function resume(i: Identity, id: string): Promise<ActionStatus> {
    return transaction(async (c) => {
      if (!(await identityLock(c, lockKey(i)))) {
        const a = (
          await c.query<Action>("select * from governed_actions where id=$1", [
            id,
          ])
        ).rows[0];
        return validateStatus(a.result);
      }
      const a = (
        await c.query<Action>(
          "select * from governed_actions where id=$1 for update",
          [id],
        )
      ).rows[0];
      if (a.approval_request_id)
        await c.query(
          "select id from approval_requests where id=$1 for update",
          [a.approval_request_id],
        );
      await authorityLock(c);
      // Pending approvals are resumed ONLY through the human decision path, even if policy later changes to allow.
      if (a.status === "pending_approval" || terminal(a.status))
        return validateStatus(a.result);
      return execute(c, i, a);
    });
  }
  return {
    capabilities() {
      return {
        contract_versions: ["mcp-next/1"],
        actions: enabled() ? [...consumers.keys()] : [],
        task_revisions: false,
      };
    },
    async submit(auth: ApiAuth, payload: unknown): Promise<ActionStatus> {
      let request: SubmitRequest;
      try {
        request = parseSubmitRequest(payload);
      } catch {
        throw new GovernedError("invalid_payload", 422);
      }
      const projectId = request.destination.project_id;
      if (!uuid.test(projectId)) throw new GovernedError("not_found", 404);
      const bytes = canonicalRequest(request),
        key = operationKey(request, auth.memberId, auth.teamId, projectId);
      const accepted = await transaction(async (c) => {
        const owned = await identityLock(
          c,
          lockKey({
            team_id: auth.teamId,
            member_id: auth.memberId,
            project_id: projectId,
            operation_key: key,
          }),
        );
        await authorityLock(c);
        const ctx = await authority(c, auth, projectId, false);
        // Task resolution precedes identity disclosure; the same inaccessible response applies on replay.
        if (request.type === "task.update") await policy(c, ctx, request);
        let i = (
          await c.query<Identity>(
            "select * from governed_action_identities where team_id=$1 and member_id=$2 and project_id=$3 and operation_key=$4",
            [auth.teamId, auth.memberId, projectId, key],
          )
        ).rows[0];
        let a = i
          ? (
              await c.query<Action>(
                "select * from governed_actions where identity_id=$1 order by attempt desc limit 1",
                [i.id],
              )
            ).rows[0]
          : undefined;
        if (i && i.canonical_request !== bytes)
          throw new GovernedError("operation_id_conflict", 409);
        if (
          a &&
          (!owned ||
            request.type !== "note.append" ||
            !["denied", "failed"].includes(a.status))
        )
          return { i, a, resume: owned && a.status === "requested" };
        if (!owned) throw new GovernedError("unavailable", 503);
        if (!available(request.type))
          throw new GovernedError("capability_unavailable", 503);
        if (ctx.principal.tier !== "team")
          throw new GovernedError("forbidden", 403);
        if (!i) {
          i = (
            await c.query<Identity>(
              `insert into governed_action_identities(team_id,member_id,project_id,operation_key,canonical_request,request_hash) values($1,$2,$3,$4,$5,$6) returning *`,
              [auth.teamId, auth.memberId, projectId, key, bytes, hash(bytes)],
            )
          ).rows[0];
        }
        const id = randomUUID(),
          audit_ref = await audit(c, i, id, "governed.requested");
        const result = validateStatus({
          contract_version: "mcp-next/1",
          action_id: id,
          audit_ref,
          status: "requested",
        });
        a = (
          await c.query<Action>(
            `insert into governed_actions(id,identity_id,attempt,credential_id,credential_fingerprint,request,status,result,audit_ref) values($1,$2,$3,$4,$5,$6,'requested',$7,$8) returning *`,
            [
              id,
              i.id,
              (a?.attempt ?? 0) + 1,
              auth.apiKeyId,
              auth.credentialFingerprint,
              JSON.stringify(request),
              JSON.stringify(result),
              audit_ref,
            ],
          )
        ).rows[0];
        return { i, a, resume: true };
      });
      return accepted.resume
        ? resume(accepted.i, accepted.a.id)
        : validateStatus(accepted.a.result);
    },
    async status(auth: ApiAuth, actionId: string): Promise<ActionStatus> {
      if (!uuid.test(actionId)) throw new GovernedError("not_found", 404);
      return transaction(async (c) => {
        const row = (
          await c.query<Action & Identity>(
            "select a.*,i.team_id,i.member_id,i.project_id from governed_actions a join governed_action_identities i on i.id=a.identity_id where a.id=$1 and i.team_id=$2 and i.member_id=$3",
            [actionId, auth.teamId, auth.memberId],
          )
        ).rows[0];
        if (!row) throw new GovernedError("not_found", 404);
        await authorityLock(c);
        await authority(c, auth, row.project_id, false);
        return validateStatus(row.result);
      });
    },
    async decide(input: ApprovalDecision): Promise<ActionStatus> {
      if (
        !uuid.test(input.approvalRequestId) ||
        !["approved", "denied"].includes(input.decision) ||
        (input.note && input.note.length > 2000)
      )
        throw new GovernedError("not_found", 404);
      return transaction(async (c) => {
        const found = (
          await c.query<{ id: string; identity_id: string }>(
            "select a.id,a.identity_id from governed_actions a join governed_action_identities i on i.id=a.identity_id where a.approval_request_id=$1 and i.team_id=$2",
            [input.approvalRequestId, input.teamId],
          )
        ).rows[0];
        if (!found) throw new GovernedError("not_found", 404);
        const i = (
          await c.query<Identity>(
            "select * from governed_action_identities where id=$1",
            [found.identity_id],
          )
        ).rows[0];
        if (!(await identityLock(c, lockKey(i))))
          throw new GovernedError("operation_in_progress", 409);
        const a = decodeAction(
          (
            await c.query<Action>(
              "select * from governed_actions where id=$1 for update",
              [found.id],
            )
          ).rows[0],
        );
        const ar = (
          await c.query(
            "select * from approval_requests where id=$1 and team_id=$2 for update",
            [input.approvalRequestId, input.teamId],
          )
        ).rows[0];
        await authorityLock(c);
        const decider = (
          await c.query("select * from members where id=$1 and team_id=$2", [
            input.deciderMemberId,
            input.teamId,
          ])
        ).rows[0];
        if (
          !decider ||
          !isPrincipal(decider) ||
          decider.kind !== "human" ||
          !["admin", "lead"].includes(decider.role) ||
          (await resolveViewerPosture(
            txDb(c).db,
            input.teamId,
            input.deciderMemberId,
          )) !== "team"
        )
          throw new GovernedError("forbidden", 403);
        if (!ar) throw new GovernedError("not_found", 404);
        if (ar.status !== "pending") {
          // A legacy resolver / unsupported downgrade may have changed only the
          // queue row. That decision is not governed execution authority.
          if (a.status === "pending_approval") {
            return settle(
              c,
              i,
              a,
              {
                status: "denied",
                error: actionError("revoked_authorization"),
              },
              "governed.inconsistent_approval",
              input.deciderMemberId,
            );
          }
          return validateStatus(a.result);
        }
        if (a.status !== "pending_approval")
          throw new GovernedError("not_found", 404);
        if (input.decision === "approved" && !available(a.request.type))
          throw new GovernedError("capability_unavailable", 503);
        await c.query(
          "update approval_requests set status=$2,decided_by=$3,decided_at=now(),decision_note=$4 where id=$1",
          [ar.id, input.decision, input.deciderMemberId, input.note ?? ""],
        );
        await audit(
          c,
          i,
          a.id,
          "governed.approval_" + input.decision,
          input.deciderMemberId,
        );
        if (input.decision === "denied")
          return settle(
            c,
            i,
            a,
            { status: "denied", error: actionError("forbidden") },
            "governed.denied",
            input.deciderMemberId,
          );
        return execute(c, i, a, input);
      });
    },
  };
}
/** Intentionally empty. Consumers land in separately reviewed increments. */
export const governedActions = createGovernedActionService({ consumers: [decisionConsumer, noteConsumer] });
