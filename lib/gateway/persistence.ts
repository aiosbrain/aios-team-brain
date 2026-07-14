import "server-only";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { withTransaction } from "@/lib/db/pg/tx";
import {
  GATEWAY_APPROVAL_TTL_MINUTES,
  GATEWAY_LEASE_TTL_SECONDS,
  GatewayPersistenceError,
  type AuthorizeDecision,
  type GatewayDecision,
} from "./types";

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const opaque = () => randomBytes(32).toString("base64url");

type Scope = {
  teamId: string;
  memberId: string;
  serviceIdentityId: string;
  executorTenantId: string;
  executorSubjectId: string;
};

export async function registerGatewayServiceIdentity(input: {
  teamId: string;
  environment: string;
  credentialId: string;
  credential: string;
  credentialVersion?: number;
  expiresAt?: string;
}): Promise<{ id: string }> {
  const id = randomUUID();
  await withTransaction(async (client) => {
    await client.query(
      `insert into gateway_service_identities
       (id, team_id, environment, credential_id, credential_hash, credential_version, expires_at)
       values ($1,$2,$3,$4,$5,$6,$7)`,
      [id, input.teamId, input.environment, input.credentialId, sha256(input.credential), input.credentialVersion ?? 1, input.expiresAt ?? null]
    );
  });
  return { id };
}

export async function bindExecutorSubject(input: Scope): Promise<{ id: string }> {
  const id = randomUUID();
  await withTransaction(async (client) => {
    const service = await client.query(
      `select s.id from gateway_service_identities s
       join members m on m.id=$3 and m.team_id=s.team_id
       where s.id=$1 and s.team_id=$2 and s.revoked_at is null
         and (s.expires_at is null or s.expires_at > now())
         and m.status='active' and m.tier='team'`,
      [input.serviceIdentityId, input.teamId, input.memberId]
    );
    if (!service.rowCount) throw new GatewayPersistenceError("gateway_scope_not_found");
    await client.query(
      `insert into executor_subject_bindings
       (id, team_id, member_id, service_identity_id, executor_tenant_id, executor_subject_id)
       values ($1,$2,$3,$4,$5,$6)`,
      [id, input.teamId, input.memberId, input.serviceIdentityId, input.executorTenantId, input.executorSubjectId]
    );
  });
  return { id };
}

export async function createGatewayConnection(input: {
  teamId: string;
  memberId: string;
  subjectBindingId: string;
  credentialCiphertext: string;
}): Promise<{ id: string; connectionRef: string }> {
  const id = randomUUID();
  const connectionRef = opaque();
  await withTransaction(async (client) => {
    const binding = await client.query<{ service_identity_id: string }>(
      `select b.service_identity_id from executor_subject_bindings b
       join gateway_service_identities s on s.id=b.service_identity_id and s.team_id=b.team_id
       join members m on m.id=b.member_id and m.team_id=b.team_id
       where b.id=$1 and b.team_id=$2 and b.member_id=$3 and b.revoked_at is null
         and (b.expires_at is null or b.expires_at > now())
         and s.revoked_at is null and (s.expires_at is null or s.expires_at > now())
         and m.status='active' and m.tier='team'`,
      [input.subjectBindingId, input.teamId, input.memberId]
    );
    if (!binding.rowCount) throw new GatewayPersistenceError("gateway_scope_not_found");
    await client.query(
      `insert into gateway_connections
       (id, connection_ref, team_id, member_id, service_identity_id, subject_binding_id, credential_ciphertext)
       values ($1,$2,$3,$4,$5,$6,$7)`,
      [id, connectionRef, input.teamId, input.memberId, binding.rows[0].service_identity_id,
       input.subjectBindingId, input.credentialCiphertext]
    );
  });
  return { id, connectionRef };
}

