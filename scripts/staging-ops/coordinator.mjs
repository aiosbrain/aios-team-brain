import { acquireCoordinatorLock, acquireDataUseLock, markReady, readJournal, transitionJournal } from "./journal.mjs";

const FULL_SHA = /^[0-9a-f]{40}$/i;

export async function bootstrapRollback({ client, environmentId, pinnedEnvironmentId, captureCurrentPair, rollbackStore, platform, currentDeployment, currentMode }) {
  if (!pinnedEnvironmentId || environmentId !== pinnedEnvironmentId) throw new Error("bootstrap rollback target is not pinned staging");
  if (!(await acquireCoordinatorLock(client))) throw new Error("another staging refresh coordinator owns the election lock");
  const journal = await readJournal(client);
  if (journal.last_ready_run_id) throw new Error("bootstrap rollback is one-time and a last-ready pair already exists");
  await transitionJournal(client, { runId: "bootstrap", from: [journal.state], to: "draining", patch: { lastSafeCheckpoint: journal.state } });
  await platform.stopAndVerifyAll();
  if (!(await acquireDataUseLock(client, "exclusive"))) throw new Error("active staging readers prevented bootstrap rollback capture");
  try {
    const pair = await captureCurrentPair();
    await rollbackStore.putAndVerify("bootstrap", pair);
    await transitionJournal(client, { runId: "bootstrap", from: ["draining"], to: "booting" });
  } catch (error) {
    await transitionJournal(client, { runId: "bootstrap", from: ["draining"], to: "failed", patch: { lastSafeCheckpoint: "draining" } }).catch(() => {});
    await Promise.resolve(platform.restartUnchanged(currentDeployment, currentMode)).catch(() => {});
    throw error;
  }
  await platform.restartUnchanged(currentDeployment, currentMode);
  await platform.waitHealthy(currentDeployment.commitSha);
  return markReady(client, { runId: "bootstrap", commit: currentDeployment.commitSha, mode: currentMode });
}

export async function installPairAndBoot({ client, runId, bundle, prior, targetCommit, mode, platform, rollbackStore, installPair, verifyPair, reapplyTesterCredentials }) {
  if (!FULL_SHA.test(String(targetCommit))) throw new Error("refresh target must be an exact staging commit SHA");
  if (!(await acquireCoordinatorLock(client))) throw new Error("another staging refresh coordinator owns the election lock");
  await transitionJournal(client, { runId, from: ["published", "ready", "failed"], to: "draining", patch: { lastSafeCheckpoint: "ready", candidateRunId: runId, catchupCommit: targetCommit } });
  await platform.stopAndVerifyAll();
  if (!(await acquireDataUseLock(client, "exclusive"))) throw new Error("active staging readers prevented exclusive refresh");
  await transitionJournal(client, { runId, from: ["draining"], to: "importing" });
  try {
    await rollbackStore.assertDurable(prior.id, prior);
    await rollbackStore.pinCandidate(runId, bundle);
    await rollbackStore.assertDurable(runId, bundle);
    await installPair(bundle);
    await reapplyTesterCredentials();
    await transitionJournal(client, { runId, from: ["importing"], to: "verifying" });
    await verifyPair(bundle);
    await rollbackStore.assertDurable(runId, bundle);
    await transitionJournal(client, { runId, from: ["verifying"], to: "booting", patch: { catchupCommit: targetCommit } });
  } catch (error) {
    await transitionJournal(client, { runId, from: ["importing", "verifying"], to: "failed", patch: { lastSafeCheckpoint: "ready" } }).catch(() => {});
    throw Object.assign(new Error(`paired refresh install failed; rollback required: ${error instanceof Error ? error.message : String(error)}`), { prior });
  }
  await platform.deployExact(targetCommit);
  await platform.waitHealthy(targetCommit);
  await rollbackStore.promoteCandidate(runId, prior.id);
  await rollbackStore.assertDurable(runId, bundle);
  await markReady(client, { runId, commit: targetCommit, mode });
  const latest = await platform.readStagingHead();
  if (latest !== targetCommit) await platform.persistAndDeployCatchup(latest);
  return { status: "ready", runId, commit: targetCommit };
}

export async function rollbackPair({ client, runId, prior, platform, rollbackStore, installPair, verifyPair, reapplyTesterCredentials }) {
  if (!(await acquireCoordinatorLock(client))) throw new Error("another staging refresh coordinator owns the election lock");
  await transitionJournal(client, { runId, from: ["failed", "booting", "ready"], to: "draining", patch: { lastSafeCheckpoint: "failed" } });
  await platform.stopAndVerifyAll();
  if (!(await acquireDataUseLock(client, "exclusive"))) throw new Error("active staging readers prevented rollback");
  try {
    await rollbackStore.assertDurable(prior.id, prior);
    await transitionJournal(client, { runId, from: ["draining"], to: "importing" });
    await installPair(prior);
    await reapplyTesterCredentials();
    await transitionJournal(client, { runId, from: ["importing"], to: "verifying" });
    await verifyPair(prior);
    await transitionJournal(client, { runId, from: ["verifying"], to: "booting" });
    await platform.deployExact(prior.commit);
    await platform.waitHealthy(prior.commit);
    await markReady(client, { runId, commit: prior.commit, mode: prior.mode });
  } catch (error) {
    await transitionJournal(client, { runId, from: ["draining", "importing", "verifying", "booting"], to: "failed", patch: { lastSafeCheckpoint: "recovery-required" } }).catch(() => {});
    throw new Error(`paired rollback failed; staging remains stopped and recovery is required: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function catchupDecision({ servedSha, branchHead, attempts, maxAttempts = 5 }) {
  if (!FULL_SHA.test(String(branchHead))) return { action: "refuse", reason: "staging branch head is not an exact SHA" };
  if (servedSha === branchHead) return { action: "complete" };
  if (attempts >= maxAttempts) return { action: "failed-loud", reason: "bounded catch-up attempts exhausted" };
  return { action: "deploy", sha: branchHead, nextAttempt: attempts + 1, backoffSeconds: Math.min(300, 15 * 2 ** attempts) };
}
