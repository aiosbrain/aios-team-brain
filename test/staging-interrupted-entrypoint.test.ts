import { describe, expect, it, vi } from "vitest";
import { installObject } from "../scripts/staging-ops/importer.mjs";
import { credentialFingerprint } from "../scripts/staging-ops/credential-fingerprint.mjs";
import { loaderCapabilityIdentity } from "../scripts/staging-ops/build-identity.mjs";

const comparisonKey = Buffer.alloc(32, 11);
const env = {
  STAGING_COMPARISON_KEY_BASE64: comparisonKey.toString("base64"), STAGING_COMPARISON_KEY_ID: "ops-v2",
  AUTH_SECRET: "staging-auth", SECRETS_KEY: "staging-secrets", NEO4J_USER: "neo4j", NEO4J_PASSWORD: "staging-password",
} as NodeJS.ProcessEnv;
const credentialFingerprints = Object.fromEntries([
  ["auth-secret", "production-auth"], ["secrets-key", "production-secrets"], ["neo4j-credential", "neo4j\0production-password"],
].map(([credentialClass, value]) => [credentialClass, credentialFingerprint({ credentialClass, value, comparisonKey, keyId: "ops-v2" })]));
const opened = {
  manifest: { runId: "candidate-run", credentialFingerprints, build: { ...loaderCapabilityIdentity(), applicationCommit: "a".repeat(40), schemaFingerprint: "b".repeat(64) } },
};

function interruptedScenario(journal: Record<string, unknown>) {
  const calls: string[] = [];
  const preserved = { manifest: { runId: "preserved-run" } };
  const canonical = { manifest: { runId: "last-ready-run" } };
  const operations = {
    verifyAndPinSourceBundle: vi.fn(async () => opened),
    acquireCoordinatorLock: vi.fn(async () => { calls.push("lock"); return true; }),
    readJournal: vi.fn(async () => { calls.push("journal"); return journal; }),
    openRollbackTarget: vi.fn(async () => { calls.push("preserved"); return preserved; }),
    openPrior: vi.fn(async () => { calls.push("canonical"); return canonical; }),
    rollbackToPrior: vi.fn(async ({ prior, failedRunId }) => { calls.push(`rollback:${prior.manifest.runId}:${failedRunId}`); return { status: "rolled-back", runId: prior.manifest.runId }; }),
    reconcileReadyInstall: vi.fn(async () => ({ catchup: null, cleanupErrors: [] })),
    releaseCoordinatorLock: vi.fn(async () => { calls.push("unlock"); }),
  };
  return { calls, operations };
}

describe("the real importer install branch recovers interrupted durable states", () => {
  for (const [state, checkpoint] of [
    ["draining", "ready"], ["importing", "ready"], ["verifying", "ready"], ["booting", "ready"],
    ["failed", "aborted-sigterm"], ["failed", "aborted-sigint"],
  ] as const) {
    it(`recovers ${state}/${checkpoint} under the coordinator lock`, async () => {
      const { calls, operations } = interruptedScenario({
        state, last_safe_checkpoint: checkpoint, run_id: `interrupted-${state}-${checkpoint}`,
        rollback_target_run_id: "preserved-run",
      });
      const result = await installObject({ client: {}, objectId: "candidate", sourceStore: {}, rollbackStore: {}, maintenance: {}, env, operations });
      expect(result).toMatchObject({ status: "interrupted-run-recovered", interruptedRunId: `interrupted-${state}-${checkpoint}`, runId: "preserved-run" });
      expect(calls).toEqual(["lock", "journal", "preserved", `rollback:preserved-run:interrupted-${state}-${checkpoint}`, "unlock"]);
      expect(operations.openPrior).not.toHaveBeenCalled();
    });
  }

  it("falls back to canonical authenticated last-ready identity when an older journal has no preserved target", async () => {
    const { calls, operations } = interruptedScenario({ state: "importing", run_id: "old-interruption" });
    const result = await installObject({ client: {}, objectId: "candidate", sourceStore: {}, rollbackStore: {}, maintenance: {}, env, operations });
    expect(result).toMatchObject({ status: "interrupted-run-recovered", runId: "last-ready-run" });
    expect(calls).toEqual(["lock", "journal", "canonical", "rollback:last-ready-run:old-interruption", "unlock"]);
  });

  it("keeps recovery-required behind explicit recovery and performs no lifecycle action", async () => {
    const { operations } = interruptedScenario({ state: "failed", last_safe_checkpoint: "recovery-required", run_id: "failed-run" });
    await expect(installObject({ client: {}, objectId: "candidate", sourceStore: {}, rollbackStore: {}, maintenance: {}, env, operations }))
      .rejects.toThrow(/explicit rollback recovery/);
    expect(operations.rollbackToPrior).not.toHaveBeenCalled();
  });

  it("reconciles a ready same-run without requiring an obsolete prior", async () => {
    const { operations } = interruptedScenario({ state: "ready", last_ready_run_id: "candidate-run", last_ready_object_id: "ready-object" });
    const result = await installObject({ client: {}, objectId: "candidate", sourceStore: {}, rollbackStore: {}, maintenance: {}, env, operations });
    expect(result).toMatchObject({ status: "already-ready", runId: "candidate-run" });
    expect(operations.openPrior).not.toHaveBeenCalled();
    expect(operations.openRollbackTarget).not.toHaveBeenCalled();
  });
});
