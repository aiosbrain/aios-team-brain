import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getPool } from "@/lib/db/pg/pool";
import { encryptGatewayRequestEnvelope } from "@/lib/gateway/envelope";
import {
  approveGatewayExecution,
  claimApprovedExecution,
  consumeLeaseAndCreateExecution,
  issueResolutionLease,
} from "@/lib/gateway/persistence";
import { gatewayScope, seedGateway } from "./gateway-helpers";

const KEY = Buffer.alloc(32, 41);

describe("gateway-strict-audit-atomicity", () => {
  it("rolls back lease consumption and execution state when strict audit insertion fails", async () => {
    const seed = await seedGateway();
    const scope = gatewayScope(seed);
    const issued = await issueResolutionLease({
      ...scope, connectionRef: seed.connectionRef, audience: "executor", correlationId: randomUUID(),
    });
    const executionId = randomUUID();
    const rejectedCorrelation = randomUUID();
    const envelope = encryptGatewayRequestEnvelope({ owner: "acme", repo: "repo" },
      { executionId, serviceIdentityId: seed.serviceIdentityId }, KEY);
    const client = await getPool().connect();
    try {
      await client.query(`create or replace function gateway_test_reject_audit() returns trigger language plpgsql as $$
        begin if new.correlation_id = '${rejectedCorrelation}'::uuid then raise exception 'injected audit failure'; end if; return new; end $$`);
      await client.query(`create trigger gateway_test_reject_audit_trigger before insert on gateway_audit_log
        for each row execute function gateway_test_reject_audit()`);

      await expect(consumeLeaseAndCreateExecution({
        ...scope, lease: issued.lease, audience: "executor", executionId,
        encryptedRequestEnvelope: envelope, toolkit: "aios-github-readonly", tool: "github.repository.get",
        requestHash: "a".repeat(64), correlationId: rejectedCorrelation, idempotencyKey: randomUUID(), decision: "allow",
      })).rejects.toThrow("injected audit failure");

      const lease = await client.query(`select consumed_at from gateway_resolution_leases where lease_hash is not null`);
      const execution = await client.query(`select id from gateway_executions where id=$1`, [executionId]);
      expect(lease.rows).toHaveLength(1);
      expect(lease.rows[0].consumed_at).toBeNull();
      expect(execution.rows).toHaveLength(0);
    } finally {
      await client.query(`drop trigger if exists gateway_test_reject_audit_trigger on gateway_audit_log`);
      await client.query(`drop function if exists gateway_test_reject_audit()`);
      client.release();
    }
  });

  it("rolls back an approved execution claim when its strict audit insertion fails", async () => {
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
      toolkit: "aios-github-readonly", tool: "github.repository.get", requestHash: "f".repeat(64),
      correlationId: randomUUID(), idempotencyKey: randomUUID(), decision: "require_approval",
    });
    await approveGatewayExecution({
      ...scope, executionId, approverMemberId: seed.memberId, correlationId: randomUUID(),
    });
    const rejectedCorrelation = randomUUID();
    const client = await getPool().connect();
    try {
      await client.query(`create or replace function gateway_test_reject_claim_audit() returns trigger language plpgsql as $$
        begin if new.correlation_id = '${rejectedCorrelation}'::uuid then raise exception 'injected claim audit failure'; end if; return new; end $$`);
      await client.query(`create trigger gateway_test_reject_claim_audit_trigger before insert on gateway_audit_log
        for each row execute function gateway_test_reject_claim_audit()`);
      await expect(claimApprovedExecution({
        ...scope, executionId, toolkit: "aios-github-readonly",
        correlationId: rejectedCorrelation, idempotencyKey: randomUUID(),
      })).rejects.toThrow("injected claim audit failure");
      const state = await client.query(`select state, claimed_at from gateway_executions where id=$1`, [executionId]);
      expect(state.rows[0]).toMatchObject({ state: "approved", claimed_at: null });
    } finally {
      await client.query(`drop trigger if exists gateway_test_reject_claim_audit_trigger on gateway_audit_log`);
      await client.query(`drop function if exists gateway_test_reject_claim_audit()`);
      client.release();
    }
  });
});
