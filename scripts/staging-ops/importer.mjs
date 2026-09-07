#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";
import neo4j from "neo4j-driver";
import { openSignedEncryptedBundle, createSignedEncryptedBundle } from "./bundle-crypto.mjs";
import { packPair, unpackPair, validatePairManifest } from "./bundle-format.mjs";
import { assertCompatibleBuildIdentity, assertInstalledSchemaMatches, loaderCapabilityIdentity, schemaFingerprintDigest } from "./build-identity.mjs";
import { credentialFingerprint, assertDistinctFingerprints } from "./credential-fingerprint.mjs";
import {
  installStagingOps, acquireCoordinatorLock, acquireDataUseLock, releaseCoordinatorLock,
  releaseDataUseLock, readJournal, transitionJournal, markReady, recordCatchup,
  hasCoordinatorLock, hasExclusiveDataUseLock, recordSourceWatermark,
} from "./journal.mjs";
import { assertActionConfiguration } from "./action-preflight.mjs";
import { assertActivated, runActivationPreflight } from "./activation-preflight.mjs";
import { assertStagingTopology } from "./config.mjs";
import { replaceNeo4jGraph, assertReplaceTarget } from "./neo4j-replace.mjs";
import { captureRollbackPostgres, resetSessionTransactionState, restorePairedPostgres, restoreRollbackPostgres } from "./pg-paired.mjs";
import { withPrivateTempDir } from "./private-store.mjs";
import { canonicalObjectId, createPrivateStore, parseCanonicalObjectId } from "./object-store.mjs";
import { assertOutboundCredentialIsolation, assertRunnerRole } from "./role-policy.mjs";
import { fingerprint } from "../schema-fingerprint.mjs";
import { RailwayMaintenance } from "./railway-maintenance.mjs";
import { LocalMaintenance } from "./local-maintenance.mjs";
import { exportGraph, GRAPH_CODEC_VERSION, validateGraphShape } from "./graph-bundle.mjs";
import { decodeNeo4jValue } from "./neo4j-codec.mjs";
import { snapshotExportFacts, validateLedgerAgainstSanitizedGraph, assertResolvedCorrectionScopes } from "./exporter.mjs";
import { keyMaterial } from "./key-material.mjs";

const exec = promisify(execFile);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const FULL_SHA = /^[0-9a-f]{40}$/i;

const errorText = (error) => String(error instanceof Error ? error.message : error);

/**
 * Run one best-effort recovery step and RECORD its failure instead of swallowing it.
 *
 * These steps are individually non-fatal — a journal transition whose `from` state no longer
 * matches, a lock release on a lock that is already gone — which is why they were `.catch(() => {})`.
 * But the same swallow also hid the case that matters: every one of them failing at once because
 * the session is in an aborted transaction, while the caller went on to report a successful
 * rollback. Collected notes travel into the thrown message so the operator sees what did not happen.
 */
async function recoveryStep(label, action, notes) {
  try { await action(); return true; }
  catch (error) { notes.push(`${label} failed: ${errorText(error).slice(0, 200)}`); return false; }
}

const withNotes = (message, notes) => (notes.length ? `${message} [recovery notes: ${notes.join("; ")}]` : message);

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

/**
 * The canonical application-schema lines of a LIVE database, with the staging discriminator removed.
 *
 * `staging_marker` is deliberately outside the canonical schema (it exists on staging and nowhere
 * else), so it must fence staging without making the same application schema look incompatible.
 *
 * This measures a target; it is NOT loader identity. See `loaderCapabilityIdentity` — B4.
 */
async function measuredSchemaLines(client) {
  return (await fingerprint(client)).filter((line) => !line.includes("\tstaging_marker") && !line.includes("\tstaging_marker."));
}

/**
 * M2: prove the captured graph can actually be REPLAYED before the checkpoint is accepted.
 *
 * "It dumped without error" is not that proof — the bootstrap checkpoint is the only thing standing
 * between a failed first import and an unrecoverable staging, so the codec version, the shape the
 * replayer validates, and a decode of every property through the very codec the restore will use
 * are all exercised here, while the original data is still in place and nothing has been touched.
 */
