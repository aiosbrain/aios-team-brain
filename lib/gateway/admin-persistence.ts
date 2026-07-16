import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { getPool } from "@/lib/db/pg/pool";
import { withTransaction } from "@/lib/db/pg/tx";
import { GATEWAY_TOOLS, normalizeGatewayArgs } from "./normalize";

const sha256 = (value: Buffer) => createHash("sha256").update(value).digest("hex");

export class GatewayAdminError extends Error {
  constructor(
    readonly code:
      | "gateway_forbidden"
      | "gateway_not_found"
      | "gateway_scope_not_found"
      | "gateway_approval_expired"
      | "gateway_idempotency_conflict"
      | "gateway_invalid_request",
    readonly status: number,
  ) {
    super(code);
    this.name = "GatewayAdminError";
  }
}

export type GatewayAdminContext = {
  teamId: string;
  teamSlug: string;
  memberId: string;
};

export async function authorizeGatewayAdmin(
  teamSlug: string,
  authUserId: string,
): Promise<GatewayAdminContext> {
  return withTransaction(async (client) => {
    const team = await client.query<{ id: string }>(
      `select id from teams where slug=$1`,
      [teamSlug],
    );
    if (!team.rows[0]) throw new GatewayAdminError("gateway_not_found", 404);
    const member = await client.query<{
      id: string;
      role: string;
      tier: string;
      status: string;
    }>(
      `select id,role::text,tier::text,status::text
         from members where team_id=$1 and auth_user_id=$2`,
      [team.rows[0].id, authUserId],
    );
    const row = member.rows[0];
    if (!row) throw new GatewayAdminError("gateway_not_found", 404);
    if (row.status !== "active" || row.tier !== "team")
      throw new GatewayAdminError("gateway_scope_not_found", 422);
    if (row.role !== "admin")
      throw new GatewayAdminError("gateway_forbidden", 403);
    return { teamId: team.rows[0].id, teamSlug, memberId: row.id };
  });
}

async function expireGatewayApprovals(
  client: import("pg").PoolClient,
  ctx: GatewayAdminContext,
  correlationId: string,
) {
  const expired = await client.query<{
    id: string;
    execution_id: string;
    member_id: string;
    service_identity_id: string;
    subject_binding_id: string;
    connection_id: string;
  }>(
    `with due as (
       select a.id,a.execution_id,e.member_id,e.service_identity_id,
              e.subject_binding_id,e.connection_id
         from gateway_approvals a
         join gateway_executions e on e.id=a.execution_id and e.team_id=a.team_id
        where a.team_id=$1 and a.status in ('pending','approved') and a.expires_at<=now()
        for update of a,e
     ), approvals as (
       update gateway_approvals a
          set status='expired',decided_at=coalesce(a.decided_at,now()),
              decision_correlation_id=coalesce(a.decision_correlation_id,$2),updated_at=now()
         from due where a.id=due.id
       returning due.*
     )
     update gateway_executions e set state='expired',updated_at=now()
       from approvals a where e.id=a.execution_id
     returning a.*`,
    [ctx.teamId, correlationId],
  );
  for (const row of expired.rows) {
    await client.query(
      `insert into gateway_audit_log(
         team_id,member_id,service_identity_id,subject_binding_id,connection_id,
         execution_id,approval_id,event,correlation_id
       ) values($1,$2,$3,$4,$5,$6,$7,'approval_expired',$8)
       on conflict do nothing`,
      [ctx.teamId,row.member_id,row.service_identity_id,row.subject_binding_id,
       row.connection_id,row.execution_id,row.id,correlationId],
    );
  }
}

