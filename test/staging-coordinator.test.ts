import { describe, expect, it, vi } from "vitest";
import { bootstrapRollback, catchupDecision, installPairAndBoot } from "../scripts/staging-ops/coordinator.mjs";

function journalClient() {
  return { query: vi.fn(async (sql: string) => {
    if (sql.includes("try_advisory")) return { rows: [{ acquired: true }] };
    if (sql.includes("SELECT *")) return { rows: [{ state: "failed", last_ready_run_id: null }] };
    return { rows: [{ state: "next" }] };
  }) };
}

describe("paired refresh coordinator", () => {
  it("first import cannot proceed when bootstrap backup fails and restarts unchanged stores", async () => {
    const platform = { stopAndVerifyAll: vi.fn(), restartUnchanged: vi.fn(), waitHealthy: vi.fn() };
    await expect(bootstrapRollback({
      client: journalClient(), environmentId: "stg", pinnedEnvironmentId: "stg",
      captureCurrentPair: vi.fn().mockRejectedValue(new Error("backup failed")), rollbackStore: { putAndVerify: vi.fn() },
      platform, currentDeployment: { commitSha: "a".repeat(40) }, currentMode: "legacy-pg-only",
    })).rejects.toThrow(/backup failed/);
    expect(platform.restartUnchanged).toHaveBeenCalled();
  });

  it("never marks a partial pair ready and requires durable prior/candidate objects", async () => {
    const client = { query: vi.fn(async (sql: string) => sql.includes("try_advisory") ? { rows: [{ acquired: true }] } : { rows: [{ state: "x" }] }) };
    const platform = { stopAndVerifyAll: vi.fn(), deployExact: vi.fn(), waitHealthy: vi.fn(), readStagingHead: vi.fn(), persistAndDeployCatchup: vi.fn() };
    const store = { assertDurable: vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("candidate pin corrupt")), pinCandidate: vi.fn(), promoteCandidate: vi.fn() };
    await expect(installPairAndBoot({ client, runId: "r", bundle: { id: "r" }, prior: { id: "old" }, targetCommit: "b".repeat(40), mode: "copy-ready", platform, rollbackStore: store, installPair: vi.fn(), verifyPair: vi.fn(), reapplyTesterCredentials: vi.fn() })).rejects.toThrow(/rollback required/);
    expect(platform.deployExact).not.toHaveBeenCalled();
    const transitions = client.query.mock.calls.filter(([sql]) => String(sql).includes("UPDATE staging_ops"));
    expect(transitions.some(([, values]) => values?.[1] === "ready")).toBe(false);
  });

  it("persists a bounded catch-up rather than losing a merge during maintenance", () => {
    expect(catchupDecision({ servedSha: "a".repeat(40), branchHead: "b".repeat(40), attempts: 0 })).toMatchObject({ action: "deploy", nextAttempt: 1 });
    expect(catchupDecision({ servedSha: "a".repeat(40), branchHead: "b".repeat(40), attempts: 5 })).toMatchObject({ action: "failed-loud" });
  });
});