async function activeConnection(client: PoolClient, scope: Scope, connectionRef: string) {
  const result = await client.query<{ connection_id: string; subject_binding_id: string }>(
    `select c.id as connection_id, b.id as subject_binding_id
       from gateway_connections c
       join executor_subject_bindings b on b.id=c.subject_binding_id and b.team_id=c.team_id
       join gateway_service_identities s on s.id=b.service_identity_id and s.team_id=b.team_id
       join members m on m.id=c.member_id and m.team_id=c.team_id
      where c.connection_ref=$1 and c.team_id=$2 and c.member_id=$3
        and b.service_identity_id=$4 and b.executor_tenant_id=$5 and b.executor_subject_id=$6
        and c.provider='github' and c.enabled and c.revoked_at is null
        and b.revoked_at is null and (b.expires_at is null or b.expires_at > now())
        and s.revoked_at is null and (s.expires_at is null or s.expires_at > now())
        and m.status='active' and m.tier='team'`,
    [connectionRef, scope.teamId, scope.memberId, scope.serviceIdentityId, scope.executorTenantId, scope.executorSubjectId]
  );
  return result.rows[0] ?? null;
}

export async function issueResolutionLease(
  input: Scope & { connectionRef: string; audience: string; correlationId: string }
): Promise<{ lease: string; expiresAt: string }> {
  const lease = opaque();
  return withTransaction(async (client) => {
    const connection = await activeConnection(client, input, input.connectionRef);
    if (!connection) throw new GatewayPersistenceError("gateway_scope_not_found");
    const inserted = await client.query<{ expires_at: string }>(
      `insert into gateway_resolution_leases
       (lease_hash, audience, team_id, member_id, service_identity_id, subject_binding_id, connection_id, expires_at)
       values ($1,$2,$3,$4,$5,$6,$7,now()+($8::text || ' seconds')::interval)
       returning expires_at`,
      [sha256(lease), input.audience, input.teamId, input.memberId, input.serviceIdentityId,
       connection.subject_binding_id, connection.connection_id, GATEWAY_LEASE_TTL_SECONDS]
    );
    await client.query(
      `insert into gateway_audit_log
       (team_id, member_id, service_identity_id, subject_binding_id, connection_id, event, correlation_id)
       values ($1,$2,$3,$4,$5,'lease_issued',$6)`,
      [input.teamId, input.memberId, input.serviceIdentityId, connection.subject_binding_id,
       connection.connection_id, input.correlationId]
    );
    return { lease, expiresAt: inserted.rows[0].expires_at };
  });
}