export async function listGatewayApprovals(ctx: GatewayAdminContext) {
  return withTransaction(async (client) => {
    await expireGatewayApprovals(client, ctx, randomUUID());
    const result = await client.query(
      `select a.id "approvalId",e.id "executionId",m.id "memberId",
              coalesce(nullif(m.display_name,''),m.actor_handle) "memberName",
              e.tool,e.policy_resource resource,left(e.request_hash,12) "requestHashPrefix",
              e.created_at "createdAt",a.expires_at "expiresAt",a.status
         from gateway_approvals a
         join gateway_executions e on e.id=a.execution_id and e.team_id=a.team_id
         join members m on m.id=e.member_id and m.team_id=e.team_id
        where a.team_id=$1 and a.status='pending'
        order by e.created_at asc`,
      [ctx.teamId],
    );
    return result.rows;
  });
}

export async function decideGatewayApproval(
  ctx: GatewayAdminContext,
  approvalId: string,
  decision: "approve" | "deny",
  correlationId: string,
) {
  const outcome = await withTransaction(async (client) => {
    const found = await client.query<{
      execution_id: string;
      status: string;
      expired: boolean;
      member_id: string;
      service_identity_id: string;
      subject_binding_id: string;
      connection_id: string;
    }>(
      `select a.execution_id,a.status,(a.expires_at<=now()) expired,
              e.member_id,e.service_identity_id,e.subject_binding_id,e.connection_id
         from gateway_approvals a
         join gateway_executions e on e.id=a.execution_id and e.team_id=a.team_id
        where a.id=$1 and a.team_id=$2 for update of a,e`,
      [approvalId, ctx.teamId],
    );
    const row = found.rows[0];
    if (!row) throw new GatewayAdminError("gateway_not_found", 404);
    if (row.expired) {
      await client.query(
        `update gateway_approvals set status='expired',decided_at=coalesce(decided_at,now()),
           decision_correlation_id=coalesce(decision_correlation_id,$1),updated_at=now()
         where id=$2`,
        [correlationId, approvalId],
      );
      await client.query(
        `update gateway_executions set state='expired',updated_at=now() where id=$1`,
        [row.execution_id],
      );
      await client.query(
        `insert into gateway_audit_log(
          team_id,member_id,service_identity_id,subject_binding_id,connection_id,
          execution_id,approval_id,event,correlation_id
        ) values($1,$2,$3,$4,$5,$6,$7,'approval_expired',$8)
        on conflict do nothing`,
        [ctx.teamId,row.member_id,row.service_identity_id,row.subject_binding_id,
         row.connection_id,row.execution_id,approvalId,correlationId],
      );
      return { expired: true as const };
    }
    if (row.status !== "pending")
      throw new GatewayAdminError("gateway_idempotency_conflict", 409);
    const status = decision === "approve" ? "approved" : "denied";
    const state = decision === "approve" ? "approved" : "cancelled";
    await client.query(
      `update gateway_approvals set status=$1,approver_member_id=$2,decided_at=now(),
       decision_correlation_id=$3,updated_at=now() where id=$4`,
      [status, ctx.memberId, correlationId, approvalId],
    );
    await client.query(
      `update gateway_executions set state=$1,updated_at=now() where id=$2`,
      [state, row.execution_id],
    );
    const inserted = await client.query<{ decided_at: string }>(
      `insert into gateway_audit_log(
         team_id,member_id,service_identity_id,subject_binding_id,connection_id,
         execution_id,approval_id,event,correlation_id
       ) values($1,$2,$3,$4,$5,$6,$7,$8,$9)
       returning created_at decided_at`,
      [ctx.teamId,row.member_id,row.service_identity_id,row.subject_binding_id,
       row.connection_id,row.execution_id,approvalId,
       decision === "approve" ? "approval_approved" : "approval_denied",correlationId],
    );
    return {
      expired: false as const,
      approvalId,
      executionId: row.execution_id,
      status,
      decidedAt: inserted.rows[0].decided_at,
    };
  });
  if (outcome.expired)
    throw new GatewayAdminError("gateway_approval_expired", 410);
  return {
    approvalId: outcome.approvalId,
    executionId: outcome.executionId,
    status: outcome.status,
    decidedAt: outcome.decidedAt,
  };
}