export function assertReplayableGraph(graph) {
  if (graph?.codecVersion !== GRAPH_CODEC_VERSION) throw new Error(`bootstrap capture has unsupported graph codec version ${graph?.codecVersion}`);
  validateGraphShape(graph);
  for (const node of graph.nodes) decodeNeo4jValue(node.properties);
  for (const rel of graph.relationships) decodeNeo4jValue(rel.properties);
  return { nodes: graph.nodes.length, relationships: graph.relationships.length };
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
  // Prove the pinned staging target BEFORE the first destructive Postgres write, not only before
  // the graph delete. The same measured facts then authorise the marker repair inside the restore:
  // re-materialising a staging discriminator is only safe on a target whose staging identity has
  // been independently established (H1) — a database URL is not that proof.
  const facts = await measuredReplaceFacts({ client, maintenance, env, opened });
  assertReplaceTarget(facts);
  const restore = { client, databaseUrl: env.DATABASE_URL, directory, verifiedStagingTarget: true };
  if (opened.manifest.databaseMode === "full") await restoreRollbackPostgres({ ...restore, env: { ...env, STAGING_DATA_MODE: opened.manifest.mode } });
  else await restorePairedPostgres({ ...restore, env });
  if (opened.manifest.kind !== "staging-rollback" && env.STAGING_PAIR_REQUIRED === "1" && env.STAGING_FAULT_POINT === "after-postgres") throw new Error("injected harness fault after Postgres restore");
  if (opened.manifest.kind !== "staging-rollback" && env.STAGING_PAIR_REQUIRED === "1" && env.STAGING_HARNESS_PAUSE_AFTER_POSTGRES_MS) {
    const pause = Number(env.STAGING_HARNESS_PAUSE_AFTER_POSTGRES_MS);
    if (!Number.isFinite(pause) || pause < 1 || pause > 120_000) throw new Error("invalid bounded harness pause");
    await new Promise((resolve) => setTimeout(resolve, pause));
  }
  await reapplyTesters(env);
  // Re-measured, not reused: the stop/lock facts must hold at the moment of the graph delete too.
  await replaceNeo4jGraph({ session, graph, facts: await measuredReplaceFacts({ client, maintenance, env, opened }) });
  if (opened.manifest.kind !== "staging-rollback" && env.STAGING_PAIR_REQUIRED === "1" && env.STAGING_FAULT_POINT === "after-graph") throw new Error("injected harness fault after graph restore");
  return graph;
}

/**
 * Verify what actually landed. Applies to BOTH kinds of pair (M2): a rollback envelope used to skip
 * dataset verification entirely, so "the prior pair was restored" was an assertion about a restore
 * command's exit status rather than about the data.
 *
 * `sanitationExpected` is the one legitimate difference: a sanitized SOURCE bundle must contain no
 * credential/outbound rows at all, while a full staging rollback capture is expected to carry back
 * whatever staging itself held (including its own tester credentials).
 */
async function verifyInstalledPair({ client, session, graph, opened, sanitationExpected = true }) {
  if (sanitationExpected) {
    const credentialCounts = await client.query(`SELECT
      (SELECT count(*) FROM auth_tokens)+(SELECT count(*) FROM api_keys)+(SELECT count(*) FROM agent_tokens)+
      (SELECT count(*) FROM integrations)+(SELECT count(*) FROM member_secrets)+(SELECT count(*) FROM social_jobs)+
      (SELECT count(*) FROM llm_usage)+(SELECT count(*) FROM usage_costs) AS forbidden_count`);
    if (Number(credentialCounts.rows[0]?.forbidden_count ?? -1) !== 0) throw new Error("post-import credential/outbound queue sanitation verification failed");
  }
  const installedGraph = await exportGraph(session);
  // The census applies to EVERY pair: whatever was verified in the bundle is what must now be in
  // the target, legacy or copy-ready.
  if (installedGraph.nodes.length !== graph.nodes.length || installedGraph.relationships.length !== graph.relationships.length) throw new Error("installed graph census differs from verified bundle");
  // The ledger↔graph correspondence is a COPY-READY contract. `legacy-pg-only` has documented
  // empty-graph semantics — its Postgres never carried `graph_episodes` — so demanding an episode
  // per ledger row of a legacy checkpoint would fail a correct restore, and passing it silently
  // would prove nothing. It is asked only where it means something.
  const mode = opened.manifest.mode ?? "copy-ready";
  if (mode !== "legacy-pg-only") {
    const facts = await snapshotExportFacts(client);
    assertResolvedCorrectionScopes(facts);
    validateLedgerAgainstSanitizedGraph(installedGraph, facts);
  } else {
    const ledger = await client.query("SELECT count(*)::int AS rows FROM graph_episodes");
    if (Number(ledger.rows[0]?.rows ?? -1) !== 0 || installedGraph.nodes.length !== 0) {
      throw new Error(`legacy-pg-only checkpoint restored ${ledger.rows[0]?.rows} ledger rows and ${installedGraph.nodes.length} graph nodes; legacy mode has empty-graph semantics`);
    }
  }
  // B4 "verify installed result": the catalog the app will actually run against, against the digest
  // the payload declared. A difference is a named diagnostic, never an invented upgrade path.
  assertInstalledSchemaMatches(opened.manifest.build?.schemaFingerprint, await measuredSchemaLines(client), {
    context: `installed ${opened.kind} pair ${opened.manifest.runId}`,
  });
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

async function pollDeployedHealth({ maintenance, deploymentId, origin, token, bootProbe, accept, fetchImpl, timeoutMs, sleep, description }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const deployment = await maintenance.readDeployment(deploymentId);
    if (new Set(["FAILED", "CRASHED", "REMOVED"]).has(deployment.status)) throw new Error(`fresh staging deployment failed in ${deployment.status}`);
    if (deployment.status === "SUCCESS" || deployment.status === "DEPLOYING") {
      const response = await fetchImpl(new URL("/api/health", origin), {
        redirect: "manual",
        headers: { "x-aios-staging-health-token": token, ...(bootProbe ? { "x-aios-staging-boot-probe": "true" } : {}) },
        signal: AbortSignal.timeout(10_000),
      }).catch(() => null);
      const body = await response?.json().catch(() => ({}));
      if (response && accept(response.status, body ?? {})) return true;
    }
    await sleep(5_000);
  }
  throw new Error(`fresh staging deployment did not pass ${description}`);
}

