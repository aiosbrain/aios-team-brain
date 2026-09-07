#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";
import neo4j from "neo4j-driver";
import { openSignedEncryptedBundle, createSignedEncryptedBundle } from "./bundle-crypto.mjs";
import { packPair, unpackPair, validatePairManifest } from "./bundle-format.mjs";
import { assertCompatibleBuildIdentity, migrationSetIdentity, schemaFingerprintDigest } from "./build-identity.mjs";
import { credentialFingerprint, assertDistinctFingerprints } from "./credential-fingerprint.mjs";
import {
  installStagingOps, acquireCoordinatorLock, acquireDataUseLock, releaseCoordinatorLock,
  releaseDataUseLock, readJournal, transitionJournal, markReady, recordCatchup,
  hasCoordinatorLock, hasExclusiveDataUseLock,
} from "./journal.mjs";
import { replaceNeo4jGraph } from "./neo4j-replace.mjs";
import { captureRollbackPostgres, restorePairedPostgres, restoreRollbackPostgres } from "./pg-paired.mjs";
import { withPrivateTempDir } from "./private-store.mjs";
import { canonicalObjectId, createPrivateStore, parseCanonicalObjectId } from "./object-store.mjs";
import { assertOutboundCredentialIsolation, assertRunnerRole } from "./role-policy.mjs";
import { fingerprint } from "../schema-fingerprint.mjs";
import { RailwayMaintenance } from "./railway-maintenance.mjs";
import { LocalMaintenance } from "./local-maintenance.mjs";
import { exportGraph } from "./graph-bundle.mjs";
import { snapshotExportFacts, validateLedgerAgainstSanitizedGraph } from "./exporter.mjs";
import { keyMaterial } from "./key-material.mjs";

const exec = promisify(execFile);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const FULL_SHA = /^[0-9a-f]{40}$/i;

function sourceKeys(env) {
  return {
    exporterSigningPublicKey: keyMaterial(env, "EXPORTER_SIGNING_PUBLIC_KEY"),
    importerEncryptionPrivateKey: keyMaterial(env, "IMPORTER_ENCRYPTION_PRIVATE_KEY"),
  };
}
function rollbackKeys(env) {
  return {
    exporterSigningPublicKey: keyMaterial(env, "ROLLBACK_SIGNING_PUBLIC_KEY"),
    importerEncryptionPrivateKey: keyMaterial(env, "ROLLBACK_ENCRYPTION_PRIVATE_KEY"),
  };
}

function openBundleBytes(bytes, env, kind = "source", { ignoreExpiry = false } = {}) {
  const opened = openSignedEncryptedBundle({ bundle: JSON.parse(bytes.toString("utf8")), ...(kind === "rollback" ? rollbackKeys(env) : sourceKeys(env)) });
  const validity = validatePairManifest(opened.manifest, ignoreExpiry ? 0 : Date.now(), { allowRollback: kind === "rollback" });
  if (!validity.ok) throw new Error(`${kind} bundle refused: ${validity.errors.join("; ")}`);
  return opened;
}

export async function verifyAndPinSourceBundle({ objectId, sourceStore, rollbackStore, env = process.env }) {
  const identity = parseCanonicalObjectId(objectId);
  const sourceBytes = await sourceStore.read(objectId);
  if (sha(sourceBytes) !== identity.digest) throw new Error("source object bytes differ from their canonical digest");
  const opened = openBundleBytes(sourceBytes, env);
  if (opened.manifest.runId !== identity.runId) throw new Error("source object key and signed run ID differ");
  await rollbackStore.putImmutable(objectId, sourceBytes);
  if (!(await rollbackStore.verify(objectId, identity.digest))) throw new Error("candidate rollback copy failed durable read-back verification");
  return { ...opened, sourceBytes, objectId, digest: identity.digest, kind: "source" };
}

export function compareEnvironmentCredentials(manifest, env = process.env) {
  const comparisonKey = Buffer.from(env.STAGING_COMPARISON_KEY_BASE64, "base64");
  const current = Object.fromEntries([
    ["auth-secret", env.AUTH_SECRET], ["secrets-key", env.SECRETS_KEY], ["neo4j-credential", `${env.NEO4J_USER}\0${env.NEO4J_PASSWORD}`],
  ].map(([credentialClass, value]) => [credentialClass, credentialFingerprint({ credentialClass, value, comparisonKey, keyId: env.STAGING_COMPARISON_KEY_ID })]));
  for (const name of Object.keys(current)) assertDistinctFingerprints(manifest.credentialFingerprints?.[name], current[name], name);
  return true;
}