export type GatewayPolicyInput = {
  subject:
    | { type: "actor"; memberId: string }
    | { type: "role"; role: "admin" | "lead" | "member" }
    | { type: "tier"; tier: "team" | "external" }
    | { type: "team" };
  tool: string;
  resource: string;
  effect: "block" | "require_approval" | "allow";
  priority: number;
  enabled: boolean;
  correlationId: string;
};

function validatePolicy(input: GatewayPolicyInput) {
  if (
    !Number.isInteger(input.priority) ||
    input.priority < -2_147_483_648 ||
    input.priority > 2_147_483_647 ||
    (input.tool !== "*" && !GATEWAY_TOOLS.some((tool) => tool === input.tool)) ||
    !["block", "require_approval", "allow"].includes(input.effect)
  )
    throw new GatewayAdminError("gateway_invalid_request", 400);
  if (input.resource === "github.repository:*") return;
  const resource = /^github\.repository:([^/]+)\/(.+)$/.exec(input.resource);
  if (!resource) throw new GatewayAdminError("gateway_invalid_request", 400);
  try {
    const normalized = normalizeGatewayArgs("github.repository.get", {
      owner: resource[1],
      repo: resource[2],
    });
    if (
      `github.repository:${normalized.owner}/${normalized.repo}` !== input.resource
    )
      throw new Error("not canonical");
  } catch {
    throw new GatewayAdminError("gateway_invalid_request", 400);
  }
}

async function policyColumns(
  client: import("pg").PoolClient,
  ctx: GatewayAdminContext,
  input: GatewayPolicyInput,
) {
  validatePolicy(input);
  let actor: string | null = null;
  if (input.subject.type === "actor") {
    const member = await client.query<{ actor_handle: string }>(
      `select actor_handle from members where id=$1 and team_id=$2`,
      [input.subject.memberId, ctx.teamId],
    );
    if (!member.rows[0]) throw new GatewayAdminError("gateway_not_found", 404);
    actor = member.rows[0].actor_handle;
  }
  return {
    actor,
    role: input.subject.type === "role" ? input.subject.role : null,
    tier: input.subject.type === "tier" ? input.subject.tier : null,
    action: `gateway.aios-github-readonly.${input.tool}`,
    effect: input.effect === "block" ? "deny" : input.effect,
  };
}

const gatewayPolicySelect = `select id,priority,subject_role::text "subjectRole",
  subject_tier::text "subjectTier",subject_actor "subjectActor",
  replace(action,'gateway.aios-github-readonly.','') tool,resource,
  case when effect='deny' then 'block' else effect::text end effect,
  enabled,created_at "createdAt",updated_at "updatedAt"
  from policies`;

export async function listGatewayAdminPolicies(ctx: GatewayAdminContext) {
  return withTransaction(async (client) => (
    await client.query(
      `${gatewayPolicySelect} where team_id=$1
        and action like 'gateway.aios-github-readonly.%' order by priority desc,id`,
      [ctx.teamId],
    )
  ).rows);
}

export async function createGatewayAdminPolicy(
  ctx: GatewayAdminContext,
  input: GatewayPolicyInput,
) {
  return withTransaction(async (client) => {
    const cols = await policyColumns(client, ctx, input);
    const result = await client.query(
      `insert into policies(team_id,priority,subject_role,subject_tier,subject_actor,
        action,resource,effect,enabled,created_by)
       values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`,
      [ctx.teamId,input.priority,cols.role,cols.tier,cols.actor,cols.action,
      input.resource,cols.effect,input.enabled,ctx.memberId],
    );
    await client.query(
      `insert into gateway_audit_log(
         team_id,member_id,event,policy_rule_id,correlation_id
       ) values($1,$2,'policy_created',$3,$4)`,
      [ctx.teamId,ctx.memberId,result.rows[0].id,input.correlationId],
    );
    return (await client.query(
      `${gatewayPolicySelect} where id=$1 and team_id=$2`,
      [result.rows[0].id, ctx.teamId],
    )).rows[0];
  });
}

