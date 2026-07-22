import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { encryptGatewayRequestEnvelope } from "@/lib/gateway/envelope";
import {
  approveGatewayExecution,
  claimApprovedExecution,
  consumeLeaseAndCreateExecution,
  issueResolutionLease,
} from "@/lib/gateway/persistence";
import { gatewayScope, seedGateway } from "./gateway-helpers";

const KEY = Buffer.alloc(32, 42);

describe("gateway-concurrency", () => {
  it("allows exactly one concurrent lease consumption", async () => {
    const seed = await seedGateway();
    const scope = gatewayScope(seed);
    const issued = await issueResolutionLease({ ...scope, connectionRef: seed.connectionRef, audience: "executor", correlationId: randomUUID() });
    const attempts = Array.from({ length: 8 }, () => {
      const executionId = randomUUID();
      return consumeLeaseAndCreateExecution({
        ...scope, lease: issued.lease, audience: "executor", executionId,
        encryptedRequestEnvelope: encryptGatewayRequestEnvelope({ owner: "acme", repo: "repo" },
          { executionId, serviceIdentityId: seed.serviceIdentityId }, KEY),
        toolkit: "aios-github-readonly", tool: "github.repository.get", requestHash: "b".repeat(64),
        correlationId: randomUUID(), idempotencyKey: randomUUID(), decision: "allow",
      });
    });
    const settled = await Promise.allSettled(attempts);
    expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(settled.filter((result) => result.status === "rejected")).toHaveLength(7);
  });

  it("allows exactly one concurrent approved resume claim", async () => {
    const seed = await seedGateway();
    const scope = gatewayScope(seed);
    const issued = await issueResolutionLease({ ...scope, connectionRef: seed.connectionRef, audience: "executor", correlationId: randomUUID() });
    const executionId = randomUUID();
    await consumeLeaseAndCreateExecution({
      ...scope, lease: issued.lease, audience: "executor", executionId,
      encryptedRequestEnvelope: encryptGatewayRequestEnvelope({ owner: "acme", repo: "repo" },
        { executionId, serviceIdentityId: seed.serviceIdentityId }, KEY),
      toolkit: "aios-github-readonly", tool: "github.repository.get", requestHash: "c".repeat(64),
      correlationId: randomUUID(), idempotencyKey: randomUUID(), decision: "require_approval",
    });
    await approveGatewayExecution({ ...scope, executionId, approverMemberId: seed.memberId, correlationId: randomUUID() });
    const settled = await Promise.allSettled(Array.from({ length: 8 }, () => claimApprovedExecution({
      ...scope, executionId, toolkit: "aios-github-readonly", correlationId: randomUUID(), idempotencyKey: randomUUID(),
    })));
    expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(8);
    const values = settled.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
    expect(values.filter((result) => result.status === "claimed")).toHaveLength(1);
    expect(values.filter((result) => result.status === "settled" && result.result === "already_claimed"))
      .toHaveLength(7);
  });
});