/**
 * INSTALL boot probe — deliberately narrow. During installation the journal is `booting`, so the
 * app answers the privileged probe with 202 + `booted`, and only that (or the legacy 200 shape)
 * is accepted: a plain 200 would mean the journal already says ready, which during an install
 * means something else advanced it.
 */
export async function waitForImportedBoot({ maintenance, deploymentId, commit, origin, token, mode = "copy-ready", fetchImpl = fetch, timeoutMs = 300_000, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  return pollDeployedHealth({
    maintenance, deploymentId, origin, token, bootProbe: true, fetchImpl, timeoutMs, sleep,
    description: "the bounded authenticated boot probe",
    accept: (status, body) =>
      (status === 202 && body.booted === true && body.commit === commit) ||
      (mode === "legacy-pg-only" && status === 200 && body.ok === true && body.mode === mode && body.commit === commit),
  });
}

/**
 * CATCH-UP probe — the journal is `ready` the whole time, so the correct health answer is a 200
 * whose mode, commit and refresh run all match what this journal says is installed.
 *
 * The install probe cannot be reused here: it admits only 202-booted (or legacy 200), and a
 * caught-up app answers 200 `copy-ready`. Every catch-up therefore "timed out" after successfully
 * deploying, burning an attempt each time and eventually exhausting the bounded budget.
 */
export async function waitForExpectedReady({ maintenance, deploymentId, commit, origin, token, mode, runId, fetchImpl = fetch, timeoutMs = 300_000, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  if (!mode || !runId) throw new Error("an expected-ready probe requires the canonical mode and refresh run identity");
  return pollDeployedHealth({
    maintenance, deploymentId, origin, token, bootProbe: false, fetchImpl, timeoutMs, sleep,
    description: `the bounded expected-ready probe for run ${runId}`,
    accept: (status, body) =>
      status === 200 && body.ok === true && body.commit === commit && body.mode === mode && body.refreshRunId === runId,
  });
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
  assertCompatibleBuildIdentity(opened.manifest.build, loaderCapabilityIdentity());
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
  // B1: `boot_run_id`/`boot_commit` are the SELECTED deployment identity that the schema loader and
  // the startup fence both admit on. They are separate from `catchup_commit`, which means something
  // else entirely (an outstanding branch head to deploy later) and was previously overloaded.
  await transitionJournal(client, { runId, from: ["verifying", "importing"], to: "booting", patch: { candidateMode: mode, bootRunId: runId, bootCommit: commit } });
  await releaseDataUseLock(client, "exclusive");
  const deploymentId = await maintenance.deployApp(commit);
  await waitForImportedBoot({ maintenance, deploymentId, commit, origin: env.STAGING_ORIGIN, token: env.STAGING_HEALTH_TOKEN, mode });
  return { deploymentId, ready: await markReady(client, { runId, objectId, digest, commit, mode }) };
}

/**
 * Reacquire the exclusive data-use lock with a BOUNDED wait.
 *
 * A bare `try` fails the moment a shared holder is still finishing its shutdown — routine after a
 * stop — and on the rollback path that turns a recoverable state into "recovery required". An
 * unbounded `pg_advisory_lock` is the opposite failure: it would hang the runner forever behind a
 * wedged reader. Retry on a bounded schedule, then refuse with a clear reason.
 */
async function acquireExclusiveDataUseLock(client, env, context, { sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  const timeoutMs = Number(env.STAGING_DATA_LOCK_TIMEOUT_MS ?? 60_000);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 600_000) throw new Error("STAGING_DATA_LOCK_TIMEOUT_MS must be 1000..600000");
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await acquireDataUseLock(client, "exclusive")) return true;
    if (Date.now() >= deadline) throw new Error(`active staging data-use readers prevented ${context} within ${timeoutMs}ms`);
    await sleep(1_000);
  }
}

