import { randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { encryptGatewayRequestEnvelope } from "@/lib/gateway/envelope";
import { getPool } from "@/lib/db/pg/pool";
import {
  approveGatewayExecution,
  bindExecutorSubject,
  claimApprovedExecution,
  consumeLeaseAndCreateExecution,
  createGatewayConnection,
  findGatewayConnection,
  issueResolutionLease,
  registerGatewayServiceIdentity,
} from "@/lib/gateway/persistence";
import { seedTeam } from "./helpers";
import { gatewayScope, seedGateway } from "./gateway-helpers";

const KEY = Buffer.alloc(32, 43);

describe("gateway-tenant-isolation", () => {
  async function createMember(
    teamId: string,
    over: { status?: "active" | "disabled"; tier?: "team" | "external" } = {}
  ) {
    const id = randomUUID();
    await getPool().query(
      `insert into members (id, team_id, email, display_name, actor_handle, role, tier, status)
       values ($1,$2,$3,'Gateway approver',$4,'member',$5,$6)`,
      [id, teamId, `${randomUUID()}@test.local`, `approver-${randomUUID()}`, over.tier ?? "team", over.status ?? "active"]
    );
    return id;
  }

  it("denies cross-team, cross-member, cross-tenant, and cross-subject connection lookup", async () => {
    const seed = await seedGateway();
    const other = await seedTeam();
    const scope = gatewayScope(seed);
    expect(await findGatewayConnection({ ...scope, teamId: other.teamId, connectionRef: seed.connectionRef })).toBeNull();
    expect(await findGatewayConnection({ ...scope, memberId: other.memberId, connectionRef: seed.connectionRef })).toBeNull();
    expect(await findGatewayConnection({ ...scope, executorTenantId: "wrong-tenant", connectionRef: seed.connectionRef })).toBeNull();
    expect(await findGatewayConnection({ ...scope, executorSubjectId: "wrong-subject", connectionRef: seed.connectionRef })).toBeNull();
  });

  it("wrong subject cannot consume a valid lease and the correct subject can still consume it", async () => {
    const seed = await seedGateway();
    const scope = gatewayScope(seed);
    const issued = await issueResolutionLease({ ...scope, connectionRef: seed.connectionRef, audience: "executor", correlationId: randomUUID() });
    const executionId = randomUUID();
    const common = {
      ...scope, lease: issued.lease, audience: "executor", executionId,
      encryptedRequestEnvelope: encryptGatewayRequestEnvelope({ owner: "acme", repo: "repo" },
        { executionId, serviceIdentityId: seed.serviceIdentityId }, KEY),
      toolkit: "aios-github-readonly", tool: "github.repository.get", requestHash: "d".repeat(64),
      correlationId: randomUUID(), idempotencyKey: randomUUID(), decision: "allow" as const,
    };
    await expect(consumeLeaseAndCreateExecution({ ...common, executorSubjectId: "wrong-subject" }))
      .rejects.toMatchObject({ code: "gateway_lease_invalid" });
    await expect(consumeLeaseAndCreateExecution(common)).resolves.toMatchObject({ decision: "allow" });
  });

  it("rebinds service expiry after lease issuance", async () => {
    const seed = await seedGateway();
    const scope = gatewayScope(seed);
    const issued = await issueResolutionLease({ ...scope, connectionRef: seed.connectionRef, audience: "executor", correlationId: randomUUID() });
    const executionId = randomUUID();
    const attempt = {
      ...scope, lease: issued.lease, audience: "executor", executionId,
      encryptedRequestEnvelope: encryptGatewayRequestEnvelope({ owner: "acme", repo: "repo" },
        { executionId, serviceIdentityId: seed.serviceIdentityId }, KEY),
      toolkit: "aios-github-readonly", tool: "github.repository.get", requestHash: "1".repeat(64),
      correlationId: randomUUID(), idempotencyKey: randomUUID(), decision: "allow" as const,
    };
    await getPool().query(
      `update gateway_service_identities set expires_at=activated_at+interval '1 microsecond' where id=$1`,
      [seed.serviceIdentityId]
    );
    await expect(consumeLeaseAndCreateExecution(attempt)).rejects.toMatchObject({ code: "gateway_lease_invalid" });
  });

  it("rebinds connection revocation before an approved resume claim", async () => {
    const seed = await seedGateway();
    const scope = gatewayScope(seed);
    const issued = await issueResolutionLease({ ...scope, connectionRef: seed.connectionRef, audience: "executor", correlationId: randomUUID() });
    const executionId = randomUUID();
    await consumeLeaseAndCreateExecution({
      ...scope, lease: issued.lease, audience: "executor", executionId,
      encryptedRequestEnvelope: encryptGatewayRequestEnvelope({ owner: "acme", repo: "repo" },
        { executionId, serviceIdentityId: seed.serviceIdentityId }, KEY),
      toolkit: "aios-github-readonly", tool: "github.repository.get", requestHash: "2".repeat(64),
      correlationId: randomUUID(), idempotencyKey: randomUUID(), decision: "require_approval",
    });
    await approveGatewayExecution({ ...scope, executionId, approverMemberId: seed.memberId, correlationId: randomUUID() });
    await getPool().query(
      `update gateway_connections set enabled=false, revoked_at=now(), updated_at=now() where id=$1`,
      [seed.connectionId]
    );
    await expect(claimApprovedExecution({
      ...scope, executionId, toolkit: "aios-github-readonly", correlationId: randomUUID(), idempotencyKey: randomUUID(),
    })).rejects.toMatchObject({ code: "gateway_execution_not_claimable" });
  });

  it("accepts only an active same-team approver and records complete audit scope", async () => {
    const seed = await seedGateway();
    const scope = gatewayScope(seed);
    const issued = await issueResolutionLease({
      ...scope, connectionRef: seed.connectionRef, audience: "executor", correlationId: randomUUID(),
    });
    const executionId = randomUUID();
    await consumeLeaseAndCreateExecution({
      ...scope, lease: issued.lease, audience: "executor", executionId,
      encryptedRequestEnvelope: encryptGatewayRequestEnvelope({ owner: "acme", repo: "repo" },
        { executionId, serviceIdentityId: seed.serviceIdentityId }, KEY),
      toolkit: "aios-github-readonly", tool: "github.repository.get", requestHash: "3".repeat(64),
      correlationId: randomUUID(), idempotencyKey: randomUUID(), decision: "require_approval",
    });
    const inactiveApprover = await createMember(seed.teamId, { status: "disabled" });
    const externalApprover = await createMember(seed.teamId, { tier: "external" });
    const otherTeam = await seedTeam();
    for (const approverMemberId of [inactiveApprover, externalApprover, otherTeam.memberId]) {
      await expect(approveGatewayExecution({
        ...scope, executionId, approverMemberId, correlationId: randomUUID(),
      })).rejects.toMatchObject({ code: "gateway_approval_not_pending" });
    }

    const activeApprover = await createMember(seed.teamId);
    const correlationId = randomUUID();
    await approveGatewayExecution({ ...scope, executionId, approverMemberId: activeApprover, correlationId });
    const audit = await getPool().query(
      `select subject_binding_id, connection_id from gateway_audit_log
       where execution_id=$1 and event='approval_approved' and correlation_id=$2`,
      [executionId, correlationId]
    );
    expect(audit.rows[0]).toMatchObject({
      subject_binding_id: seed.subjectBindingId,
      connection_id: seed.connectionId,
    });
  });

  it("refuses to bind an external member or connect through a revoked service", async () => {
    const external = await seedTeam();
    const service = await registerGatewayServiceIdentity({
      teamId: external.teamId, environment: "test", credentialId: randomBytes(16).toString("base64url"),
      credential: randomBytes(32).toString("base64url"),
    });
    await getPool().query(`update members set tier='external' where id=$1`, [external.memberId]);
    await expect(bindExecutorSubject({
      teamId: external.teamId, memberId: external.memberId, serviceIdentityId: service.id,
      executorTenantId: "tenant-external", executorSubjectId: "subject-external",
    })).rejects.toMatchObject({ code: "gateway_scope_not_found" });

    const active = await seedTeam();
    const activeService = await registerGatewayServiceIdentity({
      teamId: active.teamId, environment: "test", credentialId: randomBytes(16).toString("base64url"),
      credential: randomBytes(32).toString("base64url"),
    });
    const binding = await bindExecutorSubject({
      teamId: active.teamId, memberId: active.memberId, serviceIdentityId: activeService.id,
      executorTenantId: "tenant-active", executorSubjectId: "subject-active",
    });
    await getPool().query(`update gateway_service_identities set revoked_at=now() where id=$1`, [activeService.id]);
    await expect(createGatewayConnection({
      teamId: active.teamId, memberId: active.memberId, subjectBindingId: binding.id,
      credentialCiphertext: "synthetic-ciphertext",
    })).rejects.toMatchObject({ code: "gateway_scope_not_found" });
  });
});