async function currentLoaderIdentity(client) {
  // staging_marker is deliberately outside the canonical application schema and survives restores.
  // It must fence staging, but it must not make the same public application schema look incompatible.
  const canonical = (await fingerprint(client)).filter((line) => !line.includes("\tstaging_marker") && !line.includes("\tstaging_marker."));
  return { schemaFingerprint: schemaFingerprintDigest(canonical), migrationSet: migrationSetIdentity() };
}

async function reapplyTesters(env) {
  await exec("npx", ["tsx", "--conditions", "react-server", "scripts/staging-ops/reapply-testers.ts", "--run"], { cwd: process.cwd(), env, maxBuffer: 1024 * 1024 });
}

async function measuredReplaceFacts({ client, maintenance, env, opened }) {
  const [electionLockHeld, exclusiveDataLockHeld, token, stopMeasurement] = await Promise.all([
    hasCoordinatorLock(client), hasExclusiveDataUseLock(client), maintenance.tokenIdentity(), maintenance.stopAndVerifyAll(),
  ]);
  return {
    pinnedEnvironmentId: env.STAGING_OPS_ENVIRONMENT_ID, actualEnvironmentId: env.RAILWAY_ENVIRONMENT_ID,
    tokenEnvironmentId: token.environmentId, neo4jHost: new URL(env.NEO4J_URL).hostname,
    pinnedNeo4jService: env.STAGING_NEO4J_SERVICE_NAME, pinnedDatabase: env.STAGING_NEO4J_DATABASE,
    database: env.NEO4J_DATABASE, pinnedAppServiceId: env.STAGING_APP_SERVICE_ID,
    pinnedGraphitiServiceId: env.STAGING_GRAPHITI_SERVICE_ID,
    targetCredentialFingerprint: credentialFingerprint({ credentialClass: "neo4j-credential", value: `${env.NEO4J_USER}\0${env.NEO4J_PASSWORD}`, comparisonKey: Buffer.from(env.STAGING_COMPARISON_KEY_BASE64, "base64"), keyId: env.STAGING_COMPARISON_KEY_ID }).mac,
    sourceCredentialFingerprint: opened.manifest.credentialFingerprints?.["neo4j-credential"]?.mac,
    electionLockHeld, exclusiveDataLockHeld, stopMeasurement,
  };
}

export async function installOpenedPair({ client, session, opened, directory, env, maintenance }) {
  const graph = await unpackPair(opened.payload, directory, opened.manifest.checksums);
  if (opened.manifest.databaseMode === "full") await restoreRollbackPostgres({ client, databaseUrl: env.DATABASE_URL, directory, env: { ...env, STAGING_DATA_MODE: opened.manifest.mode } });
  else await restorePairedPostgres({ client, databaseUrl: env.DATABASE_URL, directory, env });
  if (opened.manifest.kind !== "staging-rollback" && env.STAGING_PAIR_REQUIRED === "1" && env.STAGING_FAULT_POINT === "after-postgres") throw new Error("injected harness fault after Postgres restore");
  if (opened.manifest.kind !== "staging-rollback" && env.STAGING_PAIR_REQUIRED === "1" && env.STAGING_HARNESS_PAUSE_AFTER_POSTGRES_MS) {
    const pause = Number(env.STAGING_HARNESS_PAUSE_AFTER_POSTGRES_MS);
    if (!Number.isFinite(pause) || pause < 1 || pause > 120_000) throw new Error("invalid bounded harness pause");
    await new Promise((resolve) => setTimeout(resolve, pause));
  }
  await reapplyTesters(env);
  await replaceNeo4jGraph({ session, graph, facts: await measuredReplaceFacts({ client, maintenance, env, opened }) });
  if (opened.manifest.kind !== "staging-rollback" && env.STAGING_PAIR_REQUIRED === "1" && env.STAGING_FAULT_POINT === "after-graph") throw new Error("injected harness fault after graph restore");
  return graph;
}

async function verifyInstalledPair({ client, session, graph }) {
  const credentialCounts = await client.query(`SELECT
    (SELECT count(*) FROM auth_tokens)+(SELECT count(*) FROM api_keys)+(SELECT count(*) FROM agent_tokens)+
    (SELECT count(*) FROM integrations)+(SELECT count(*) FROM member_secrets)+(SELECT count(*) FROM social_jobs)+
    (SELECT count(*) FROM llm_usage)+(SELECT count(*) FROM usage_costs) AS forbidden_count`);
  if (Number(credentialCounts.rows[0]?.forbidden_count ?? -1) !== 0) throw new Error("post-import credential/outbound queue sanitation verification failed");
  const [facts, installedGraph] = await Promise.all([snapshotExportFacts(client), exportGraph(session)]);
  validateLedgerAgainstSanitizedGraph(installedGraph, facts);
  if (installedGraph.nodes.length !== graph.nodes.length || installedGraph.relationships.length !== graph.relationships.length) throw new Error("installed graph census differs from verified bundle");
}

