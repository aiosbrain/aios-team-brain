import { createHash, randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { encryptGatewayRequestEnvelope } from "@/lib/gateway/envelope";
import {
  authenticateGatewayServiceCredential,
  authorizeLeaseAndCreateExecution,
  failGatewayCredentialSealing,
  gatewayRateLimit,
  issueResolutionLease,
  consumeLeaseAndCreateExecution,
  recordGatewayOutcome,
  registerGatewayServiceIdentity,
} from "@/lib/gateway/persistence";
import { getPool } from "@/lib/db/pg/pool";
import { gatewayScope, seedGateway } from "./gateway-helpers";
import { seedTeam } from "./helpers";

describe("gateway v1.10 data mechanics", () => {
  it("authenticates strict service grammar, supports overlap, and closes on revocation", async () => {
    const team = await seedTeam();
    const make = async () => {
      const credentialId = randomBytes(16).toString("base64url");
      const secret = randomBytes(32).toString("base64url");
      const row = await registerGatewayServiceIdentity({
        teamId: team.teamId,
        environment: "test",
        credentialId,
        credential: secret,
      });
      return { ...row, credentialId, secret };
    };
    const first = await make();
    const second = await make();
    for (const value of [first, second]) {
      const auth = await authenticateGatewayServiceCredential(
        `Bearer aios_gw_${value.credentialId}_${value.secret}`,
      );
      expect(auth.id).toBe(value.id);
      auth.secretBytes.fill(0);
    }
    await expect(
      authenticateGatewayServiceCredential(
        `Bearer aios_gw_${first.credentialId}_${randomBytes(32).toString("base64url")}`,
      ),
    ).rejects.toMatchObject({
      code: "gateway_unauthorized",
      message: "Unauthorized",
    });
    await getPool().query(
      `update gateway_service_identities set revoked_at=now() where id=$1`,
      [first.id],
    );
    await expect(
      authenticateGatewayServiceCredential(
        `Bearer aios_gw_${first.credentialId}_${first.secret}`,
      ),
    ).rejects.toMatchObject({
      code: "gateway_unauthorized",
      message: "Unauthorized",
    });
    const remaining = await authenticateGatewayServiceCredential(
      `Bearer aios_gw_${second.credentialId}_${second.secret}`,
    );
    expect(remaining.id).toBe(second.id);
    remaining.secretBytes.fill(0);
  });

  it("uses an atomic persistent gateway-owned minute bucket", async () => {
    const bucket = `test-${randomUUID()}`;
    const hits = await Promise.all(
      Array.from({ length: 121 }, () => gatewayRateLimit(bucket, 120)),
    );
    expect(hits.filter((hit) => hit.allowed)).toHaveLength(120);
    expect(hits.filter((hit) => !hit.allowed)).toHaveLength(1);
    expect(
      hits.every((hit) => hit.retryAfter >= 1 && hit.retryAfter <= 60),
    ).toBe(true);
  });

  it("keeps one PAT ciphertext source and no member_secrets duplicate", async () => {
    const seed = await seedGateway();
    const custody = await getPool().query(
      `select (select count(*)::int from gateway_connections where id=$1 and credential_ciphertext is not null) connection_rows,(select count(*)::int from member_secrets where team_id=$2 and member_id=$3 and provider='github') duplicate_rows`,
      [seed.connectionId, seed.teamId, seed.memberId],
    );
    expect(custody.rows[0]).toEqual({ connection_rows: 1, duplicate_rows: 0 });
  });

  it("settles once, replays identically, and rejects divergent outcomes", async () => {
    const seed = await seedGateway();
    const scope = gatewayScope(seed);
    const correlationId = randomUUID();
    const executionId = randomUUID();
    const lease = await issueResolutionLease({
      ...scope,
      connectionRef: seed.connectionRef,
      audience: "aios-github-readonly",
      correlationId,
    });
    await consumeLeaseAndCreateExecution({
      ...scope,
      lease: lease.lease,
      audience: "aios-github-readonly",
      executionId,
      encryptedRequestEnvelope: encryptGatewayRequestEnvelope(
        { owner: "octo", repo: "project" },
        { executionId, serviceIdentityId: seed.serviceIdentityId },
        Buffer.alloc(32, 7),
      ),
      toolkit: "aios-github-readonly",
      tool: "github.repository.get",
      requestHash: "a".repeat(64),
      correlationId,
      idempotencyKey: randomUUID(),
      decision: "allow",
    });
    const outcome = {
      serviceIdentityId: seed.serviceIdentityId,
      executionId,
      correlationId: randomUUID(),
      classification: "success",
      upstreamStatusClass: "2xx",
      responseBytes: 123,
    };
    await expect(recordGatewayOutcome(outcome)).resolves.toBe("recorded");
    await expect(
      recordGatewayOutcome({ ...outcome, correlationId: randomUUID() }),
    ).resolves.toBe("replay");
    await expect(
      recordGatewayOutcome({
        ...outcome,
        correlationId: randomUUID(),
        responseBytes: 124,
      }),
    ).rejects.toThrow("gateway_outcome_conflict");
    const rows = await getPool().query(
      `select state,(select count(*)::int from gateway_audit_log where execution_id=$1 and event='outcome_recorded') audits from gateway_executions where id=$1`,
      [executionId],
    );
    expect(rows.rows[0]).toEqual({ state: "succeeded", audits: 1 });
  });

  it("commits allow once, never replays it, and settles a post-commit seal failure", async () => {
    const seed = await seedGateway();
    await getPool().query(
      `insert into policies(team_id,action,resource,effect,priority) values($1,$2,$3,'allow',10)`,
      [
        seed.teamId,
        "gateway.aios-github-readonly.github.repository.get",
        "github.repository:octo/project",
      ],
    );
    const lease = await issueResolutionLease({
      ...gatewayScope(seed),
      connectionRef: seed.connectionRef,
      audience: "aios-github-readonly",
      correlationId: randomUUID(),
    });
    const input = {
      serviceIdentityId: seed.serviceIdentityId,
      executionId: randomUUID(),
      lease: lease.lease,
      audience: "aios-github-readonly",
      toolkit: "aios-github-readonly",
      tool: "github.repository.get",
      normalizedArgs: { owner: "octo", repo: "project" },
      requestHash: "b".repeat(64),
      correlationId: randomUUID(),
      idempotencyKey: randomUUID(),
      requestEnvelope: Buffer.from("sealed-request"),
    };
    const allowed = await authorizeLeaseAndCreateExecution(input);
    expect(allowed.decision).toBe("allow");
    await expect(authorizeLeaseAndCreateExecution(input)).rejects.toMatchObject(
      { code: "gateway_allow_already_committed" },
    );
    await failGatewayCredentialSealing({
      serviceIdentityId: seed.serviceIdentityId,
      executionId: allowed.executionId,
      correlationId: randomUUID(),
    });
    const settled = await getPool().query(
      `select state,outcome_classification from gateway_executions where id=$1`,
      [allowed.executionId],
    );
    expect(settled.rows[0]).toEqual({
      state: "failed",
      outcome_classification: "credential",
    });
  });

  it("detects stale policy without consuming the lease or creating an execution", async () => {
    const seed = await seedGateway();
    const policy = await getPool().query<{ id: string }>(
      `insert into policies(team_id,action,resource,effect) values($1,'gateway.aios-github-readonly.*','github.repository:*','allow') returning id`,
      [seed.teamId],
    );
    const lease = await issueResolutionLease({
      ...gatewayScope(seed),
      connectionRef: seed.connectionRef,
      audience: "aios-github-readonly",
      correlationId: randomUUID(),
    });
    await getPool().query(
      `update policies set priority=priority+1,updated_at=now()+interval '1 second' where id=$1`,
      [policy.rows[0].id],
    );
    await expect(
      authorizeLeaseAndCreateExecution({
        serviceIdentityId: seed.serviceIdentityId,
        executionId: randomUUID(),
        lease: lease.lease,
        audience: "aios-github-readonly",
        toolkit: "aios-github-readonly",
        tool: "github.repository.get",
        normalizedArgs: { owner: "octo", repo: "project" },
        requestHash: "c".repeat(64),
        correlationId: randomUUID(),
        idempotencyKey: randomUUID(),
        requestEnvelope: Buffer.from("sealed-request"),
      }),
    ).rejects.toMatchObject({ code: "gateway_policy_stale" });
    const result = await getPool().query(
      `select consumed_at,(select count(*)::int from gateway_executions where lease_id=gateway_resolution_leases.id) executions from gateway_resolution_leases where lease_hash=$1`,
      [createHash("sha256").update(lease.lease).digest("hex")],
    );
    expect(result.rows[0]).toEqual({ consumed_at: null, executions: 0 });
  });
});