export async function consumeLeaseAndCreateExecution(input: Scope & {
  lease: string;
  audience: string;
  executionId: string;
  encryptedRequestEnvelope: Buffer;
  toolkit: string;
  tool: string;
  requestHash: string;
  correlationId: string;
  idempotencyKey: string;
  decision: GatewayDecision;
  policyVersion?: string;
  policyRuleId?: string;
}): Promise<AuthorizeDecision> {
  return withTransaction(async (client) => {
    const leaseResult = await client.query<{ id: string; connection_id: string; subject_binding_id: string }>(
      `select l.id, l.connection_id, l.subject_binding_id
         from gateway_resolution_leases l
         join executor_subject_bindings b on b.id=l.subject_binding_id and b.team_id=l.team_id
         join gateway_connections c on c.id=l.connection_id and c.team_id=l.team_id
         join gateway_service_identities s on s.id=l.service_identity_id and s.team_id=l.team_id
         join members m on m.id=l.member_id and m.team_id=l.team_id
        where l.lease_hash=$1 and l.audience=$2 and l.team_id=$3 and l.member_id=$4
          and l.service_identity_id=$5 and b.executor_tenant_id=$6 and b.executor_subject_id=$7
          and l.consumed_at is null and l.revoked_at is null and l.expires_at > now()
          and b.revoked_at is null and (b.expires_at is null or b.expires_at > now())
          and c.enabled and c.revoked_at is null
          and (c.credential_expires_at is null or c.credential_expires_at > now())
          and s.revoked_at is null and (s.expires_at is null or s.expires_at > now())
          and m.status='active' and m.tier='team'
        for update of l`,
      [sha256(input.lease), input.audience, input.teamId, input.memberId, input.serviceIdentityId,
       input.executorTenantId, input.executorSubjectId]
    );
    const lease = leaseResult.rows[0];
    if (!lease) throw new GatewayPersistenceError("gateway_lease_invalid");

    const state = input.decision === "block" ? "blocked" : input.decision === "allow" ? "claimed" : "approval_required";
    await client.query(
      `insert into gateway_executions
       (id, team_id, member_id, service_identity_id, subject_binding_id, connection_id, lease_id,
        correlation_id, idempotency_key, toolkit, tool, request_hash, encrypted_request_envelope,
        decision, state, policy_version, policy_rule_id, claimed_at, claimed_by_correlation_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
               case when $14::text='allow' then now() else null end,
               case when $14::text='allow' then $8::uuid else null end)`,
      [input.executionId, input.teamId, input.memberId, input.serviceIdentityId, lease.subject_binding_id,
       lease.connection_id, lease.id, input.correlationId, input.idempotencyKey, input.toolkit, input.tool,
       input.requestHash, input.encryptedRequestEnvelope, input.decision, state,
       input.policyVersion ?? null, input.policyRuleId ?? null]
    );
    await client.query(`update gateway_resolution_leases set consumed_at=now() where id=$1`, [lease.id]);

    let approval: { id: string; expires_at: string } | undefined;
    if (input.decision === "require_approval") {
      const approvalId = randomUUID();
      const result = await client.query<{ id: string; expires_at: string }>(
        `insert into gateway_approvals (id, team_id, execution_id, expires_at)
         values ($1,$2,$3,now()+($4::text || ' minutes')::interval) returning id, expires_at`,
        [approvalId, input.teamId, input.executionId, GATEWAY_APPROVAL_TTL_MINUTES]
      );
      approval = result.rows[0];
    }

    const event = input.decision === "block" ? "decision_blocked"
      : input.decision === "allow" ? "decision_allowed" : "decision_approval_required";
    await client.query(
      `insert into gateway_audit_log
       (team_id, member_id, service_identity_id, subject_binding_id, connection_id, execution_id,
        approval_id, event, toolkit, tool, request_hash, policy_version, policy_rule_id, decision,
        correlation_id, idempotency_key)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [input.teamId, input.memberId, input.serviceIdentityId, lease.subject_binding_id,
       lease.connection_id, input.executionId, approval?.id ?? null, event, input.toolkit, input.tool,
       input.requestHash, input.policyVersion ?? null, input.policyRuleId ?? null, input.decision,
       input.correlationId, input.idempotencyKey]
    );

    if (input.decision === "block") return { decision: "block", executionId: input.executionId };
    if (input.decision === "allow") return { decision: "allow", executionId: input.executionId };
    return { decision: "require_approval", executionId: input.executionId,
      approvalId: approval!.id, expiresAt: approval!.expires_at };
  });
}

export async function approveGatewayExecution(input: Scope & {
  executionId: string;
  approverMemberId: string;
  correlationId: string;
}): Promise<void> {
  await withTransaction(async (client) => {
    const approval = await client.query<{ id: string }>(
      `select a.id from gateway_approvals a
       join gateway_executions e on e.id=a.execution_id and e.team_id=a.team_id
       join executor_subject_bindings b on b.id=e.subject_binding_id and b.team_id=e.team_id
       join gateway_service_identities s on s.id=e.service_identity_id and s.team_id=e.team_id
       join gateway_connections c on c.id=e.connection_id and c.team_id=e.team_id
       join members m on m.id=e.member_id and m.team_id=e.team_id
       where e.id=$1 and e.team_id=$2 and e.member_id=$3 and e.service_identity_id=$4
         and b.executor_tenant_id=$5 and b.executor_subject_id=$6
         and a.status='pending' and a.expires_at > now()
         and b.revoked_at is null and (b.expires_at is null or b.expires_at > now())
         and s.revoked_at is null and (s.expires_at is null or s.expires_at > now())
         and c.enabled and c.revoked_at is null
         and (c.credential_expires_at is null or c.credential_expires_at > now())
         and m.status='active' and m.tier='team'
       for update of a, e`,
      [input.executionId, input.teamId, input.memberId, input.serviceIdentityId,
       input.executorTenantId, input.executorSubjectId]
    );
    if (!approval.rows[0]) throw new GatewayPersistenceError("gateway_approval_not_pending");
    await client.query(
      `update gateway_approvals set status='approved', approver_member_id=$1, decided_at=now(), updated_at=now()
       where id=$2`, [input.approverMemberId, approval.rows[0].id]
    );
    await client.query(`update gateway_executions set state='approved', updated_at=now() where id=$1`, [input.executionId]);
    await client.query(
      `insert into gateway_audit_log
       (team_id, member_id, service_identity_id, execution_id, approval_id, event, correlation_id)
       values ($1,$2,$3,$4,$5,'approval_approved',$6)`,
      [input.teamId, input.memberId, input.serviceIdentityId, input.executionId, approval.rows[0].id, input.correlationId]
    );
  });
}

export async function claimApprovedExecution(input: Scope & {
  executionId: string;
  toolkit: string;
  correlationId: string;
  idempotencyKey: string;
}): Promise<
  | { status: "claimed"; executionId: string }
  | { status: "settled"; executionId: string; result: "already_claimed" }
> {
  return withTransaction(async (client) => {
    const execution = await client.query<{ id: string; subject_binding_id: string; connection_id: string }>(
      `select e.id, e.subject_binding_id, e.connection_id
       from gateway_executions e
       join gateway_approvals a on a.execution_id=e.id and a.team_id=e.team_id
       join executor_subject_bindings b on b.id=e.subject_binding_id and b.team_id=e.team_id
       join gateway_service_identities s on s.id=e.service_identity_id and s.team_id=e.team_id
       join gateway_connections c on c.id=e.connection_id and c.team_id=e.team_id
       join members m on m.id=e.member_id and m.team_id=e.team_id
       where e.id=$1 and e.team_id=$2 and e.member_id=$3 and e.service_identity_id=$4
         and b.executor_tenant_id=$5 and b.executor_subject_id=$6 and e.toolkit=$7
         and e.state='approved' and a.status='approved' and a.expires_at > now()
         and b.revoked_at is null and (b.expires_at is null or b.expires_at > now())
         and s.revoked_at is null and (s.expires_at is null or s.expires_at > now())
         and c.enabled and c.revoked_at is null
         and (c.credential_expires_at is null or c.credential_expires_at > now())
         and m.status='active' and m.tier='team'
       for update of e`,
      [input.executionId, input.teamId, input.memberId, input.serviceIdentityId,
       input.executorTenantId, input.executorSubjectId, input.toolkit]
    );
    const row = execution.rows[0];
    if (!row) {
      const settled = await client.query(
        `select e.id from gateway_executions e
         join executor_subject_bindings b on b.id=e.subject_binding_id and b.team_id=e.team_id
         where e.id=$1 and e.team_id=$2 and e.member_id=$3 and e.service_identity_id=$4
           and b.executor_tenant_id=$5 and b.executor_subject_id=$6 and e.toolkit=$7
           and e.state='claimed'`,
        [input.executionId, input.teamId, input.memberId, input.serviceIdentityId,
         input.executorTenantId, input.executorSubjectId, input.toolkit]
      );
      if (settled.rowCount) {
        return { status: "settled", executionId: input.executionId, result: "already_claimed" };
      }
      throw new GatewayPersistenceError("gateway_execution_not_claimable");
    }
    await client.query(
      `update gateway_executions set state='claimed', claimed_at=now(), claimed_by_correlation_id=$1, updated_at=now()
       where id=$2`, [input.correlationId, input.executionId]
    );
    await client.query(
      `insert into gateway_audit_log
       (team_id, member_id, service_identity_id, subject_binding_id, connection_id, execution_id,
        event, toolkit, correlation_id, idempotency_key)
       values ($1,$2,$3,$4,$5,$6,'execution_claimed',$7,$8,$9)`,
      [input.teamId, input.memberId, input.serviceIdentityId, row.subject_binding_id, row.connection_id,
       input.executionId, input.toolkit, input.correlationId, input.idempotencyKey]
    );
    return { status: "claimed", executionId: input.executionId };
  });
}

export async function findGatewayConnection(input: Scope & { connectionRef: string }) {
  return withTransaction((client) => activeConnection(client, input, input.connectionRef));
}