export async function readStagingHead(env = process.env, fetchImpl = fetch) {
  if (env.STAGING_MAINTENANCE_ADAPTER === "local") {
    return new LocalMaintenance({ baseUrl: env.LOCAL_MAINTENANCE_URL, token: env.RAILWAY_STAGING_MAINTENANCE_TOKEN, environmentId: env.STAGING_OPS_ENVIRONMENT_ID, appServiceId: env.STAGING_APP_SERVICE_ID, graphitiServiceId: env.STAGING_GRAPHITI_SERVICE_ID, fetchImpl }).readStagingHead();
  }
  if (!env.STAGING_GITHUB_READ_TOKEN || !env.GITHUB_REPOSITORY) throw new Error("staging head read identity is required");
  const response = await fetchImpl(`https://api.github.com/repos/${env.GITHUB_REPOSITORY}/git/ref/heads/staging`, { headers: { Authorization: `Bearer ${env.STAGING_GITHUB_READ_TOKEN}`, Accept: "application/vnd.github+json" }, redirect: "error", signal: AbortSignal.timeout(10_000) });
  const body = await response.json(); const commit = body?.object?.sha;
  if (!response.ok || !FULL_SHA.test(commit ?? "")) throw new Error("could not observe exact staging branch head");
  return commit;
}

export async function waitForImportedBoot({ maintenance, deploymentId, commit, origin, token, mode = "copy-ready", fetchImpl = fetch, timeoutMs = 300_000, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const deployment = await maintenance.readDeployment(deploymentId);
    if (new Set(["FAILED", "CRASHED", "REMOVED"]).has(deployment.status)) throw new Error(`fresh staging deployment failed in ${deployment.status}`);
    if (deployment.status === "SUCCESS" || deployment.status === "DEPLOYING") {
      const response = await fetchImpl(new URL("/api/health", origin), { redirect: "manual", headers: { "x-aios-staging-health-token": token, "x-aios-staging-boot-probe": "true" }, signal: AbortSignal.timeout(10_000) }).catch(() => null);
      const body = await response?.json().catch(() => ({}));
      if (response?.status === 202 && body?.booted === true && body?.commit === commit) return true;
      if (mode === "legacy-pg-only" && response?.status === 200 && body?.ok === true && body?.mode === mode && body?.commit === commit) return true;
    }
    await sleep(5_000);
  }
  throw new Error("fresh staging deployment did not pass the bounded authenticated boot probe");
}

function maintenanceFor(env) {
  if (env.STAGING_MAINTENANCE_ADAPTER === "local") return new LocalMaintenance({ baseUrl: env.LOCAL_MAINTENANCE_URL, token: env.RAILWAY_STAGING_MAINTENANCE_TOKEN, environmentId: env.STAGING_OPS_ENVIRONMENT_ID, appServiceId: env.STAGING_APP_SERVICE_ID, graphitiServiceId: env.STAGING_GRAPHITI_SERVICE_ID });
  return new RailwayMaintenance({ projectId: env.RAILWAY_PROJECT_ID, environmentId: env.STAGING_OPS_ENVIRONMENT_ID, appServiceId: env.STAGING_APP_SERVICE_ID, graphitiServiceId: env.STAGING_GRAPHITI_SERVICE_ID, token: env.RAILWAY_STAGING_MAINTENANCE_TOKEN });
}

async function openPrior({ client, journal, rollbackStore, env }) {
  if (!journal.last_ready_run_id || !journal.last_ready_object_id || !journal.last_ready_digest) throw new Error("no canonical verified last-ready rollback pair; run bootstrap-rollback before the first import");
  const bytes = await rollbackStore.read(journal.last_ready_object_id);
  if (sha(bytes) !== journal.last_ready_digest) throw new Error("last-ready rollback object failed digest verification");
  const encoded = JSON.parse(bytes.toString("utf8"));
  const kind = encoded?.manifest?.kind === "staging-rollback" ? "rollback" : "source";
  const opened = openBundleBytes(bytes, env, kind, { ignoreExpiry: true });
  if (opened.manifest.runId !== journal.last_ready_run_id || journal.last_ready_commit !== opened.manifest.targetCommit) throw new Error("last-ready journal/object metadata mismatch");
  assertCompatibleBuildIdentity(opened.manifest.build, await currentLoaderIdentity(client));
  return { ...opened, sourceBytes: bytes, objectId: journal.last_ready_object_id, digest: journal.last_ready_digest, kind };
}

