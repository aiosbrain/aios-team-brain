import "server-only";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { PoolClient } from "pg";
import { getPool } from "@/lib/db/pg/pool";
import { withTransaction } from "@/lib/db/pg/tx";
import { canonicalize } from "./canonical";
import {
  GATEWAY_APPROVAL_TTL_MINUTES,
  GATEWAY_LEASE_TTL_SECONDS,
  GatewayPersistenceError,
  type AuthorizeDecision,
  type GatewayDecision,
} from "./types";
import { evaluateGatewayPolicy, gatewayPolicyVersion, loadGatewayPolicies } from "./policy";
export { GatewayPersistenceError } from "./types";

const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
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
  if (!/^[A-Za-z0-9_-]{22}$/.test(input.credentialId) || !/^[A-Za-z0-9_-]{43}$/.test(input.credential)) {
    throw new Error("gateway_service_credential_invalid");
  }
  const credentialIdBytes = Buffer.from(input.credentialId, "base64url");
  const credentialBytes = Buffer.from(input.credential, "base64url");
  try {
    if (credentialIdBytes.length !== 16 || credentialIdBytes.toString("base64url") !== input.credentialId || credentialBytes.length !== 32 || credentialBytes.toString("base64url") !== input.credential) {
      throw new Error("gateway_service_credential_invalid");
    }
    const id = randomUUID();
    await withTransaction(async (client) => {
      const digest = sha256(credentialBytes);
      await client.query(
        `insert into gateway_service_identities
         (id, team_id, environment, credential_id, credential_hash, credential_version, expires_at)
         values ($1,$2,$3,$4,$5,$6,$7)`,
        [id, input.teamId, input.environment, input.credentialId, digest,
         input.credentialVersion ?? 1, input.expiresAt ?? null],
      );
      await client.query(
        `insert into gateway_service_credentials
         (team_id,service_identity_id,credential_id,version,secret_hash,expires_at)
         values ($1,$2,$3,$4,$5,$6)`,
        [input.teamId, id, input.credentialId, input.credentialVersion ?? 1,
         digest, input.expiresAt ?? null],
      );
    });
    return { id };
  } finally {
    credentialIdBytes.fill(0);
    credentialBytes.fill(0);
  }
}

export type AuthenticatedGatewayService = {
  id: string;
  teamId: string;
  environment: string;
  credentialId: string;
  credentialVersion: number;
  credentialRowId: string;
  secretBytes: Buffer;
};

export class GatewayAuthenticationError extends Error {
  readonly code = "gateway_unauthorized";
  constructor() {
    super("Unauthorized");
  }
}