export async function rollbackToPrior({ client, prior, failedRunId, maintenance, rollbackStore, env, notes = [] }) {
  // FIRST statement of the recovery path, before the journal write, before the advisory lock, and
  // before the marker read inside the restore. Whatever failed may have left this connection in an
  // aborted transaction, in which case all three fail — and the pre-existing `.catch(() => {})`
  // around the journal write made two of those failures invisible.
  const reset = await resetSessionTransactionState(client);
  if (reset.status !== "reset") {
    notes.push(`session reset failed: ${reset.detail}`);
    await recoveryStep("recovery-required journal transition", () => transitionJournal(client, { runId: failedRunId, from: ["draining", "importing", "verifying", "booting", "failed", "ready"], to: "failed", patch: { lastSafeCheckpoint: "recovery-required" } }), notes);
    throw new Error(withNotes("the importer's database session is unusable, so NO rollback was attempted; staging remains fenced and recovery is required", notes));
  }
  let driver = null;
  let session = null;
  try {
    // Stopping the services and reacquiring the exclusive lock used to sit OUTSIDE this block, so a
    // failure in either escaped raw — after the services were already stopped — and neither reached
    // the recovery-required checkpoint below nor said what state staging had been left in.
    await recoveryStep("draining journal transition", () => transitionJournal(client, { runId: failedRunId, from: ["failed", "booting", "importing", "verifying", "draining"], to: "draining", patch: { lastSafeCheckpoint: "rollback" } }), notes);
    await maintenance.stopAndVerifyAll();
    await acquireExclusiveDataUseLock(client, env, "rollback");
    driver = neo4j.driver(env.NEO4J_URL, neo4j.auth.basic(env.NEO4J_USER, env.NEO4J_PASSWORD));
    session = driver.session({ database: env.NEO4J_DATABASE, defaultAccessMode: neo4j.session.WRITE });
    if (env.STAGING_PAIR_REQUIRED === "1" && env.STAGING_FAULT_ROLLBACK === "1") throw new Error("injected harness rollback failure");
    await transitionJournal(client, { runId: prior.manifest.runId, from: ["draining", "failed"], to: "importing" });
    const graph = await withPrivateTempDir("aios-staging-rollback-", (directory) => installOpenedPair({ client, session, opened: prior, directory, env, maintenance }));
    await transitionJournal(client, { runId: prior.manifest.runId, from: ["importing"], to: "verifying" });
    // M2: BOTH kinds are verified against the data that landed. A full staging capture legitimately
    // carries staging's own credentials, so only the source-sanitation assertion is conditional.
    await verifyInstalledPair({ client, session, graph, opened: prior, sanitationExpected: prior.kind === "source" });
    await rollbackStore.putImmutable(prior.objectId, prior.sourceBytes);
    await bootExact({ client, maintenance, runId: prior.manifest.runId, objectId: prior.objectId, digest: prior.digest, commit: prior.manifest.targetCommit, mode: prior.manifest.mode, env });
    await rollbackStore.writePointer("last-ready", { runId: prior.manifest.runId, objectId: prior.objectId, digest: prior.digest, commit: prior.manifest.targetCommit, mode: prior.manifest.mode, kind: prior.kind });
    return { status: "rolled-back", runId: prior.manifest.runId, recoveryNotes: notes };
  } catch (error) {
    // The checkpoint write is itself SQL on a connection that has just failed, so reset again and
    // report whether the checkpoint actually landed rather than assuming it did.
    const checkpointReset = await resetSessionTransactionState(client);
    if (checkpointReset.status !== "reset") notes.push(`session reset before the recovery checkpoint failed: ${checkpointReset.detail}`);
    await recoveryStep("recovery-required journal transition", () => transitionJournal(client, { runId: failedRunId, from: ["draining", "importing", "verifying", "booting"], to: "failed", patch: { lastSafeCheckpoint: "recovery-required" } }), notes);
    throw new Error(withNotes(`paired rollback failed; staging remains fenced and recovery is required: ${errorText(error)}`, notes));
  } finally { await session?.close(); await driver?.close(); }
}