export async function updateGatewayAdminPolicy(
  ctx: GatewayAdminContext,
  policyId: string,
  input: GatewayPolicyInput,
) {
  return withTransaction(async (client) => {
    const cols = await policyColumns(client, ctx, input);
    const changed = await client.query(
      `update policies set priority=$1,subject_role=$2,subject_tier=$3,
         subject_actor=$4,action=$5,resource=$6,effect=$7,enabled=$8,updated_at=now()
       where id=$9 and team_id=$10 and action like 'gateway.aios-github-readonly.%'
       returning id`,
      [input.priority,cols.role,cols.tier,cols.actor,cols.action,input.resource,
       cols.effect,input.enabled,policyId,ctx.teamId],
    );
    if (!changed.rows[0]) throw new GatewayAdminError("gateway_not_found", 404);
    await client.query(
      `insert into gateway_audit_log(
         team_id,member_id,event,policy_rule_id,correlation_id
       ) values($1,$2,'policy_updated',$3,$4)`,
      [ctx.teamId,ctx.memberId,policyId,input.correlationId],
    );
    return (await client.query(
      `${gatewayPolicySelect} where id=$1 and team_id=$2`,
      [policyId, ctx.teamId],
    )).rows[0];
  });
}

export async function deleteGatewayAdminPolicy(
  ctx: GatewayAdminContext,
  policyId: string,
  correlationId: string,
) {
  return withTransaction(async (client) => {
    const deleted = await client.query(
      `delete from policies where id=$1 and team_id=$2
        and action like 'gateway.aios-github-readonly.%' returning id`,
      [policyId, ctx.teamId],
    );
    if (!deleted.rows[0]) throw new GatewayAdminError("gateway_not_found", 404);
    await client.query(
      `insert into gateway_audit_log(
         team_id,member_id,event,policy_rule_id,correlation_id
       ) values($1,$2,'policy_deleted',$3,$4)`,
      [ctx.teamId,ctx.memberId,policyId,correlationId],
    );
  });
}

export async function listGatewayCredentials(
  ctx: GatewayAdminContext,
  serviceIdentityId: string,
) {
  return withTransaction(async (client) => {
    const identity = await client.query(
      `select id from gateway_service_identities where id=$1 and team_id=$2`,
      [serviceIdentityId, ctx.teamId],
    );
    if (!identity.rows[0]) throw new GatewayAdminError("gateway_not_found", 404);
    return (await client.query(
      `select credential_id "credentialId",version,created_at "createdAt",
              expires_at "expiresAt",revoked_at "revokedAt",
              replaces_credential_id "replacesCredentialId"
         from gateway_service_credentials
        where service_identity_id=$1 and team_id=$2 order by version desc`,
      [serviceIdentityId, ctx.teamId],
    )).rows;
  });
}

function decodeCredential(credentialId: string, secret: string) {
  if (!/^[A-Za-z0-9_-]{22}$/.test(credentialId) || !/^[A-Za-z0-9_-]{43}$/.test(secret))
    throw new GatewayAdminError("gateway_invalid_request", 400);
  const id = Buffer.from(credentialId, "base64url");
  const bytes = Buffer.from(secret, "base64url");
  try {
    if (id.length !== 16 || id.toString("base64url") !== credentialId ||
        bytes.length !== 32 || bytes.toString("base64url") !== secret)
      throw new GatewayAdminError("gateway_invalid_request", 400);
    return bytes;
  } catch (error) {
    bytes.fill(0);
    throw error;
  } finally {
    id.fill(0);
  }
}