function sealReadyRollback(opened, targetCommit, env) {
  const manifest = {
    ...opened.manifest, kind: "staging-rollback", databaseMode: opened.manifest.databaseMode ?? "sanitized",
    targetCommit, mode: opened.manifest.mode ?? "copy-ready", expiresAt: "9999-12-31T23:59:59.999Z",
  };
  delete manifest.signature; delete manifest.ciphertextSha256; delete manifest.encryption; delete manifest.signing;
  const bundle = createSignedEncryptedBundle({ payload: opened.payload, manifest,
    exporterSigningPrivateKey: keyMaterial(env, "ROLLBACK_SIGNING_PRIVATE_KEY"),
    importerEncryptionPublicKey: keyMaterial(env, "ROLLBACK_ENCRYPTION_PUBLIC_KEY") });
  const sourceBytes = Buffer.from(JSON.stringify(bundle)); const digest = sha(sourceBytes);
  return { ...openBundleBytes(sourceBytes, env, "rollback", { ignoreExpiry: true }), sourceBytes, objectId: canonicalObjectId(manifest.runId, digest), digest, kind: "rollback" };
}

async function bootExact({ client, maintenance, runId, objectId, digest, commit, mode, env }) {
  await transitionJournal(client, { runId, from: ["verifying", "importing"], to: "booting", patch: { catchupCommit: commit, candidateMode: mode } });
  await releaseDataUseLock(client, "exclusive");
  const deploymentId = await maintenance.deployApp(commit);
  await waitForImportedBoot({ maintenance, deploymentId, commit, origin: env.STAGING_ORIGIN, token: env.STAGING_HEALTH_TOKEN, mode });
  return { deploymentId, ready: await markReady(client, { runId, objectId, digest, commit, mode }) };
}

async function rollbackToPrior({ client, prior, failedRunId, maintenance, rollbackStore, env }) {
  await transitionJournal(client, { runId: failedRunId, from: ["failed", "booting", "importing", "verifying", "draining"], to: "draining", patch: { lastSafeCheckpoint: "rollback" } }).catch(() => {});
  await maintenance.stopAndVerifyAll();
  if (!(await acquireDataUseLock(client, "exclusive"))) throw new Error("active staging readers prevented rollback");
  const driver = neo4j.driver(env.NEO4J_URL, neo4j.auth.basic(env.NEO4J_USER, env.NEO4J_PASSWORD));
  const session = driver.session({ database: env.NEO4J_DATABASE, defaultAccessMode: neo4j.session.WRITE });
  try {
    if (env.STAGING_PAIR_REQUIRED === "1" && env.STAGING_FAULT_ROLLBACK === "1") throw new Error("injected harness rollback failure");
    await transitionJournal(client, { runId: prior.manifest.runId, from: ["draining", "failed"], to: "importing" });
    const graph = await withPrivateTempDir("aios-staging-rollback-", (directory) => installOpenedPair({ client, session, opened: prior, directory, env, maintenance }));
    await transitionJournal(client, { runId: prior.manifest.runId, from: ["importing"], to: "verifying" });
    if (prior.kind === "source") await verifyInstalledPair({ client, session, graph });
    await rollbackStore.putImmutable(prior.objectId, prior.sourceBytes);
    await bootExact({ client, maintenance, runId: prior.manifest.runId, objectId: prior.objectId, digest: prior.digest, commit: prior.manifest.targetCommit, mode: prior.manifest.mode, env });
    await rollbackStore.writePointer("last-ready", { runId: prior.manifest.runId, objectId: prior.objectId, digest: prior.digest, commit: prior.manifest.targetCommit, mode: prior.manifest.mode, kind: prior.kind });
    return { status: "rolled-back", runId: prior.manifest.runId };
  } catch (error) {
    await transitionJournal(client, { runId: failedRunId, from: ["draining", "importing", "verifying", "booting"], to: "failed", patch: { lastSafeCheckpoint: "recovery-required" } }).catch(() => {});
    throw new Error(`paired rollback failed; staging remains fenced and recovery is required: ${error instanceof Error ? error.message : String(error)}`);
  } finally { await session.close(); await driver.close(); }
}

