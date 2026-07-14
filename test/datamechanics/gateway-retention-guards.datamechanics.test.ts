import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getPool } from "@/lib/db/pg/pool";
import { encryptGatewayRequestEnvelope } from "@/lib/gateway/envelope";
import { consumeLeaseAndCreateExecution, issueResolutionLease } from "@/lib/gateway/persistence";
import { gatewayScope, seedGateway } from "./gateway-helpers";

const KEY = Buffer.alloc(32, 46);

describe("gateway-retention-guards", () => {
  it("blocks audit mutation, retained-record deletion, immutable request updates, and team deletion", async () => {
    const seed = await seedGateway();
    const scope = gatewayScope(seed);
    const issued = await issueResolutionLease({ ...scope, connectionRef: seed.connectionRef, audience: "executor", correlationId: randomUUID() });
    const executionId = randomUUID();
    await consumeLeaseAndCreateExecution({
      ...scope, lease: issued.lease, audience: "executor", executionId,
      encryptedRequestEnvelope: encryptGatewayRequestEnvelope({ owner: "acme", repo: "repo" },
        { executionId, serviceIdentityId: seed.serviceIdentityId }, KEY),
      toolkit: "aios-github-readonly", tool: "github.repository.get", requestHash: "e".repeat(64),
      correlationId: randomUUID(), idempotencyKey: randomUUID(), decision: "require_approval",
    });
    const client = await getPool().connect();
    try {
      await expect(client.query(`update gateway_audit_log set event='outcome_recorded' where team_id=$1`, [seed.teamId]))
        .rejects.toThrow("gateway_audit_log is append-only");
      await expect(client.query(`delete from gateway_audit_log where team_id=$1`, [seed.teamId]))
        .rejects.toThrow("gateway_audit_log is append-only");
      await expect(client.query(`update gateway_executions set tool='github.issue.get' where id=$1`, [executionId]))
        .rejects.toThrow("identity/request fields are immutable");
      await expect(client.query(`delete from gateway_executions where id=$1`, [executionId]))
        .rejects.toThrow("gateway_executions are retained");
      await expect(client.query(`delete from gateway_approvals where execution_id=$1`, [executionId]))
        .rejects.toThrow("gateway_approvals are retained");
      await expect(client.query(`delete from gateway_resolution_leases where team_id=$1`, [seed.teamId]))
        .rejects.toThrow("must be revoked, not deleted");
      await expect(client.query(`delete from gateway_connections where id=$1`, [seed.connectionId]))
        .rejects.toThrow("must be revoked, not deleted");
      await expect(client.query(`delete from executor_subject_bindings where id=$1`, [seed.subjectBindingId]))
        .rejects.toThrow("must be revoked, not deleted");
      await expect(client.query(`delete from gateway_service_identities where id=$1`, [seed.serviceIdentityId]))
        .rejects.toThrow("must be revoked, not deleted");
      await expect(client.query(`update gateway_connections set member_id=$1 where id=$2`, [randomUUID(), seed.connectionId]))
        .rejects.toThrow("identity fields are immutable");
      await expect(client.query(`delete from teams where id=$1`, [seed.teamId])).rejects.toThrow();
      const retained = await client.query(`select count(*)::int as n from gateway_audit_log where team_id=$1`, [seed.teamId]);
      expect(retained.rows[0].n).toBeGreaterThan(0);
    } finally {
      client.release();
    }
  });
});