export async function rotateGatewayCredential(
  ctx: GatewayAdminContext,
  serviceIdentityId: string,
  input: {
    credentialId: string;
    secret: string;
    replacesCredentialId: string;
    correlationId: string;
    expiresAt?: string;
  },
) {
  const replacementBytes = Buffer.from(input.replacesCredentialId, "base64url");
  if (
    input.credentialId === input.replacesCredentialId ||
    !/^[A-Za-z0-9_-]{22}$/.test(input.replacesCredentialId) ||
    replacementBytes.length !== 16 ||
    replacementBytes.toString("base64url") !== input.replacesCredentialId
  ) {
    replacementBytes.fill(0);
    throw new GatewayAdminError("gateway_invalid_request", 400);
  }
  replacementBytes.fill(0);
  const bytes = decodeCredential(input.credentialId, input.secret);
  try {
    return await withTransaction(async (client) => {
      await client.query(
        `select pg_advisory_xact_lock(hashtextextended($1,408))`,
        [serviceIdentityId],
      );
      if (input.expiresAt) {
        const expiry = await client.query<{ valid: boolean }>(
          `select $1::timestamptz>now() valid`,
          [input.expiresAt],
        );
        if (!expiry.rows[0].valid)
          throw new GatewayAdminError("gateway_invalid_request", 400);
      }
      const prior = await client.query(
        `select id from gateway_service_credentials
          where service_identity_id=$1 and team_id=$2 and credential_id=$3 for update`,
        [serviceIdentityId, ctx.teamId, input.replacesCredentialId],
      );
      if (!prior.rows[0]) throw new GatewayAdminError("gateway_not_found", 404);
      const version = await client.query<{ next: number }>(
        `select coalesce(max(version),0)::int+1 next
           from gateway_service_credentials
          where service_identity_id=$1 and team_id=$2`,
        [serviceIdentityId, ctx.teamId],
      );
      const inserted = await client.query<{ id: string }>(
        `insert into gateway_service_credentials(
           team_id,service_identity_id,credential_id,version,secret_hash,
           replaces_credential_id,expires_at,created_by_member_id
         ) values($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
        [ctx.teamId,serviceIdentityId,input.credentialId,version.rows[0].next,
         sha256(bytes),input.replacesCredentialId,input.expiresAt ?? null,ctx.memberId],
      );
      await client.query(
        `insert into gateway_audit_log(team_id,service_identity_id,credential_row_id,
          event,correlation_id) values($1,$2,$3,'credential_rotated',$4)`,
        [ctx.teamId,serviceIdentityId,inserted.rows[0].id,input.correlationId],
      );
      return (await client.query(
        `select credential_id "credentialId",version,created_at "createdAt",
                expires_at "expiresAt",revoked_at "revokedAt",
                replaces_credential_id "replacesCredentialId"
           from gateway_service_credentials where id=$1`,
        [inserted.rows[0].id],
      )).rows[0];
    });
  } finally {
    bytes.fill(0);
  }
}

export async function revokeGatewayCredential(
  ctx: GatewayAdminContext,
  serviceIdentityId: string,
  credentialId: string,
  correlationId: string,
) {
  const client = await getPool().connect();
  try {
    await client.query(`select pg_advisory_lock(hashtextextended($1,407))`, [credentialId]);
    await client.query("BEGIN");
    const revoked = await client.query<{ id: string }>(
      `update gateway_service_credentials set revoked_at=coalesce(revoked_at,now())
        where credential_id=$1 and service_identity_id=$2 and team_id=$3
        returning id`,
      [credentialId, serviceIdentityId, ctx.teamId],
    );
    if (!revoked.rows[0]) throw new GatewayAdminError("gateway_not_found", 404);
    await client.query(
      `insert into gateway_audit_log(team_id,service_identity_id,credential_row_id,
       event,correlation_id) values($1,$2,$3,'credential_revoked',$4)
       on conflict do nothing`,
      [ctx.teamId,serviceIdentityId,revoked.rows[0].id,correlationId],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.query(`select pg_advisory_unlock(hashtextextended($1,407))`, [credentialId]).catch(() => undefined);
    client.release();
  }
}