export async function authenticateGatewayServiceCredential(
  authorization: string | null,
): Promise<AuthenticatedGatewayService> {
  const match = /^Bearer aios_gw_([A-Za-z0-9_-]{22})_([A-Za-z0-9_-]{43})$/.exec(
    authorization ?? "",
  );
  if (!match) throw new GatewayAuthenticationError();
  const credentialIdBytes = Buffer.from(match[1], "base64url");
  const secretBytes = Buffer.from(match[2], "base64url");
  if (
    credentialIdBytes.length !== 16 ||
    credentialIdBytes.toString("base64url") !== match[1] ||
    secretBytes.length !== 32 ||
    secretBytes.toString("base64url") !== match[2]
  ) {
    credentialIdBytes.fill(0);
    secretBytes.fill(0);
    throw new GatewayAuthenticationError();
  }
  const candidate = createHash("sha256").update(secretBytes).digest();
  try {
    return await withTransaction(async (client) => {
      const result = await client.query<{
        id: string;
        team_id: string;
        environment: string;
        credential_row_id: string;
        credential_id: string;
        secret_hash: string;
        version: number;
      }>(
        `select s.id, s.team_id, s.environment, c.id credential_row_id,
                c.credential_id, c.secret_hash, c.version
           from gateway_service_credentials c
           join gateway_service_identities s
             on s.id=c.service_identity_id and s.team_id=c.team_id
          where c.credential_id=$1 and c.revoked_at is null
            and c.activated_at <= now() and (c.expires_at is null or c.expires_at > now())
            and s.revoked_at is null and (s.expires_at is null or s.expires_at > now())
          for update of c`,
        [match[1]],
      );
      const row = result.rows[0];
      const stored =
        row && /^[0-9a-f]{64}$/.test(row.secret_hash)
          ? Buffer.from(row.secret_hash, "hex")
          : Buffer.alloc(32);
      try {
        const matches =
          stored.length === candidate.length &&
          timingSafeEqual(stored, candidate);
        if (!row || !matches) throw new GatewayAuthenticationError();
        await client.query(
          `update gateway_service_credentials set last_authenticated_at=now() where id=$1`,
          [row.credential_row_id],
        );
        return {
          id: row.id,
          teamId: row.team_id,
          environment: row.environment,
          credentialId: row.credential_id,
          credentialVersion: row.version,
          credentialRowId: row.credential_row_id,
          secretBytes,
        };
      } finally {
        candidate.fill(0);
        stored.fill(0);
        credentialIdBytes.fill(0);
      }
    });
  } catch (error) {
    secretBytes.fill(0);
    throw error;
  } finally {
    candidate.fill(0);
    credentialIdBytes.fill(0);
  }
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
    const policyVersion = gatewayPolicyVersion(await loadGatewayPolicies(client, input.teamId));
    const inserted = await client.query<{ expires_at: string }>(
      `insert into gateway_resolution_leases
       (lease_hash, audience, team_id, member_id, service_identity_id, subject_binding_id, connection_id, policy_version, expires_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,now()+($9::text || ' seconds')::interval)
       returning expires_at`,
      [sha256(lease), input.audience, input.teamId, input.memberId, input.serviceIdentityId,
       connection.subject_binding_id, connection.connection_id, policyVersion, GATEWAY_LEASE_TTL_SECONDS]
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
    const leaseResult = await client.query<{
      id: string;
      connection_id: string;
      subject_binding_id: string;
      actor_handle: string;
      role: string;
      tier: string;
    }>(
      `select l.id, l.connection_id, l.subject_binding_id,
              m.actor_handle,m.role::text role,m.tier::text tier
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
        actor_snapshot,role_snapshot,tier_snapshot,policy_resource,request_envelope_hash,
        decision, state, policy_version, policy_rule_id, claimed_at, claimed_by_correlation_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
               $19,$20,$21,$22,
               case when $19::text='allow' then now() else null end,
               case when $19::text='allow' then $8::uuid else null end)`,
      [input.executionId, input.teamId, input.memberId, input.serviceIdentityId, lease.subject_binding_id,
       lease.connection_id, lease.id, input.correlationId, input.idempotencyKey, input.toolkit, input.tool,
       input.requestHash, input.encryptedRequestEnvelope,
       lease.actor_handle,lease.role,lease.tier,"github.repository:*",
       sha256(input.encryptedRequestEnvelope),
       input.decision, state,
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
    const approval = await client.query<{ id: string; subject_binding_id: string; connection_id: string }>(
      `select a.id, e.subject_binding_id, e.connection_id from gateway_approvals a
       join gateway_executions e on e.id=a.execution_id and e.team_id=a.team_id
       join executor_subject_bindings b on b.id=e.subject_binding_id and b.team_id=e.team_id
       join gateway_service_identities s on s.id=e.service_identity_id and s.team_id=e.team_id
       join gateway_connections c on c.id=e.connection_id and c.team_id=e.team_id
       join members m on m.id=e.member_id and m.team_id=e.team_id
       join members approver on approver.id=$7 and approver.team_id=e.team_id
       where e.id=$1 and e.team_id=$2 and e.member_id=$3 and e.service_identity_id=$4
         and b.executor_tenant_id=$5 and b.executor_subject_id=$6
         and a.status='pending' and a.expires_at > now()
         and b.revoked_at is null and (b.expires_at is null or b.expires_at > now())
         and s.revoked_at is null and (s.expires_at is null or s.expires_at > now())
         and c.enabled and c.revoked_at is null
         and (c.credential_expires_at is null or c.credential_expires_at > now())
         and m.status='active' and m.tier='team'
         and approver.status='active' and approver.tier='team'
       for update of a, e, approver`,
      [input.executionId, input.teamId, input.memberId, input.serviceIdentityId,
       input.executorTenantId, input.executorSubjectId, input.approverMemberId]
    );
    if (!approval.rows[0]) throw new GatewayPersistenceError("gateway_approval_not_pending");
    await client.query(
      `update gateway_approvals set status='approved', approver_member_id=$1, decided_at=now(), updated_at=now()
       where id=$2`, [input.approverMemberId, approval.rows[0].id]
    );
    await client.query(`update gateway_executions set state='approved', updated_at=now() where id=$1`, [input.executionId]);
    await client.query(
      `insert into gateway_audit_log
       (team_id, member_id, service_identity_id, subject_binding_id, connection_id,
        execution_id, approval_id, event, correlation_id)
       values ($1,$2,$3,$4,$5,$6,$7,'approval_approved',$8)`,
      [input.teamId, input.memberId, input.serviceIdentityId, approval.rows[0].subject_binding_id,
       approval.rows[0].connection_id, input.executionId, approval.rows[0].id, input.correlationId]
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

export type ResumeClaimPayload = {
  executionId: string;
  toolkit: string;
  tool: string;
  requestHash: string;
  encryptedRequestEnvelope: Buffer;
  credentialCiphertext: string;
  credentialExpiresAt: string | null;
};

export type ResumeClaimResult<T> =
  | { status: "claimed"; value: T }
  | {
      status: "already_claimed";
      executionId: string;
      state: "claimed" | "succeeded" | "failed";
    };

/**
 * Claim an approved execution and commit its audit record before exposing any
 * ciphertext to the request-local callback. A session advisory lock remains held
 * across that callback; credential revocation takes the same lock.
 */
export async function resumeClaimGatewayExecution<T>(input: {
  service: AuthenticatedGatewayService;
  executionId: string;
  executorTenantId: string;
  executorSubjectId: string;
  toolkit: string;
  tool: string;
  requestHash: string;
  correlationId: string;
  idempotencyKey: string;
  useWinningPayload: (payload: ResumeClaimPayload) => Promise<T> | T;
}): Promise<ResumeClaimResult<T>> {
  const client = await getPool().connect();
  let inTransaction = false;
  let locked = false;
  let committedError: GatewayPersistenceError | null = null;
  try {
    await client.query(
      `select pg_advisory_lock(hashtextextended($1, 407))`,
      [input.service.credentialId],
    );
    locked = true;
    await client.query("BEGIN");
    inTransaction = true;
    const result = await client.query<{
      id: string;
      team_id: string;
      member_id: string;
      service_identity_id: string;
      subject_binding_id: string;
      connection_id: string;
      toolkit: string;
      tool: string;
      request_hash: string;
      encrypted_request_envelope: Buffer;
      request_envelope_hash: string;
      actor_snapshot: string;
      role_snapshot: "admin" | "lead" | "member";
      tier_snapshot: "team" | "external";
      policy_resource: string;
      state: string;
      resume_fingerprint: string | null;
      claim_idempotency_key: string | null;
      approval_id: string;
      approval_status: string;
      approval_expires_at: string;
      approval_expired: boolean;
      executor_tenant_id: string;
      executor_subject_id: string;
      member_actor: string;
      member_role: "admin" | "lead" | "member";
      member_tier: "team" | "external";
      member_status: string;
      binding_revoked_at: string | null;
      binding_expires_at: string | null;
      binding_active: boolean;
      connection_enabled: boolean;
      connection_revoked_at: string | null;
      connection_provider: string;
      connection_credential_expires_at: string | null;
      connection_active: boolean;
      credential_ciphertext: string;
      credential_expires_at: string | null;
      credential_active: boolean;
      identity_active: boolean;
    }>(
      `select e.id,e.team_id,e.member_id,e.service_identity_id,e.subject_binding_id,
              e.connection_id,e.toolkit,e.tool,e.request_hash,e.encrypted_request_envelope,
              e.request_envelope_hash,e.actor_snapshot,e.role_snapshot,e.tier_snapshot,
              e.policy_resource,e.state,e.resume_fingerprint,e.claim_idempotency_key,
              a.id approval_id,a.status approval_status,a.expires_at approval_expires_at,
              (a.expires_at<=now()) approval_expired,
              b.executor_tenant_id,b.executor_subject_id,b.revoked_at binding_revoked_at,
              b.expires_at binding_expires_at,
              (b.revoked_at is null and (b.expires_at is null or b.expires_at>now())) binding_active,
              m.actor_handle member_actor,
              m.role::text member_role,m.tier::text member_tier,m.status::text member_status,
              c.enabled connection_enabled,c.revoked_at connection_revoked_at,
              c.provider connection_provider,c.credential_expires_at connection_credential_expires_at,
              (c.enabled and c.revoked_at is null and
                (c.credential_expires_at is null or c.credential_expires_at>now())) connection_active,
              c.credential_ciphertext,c.credential_expires_at,
              (gc.revoked_at is null and gc.activated_at<=now()
                and (gc.expires_at is null or gc.expires_at>now())) credential_active,
              (s.revoked_at is null and (s.expires_at is null or s.expires_at>now())) identity_active
         from gateway_executions e
         join gateway_approvals a on a.execution_id=e.id and a.team_id=e.team_id
         join executor_subject_bindings b on b.id=e.subject_binding_id and b.team_id=e.team_id
         join members m on m.id=e.member_id and m.team_id=e.team_id
         join gateway_connections c on c.id=e.connection_id and c.team_id=e.team_id
         join gateway_service_identities s on s.id=e.service_identity_id and s.team_id=e.team_id
         join gateway_service_credentials gc
           on gc.id=$5 and gc.service_identity_id=e.service_identity_id and gc.team_id=e.team_id
        where e.id=$1 and e.service_identity_id=$2
          and b.executor_tenant_id=$3 and b.executor_subject_id=$4
        for update of e,a,gc`,
      [
        input.executionId,
        input.service.id,
        input.executorTenantId,
        input.executorSubjectId,
        input.service.credentialRowId,
      ],
    );
    const row = result.rows[0];
    if (!row) {
      await client.query("ROLLBACK");
      inTransaction = false;
      throw new GatewayPersistenceError("gateway_not_found");
    }
    const fingerprint = sha256(
      canonicalize({
        credentialId: input.service.credentialId,
        credentialVersion: input.service.credentialVersion,
        executionId: input.executionId,
        executorSubjectId: input.executorSubjectId,
        executorTenantId: input.executorTenantId,
        memberId: row.member_id,
        requestHash: input.requestHash,
        serviceIdentityId: input.service.id,
        teamId: row.team_id,
        tool: input.tool,
        toolkit: input.toolkit,
      }),
    );
    if (["claimed", "succeeded", "failed"].includes(row.state)) {
      if (
        row.resume_fingerprint !== fingerprint ||
        row.claim_idempotency_key !== input.idempotencyKey
      ) {
        await client.query("ROLLBACK");
        inTransaction = false;
        throw new GatewayPersistenceError("gateway_idempotency_conflict");
      }
      await client.query("COMMIT");
      inTransaction = false;
      return {
        status: "already_claimed",
        executionId: row.id,
        state: row.state as "claimed" | "succeeded" | "failed",
      };
    }
    if (row.approval_expired) {
      await client.query(
        `update gateway_approvals set status='expired',decided_at=coalesce(decided_at,now()),
           decision_correlation_id=coalesce(decision_correlation_id,$1),updated_at=now()
         where id=$2 and status in ('pending','approved')`,
        [input.correlationId, row.approval_id],
      );
      await client.query(
        `update gateway_executions set state='expired',updated_at=now()
          where id=$1 and state in ('approval_required','approved')`,
        [row.id],
      );
      await client.query(
        `insert into gateway_audit_log(
           team_id,member_id,service_identity_id,subject_binding_id,connection_id,
           execution_id,approval_id,event,correlation_id
         ) values($1,$2,$3,$4,$5,$6,$7,'approval_expired',$8)
         on conflict do nothing`,
        [row.team_id,row.member_id,row.service_identity_id,row.subject_binding_id,
         row.connection_id,row.id,row.approval_id,input.correlationId],
      );
      committedError = new GatewayPersistenceError("gateway_approval_expired");
    } else {
      const resource = /^github\.repository:([^/]+)\/(.+)$/.exec(row.policy_resource);
      const currentPolicy = resource
        ? evaluateGatewayPolicy(await loadGatewayPolicies(client, row.team_id), {
            principal: {
              actor: row.member_actor,
              role: row.member_role,
              tier: row.member_tier,
            },
            tool: input.tool,
            owner: resource[1],
            repo: resource[2],
          })
        : null;
      const eligible =
        row.state === "approved" &&
        row.approval_status === "approved" &&
        row.toolkit === input.toolkit &&
        row.tool === input.tool &&
        row.request_hash === input.requestHash &&
        row.request_envelope_hash === sha256(row.encrypted_request_envelope) &&
        row.actor_snapshot === row.member_actor &&
        row.role_snapshot === row.member_role &&
        row.tier_snapshot === row.member_tier &&
        row.member_status === "active" &&
        row.member_tier === "team" &&
        row.binding_active &&
        row.connection_active &&
        row.connection_provider === "github" &&
        row.credential_active &&
        row.identity_active &&
        currentPolicy !== null &&
        currentPolicy.decision !== "block";
      if (!eligible) {
        await client.query(
          `update gateway_approvals set status='cancelled',decided_at=coalesce(decided_at,now()),
             decision_correlation_id=coalesce(decision_correlation_id,$1),updated_at=now()
           where id=$2 and status in ('pending','approved')`,
          [input.correlationId, row.approval_id],
        );
        await client.query(
          `update gateway_executions set state='cancelled',updated_at=now()
            where id=$1 and state in ('approval_required','approved')`,
          [row.id],
        );
        await client.query(
          `insert into gateway_audit_log(
             team_id,member_id,service_identity_id,subject_binding_id,connection_id,
             execution_id,approval_id,event,correlation_id
           ) values($1,$2,$3,$4,$5,$6,$7,'approval_cancelled',$8)
           on conflict do nothing`,
          [row.team_id,row.member_id,row.service_identity_id,row.subject_binding_id,
           row.connection_id,row.id,row.approval_id,input.correlationId],
        );
        committedError = new GatewayPersistenceError("gateway_scope_not_found");
      } else {
        await client.query(
          `update gateway_executions
              set state='claimed',claimed_at=now(),claimed_by_correlation_id=$1,
                  resume_fingerprint=$2,claim_idempotency_key=$3,claimed_credential_id=$4,
                  updated_at=now()
            where id=$5 and state='approved'`,
          [input.correlationId,fingerprint,input.idempotencyKey,
           input.service.credentialRowId,row.id],
        );
        await client.query(
          `insert into gateway_audit_log(
             team_id,member_id,service_identity_id,credential_row_id,subject_binding_id,
             connection_id,execution_id,approval_id,event,toolkit,tool,request_hash,
             correlation_id,idempotency_key
           ) values($1,$2,$3,$4,$5,$6,$7,$8,'execution_claimed',$9,$10,$11,$12,$13)`,
          [row.team_id,row.member_id,row.service_identity_id,input.service.credentialRowId,
           row.subject_binding_id,row.connection_id,row.id,row.approval_id,row.toolkit,
           row.tool,row.request_hash,input.correlationId,input.idempotencyKey],
        );
      }
    }
    await client.query("COMMIT");
    inTransaction = false;
    if (committedError) throw committedError;
    return {
      status: "claimed",
      value: await input.useWinningPayload({
        executionId: row.id,
        toolkit: row.toolkit,
        tool: row.tool,
        requestHash: row.request_hash,
        encryptedRequestEnvelope: row.encrypted_request_envelope,
        credentialCiphertext: row.credential_ciphertext,
        credentialExpiresAt: row.credential_expires_at,
      }),
    };
  } catch (error) {
    if (inTransaction) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // original error wins
      }
    }
    throw error;
  } finally {
    if (locked) {
      try {
        await client.query(
          `select pg_advisory_unlock(hashtextextended($1, 407))`,
          [input.service.credentialId],
        );
      } catch {
        // releasing the client also releases session locks
      }
    }
    client.release();
  }
}

export async function findGatewayConnection(input: Scope & { connectionRef: string }) {
  return withTransaction((client) => activeConnection(client, input, input.connectionRef));
}

/** Resolve all request authority from stored bindings; callers provide no team/member/tier authority. */
export async function resolveAndIssueLease(input: {
  serviceIdentityId: string;
  executorTenantId: string;
  executorSubjectId: string;
  connectionRef: string;
  audience: string;
  correlationId: string;
}): Promise<{ lease: string; expiresAt: string }> {
  const leaseValue = opaque();
  return withTransaction(async (client) => {
    const scope = await client.query<{
      team_id: string;
      member_id: string;
      subject_binding_id: string;
      connection_id: string;
    }>(
      `select c.team_id, c.member_id, b.id subject_binding_id, c.id connection_id
         from gateway_connections c
         join executor_subject_bindings b on b.id=c.subject_binding_id and b.team_id=c.team_id and b.member_id=c.member_id
         join gateway_service_identities s on s.id=b.service_identity_id and s.team_id=b.team_id
         join members m on m.id=c.member_id and m.team_id=c.team_id
        where s.id=$1 and b.executor_tenant_id=$2 and b.executor_subject_id=$3 and c.connection_ref=$4
          and c.provider='github' and c.enabled and c.revoked_at is null and (c.credential_expires_at is null or c.credential_expires_at > now())
          and b.revoked_at is null and (b.expires_at is null or b.expires_at > now())
          and s.revoked_at is null and (s.expires_at is null or s.expires_at > now())
          and m.status='active' and m.tier='team'`,
      [
        input.serviceIdentityId,
        input.executorTenantId,
        input.executorSubjectId,
        input.connectionRef,
      ],
    );
    const row = scope.rows[0];
    if (!row) throw new GatewayPersistenceError("gateway_scope_not_found");
    const policyVersion = gatewayPolicyVersion(
      await loadGatewayPolicies(client, row.team_id),
    );
    const inserted = await client.query<{ expires_at: string }>(
      `insert into gateway_resolution_leases
       (lease_hash,audience,team_id,member_id,service_identity_id,subject_binding_id,connection_id,policy_version,expires_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,now()+interval '30 seconds') returning expires_at`,
      [
        sha256(leaseValue),
        input.audience,
        row.team_id,
        row.member_id,
        input.serviceIdentityId,
        row.subject_binding_id,
        row.connection_id,
        policyVersion,
      ],
    );
    await client.query(
      `insert into gateway_audit_log (team_id,member_id,service_identity_id,subject_binding_id,connection_id,event,correlation_id) values ($1,$2,$3,$4,$5,'lease_issued',$6)`,
      [
        row.team_id,
        row.member_id,
        input.serviceIdentityId,
        row.subject_binding_id,
        row.connection_id,
        input.correlationId,
      ],
    );
    return { lease: leaseValue, expiresAt: inserted.rows[0].expires_at };
  });
}

export class GatewayConflictError extends Error {
  constructor(
    readonly code:
      | "gateway_policy_stale"
      | "gateway_allow_already_committed"
      | "gateway_idempotency_conflict"
      | "gateway_outcome_conflict",
  ) {
    super(code);
  }
}

export async function authorizeLeaseAndCreateExecution(input: {
  serviceIdentityId: string;
  executionId: string;
  lease: string;
  audience: string;
  toolkit: string;
  tool: string;
  normalizedArgs: {
    owner: string;
    repo: string;
    [key: string]: string | number;
  };
  requestHash: string;
  correlationId: string;
  idempotencyKey: string;
  requestEnvelope: Buffer;
  /** Test/support seam for shorter database-enforced approvals; routes omit it. */
  approvalTtlMilliseconds?: number;
}): Promise<AuthorizeDecision> {
  return withTransaction(async (client) => {
    const incomingLease = await client.query<{
      id: string;
      subject_binding_id: string;
      connection_id: string;
      consumed_at: string | null;
    }>(
      `select id,subject_binding_id,connection_id,consumed_at from gateway_resolution_leases where lease_hash=$1 and service_identity_id=$2 and audience=$3`,
      [sha256(input.lease), input.serviceIdentityId, input.audience],
    );
    const prior = await client.query<{
      toolkit: string;
      tool: string;
      request_hash: string;
      subject_binding_id: string;
      connection_id: string;
    }>(
      `select toolkit,tool,request_hash,subject_binding_id,connection_id from gateway_executions where service_identity_id=$1 and idempotency_key=$2`,
      [input.serviceIdentityId, input.idempotencyKey],
    );
    if (prior.rows[0]) {
      const same =
        prior.rows[0].toolkit === input.toolkit &&
        prior.rows[0].tool === input.tool &&
        prior.rows[0].request_hash === input.requestHash &&
        incomingLease.rows[0]?.subject_binding_id ===
          prior.rows[0].subject_binding_id &&
        incomingLease.rows[0]?.connection_id === prior.rows[0].connection_id;
      throw new GatewayConflictError(
        same
          ? "gateway_allow_already_committed"
          : "gateway_idempotency_conflict",
      );
    }
    if (incomingLease.rows[0]?.consumed_at) {
      const committed = await client.query<{
        toolkit: string;
        tool: string;
        request_hash: string;
      }>(
        `select toolkit,tool,request_hash from gateway_executions where lease_id=$1`,
        [incomingLease.rows[0].id],
      );
      const same =
        committed.rows[0]?.toolkit === input.toolkit &&
        committed.rows[0]?.tool === input.tool &&
        committed.rows[0]?.request_hash === input.requestHash;
      throw new GatewayConflictError(
        same
          ? "gateway_allow_already_committed"
          : "gateway_idempotency_conflict",
      );
    }
    const leased = await client.query<{
      id: string;
      team_id: string;
      member_id: string;
      subject_binding_id: string;
      connection_id: string;
      policy_version: string;
      actor_handle: string;
      role: "admin" | "lead" | "member";
      tier: "team" | "external";
    }>(
      `select l.id,l.team_id,l.member_id,l.subject_binding_id,l.connection_id,l.policy_version,m.actor_handle,m.role::text,m.tier::text
       from gateway_resolution_leases l
       join gateway_service_identities s on s.id=l.service_identity_id and s.team_id=l.team_id
       join executor_subject_bindings b on b.id=l.subject_binding_id and b.team_id=l.team_id
       join gateway_connections c on c.id=l.connection_id and c.team_id=l.team_id
       join members m on m.id=l.member_id and m.team_id=l.team_id
       where l.lease_hash=$1 and l.audience=$2 and l.service_identity_id=$3 and l.consumed_at is null and l.revoked_at is null and l.expires_at>now()
       and s.revoked_at is null and (s.expires_at is null or s.expires_at>now()) and b.revoked_at is null and (b.expires_at is null or b.expires_at>now())
       and c.enabled and c.revoked_at is null and (c.credential_expires_at is null or c.credential_expires_at>now()) and m.status='active' and m.tier='team' for update of l`,
      [sha256(input.lease), input.audience, input.serviceIdentityId],
    );
    const row = leased.rows[0];
    if (!row) throw new GatewayPersistenceError("gateway_lease_invalid");
    const policies = await loadGatewayPolicies(client, row.team_id);
    const policy = evaluateGatewayPolicy(policies, {
      principal: { actor: row.actor_handle, role: row.role, tier: row.tier },
      tool: input.tool,
      owner: input.normalizedArgs.owner,
      repo: input.normalizedArgs.repo,
    });
    if (policy.policyVersion !== row.policy_version)
      throw new GatewayConflictError("gateway_policy_stale");
    const executionId = input.executionId;
    const state =
      policy.decision === "allow"
        ? "claimed"
        : policy.decision === "block"
          ? "blocked"
          : "approval_required";
    const policyResource = `github.repository:${input.normalizedArgs.owner}/${input.normalizedArgs.repo}`;
    await client.query(
      `insert into gateway_executions(
        id,team_id,member_id,service_identity_id,subject_binding_id,connection_id,lease_id,
        correlation_id,idempotency_key,toolkit,tool,request_hash,encrypted_request_envelope,
        actor_snapshot,role_snapshot,tier_snapshot,policy_resource,request_envelope_hash,
        decision,state,policy_version,policy_rule_id,claimed_at,claimed_by_correlation_id
       ) values(
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
        $19,$20,$21,$22,case when $19='allow' then now() end,
        case when $19='allow' then $8::uuid end
       )`,
      [
        executionId,
        row.team_id,
        row.member_id,
        input.serviceIdentityId,
        row.subject_binding_id,
        row.connection_id,
        row.id,
        input.correlationId,
        input.idempotencyKey,
        input.toolkit,
        input.tool,
        input.requestHash,
        input.requestEnvelope,
        row.actor_handle,
        row.role,
        row.tier,
        policyResource,
        sha256(input.requestEnvelope),
        policy.decision,
        state,
        policy.policyVersion,
        policy.policyRuleId,
      ],
    );
    await client.query(
      `update gateway_resolution_leases set consumed_at=now() where id=$1`,
      [row.id],
    );
    let approval: { id: string; expires_at: string } | undefined;
    if (policy.decision === "require_approval") {
      const id = randomUUID();
      const made = await client.query<{ id: string; expires_at: string }>(
        `insert into gateway_approvals(id,team_id,execution_id,expires_at)
         values($1,$2,$3,now()+($4::text || ' milliseconds')::interval)
         returning id,expires_at`,
        [
          id,
          row.team_id,
          executionId,
          Math.max(
            1,
            Math.min(
              GATEWAY_APPROVAL_TTL_MINUTES * 60_000,
              input.approvalTtlMilliseconds ??
                GATEWAY_APPROVAL_TTL_MINUTES * 60_000,
            ),
          ),
        ],
      );
      approval = made.rows[0];
    }
    const event =
      policy.decision === "allow"
        ? "decision_allowed"
        : policy.decision === "block"
          ? "decision_blocked"
          : "decision_approval_required";
    await client.query(
      `insert into gateway_audit_log(team_id,member_id,service_identity_id,subject_binding_id,connection_id,execution_id,approval_id,event,toolkit,tool,request_hash,policy_version,policy_rule_id,decision,correlation_id,idempotency_key) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [
        row.team_id,
        row.member_id,
        input.serviceIdentityId,
        row.subject_binding_id,
        row.connection_id,
        executionId,
        approval?.id ?? null,
        event,
        input.toolkit,
        input.tool,
        input.requestHash,
        policy.policyVersion,
        policy.policyRuleId,
        policy.decision,
        input.correlationId,
        input.idempotencyKey,
      ],
    );
    if (policy.decision === "allow") return { decision: "allow", executionId };
    if (policy.decision === "block") return { decision: "block", executionId };
    return {
      decision: "require_approval",
      executionId,
      approvalId: approval!.id,
      expiresAt: approval!.expires_at,
    };
  });
}

export async function reboundMemberForLease(input: {
  serviceIdentityId: string;
  lease: string;
  audience: string;
}): Promise<string> {
  return withTransaction(async (client) => {
    const result = await client.query<{ member_id: string }>(
      `select member_id from gateway_resolution_leases where lease_hash=$1 and service_identity_id=$2 and audience=$3 and consumed_at is null and revoked_at is null and expires_at>now()`,
      [sha256(input.lease), input.serviceIdentityId, input.audience],
    );
    if (!result.rows[0])
      throw new GatewayPersistenceError("gateway_lease_invalid");
    return result.rows[0].member_id;
  });
}

export async function gatewayRateLimit(
  bucket: string,
  limit: number,
): Promise<{ allowed: boolean; retryAfter: number }> {
  return withTransaction(async (client) => {
    const result = await client.query<{ count: number; retry_after: number }>(
      `with clock as (select date_trunc('minute', clock_timestamp()) window_start, clock_timestamp() now_at),
       hit as (insert into gateway_rate_limits(bucket,window_start,count)
         select $1,window_start,1 from clock on conflict(bucket,window_start) do update set count=gateway_rate_limits.count+1
         returning count)
       select hit.count, greatest(1,ceil(extract(epoch from ((select window_start from clock)+interval '1 minute'-(select now_at from clock)))))::int retry_after from hit`,
      [bucket],
    );
    return {
      allowed: result.rows[0].count <= limit,
      retryAfter: result.rows[0].retry_after,
    };
  });
}

export async function getGatewayCredentialForClaimedExecution(input: {
  serviceIdentityId: string;
  executionId: string;
}): Promise<{ ciphertext: string; credentialExpiresAt: string | null }> {
  return withTransaction(async (client) => {
    const result = await client.query<{
      credential_ciphertext: string;
      credential_expires_at: string | null;
    }>(
      `select c.credential_ciphertext,c.credential_expires_at from gateway_executions e
       join gateway_connections c on c.id=e.connection_id and c.team_id=e.team_id
       join gateway_service_identities s on s.id=e.service_identity_id and s.team_id=e.team_id
       where e.id=$1 and e.service_identity_id=$2 and e.state='claimed' and e.decision='allow'
         and c.enabled and c.revoked_at is null and (c.credential_expires_at is null or c.credential_expires_at>now())
         and s.revoked_at is null and (s.expires_at is null or s.expires_at>now())`,
      [input.executionId, input.serviceIdentityId],
    );
    const row = result.rows[0];
    if (!row)
      throw new GatewayPersistenceError("gateway_execution_not_claimable");
    return {
      ciphertext: row.credential_ciphertext,
      credentialExpiresAt: row.credential_expires_at,
    };
  });
}

export async function failGatewayCredentialSealing(input: {
  serviceIdentityId: string;
  executionId: string;
  correlationId: string;
}): Promise<void> {
  await withTransaction(async (client) => {
    const result = await client.query<{
      team_id: string;
      member_id: string;
      subject_binding_id: string;
      connection_id: string;
    }>(
      `update gateway_executions set state='failed',outcome_classification='credential',updated_at=now() where id=$1 and service_identity_id=$2 and state='claimed' and outcome_classification is null returning team_id,member_id,subject_binding_id,connection_id`,
      [input.executionId, input.serviceIdentityId],
    );
    const row = result.rows[0];
    if (!row) return;
    await client.query(
      `insert into gateway_audit_log(team_id,member_id,service_identity_id,subject_binding_id,connection_id,execution_id,event,correlation_id,outcome_classification) values($1,$2,$3,$4,$5,$6,'outcome_recorded',$7,'credential') on conflict do nothing`,
      [
        row.team_id,
        row.member_id,
        input.serviceIdentityId,
        row.subject_binding_id,
        row.connection_id,
        input.executionId,
        input.correlationId,
      ],
    );
  });
}

export async function recordGatewayOutcome(input: {
  serviceIdentityId: string;
  executionId: string;
  correlationId: string;
  classification: string;
  upstreamStatusClass?: string;
  responseBytes?: number;
}): Promise<"recorded" | "replay"> {
  return withTransaction(async (client) => {
    const current = await client.query<{
      team_id: string;
      member_id: string;
      subject_binding_id: string;
      connection_id: string;
      state: string;
      outcome_classification: string | null;
      upstream_status_class: string | null;
      response_bytes: string | null;
    }>(
      `select team_id,member_id,subject_binding_id,connection_id,state,outcome_classification,upstream_status_class,response_bytes::text from gateway_executions where id=$1 and service_identity_id=$2 for update`,
      [input.executionId, input.serviceIdentityId],
    );
    const row = current.rows[0];
    if (!row)
      throw new GatewayPersistenceError("gateway_execution_not_claimable");
    const upstream = input.upstreamStatusClass ?? null;
    const bytes = input.responseBytes ?? null;
    if (row.outcome_classification !== null) {
      if (
        row.outcome_classification === input.classification &&
        row.upstream_status_class === upstream &&
        (row.response_bytes === null ? null : Number(row.response_bytes)) ===
          bytes
      )
        return "replay";
      throw new Error("gateway_outcome_conflict");
    }
    const next =
      row.state === "claimed"
        ? input.classification === "success"
          ? "succeeded"
          : [
                "credential",
                "network",
                "upstream",
                "response_too_large",
                "internal",
              ].includes(input.classification)
            ? "failed"
            : null
        : row.state === "blocked" && input.classification === "blocked"
          ? "blocked"
          : row.state === "approval_required" &&
              input.classification === "approval_required"
            ? "approval_required"
            : null;
    if (!next) throw new Error("gateway_outcome_conflict");
    await client.query(
      `update gateway_executions set state=$1,outcome_classification=$2,upstream_status_class=$3,response_bytes=$4,updated_at=now() where id=$5 and outcome_classification is null`,
      [next, input.classification, upstream, bytes, input.executionId],
    );
    await client.query(
      `insert into gateway_audit_log(team_id,member_id,service_identity_id,subject_binding_id,connection_id,execution_id,event,correlation_id,outcome_classification,upstream_status_class,response_bytes) values($1,$2,$3,$4,$5,$6,'outcome_recorded',$7,$8,$9,$10)`,
      [
        row.team_id,
        row.member_id,
        input.serviceIdentityId,
        row.subject_binding_id,
        row.connection_id,
        input.executionId,
        input.correlationId,
        input.classification,
        upstream,
        bytes,
      ],
    );
    return "recorded";
  });
}