async function installObject({ client, objectId, sourceStore, rollbackStore, maintenance, env }) {
  const opened = await verifyAndPinSourceBundle({ objectId, sourceStore, rollbackStore, env });
  compareEnvironmentCredentials(opened.manifest, env);
  assertCompatibleBuildIdentity(opened.manifest.build, await currentLoaderIdentity(client));
  if (!(await acquireCoordinatorLock(client))) throw new Error("another importer owns the coordinator lock");
  try {
  const journal = await readJournal(client);
  const prior = await openPrior({ client, journal, rollbackStore, env });
  if (journal.state === "failed" && journal.last_safe_checkpoint === "recovery-required") {
    throw new Error("prior-pair rollback previously failed; staging remains fenced until explicit rollback recovery");
  }
  if (journal.state !== "ready") {
    const recovered = await rollbackToPrior({ client, prior, failedRunId: journal.run_id ?? `interrupted-${Date.now()}`, maintenance, rollbackStore, env });
    return { ...recovered, status: "interrupted-run-recovered", interruptedRunId: journal.run_id };
  }
  if (journal.last_ready_run_id === opened.manifest.runId) {
    await rollbackStore.writePointer("last-ready", {
      runId: journal.last_ready_run_id, objectId: journal.last_ready_object_id,
      digest: journal.last_ready_digest, commit: journal.last_ready_commit,
      mode: journal.last_ready_mode, kind: "rollback",
    });
    if (objectId !== journal.last_ready_object_id) await rollbackStore.delete(objectId).catch(() => {});
    return { status: "already-ready", runId: opened.manifest.runId, objectId: journal.last_ready_object_id };
  }
  const targetCommit = await readStagingHead(env);
  let destructive = false;
  try {
    await maintenance.assertPinnedRunnerConfiguration(env.STAGING_IMPORTER_SERVICE_ID, env.STAGING_IMPORTER_IMAGE_DIGEST);
    await transitionJournal(client, { runId: opened.manifest.runId, from: ["ready", "failed"], to: "draining", patch: { lastSafeCheckpoint: "ready", candidateRunId: opened.manifest.runId, candidateObjectId: objectId, candidateDigest: opened.digest, candidateMode: "copy-ready", catchupCommit: targetCommit } });
    destructive = true;
    await maintenance.stopAndVerifyAll();
    if (!(await acquireDataUseLock(client, "exclusive"))) throw new Error("active app/predeploy sessions prevent import");
    await transitionJournal(client, { runId: opened.manifest.runId, from: ["draining"], to: "importing" });
    const driver = neo4j.driver(env.NEO4J_URL, neo4j.auth.basic(env.NEO4J_USER, env.NEO4J_PASSWORD));
    const session = driver.session({ database: env.NEO4J_DATABASE, defaultAccessMode: neo4j.session.WRITE });
    try {
      const graph = await withPrivateTempDir("aios-staging-import-", (directory) => installOpenedPair({ client, session, opened, directory, env, maintenance }));
      await transitionJournal(client, { runId: opened.manifest.runId, from: ["importing"], to: "verifying" });
      await verifyInstalledPair({ client, session, graph });
      const readyPair = sealReadyRollback(opened, targetCommit, env);
      await rollbackStore.putImmutable(readyPair.objectId, readyPair.sourceBytes);
      if (!(await rollbackStore.verify(readyPair.objectId, readyPair.digest))) throw new Error("candidate rollback pair failed durable read-back verification");
      await bootExact({ client, maintenance, runId: opened.manifest.runId, objectId: readyPair.objectId, digest: readyPair.digest, commit: targetCommit, mode: "copy-ready", env });
      if (!(await rollbackStore.verify(readyPair.objectId, readyPair.digest))) throw new Error("candidate rollback pair was not durable at ready boundary");
      await rollbackStore.writePointer("last-ready", { runId: opened.manifest.runId, objectId: readyPair.objectId, digest: readyPair.digest, commit: targetCommit, mode: "copy-ready", kind: "rollback" });
      const catchup = await readStagingHead(env);
      if (catchup !== targetCommit) await recordCatchup(client, { commit: catchup, attempts: 0 });
      const cleanupErrors = [];
      for (const retainedId of new Set([prior.objectId, objectId])) {
        if (retainedId !== readyPair.objectId) await rollbackStore.delete(retainedId).catch((error) => cleanupErrors.push(String(error instanceof Error ? error.message : error)));
      }
      return { status: "ready", runId: opened.manifest.runId, objectId: readyPair.objectId, sourceObjectId: objectId, commit: targetCommit, nodes: graph.nodes.length, relationships: graph.relationships.length, catchup: catchup === targetCommit ? null : catchup, cleanupErrors };
    } finally { await session.close(); await driver.close(); }
  } catch (error) {
    if (!destructive) throw error;
    await transitionJournal(client, { runId: opened.manifest.runId, from: ["draining", "importing", "verifying", "booting"], to: "failed", patch: { lastSafeCheckpoint: "ready" } }).catch(() => {});
    try { await releaseDataUseLock(client, "exclusive"); } catch {}
    await rollbackToPrior({ client, prior, failedRunId: opened.manifest.runId, maintenance, rollbackStore, env });
    throw new Error(`paired refresh failed and the prior pair was restored: ${error instanceof Error ? error.message : String(error)}`);
  }
  } finally { await releaseCoordinatorLock(client).catch(() => {}); }
}