async function installObject({ client, objectId, sourceStore, rollbackStore, maintenance, env }) {
  const opened = await verifyAndPinSourceBundle({ objectId, sourceStore, rollbackStore, env });
  compareEnvironmentCredentials(opened.manifest, env);
  // B4: compatibility is against this pinned runner image's OWN loader capability, never against
  // the live target catalog — the catalog is the thing being replaced, and reading it here both
  // blocked legitimate staging-only schema changes and made a half-installed target unrecoverable.
  assertCompatibleBuildIdentity(opened.manifest.build, loaderCapabilityIdentity());
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
    // The idempotent repair path: `markReady` may have committed and the process then died before
    // the durable pointer was written. Re-writing the pointer from the JOURNAL (the authority) is
    // safe to repeat, and the watermark advance below is what stops discovery re-offering this run.
    await rollbackStore.writePointer("last-ready", {
      runId: journal.last_ready_run_id, objectId: journal.last_ready_object_id,
      digest: journal.last_ready_digest, commit: journal.last_ready_commit,
      mode: journal.last_ready_mode, kind: "rollback",
    });
    await recordSourceWatermark(client, { capturedAt: opened.manifest.captureEndedAt, runId: opened.manifest.runId });
    if (objectId !== journal.last_ready_object_id) await rollbackStore.delete(objectId).catch(() => {});
    return { status: "already-ready", runId: opened.manifest.runId, objectId: journal.last_ready_object_id };
  }
  // B3: never install a capture older than the newest one already installed. Without a durable
  // watermark, discovery that skipped the installed newest run simply picked the SECOND newest —
  // an older bundle — and the next run picked the newest again, oscillating staging forever.
  const watermark = journal.source_watermark ? Date.parse(journal.source_watermark) : null;
  const captured = Date.parse(opened.manifest.captureEndedAt);
  if (!Number.isFinite(captured)) throw new Error("source bundle declares no parseable capture end");
  if (watermark !== null && Number.isFinite(watermark) && captured <= watermark) {
    throw new Error(`source run ${opened.manifest.runId} captured at or before the installed watermark; refusing to move staging backwards`);
  }
  const targetCommit = await readStagingHead(env);
  let destructive = false;
  try {
    await maintenance.assertPinnedRunnerConfiguration(env.STAGING_IMPORTER_SERVICE_ID, env.STAGING_IMPORTER_IMAGE_DIGEST);
    await transitionJournal(client, { runId: opened.manifest.runId, from: ["ready", "failed"], to: "draining", patch: { lastSafeCheckpoint: "ready", candidateRunId: opened.manifest.runId, candidateObjectId: objectId, candidateDigest: opened.digest, candidateMode: "copy-ready", catchupCommit: targetCommit } });
    destructive = true;
    await maintenance.stopAndVerifyAll();
    await acquireExclusiveDataUseLock(client, env, "import");
    await transitionJournal(client, { runId: opened.manifest.runId, from: ["draining"], to: "importing" });
    const driver = neo4j.driver(env.NEO4J_URL, neo4j.auth.basic(env.NEO4J_USER, env.NEO4J_PASSWORD));
    const session = driver.session({ database: env.NEO4J_DATABASE, defaultAccessMode: neo4j.session.WRITE });
    try {
      const graph = await withPrivateTempDir("aios-staging-import-", (directory) => installOpenedPair({ client, session, opened, directory, env, maintenance }));
      await transitionJournal(client, { runId: opened.manifest.runId, from: ["importing"], to: "verifying" });
      await verifyInstalledPair({ client, session, graph, opened });
      const readyPair = sealReadyRollback(opened, targetCommit, env);
      await rollbackStore.putImmutable(readyPair.objectId, readyPair.sourceBytes);
      if (!(await rollbackStore.verify(readyPair.objectId, readyPair.digest))) throw new Error("candidate rollback pair failed durable read-back verification");
      await bootExact({ client, maintenance, runId: opened.manifest.runId, objectId: readyPair.objectId, digest: readyPair.digest, commit: targetCommit, mode: "copy-ready", env });
      if (!(await rollbackStore.verify(readyPair.objectId, readyPair.digest))) throw new Error("candidate rollback pair was not durable at ready boundary");
      await rollbackStore.writePointer("last-ready", { runId: opened.manifest.runId, objectId: readyPair.objectId, digest: readyPair.digest, commit: targetCommit, mode: "copy-ready", kind: "rollback" });
      await recordSourceWatermark(client, { capturedAt: opened.manifest.captureEndedAt, runId: opened.manifest.runId });
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
    const notes = [];
    // BEFORE the journal write and BEFORE the lock release, both of which are SQL on the connection
    // the failed loader/restore may have left in an aborted transaction. Measured on PG18: with the
    // reset missing, this transition and the release both fail silently and the rollback path then
    // fails on its own first statement — while the message below still said the prior pair had been
    // restored. The lock is released on the SAME backend, so the reset must not reconnect.
    const reset = await resetSessionTransactionState(client);
    if (reset.status !== "reset") notes.push(`session reset failed: ${reset.detail}`);
    const usable = reset.status === "reset";
    await recoveryStep("failed-state journal transition", () => transitionJournal(client, { runId: opened.manifest.runId, from: ["draining", "importing", "verifying", "booting"], to: "failed", patch: { lastSafeCheckpoint: usable ? "ready" : "recovery-required" } }), notes);
    await recoveryStep("exclusive data-use lock release", () => releaseDataUseLock(client, "exclusive"), notes);
    if (!usable) {
      // Never call a rollback the session cannot execute, and never describe one that did not run.
      throw new Error(withNotes(`paired refresh failed and the importer's database session could not be reset, so the prior pair was NOT restored; staging remains fenced and recovery is required: ${errorText(error)}`, notes));
    }
    await rollbackToPrior({ client, prior, failedRunId: opened.manifest.runId, maintenance, rollbackStore, env, notes });
    throw new Error(withNotes(`paired refresh failed and the prior pair was restored: ${errorText(error)}`, notes));
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
    await acquireExclusiveDataUseLock(client, env, "rollback bootstrap");
    const created = await withPrivateTempDir("aios-staging-bootstrap-", async (directory) => {
      await captureRollbackPostgres({ client, databaseUrl: env.DATABASE_URL, directory });
      const driver = neo4j.driver(env.NEO4J_URL, neo4j.auth.basic(env.NEO4J_USER, env.NEO4J_PASSWORD));
      const session = driver.session({ database: env.NEO4J_DATABASE, defaultAccessMode: neo4j.session.READ });
      try {
        const graph = await exportGraph(session);
        // M2: prove the captured graph is REPLAYABLE before this checkpoint is accepted as the
        // thing recovery depends on. Codec version, shape and a round trip through the same codec
        // the restore will use — a checkpoint that cannot be replayed is not a checkpoint.
        assertReplayableGraph(graph);
        const packed = await packPair(directory, graph, { includeAuthUsers: false });
        const manifest = { kind: "staging-rollback", databaseMode: "full", formatVersion: 1, graphCodecVersion: graph.codecVersion, runId,
          captureStartedAt: new Date().toISOString(), captureEndedAt: new Date().toISOString(), expiresAt: "9999-12-31T23:59:59.999Z",
          checksums: packed.checksums,
          // The measured deployment commit AND the measured catalog of the very database being
          // captured. Both are facts about this checkpoint, so a later rollback can check the
          // installed result against them rather than trusting the restore's exit status.
          build: {
            applicationCommit: current.commit,
            schemaFingerprint: schemaFingerprintDigest(await measuredSchemaLines(client)),
            migrationSet: loaderCapabilityIdentity().migrationSet,
          },
          targetCommit: current.commit, mode };
        const bundle = createSignedEncryptedBundle({ payload: packed.payload, manifest,
          exporterSigningPrivateKey: keyMaterial(env, "ROLLBACK_SIGNING_PRIVATE_KEY"),
          importerEncryptionPublicKey: keyMaterial(env, "ROLLBACK_ENCRYPTION_PUBLIC_KEY") });
        const bytes = Buffer.from(JSON.stringify(bundle)); const digest = sha(bytes); const objectId = canonicalObjectId(runId, digest);
        await rollbackStore.putImmutable(objectId, bytes);
        if (!(await rollbackStore.verify(objectId, digest))) throw new Error("bootstrap rollback failed durable read-back verification");
        // Read the sealed object BACK through the ordinary open path: signature, decryption,
        // manifest validity and checksums, exactly as a real rollback would.
        const readBack = openBundleBytes(await rollbackStore.read(objectId), env, "rollback", { ignoreExpiry: true });
        if (readBack.manifest.runId !== runId || readBack.manifest.build?.applicationCommit !== current.commit) {
          throw new Error("bootstrap checkpoint failed its durable read-back identity check");
        }
        return { objectId, digest };
      } finally { await session.close(); await driver.close(); }
    });
    await transitionJournal(client, { runId, from: ["draining"], to: "booting", patch: { candidateMode: mode, bootRunId: runId, bootCommit: current.commit } });
    await releaseDataUseLock(client, "exclusive");
    const deploymentId = await maintenance.deployApp(current.commit);
    await waitForImportedBoot({ maintenance, deploymentId, commit: current.commit, origin: env.STAGING_ORIGIN, token: env.STAGING_HEALTH_TOKEN, mode });
    await rollbackStore.writePointer("last-ready", { runId, objectId: created.objectId, digest: created.digest, commit: current.commit, mode, kind: "rollback" });
    await markReady(client, { runId, objectId: created.objectId, digest: created.digest, commit: current.commit, mode });
    return { status: "bootstrapped", runId, objectId: created.objectId, commit: current.commit, mode };
  } catch (error) {
    const notes = [];
    // Same ordering rule as the refresh path: the capture holds a read-only transaction on this
    // client, so a failure inside it can leave the session aborted and every recovery statement
    // below — the lock release and both journal transitions — would fail invisibly.
    const reset = await resetSessionTransactionState(client);
    if (reset.status !== "reset") notes.push(`session reset failed: ${reset.detail}`);
    await recoveryStep("exclusive data-use lock release", () => releaseDataUseLock(client, "exclusive"), notes);
    // Bootstrap performs no destructive database write, so recovery is exactly "put the UNCHANGED
    // deployment back". Two things this has to get right:
    //  - the journal must ADMIT that restart. Going straight to `failed` fences the very process
    //    recovery depends on, because the loader and startup fence both refuse a failed journal.
    //  - the probe must use the mode staging ACTUALLY runs in. Defaulting it to `copy-ready` meant a
    //    legacy-pg-only baseline could never satisfy it, and a successful restart was reported as a
    //    failed one.
    let restored = false;
    try {
      await transitionJournal(client, { runId, from: ["draining", "booting", "failed"], to: "booting", patch: { candidateMode: mode, bootRunId: runId, bootCommit: current.commit } });
      const deploymentId = await maintenance.deployApp(current.commit);
      await waitForImportedBoot({ maintenance, deploymentId, commit: current.commit, origin: env.STAGING_ORIGIN, token: env.STAGING_HEALTH_TOKEN, mode });
      restored = true;
    } catch (restoreError) { restored = false; notes.push(`deployment restart failed: ${errorText(restoreError).slice(0, 200)}`); }
    await recoveryStep("bootstrap checkpoint journal transition", () => transitionJournal(client, {
      runId, from: ["draining", "booting", "failed"], to: "failed",
      patch: { lastSafeCheckpoint: restored ? "bootstrap-failed-prior-restored" : "recovery-required" },
    }), notes);
    throw new Error(withNotes(`${errorText(error)} (prior staging deployment ${restored ? "restored unchanged" : "NOT restored — run `importer rollback` or restore the deployment explicitly"})`, notes));
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
    // A SUPERSEDING head is a new target and gets its own attempt budget; the exhausted budget for
    // the old target is not a permanent wedge that only a human can clear. Exhaustion against the
    // SAME head stays loud and stays failed.
    const sameTarget = journal.catchup_commit === head;
    const attempts = sameTarget ? Number(journal.catchup_attempts ?? 0) : 0;
    if (attempts >= Number(env.STAGING_CATCHUP_MAX_ATTEMPTS ?? 5)) throw new Error(`bounded staging catch-up attempts exhausted for ${head}`);
    await recordCatchup(client, { commit: head, attempts: attempts + 1 });
    await maintenance.assertPinnedRunnerConfiguration(env.STAGING_IMPORTER_SERVICE_ID, env.STAGING_IMPORTER_IMAGE_DIGEST);
    const rollbackStore = createPrivateStore({ env, scope: "rollback", role: "rollback-owner" });
    const prior = await openPrior({ client, journal, rollbackStore, env });
    const id = await maintenance.deployApp(head);
    // B2: catch-up NEVER leaves the journal, so the app answers `ready`, not `booting`. The correct
    // acceptance is therefore the exact expected-ready shape — mode, commit AND the canonical
    // installed run — not the install path's 202-booted probe, which no caught-up app can satisfy.
    await waitForExpectedReady({
      maintenance, deploymentId: id, commit: head,
      origin: env.STAGING_ORIGIN, token: env.STAGING_HEALTH_TOKEN,
      mode: journal.last_ready_mode, runId: journal.last_ready_run_id,
    });
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

/**
 * B3: pick the newest capture STRICTLY newer than the durable watermark, or nothing.
 *
 * The previous rule was "newest run that isn't the one the pointer names", which reads as a
 * skip-the-installed-one rule but is a downgrade rule: when the newest run IS installed, it selects
 * the SECOND newest — an older bundle — installs it, and the next tick selects the newest again.
 * Staging then oscillated between two weekly bundles indefinitely. "Newest already installed" must
 * mean idle.
 *
 * A candidate whose capture end is missing, unparseable or expired is never a reason to downgrade:
 * it is skipped, and the watermark stands. Equal timestamps are ambiguous rather than newer, so
 * they are refused too — advancing on `>=` would reintroduce the oscillation between two runs that
 * share a capture end.
 */
export async function discoverLatestSource(sourceStore, journal, env) {
  const watermark = journal?.source_watermark ? Date.parse(journal.source_watermark) : null;
  const floor = Number.isFinite(watermark) ? watermark : null;
  const objects = await sourceStore.list();
  const candidates = [];
  for (const objectId of objects) {
    try {
      const identity = parseCanonicalObjectId(objectId);
      const bytes = await sourceStore.read(objectId);
      if (sha(bytes) !== identity.digest) continue;
      const opened = openBundleBytes(bytes, env);
      if (opened.manifest.runId !== identity.runId) continue;
      const ended = Date.parse(opened.manifest.captureEndedAt);
      if (!Number.isFinite(ended)) continue;
      if (floor !== null && ended <= floor) continue;
      if (opened.manifest.runId === journal?.source_watermark_run_id) continue;
      candidates.push({ objectId, ended });
    } catch {}
  }
  candidates.sort((a, b) => b.ended - a.ended || a.objectId.localeCompare(b.objectId));
  // A tie at the top is ambiguous identity, not a newest run; refuse rather than pick arbitrarily.
  if (candidates.length > 1 && candidates[0].ended === candidates[1].ended) {
    throw new Error(`two source runs share capture end ${new Date(candidates[0].ended).toISOString()}; refusing an ambiguous newest-run selection`);
  }
  return candidates[0]?.objectId ?? null;
}

/**
 * The read-only topology check, with a real caller.
 *
 * `assertStagingTopology` validates branch names, distinct pinned IDs, internal hosts and variable
 * REFERENCE SHAPES from a supplied facts document. It reads no variable VALUES and touches no
 * provider API, so it is safe to run from `verify`. When no document is configured, that is
 * reported as NOT SUPPLIED — an unsupplied check must not read as a passed one.
 */
export function verifyConfiguredTopology(env = process.env) {
  const file = env.STAGING_TOPOLOGY_FILE;
  if (!file) return { status: "not-supplied", detail: "set STAGING_TOPOLOGY_FILE to the measured topology facts document" };
  const topology = JSON.parse(readFileSync(file, "utf8"));
  assertStagingTopology(topology);
  return { status: "verified", file };
}

export async function importerPreflight(env = process.env, action = "install") {
  assertRunnerRole(env, "importer"); assertOutboundCredentialIsolation(env);
  if (action === "install-ops") return true;
  const common = ["STAGING_COMPARISON_KEY_BASE64", "STAGING_COMPARISON_KEY_ID", "STAGING_NEO4J_SERVICE_NAME", "STAGING_NEO4J_DATABASE"];
  const runtime = ["STAGING_OPS_ENVIRONMENT_ID", "RAILWAY_ENVIRONMENT_ID", "RAILWAY_PROJECT_ID", "STAGING_APP_SERVICE_ID", "STAGING_GRAPHITI_SERVICE_ID", "RAILWAY_STAGING_MAINTENANCE_TOKEN", "STAGING_IMPORTER_SERVICE_ID", "STAGING_IMPORTER_IMAGE_DIGEST"];
  const rollback = [];
  for (const name of [...common, ...(action === "verify" || action === "install-ops" ? [] : runtime), ...rollback]) if (!env[name]) throw new Error(`${name} is required`);
  for (const name of ["EXPORTER_SIGNING_PUBLIC_KEY", "IMPORTER_ENCRYPTION_PRIVATE_KEY", ...(action === "verify" ? [] : ["ROLLBACK_SIGNING_PRIVATE_KEY", "ROLLBACK_SIGNING_PUBLIC_KEY", "ROLLBACK_ENCRYPTION_PUBLIC_KEY", "ROLLBACK_ENCRYPTION_PRIVATE_KEY"])]) keyMaterial(env, name);
  // H2: the settings this ACTION reaches for later — origin, health token, tester credentials —
  // validated here, before anything can drain, stop, restore or delete.
  assertActionConfiguration(env, action);
  createPrivateStore({ env, scope: "source", role: "source-reader" });
  createPrivateStore({ env, scope: "rollback", role: "rollback-owner" });
  return true;
}

export async function runImporter(env = process.env, argv = process.argv.slice(2), { activationRunner = runActivationPreflight } = {}) {
  const action = argv[0];
  if (!new Set(["install-ops", "verify", "install", "bootstrap-rollback", "rollback", "tick", "daemon", "activation-preflight"]).has(action)) throw new Error("importer action must be install-ops, verify, install, bootstrap-rollback, rollback, tick, daemon, or activation-preflight");
  // The activation verifier is READ-ONLY and needs no database, no locks and no runner role: it is
  // the check an operator runs BEFORE any of this is turned on, and making it depend on the runtime
  // it is supposed to authorise would be circular. It refuses on `UNVERIFIED` as well as on
  // `NOT ACTIVATED` — "we could not look" is not permission.
  if (action === "activation-preflight") {
    const result = await activationRunner(env);
    console.log(result.report);
    assertActivated(result);
    return { status: result.status, checks: result.checks };
  }
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
      return { status: "verified-and-pinned", runId: opened.manifest.runId, objectId, topology: verifyConfiguredTopology(env) };
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
      // Selection reads the watermark unlocked and `installObject` RE-CHECKS it while holding the
      // coordinator lock, so a concurrent worker cannot install between the two.
      const objectId = await discoverLatestSource(sourceStore, await readJournal(client), env);
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