async function currentDeployment(maintenance) {
  const active = await maintenance.listActiveDeployments(maintenance.appServiceId);
  const current = active.filter((deployment) => deployment.status === "SUCCESS").sort((a, b) => String(b.meta?.createdAt ?? "").localeCompare(String(a.meta?.createdAt ?? "")))[0];
  const commit = current?.meta?.commitHash ?? current?.meta?.commitSha;
  if (!current || !FULL_SHA.test(String(commit ?? ""))) throw new Error("bootstrap could not measure the current successful staging deployment commit");
  return { deployment: current, commit };
}

async function bootstrapRollback({ client, rollbackStore, maintenance, env }) {
  if (!(await acquireCoordinatorLock(client))) throw new Error("another importer owns the coordinator lock");
  const journal = await readJournal(client);
  if (journal.last_ready_run_id) throw new Error("bootstrap rollback is one-time and last-ready already exists");
  const current = await currentDeployment(maintenance);
  const mode = env.STAGING_BOOTSTRAP_MODE;
  if (!new Set(["legacy-pg-only", "copy-ready"]).has(mode)) throw new Error("STAGING_BOOTSTRAP_MODE must describe the measured current staging mode");
  const runId = `bootstrap-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  try {
    await transitionJournal(client, { runId, from: [journal.state], to: "draining", patch: { lastSafeCheckpoint: journal.state } });
    await maintenance.stopAndVerifyAll();
    if (!(await acquireDataUseLock(client, "exclusive"))) throw new Error("active staging readers prevented rollback bootstrap");
    const created = await withPrivateTempDir("aios-staging-bootstrap-", async (directory) => {
      await captureRollbackPostgres({ client, databaseUrl: env.DATABASE_URL, directory });
      const driver = neo4j.driver(env.NEO4J_URL, neo4j.auth.basic(env.NEO4J_USER, env.NEO4J_PASSWORD));
      const session = driver.session({ database: env.NEO4J_DATABASE, defaultAccessMode: neo4j.session.READ });
      try {
        const graph = await exportGraph(session); const packed = await packPair(directory, graph, { includeAuthUsers: false });
        const manifest = { kind: "staging-rollback", databaseMode: "full", formatVersion: 1, graphCodecVersion: graph.codecVersion, runId,
          captureStartedAt: new Date().toISOString(), captureEndedAt: new Date().toISOString(), expiresAt: "9999-12-31T23:59:59.999Z",
          checksums: packed.checksums, build: { applicationCommit: current.commit, ...(await currentLoaderIdentity(client)) }, targetCommit: current.commit, mode };
        const bundle = createSignedEncryptedBundle({ payload: packed.payload, manifest,
          exporterSigningPrivateKey: keyMaterial(env, "ROLLBACK_SIGNING_PRIVATE_KEY"),
          importerEncryptionPublicKey: keyMaterial(env, "ROLLBACK_ENCRYPTION_PUBLIC_KEY") });
        const bytes = Buffer.from(JSON.stringify(bundle)); const digest = sha(bytes); const objectId = canonicalObjectId(runId, digest);
        await rollbackStore.putImmutable(objectId, bytes);
        if (!(await rollbackStore.verify(objectId, digest))) throw new Error("bootstrap rollback failed durable read-back verification");
        return { objectId, digest };
      } finally { await session.close(); await driver.close(); }
    });
    await transitionJournal(client, { runId, from: ["draining"], to: "booting", patch: { candidateMode: mode } });
    await releaseDataUseLock(client, "exclusive");
    const deploymentId = await maintenance.deployApp(current.commit);
    await waitForImportedBoot({ maintenance, deploymentId, commit: current.commit, origin: env.STAGING_ORIGIN, token: env.STAGING_HEALTH_TOKEN, mode });
    await rollbackStore.writePointer("last-ready", { runId, objectId: created.objectId, digest: created.digest, commit: current.commit, mode, kind: "rollback" });
    await markReady(client, { runId, objectId: created.objectId, digest: created.digest, commit: current.commit, mode });
    return { status: "bootstrapped", runId, objectId: created.objectId, commit: current.commit, mode };
  } catch (error) {
    await transitionJournal(client, { runId, from: ["draining", "booting"], to: "failed", patch: { lastSafeCheckpoint: "bootstrap-failed" } }).catch(() => {});
    await releaseDataUseLock(client, "exclusive").catch(() => {});
    const deploymentId = await maintenance.deployApp(current.commit).catch(() => null);
    if (deploymentId) await waitForImportedBoot({ maintenance, deploymentId, commit: current.commit, origin: env.STAGING_ORIGIN, token: env.STAGING_HEALTH_TOKEN }).catch(() => {});
    throw error;
  } finally { await releaseCoordinatorLock(client).catch(() => {}); }
}

async function serviceCatchup({ client, maintenance, env }) {
  if (!(await acquireCoordinatorLock(client))) return { status: "catchup-busy" };
  try {
    const journal = await readJournal(client);
    if (journal.state !== "ready") return { status: "catchup-deferred", state: journal.state };
    const head = await readStagingHead(env);
    if (head === journal.last_ready_commit) {
      if (journal.catchup_commit) await recordCatchup(client, { commit: null, attempts: 0 });
      return { status: "catchup-current", commit: head };
    }
    const attempts = Number(journal.catchup_attempts ?? 0);
    if (attempts >= Number(env.STAGING_CATCHUP_MAX_ATTEMPTS ?? 5)) throw new Error("bounded staging catch-up attempts exhausted");
    await recordCatchup(client, { commit: head, attempts: attempts + 1 });
    await maintenance.assertPinnedRunnerConfiguration(env.STAGING_IMPORTER_SERVICE_ID, env.STAGING_IMPORTER_IMAGE_DIGEST);
    const rollbackStore = createPrivateStore({ env, scope: "rollback", role: "rollback-owner" });
    const prior = await openPrior({ client, journal, rollbackStore, env });
    const id = await maintenance.deployApp(head);
    await waitForImportedBoot({ maintenance, deploymentId: id, commit: head, origin: env.STAGING_ORIGIN, token: env.STAGING_HEALTH_TOKEN });
    const advanced = sealReadyRollback(prior, head, env);
    await rollbackStore.putImmutable(advanced.objectId, advanced.sourceBytes);
    if (!(await rollbackStore.verify(advanced.objectId, advanced.digest))) throw new Error("catch-up rollback metadata failed durable read-back verification");
    await rollbackStore.writePointer("last-ready", { runId: prior.manifest.runId, objectId: advanced.objectId, digest: advanced.digest, commit: head, mode: advanced.manifest.mode, kind: "rollback" });
    await client.query("UPDATE staging_ops.refresh_journal SET last_ready_object_id=$1, last_ready_digest=$2, last_ready_commit=$3, catchup_commit=NULL, catchup_attempts=0, catchup_error=NULL, updated_at=now() WHERE singleton=true AND state='ready'", [advanced.objectId, advanced.digest, head]);
    if (prior.objectId !== advanced.objectId) await rollbackStore.delete(prior.objectId).catch(() => {});
    return { status: "caught-up", commit: head };
  } catch (error) {
    const journal = await readJournal(client).catch(() => null);
    if (journal?.catchup_commit) await recordCatchup(client, { commit: journal.catchup_commit, attempts: Number(journal.catchup_attempts ?? 0), error: String(error instanceof Error ? error.message : error).slice(0, 500) });
    throw error;
  } finally { await releaseCoordinatorLock(client).catch(() => {}); }
}

async function discoverLatestSource(sourceStore, rollbackStore, env) {
  const objects = await sourceStore.list(); const candidates = [];
  for (const objectId of objects) {
    try {
      const identity = parseCanonicalObjectId(objectId); const bytes = await sourceStore.read(objectId);
      if (sha(bytes) !== identity.digest) continue;
      const opened = openBundleBytes(bytes, env);
      if (opened.manifest.runId === identity.runId) candidates.push({ objectId, ended: Date.parse(opened.manifest.captureEndedAt) });
    } catch {}
  }
  candidates.sort((a, b) => b.ended - a.ended || a.objectId.localeCompare(b.objectId));
  const pointer = await rollbackStore.readPointer("last-ready").catch(() => null);
  return candidates.find((candidate) => parseCanonicalObjectId(candidate.objectId).runId !== pointer?.runId)?.objectId ?? null;
}

export async function importerPreflight(env = process.env, action = "install") {
  assertRunnerRole(env, "importer"); assertOutboundCredentialIsolation(env);
  if (action === "install-ops") return true;
  const common = ["STAGING_COMPARISON_KEY_BASE64", "STAGING_COMPARISON_KEY_ID", "STAGING_NEO4J_SERVICE_NAME", "STAGING_NEO4J_DATABASE"];
  const runtime = ["STAGING_OPS_ENVIRONMENT_ID", "RAILWAY_ENVIRONMENT_ID", "RAILWAY_PROJECT_ID", "STAGING_APP_SERVICE_ID", "STAGING_GRAPHITI_SERVICE_ID", "RAILWAY_STAGING_MAINTENANCE_TOKEN", "STAGING_IMPORTER_SERVICE_ID", "STAGING_IMPORTER_IMAGE_DIGEST"];
  const rollback = [];
  for (const name of [...common, ...(action === "verify" || action === "install-ops" ? [] : runtime), ...rollback]) if (!env[name]) throw new Error(`${name} is required`);
  for (const name of ["EXPORTER_SIGNING_PUBLIC_KEY", "IMPORTER_ENCRYPTION_PRIVATE_KEY", ...(action === "verify" ? [] : ["ROLLBACK_SIGNING_PRIVATE_KEY", "ROLLBACK_SIGNING_PUBLIC_KEY", "ROLLBACK_ENCRYPTION_PUBLIC_KEY", "ROLLBACK_ENCRYPTION_PRIVATE_KEY"])]) keyMaterial(env, name);
  createPrivateStore({ env, scope: "source", role: "source-reader" });
  createPrivateStore({ env, scope: "rollback", role: "rollback-owner" });
  return true;
}

export async function runImporter(env = process.env, argv = process.argv.slice(2)) {
  const action = argv[0];
  if (!new Set(["install-ops", "verify", "install", "bootstrap-rollback", "rollback", "tick", "daemon"]).has(action)) throw new Error("importer action must be install-ops, verify, install, bootstrap-rollback, rollback, tick, or daemon");
  await importerPreflight(env, action);
  const client = new pg.Client({ connectionString: env.DATABASE_URL }); await client.connect();
  let shuttingDown = false;
  const recordSignalAbort = async (signal) => {
    if (shuttingDown) return; shuttingDown = true;
    const abortClient = new pg.Client({ connectionString: env.DATABASE_URL, connectionTimeoutMillis: 5_000 });
    try {
      await abortClient.connect(); const journal = await readJournal(abortClient);
      if (journal.state !== "ready") await transitionJournal(abortClient, { runId: journal.run_id ?? `signal-${Date.now()}`, from: [journal.state], to: "failed", patch: { lastSafeCheckpoint: `aborted-${signal.toLowerCase()}` } });
    } catch {} finally { await abortClient.end().catch(() => {}); }
    process.exit(1);
  };
  for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => { void recordSignalAbort(signal); });
  const sourceStore = action === "install-ops" ? null : createPrivateStore({ env, scope: "source", role: "source-reader" });
  const rollbackStore = action === "install-ops" ? null : createPrivateStore({ env, scope: "rollback", role: "rollback-owner" });
  const maintenance = action === "verify" || action === "install-ops" ? null : maintenanceFor(env);
  try {
    if (action === "install-ops") { await installStagingOps(client); return { status: "installed" }; }
    if (action === "verify") {
      const objectId = argv[1]; if (!objectId) throw new Error("canonical immutable object ID is required");
      const opened = await verifyAndPinSourceBundle({ objectId, sourceStore, rollbackStore, env }); compareEnvironmentCredentials(opened.manifest, env);
      return { status: "verified-and-pinned", runId: opened.manifest.runId, objectId };
    }
    if (action === "bootstrap-rollback") return bootstrapRollback({ client, rollbackStore, maintenance, env });
    if (action === "rollback") {
      if (!(await acquireCoordinatorLock(client))) throw new Error("another importer owns the coordinator lock");
      try { const journal = await readJournal(client); const prior = await openPrior({ client, journal, rollbackStore, env }); return rollbackToPrior({ client, prior, failedRunId: argv[1] ?? `manual-${Date.now()}`, maintenance, rollbackStore, env }); }
      finally { await releaseCoordinatorLock(client).catch(() => {}); }
    }
    if (action === "install") {
      if (!argv[1]) throw new Error("canonical immutable object ID is required");
      return installObject({ client, objectId: argv[1], sourceStore, rollbackStore, maintenance, env });
    }
    const tick = async () => {
      const catchup = await serviceCatchup({ client, maintenance, env });
      const objectId = await discoverLatestSource(sourceStore, rollbackStore, env);
      if (!objectId) return { status: "idle", catchup };
      return installObject({ client, objectId, sourceStore, rollbackStore, maintenance, env });
    };
    if (action === "tick") return tick();
    const interval = Number(env.STAGING_IMPORTER_POLL_MS ?? 300_000);
    if (!Number.isFinite(interval) || interval < 300_000) throw new Error("importer poll interval must be at least five minutes");
    for (;;) { await tick().catch((error) => console.error(`staging importer tick failed: ${error instanceof Error ? error.message : String(error)}`)); await new Promise((resolve) => setTimeout(resolve, interval)); }
  } finally { await client.end(); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) runImporter().then((result) => console.log(JSON.stringify(result))).catch((error) => { console.error(`staging importer refused: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; });
