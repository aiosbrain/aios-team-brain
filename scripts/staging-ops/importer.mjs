#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import neo4j from "neo4j-driver";
import { openSignedEncryptedBundle, createSignedEncryptedBundle, isAuthenticatedRollbackProvenance, rollbackOpeningProvenance } from "./bundle-crypto.mjs";
import { packPair, unpackPair, validatePairManifest } from "./bundle-format.mjs";
import { assertCompatibleBuildIdentity, assertInstalledSchemaMatches, loaderCapabilityIdentity, schemaFingerprintDigest } from "./build-identity.mjs";
import {
  credentialFingerprint,
  assertDistinctFingerprints,
  REQUIRED_ENVIRONMENT_CREDENTIAL_CLASSES,
} from "./credential-fingerprint.mjs";
import {
  installStagingOps, acquireCoordinatorLock, acquireDataUseLock, releaseCoordinatorLock,
  releaseDataUseLock, readJournal, transitionJournal, markReady, recordCatchup,
  hasCoordinatorLock, hasExclusiveDataUseLock, recordSourceWatermark, clearRollbackTarget,
  bootstrapResumeVerdict, beginBootstrapDraining, recordBootstrapRecovery, clearBootstrapRecovery,
  readSourceAttempt, recordSourceAttempt, completeSourceAttempt, withdrawSourceAttempt, sourceAttemptAdmission,
} from "./journal.mjs";
import { assertActionConfiguration } from "./action-preflight.mjs";
import { isDirectEntry } from "./direct-entry.mjs";
import { emitReceipt } from "./receipts.mjs";
import { assertActivationPreflightReady, runActivationPreflight } from "./activation-preflight.mjs";
import { assertStagingTopology } from "./config.mjs";
import { replaceNeo4jGraph, assertReplaceTarget } from "./neo4j-replace.mjs";
import { captureRollbackPostgres, resetSessionTransactionState, restorePairedPostgres, restoreRollbackPostgres } from "./pg-paired.mjs";
import { withPrivateTempDir } from "./private-store.mjs";
import { closeAllWithinBudget, ownedCloser } from "./resource-cleanup.mjs";
import { canonicalObjectId, createPrivateStore, parseCanonicalObjectId } from "./object-store.mjs";
import { assertOutboundCredentialIsolation, assertRunnerRole } from "./role-policy.mjs";
import { fingerprint } from "../schema-fingerprint.mjs";
import { RailwayMaintenance } from "./railway-maintenance.mjs";
import { LocalMaintenance } from "./local-maintenance.mjs";
import { exportGraph, GRAPH_CODEC_VERSION, validateGraphShape } from "./graph-bundle.mjs";
import { decodeNeo4jValue } from "./neo4j-codec.mjs";
import { snapshotExportFacts, validateLedgerAgainstSanitizedGraph, assertResolvedCorrectionScopes } from "./exporter.mjs";
import { keyMaterial } from "./key-material.mjs";
import { configurePostgresDeadline, createOperationBudget, createSessionWatchdogOwner, postgresDeadlineConfig, remainingBudgetMs, stagingOperationDeadlines } from "./operation-deadline.mjs";
import { runBoundedProcess } from "./bounded-process.mjs";
import { assertLivePostgresTarget, parseCanonicalPostgresTarget } from "./postgres-target.mjs";

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

/**
 * Refuse to BEGIN work that a cancellation has already withdrawn permission for.
 *
 * `runBoundedProcess` consumes the signal, so before this the earliest a SIGTERM was observed was
 * the first subprocess spawn — which on the install path is `pg_restore --list`, well past the
 * drain, the verified stop and the exclusive lock. The importer therefore stopped staging in order
 * to abort, and the recovery that followed inherited the same aborted signal and aborted too.
 *
 * Placed only where NEW work or a NEW destructive admission starts. It is deliberately absent from
 * recovery, which must run to completion on its own fresh scope (`transferTo`) once the destructive
 * window has been entered.
 */
export function assertNotCancelled(signal, operation) {
  if (!signal?.aborted) return false;
  // L2: PRESERVE A CLASSIFIED REASON; synthesize only for an unclassified external cancellation.
  //
  // The signal handed to owned work is `AbortSignal.any([external, watchdog])`, so the abort that
  // reaches here is just as often the operation's OWN deadline — a `StagingDeadlineExceededError`
  // carrying `STAGING_OPERATION_TIMEOUT`. Rewriting every reason to `STAGING_OPERATION_ABORTED` told
  // the caller a budget breach was an operator shutdown, which is the one classification the daemon
  // acts on differently: `isFatal` recognises TIMEOUT and ends the loop, while ABORTED is the
  // expected-shutdown case. So a deadline breach was relabelled into a quiet five-minute retry on a
  // session that had already blown its budget.
  const reason = signal.reason;
  const code = typeof reason?.code === "string" && reason.code ? reason.code : null;
  if (code) {
    throw Object.assign(new Error(`${operation} refused: ${reason.message ?? code}`), { code, cause: reason });
  }
  throw Object.assign(new Error(`${operation} refused: the staging operation was cancelled before it began`), {
    code: "STAGING_OPERATION_ABORTED", cause: reason,
  });
}

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
  const opened = openSignedEncryptedBundle({ bundle: JSON.parse(bytes.toString("utf8")), ...(kind === "rollback" ? rollbackKeys(env) : sourceKeys(env)), signerPurpose: kind });
  const validity = validatePairManifest(opened.manifest, ignoreExpiry ? 0 : Date.now(), { allowRollback: kind === "rollback" });
  if (!validity.ok) throw new Error(`${kind} bundle refused: ${validity.errors.join("; ")}`);
  return { ...opened, sourceProvenance: rollbackOpeningProvenance(opened) };
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
  for (const name of REQUIRED_ENVIRONMENT_CREDENTIAL_CLASSES) {
    assertDistinctFingerprints(manifest.credentialFingerprints?.[name], current[name], name);
  }
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

async function reapplyTesters(env, deadlines, signal) {
  await runBoundedProcess("npx", ["tsx", "--conditions", "react-server", "scripts/staging-ops/reapply-testers.ts", "--run"], {
    cwd: process.cwd(), env, maxBuffer: 1024 * 1024,
    timeoutMs: deadlines.operationMs, terminateGraceMs: deadlines.terminateGraceMs, signal,
  });
}

async function withRecoveryWatchdog(beginRecoveryWatchdog, budget, work) {
  const watchdog = await beginRecoveryWatchdog?.(budget);
  try { return await work(watchdog?.signal); }
  finally { await watchdog?.disarm(); }
}

/**
 * HARNESS-ONLY, LOCAL-ADAPTER-ONLY: leave the importer's OWN lock-owning Postgres session in a real
 * aborted transaction at the after-graph boundary.
 *
 * Why a separate seam. `after-postgres` and `after-graph` are plain JavaScript `throw`s, so when
 * recovery starts the session is perfectly usable — which means neither of them can exercise the one
 * failure `resetSessionTransactionState` exists for: a connection sitting in `25P02`, where the
 * recovery journal write, the advisory-lock release and the marker read all fail. Those faults prove
 * ORDERING; only a real `BEGIN` + a real failing statement proves RECOVERY.
 *
 * Fenced twice over — the required-harness flag AND the LOCAL maintenance adapter — so a fault
 * variable that somehow reaches a Railway-adapter importer cannot reach a deliberate abort. It is
 * also unreachable on the rollback path (see the caller's `kind !== "staging-rollback"` guard): the
 * scenario is a failed INSTALL, and injecting again during the recovery it triggered would prove
 * something else.
 */
export function sqlAbortFaultArmed(env = process.env) {
  return env.STAGING_PAIR_REQUIRED === "1"
    && env.STAGING_MAINTENANCE_ADAPTER === "local"
    && env.STAGING_FAULT_POINT === "after-graph-sql-abort";
}

/**
 * The version stamps the harness fixture writes into BOTH stores, read back from the STORES (not
 * from the bundle object), so "the candidate landed in Postgres and in the graph before the abort"
 * is observable evidence rather than an inference from the restore having exited zero. Harness-only:
 * the ` vN` convention is the fixture's, and nothing outside this seam depends on it.
 */
async function observedStoreVersions({ client, session }) {
  // Postgres: the fixture re-stamps ONE item body per capture and leaves the rest at their seeded
  // v1, so the NEWEST stamp present is the capture that landed. Compared numerically — `max()` over
  // the text would put v6 above v10.
  const postgres = await client.query(
    "SELECT max(substring(body from ' v([0-9]+)$')::int) AS n FROM items WHERE body ~ ' v[0-9]+$'",
  );
  // Graph: stamped wholesale, so a correctly replaced graph yields exactly ONE version. More than
  // one is itself evidence of a partial replace, which is why the whole set is reported, not a max.
  const graph = await session.run(
    "MATCH ()-[r:RELATES_TO]->() WHERE r.fact =~ '.* v[0-9]+$' RETURN DISTINCT last(split(r.fact, ' ')) AS version ORDER BY version",
  );
  const newest = postgres.rows[0]?.n;
  return {
    pgVersion: newest == null ? "" : `v${newest}`,
    graphVersions: graph.records.map((record) => record.get("version")).join(","),
  };
}

export async function injectAbortedTransactionFault({ client, session, opened }) {
  const identity = await client.query("SELECT pg_backend_pid() AS pid");
  const backendPid = Number(identity.rows[0]?.pid);
  const versions = await observedStoreVersions({ client, session });
  // BEFORE the failing statement, tied to this candidate run: a scenario satisfied by some earlier
  // refusal would never have reached this line, let alone with both stores holding the candidate.
  emitReceipt("candidate-observed", { runId: opened.manifest.runId, backendPid, pgVersion: versions.pgVersion, graphVersions: versions.graphVersions });
  await client.query("BEGIN");
  try {
    await client.query("SELECT 1/0");
  } catch (error) {
    // Assert the REAL database error, not a stand-in: a `22012` from Postgres is what leaves the
    // transaction aborted, and anything else here means the scenario did not happen.
    if (error?.code !== "22012") throw new Error(`the harness SQL abort expected SQLSTATE 22012 from the database, observed ${error?.code ?? "no SQLSTATE"}`);
    emitReceipt("fault-injected", { point: "after-graph-sql-abort", runId: opened.manifest.runId, postgresRestored: true, graphRestored: true, sqlstate: error.code, backendPid, transactionAborted: true });
    // NO ROLLBACK here. Handing the caller a session still inside the aborted transaction IS the
    // scenario; resetting it would hand the recovery path the easy case the other faults already
    // cover.
    throw error;
  }
  throw new Error("the harness SQL abort did not fail; an aborted-transaction scenario whose transaction never aborts proves nothing");
}

/**
 * Same-session evidence at a recovery checkpoint: the backend PID and which advisory locks this
 * connection still holds. Together across checkpoints these say the reset stayed on ONE backend and
 * kept the fence — a reconnect or a `DISCARD ALL` would show as a different PID or a dropped lock,
 * and both would silently "work" otherwise. Harness-only, so no ordinary run changes behaviour.
 */
async function emitSessionContinuity(client, { checkpoint, failedRunId, env }) {
  if (!sqlAbortFaultArmed(env)) return;
  try {
    const identity = await client.query("SELECT pg_backend_pid() AS pid");
    const [coordinatorLockHeld, exclusiveDataLockHeld] = await Promise.all([hasCoordinatorLock(client), hasExclusiveDataUseLock(client)]);
    emitReceipt("session-continuity", { checkpoint, failedRunId, backendPid: Number(identity.rows[0]?.pid), coordinatorLockHeld, exclusiveDataLockHeld });
  } catch (error) {
    // A checkpoint that could not be measured must not read as one that measured well.
    emitReceipt("session-continuity", { checkpoint, failedRunId, backendPid: null, coordinatorLockHeld: false, exclusiveDataLockHeld: false, detail: errorText(error).slice(0, 200) });
  }
}

async function verifyPostgresDestination({ client, maintenance, env }) {
  const postgresTarget = parseCanonicalPostgresTarget(env.DATABASE_URL, {
    label: "importer Postgres", requireInternal: env.STAGING_MAINTENANCE_ADAPTER !== "local",
  });
  const pins = {
    projectId: env.RAILWAY_PROJECT_ID,
    environmentId: env.STAGING_OPS_ENVIRONMENT_ID,
    serviceId: env.STAGING_POSTGRES_SERVICE_ID,
    serviceInstanceId: env.STAGING_POSTGRES_SERVICE_INSTANCE_ID,
    deploymentId: env.STAGING_POSTGRES_DEPLOYMENT_ID,
    hostname: env.STAGING_POSTGRES_HOST,
    database: env.STAGING_POSTGRES_DATABASE,
    importerServiceId: env.STAGING_IMPORTER_SERVICE_ID,
    importerServiceInstanceId: env.STAGING_IMPORTER_SERVICE_INSTANCE_ID,
    importerDeploymentId: env.STAGING_IMPORTER_DEPLOYMENT_ID,
  };
  const providerProof = env.STAGING_MAINTENANCE_ADAPTER === "local"
    ? Promise.resolve({ kind: "local-harness", environmentId: env.STAGING_OPS_ENVIRONMENT_ID })
    : maintenance.assertPinnedPostgresTarget(postgresTarget, pins);
  const [livePostgres, providerPostgres] = await Promise.all([assertLivePostgresTarget(client, postgresTarget), providerProof]);
  return { postgresTarget, livePostgres, providerPostgres };
}

/**
 * M1: THE NAMED READ-ONLY DESTINATION PROOF — `importer verify-target`.
 *
 * `docs/OPS.md` and `scripts/dm-network-attached.sh` both name a command to run against the live
 * staging service before any schedule is enabled, to confirm the destination check passes on
 * Railway's own private network. They named `importer verify`, which cannot perform it: `verify`
 * verifies and pins a source BUNDLE, its preflight deliberately omits the runtime/provider pins, and
 * its maintenance adapter is null — so the paragraph promised a measurement no supplied command
 * made. `verifyPostgresDestination` was reachable only from install/bootstrap/replacement, i.e. only
 * from paths that go on to drain staging.
 *
 * This is the same verifier, given a caller of its own. It MEASURES and returns; it never drains,
 * transitions the journal, stops a deployment, restores a store or deletes a graph. Both underlying
 * reads are reads: one `SELECT` on the lock-owning session, and read-only GraphQL queries against
 * the pinned provider identities. There is no skip-if-unpinned branch — a missing pin fails
 * preflight and a mismatched one fails the assertion, because a check that returns green when it
 * could not look is the thing this exists to replace.
 *
 * `proof` distinguishes the two adapters honestly: the local harness has no provider to measure, so
 * a harness pass is reported as `local-harness` and is NOT the activation evidence.
 *
 * The connection string is deliberately absent from the result — this value is printed by the CLI.
 */
export async function verifyStagingTarget({ client, maintenance, env }) {
  const { postgresTarget, livePostgres, providerPostgres } = await verifyPostgresDestination({ client, maintenance, env });
  return {
    status: "target-verified",
    proof: env.STAGING_MAINTENANCE_ADAPTER === "local" ? "local-harness" : "provider-measured",
    target: {
      hostname: postgresTarget.hostname, port: postgresTarget.port,
      database: postgresTarget.database, username: postgresTarget.username,
    },
    live: livePostgres,
    provider: providerPostgres,
  };
}

async function measuredReplaceFacts({ client, maintenance, env, opened }) {
  // Target proof precedes even service containment and is repeated immediately before each store
  // replacement. The same lock-owning session remains connected throughout.
  const postgres = await verifyPostgresDestination({ client, maintenance, env });
  const [electionLockHeld, exclusiveDataLockHeld, token, stopMeasurement] = await Promise.all([
    hasCoordinatorLock(client), hasExclusiveDataUseLock(client), maintenance.tokenIdentity(), maintenance.stopAndVerifyAll(),
  ]);
  return {
    pinnedEnvironmentId: env.STAGING_OPS_ENVIRONMENT_ID, actualEnvironmentId: env.RAILWAY_ENVIRONMENT_ID,
    tokenEnvironmentId: token.environmentId, neo4jHost: new URL(env.NEO4J_URL).hostname,
    pinnedNeo4jService: env.STAGING_NEO4J_SERVICE_NAME, pinnedDatabase: env.STAGING_NEO4J_DATABASE,
    database: env.NEO4J_DATABASE, pinnedAppServiceId: env.STAGING_APP_SERVICE_ID,
    pinnedGraphitiServiceId: env.STAGING_GRAPHITI_SERVICE_ID,
    targetCredentialFingerprint: credentialFingerprint({ credentialClass: "neo4j-credential", value: `${env.NEO4J_USER}\0${env.NEO4J_PASSWORD}`, comparisonKey: Buffer.from(env.STAGING_COMPARISON_KEY_BASE64, "base64"), keyId: env.STAGING_COMPARISON_KEY_ID }),
    sourceCredentialFingerprint: opened.manifest.credentialFingerprints?.["neo4j-credential"],
    sourceProvenance: opened.sourceProvenance, ...postgres,
    electionLockHeld, exclusiveDataLockHeld, stopMeasurement,
  };
}

/**
 * AC-06: the ONE predicate that decides whether an installed pair carries its own credentials.
 *
 * All three terms are required and none is caller-assertable. `databaseMode` and `kind` are signed
 * manifest claims, so on their own a forged SOURCE manifest declaring `full` would both take the
 * whole-database restore path and skip the tester reapply — i.e. install unsanitized production
 * credentials and call it a baseline. The third term is not a claim at all: `sourceProvenance` is an
 * opaque token minted only by an open that verified the importer-owned ROLLBACK signing key, and it
 * cannot be spelled by a manifest.
 *
 * Everything else — a sanitized source install, a sanitized staging rollback checkpoint, a legacy
 * declaration — reapplies the configured testers strictly. There is no environment escape and no
 * "the identity check failed, so restore what was there" fallback: those are the two ways this
 * exception would turn into a way to keep production credentials.
 */
export function preservesCapturedStagingCredentials(opened) {
  return opened?.manifest?.kind === "staging-rollback"
    && opened?.manifest?.databaseMode === "full"
    && isAuthenticatedRollbackProvenance(opened?.sourceProvenance);
}

export async function installOpenedPair({ client, session, opened, directory, env, maintenance, deadlines = stagingOperationDeadlines(env), budget = null, cleanupBudget = null, signal }) {
  budget?.assert("pair unpack");
  const graph = await unpackPair(opened.payload, directory, opened.manifest.checksums);
  // Prove the pinned staging target BEFORE the first destructive Postgres write, not only before
  // the graph delete. The same measured facts then authorise the marker repair inside the restore:
  // re-materialising a staging discriminator is only safe on a target whose staging identity has
  // been independently established (H1) — a database URL is not that proof.
  budget?.assert("replace target measurement");
  const facts = await measuredReplaceFacts({ client, maintenance, env, opened });
  assertReplaceTarget(facts);
  const restore = {
    client, databaseUrl: facts.postgresTarget.connectionString, directory, verifiedStagingTarget: true,
    operationTimeoutMs: deadlines.operationMs, terminateGraceMs: deadlines.terminateGraceMs,
    budget, signal,
  };
  // ONE decision, used for the restore shape AND for the credential handling below, so the two can
  // never disagree about what this pair is.
  const fullStagingCheckpoint = preservesCapturedStagingCredentials(opened);
  if (fullStagingCheckpoint) await restoreRollbackPostgres({ ...restore, env: { ...env, STAGING_DATA_MODE: opened.manifest.mode } });
  else await restorePairedPostgres({ ...restore, env });
  // The after-PG BARRIER, stated positively and tied to this run. The harness needs it for two
  // things it could not previously observe: that an interruption happened after real data was
  // written (journal `importing` precedes the restore, so killing on it can hit an empty target),
  // and that an injected fault fired at the point the scenario names rather than somewhere earlier.
  emitReceipt("postgres-restored", { runId: opened.manifest.runId, kind: opened.kind, mode: opened.manifest.mode ?? null });
  if (opened.manifest.kind !== "staging-rollback" && env.STAGING_PAIR_REQUIRED === "1" && env.STAGING_FAULT_POINT === "after-postgres") {
    emitReceipt("fault-injected", { point: "after-postgres", runId: opened.manifest.runId, postgresRestored: true, graphRestored: false });
    throw new Error("injected harness fault after Postgres restore");
  }
  if (opened.manifest.kind !== "staging-rollback" && env.STAGING_PAIR_REQUIRED === "1" && env.STAGING_HARNESS_PAUSE_AFTER_POSTGRES_MS) {
    const pause = Number(env.STAGING_HARNESS_PAUSE_AFTER_POSTGRES_MS);
    if (!Number.isFinite(pause) || pause < 1 || pause > 120_000) throw new Error("invalid bounded harness pause");
    await new Promise((resolve) => setTimeout(resolve, pause));
  }
  if (fullStagingCheckpoint) {
    // The captured staging authentication state IS the thing being restored. Its members belong to
    // whatever teams staging had; the testers configured for INCOMING SOURCE data need not exist
    // there, and reapplying them would either fail the restore of a good baseline or mint identities
    // this restore has no authority to create.
    emitReceipt("captured-credentials-preserved", { runId: opened.manifest.runId, kind: opened.kind, mode: opened.manifest.mode ?? null });
  } else {
    budget?.assert("tester reprovisioning");
    await reapplyTesters(env, { ...deadlines, operationMs: remainingBudgetMs(budget, deadlines.operationMs, "tester reprovisioning") }, signal);
  }
  // Re-measured, not reused: the stop/lock facts must hold at the moment of the graph delete too.
  await replaceNeo4jGraph({
    session, graph, facts: await measuredReplaceFacts({ client, maintenance, env, opened }),
    operationTimeoutMs: deadlines.operationMs, cleanupTimeoutMs: deadlines.cleanupMs,
    budget, cleanupBudget,
  });
  emitReceipt("graph-restored", { runId: opened.manifest.runId, kind: opened.kind, nodes: graph.nodes.length, relationships: graph.relationships.length });
  if (opened.manifest.kind !== "staging-rollback" && env.STAGING_PAIR_REQUIRED === "1" && env.STAGING_FAULT_POINT === "after-graph") {
    emitReceipt("fault-injected", { point: "after-graph", runId: opened.manifest.runId, postgresRestored: true, graphRestored: true });
    throw new Error("injected harness fault after graph restore");
  }
  if (opened.manifest.kind !== "staging-rollback" && sqlAbortFaultArmed(env)) await injectAbortedTransactionFault({ client, session, opened });
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
export async function verifyInstalledPair({ client, session, graph, opened, sanitationExpected = true, deadlines = stagingOperationDeadlines(process.env), budget = null }) {
  budget?.assert("installed pair verification");
  if (sanitationExpected) {
    const credentialCounts = await client.query(`SELECT
      (SELECT count(*) FROM auth_tokens)+(SELECT count(*) FROM api_keys)+(SELECT count(*) FROM agent_tokens)+
      (SELECT count(*) FROM integrations)+(SELECT count(*) FROM member_secrets)+(SELECT count(*) FROM social_jobs)+
      (SELECT count(*) FROM llm_usage)+(SELECT count(*) FROM usage_costs) AS forbidden_count`);
    if (Number(credentialCounts.rows[0]?.forbidden_count ?? -1) !== 0) throw new Error("post-import credential/outbound queue sanitation verification failed");
  }
  const installedGraph = await exportGraph(session, { operationTimeoutMs: deadlines.operationMs, budget });
  // The census applies to EVERY pair: whatever was verified in the bundle is what must now be in
  // the target, legacy or copy-ready.
  if (installedGraph.nodes.length !== graph.nodes.length || installedGraph.relationships.length !== graph.relationships.length) throw new Error("installed graph census differs from verified bundle");
  // The ledger↔graph correspondence is a COPY-READY contract. Ordinary `legacy-pg-only` installs
  // have documented empty-graph semantics. The one exception is a FULL, importer-authenticated
  // staging rollback: it restores both stores as captured, but graph use remains disabled and the
  // captured graph/ledger are not relabelled or validated as copy-ready. Use the SAME provenance
  // predicate as restore/credential handling; mode or databaseMode alone are caller-controlled
  // signed claims and must never select this exception.
  const mode = opened.manifest.mode ?? "copy-ready";
  if (mode !== "legacy-pg-only") {
    const facts = await snapshotExportFacts(client);
    assertResolvedCorrectionScopes(facts);
    validateLedgerAgainstSanitizedGraph(installedGraph, facts);
  } else {
    const ledger = await client.query("SELECT count(*)::int AS rows FROM graph_episodes");
    const ledgerRows = Number(ledger.rows[0]?.rows ?? -1);
    if (!Number.isInteger(ledgerRows) || ledgerRows < 0) throw new Error("legacy checkpoint ledger census could not be measured");
    if (!preservesCapturedStagingCredentials(opened) && (ledgerRows !== 0 || installedGraph.nodes.length !== 0)) {
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
  // WHY DID IT KEEP POLLING? The `.catch(() => null)` below swallows every fetch failure, so a
  // health probe that timed out on every attempt and one that answered 503 every time produced the
  // SAME message — which is why runtime 4's "bootstrap timed out" could not be attributed to any
  // operation. The last observation of each kind is carried into the refusal. Identities and
  // statuses only; no body, no token, no origin.
  const observed = { attempts: 0, lastDeploymentStatus: null, lastResponseStatus: null, lastFetchError: null, lastBodyOk: null };
  const startedAt = Date.now();
  while (Date.now() <= deadline) {
    observed.attempts += 1;
    const deployment = await maintenance.readDeployment(deploymentId);
    observed.lastDeploymentStatus = deployment.status ?? null;
    if (new Set(["FAILED", "CRASHED", "REMOVED"]).has(deployment.status)) {
      // The child's own lifecycle facts, when the controller recorded them — `CRASHED` alone
      // describes a tracked child and says nothing about how it died.
      const life = deployment.lifecycle ?? {};
      emitReceipt("deployment-observed-dead", {
        deploymentId, status: deployment.status, pid: life.pid ?? null,
        exitCode: life.exitCode ?? null, exitSignal: life.exitSignal ?? null,
        spawnError: life.spawnError ?? null, attempts: observed.attempts, waitedMs: Date.now() - startedAt,
      });
      throw new Error(`fresh staging deployment failed in ${deployment.status} (pid ${life.pid ?? "unknown"}, exit ${life.exitCode ?? "none"}${life.exitSignal ? `/${life.exitSignal}` : ""}${life.spawnError ? `, spawn error ${life.spawnError}` : ""})`);
    }
    if (deployment.status === "SUCCESS" || deployment.status === "DEPLOYING") {
      const response = await fetchImpl(new URL("/api/health", origin), {
        redirect: "manual",
        headers: { "x-aios-staging-health-token": token, ...(bootProbe ? { "x-aios-staging-boot-probe": "true" } : {}) },
        signal: AbortSignal.timeout(10_000),
      }).catch((error) => { observed.lastFetchError = error?.name ?? "Error"; return null; });
      if (response) { observed.lastResponseStatus = response.status; observed.lastFetchError = null; }
      const body = await response?.json().catch(() => ({}));
      if (response) observed.lastBodyOk = body?.ok ?? null;
      if (response && accept(response.status, body ?? {})) return true;
    }
    await sleep(5_000);
  }
  emitReceipt("health-poll-timed-out", {
    deploymentId, description, attempts: observed.attempts, waitedMs: Date.now() - startedAt,
    lastDeploymentStatus: observed.lastDeploymentStatus, lastResponseStatus: observed.lastResponseStatus,
    lastFetchError: observed.lastFetchError, lastBodyOk: observed.lastBodyOk,
  });
  throw new Error(
    `fresh staging deployment did not pass ${description} after ${observed.attempts} attempt(s) over ${Date.now() - startedAt}ms `
    + `(deployment ${observed.lastDeploymentStatus ?? "unknown"}; last probe ${observed.lastFetchError ? `failed with ${observed.lastFetchError}` : `answered ${observed.lastResponseStatus ?? "nothing"} ok=${String(observed.lastBodyOk)}`})`,
  );
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

async function openJournalPair({ journal, rollbackStore, env, prefix, label }) {
  const runId = journal[`${prefix}_run_id`];
  const objectId = journal[`${prefix}_object_id`];
  const digest = journal[`${prefix}_digest`];
  const commit = journal[`${prefix}_commit`];
  if (!runId || !objectId || !digest) throw new Error(`no canonical verified ${label} rollback pair`);
  const bytes = await rollbackStore.read(objectId);
  if (sha(bytes) !== digest) throw new Error(`${label} rollback object failed digest verification`);
  // A journal prior is, by contract, an importer-owned rollback object. Authenticate it with the
  // rollback key directly; never let unauthenticated manifest.kind choose the trusted signer.
  const opened = openBundleBytes(bytes, env, "rollback", { ignoreExpiry: true });
  if (opened.manifest.runId !== runId || commit !== opened.manifest.targetCommit) throw new Error(`${label} journal/object metadata mismatch`);
  assertCompatibleBuildIdentity(opened.manifest.build, loaderCapabilityIdentity());
  return { ...opened, sourceBytes: bytes, objectId, digest, kind: "rollback" };
}

async function openPrior({ journal, rollbackStore, env }) {
  return openJournalPair({ journal, rollbackStore, env, prefix: "last_ready", label: "last-ready" })
    .catch((error) => {
      if (String(error?.message ?? error).includes("no canonical verified last-ready")) {
        throw new Error("no canonical verified last-ready rollback pair; run bootstrap-rollback before the first import");
      }
      throw error;
    });
}

async function openRollbackTarget({ journal, rollbackStore, env }) {
  return openJournalPair({ journal, rollbackStore, env, prefix: "rollback_target", label: "preserved prior" });
}

/**
 * M3: SEALING IS WHERE A CLAIM BECOMES PROVENANCE, so `databaseMode` is decided here, not copied.
 *
 * This mints an importer-signed rollback envelope, and `preservesCapturedStagingCredentials` reads
 * `databaseMode: "full"` on such an envelope as authority to restore the whole database and skip the
 * tester reapply. Spreading the opened manifest and defaulting only the ABSENT case therefore
 * laundered a source claim into that authority: a source bundle declaring `full` was refused as a
 * direct install, then re-sealed into a rollback pair the importer's own key vouches for — with a
 * sanitized archive that has no auth rows to restore.
 *
 * The carry-forward is keyed on the SAME non-caller-assertable predicate the restore uses, so only
 * an already-authenticated importer-owned FULL checkpoint (the catch-up re-seal of a bootstrap
 * baseline) keeps its mode. Everything sealed from a source is `sanitized`, whatever it claimed.
 */
export function sealReadyRollback(opened, targetCommit, env) {
  const manifest = {
    ...opened.manifest, kind: "staging-rollback",
    databaseMode: preservesCapturedStagingCredentials(opened) ? opened.manifest.databaseMode : "sanitized",
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
 * Everything here is AFTER the durable serving commit. A failure is repair work, not permission to
 * stop the deployment that just passed health and committed `ready`.
 *
 * The rollback target is cleared only after durable artifact read-back, pointer, watermark and
 * catch-up bookkeeping all succeed. Until then the prior object remains a named recovery target.
 */
export async function reconcileReadyInstall({
  client, ready, opened, sourceObjectId, rollbackStore, env,
  operations = {},
}) {
  const recordWatermark = operations.recordSourceWatermark ?? recordSourceWatermark;
  const readHead = operations.readStagingHead ?? readStagingHead;
  const writeCatchup = operations.recordCatchup ?? recordCatchup;
  const clearTarget = operations.clearRollbackTarget ?? clearRollbackTarget;
  if (ready?.state !== "ready" || ready.last_ready_run_id !== opened.manifest.runId) {
    throw new Error("post-ready reconciliation requires the canonical ready journal identity");
  }
  if (!(await rollbackStore.verify(ready.last_ready_object_id, ready.last_ready_digest))) {
    throw new Error("canonical ready rollback pair failed post-commit durable read-back verification");
  }
  await rollbackStore.writePointer("last-ready", {
    runId: ready.last_ready_run_id,
    objectId: ready.last_ready_object_id,
    digest: ready.last_ready_digest,
    commit: ready.last_ready_commit,
    mode: ready.last_ready_mode,
    kind: "rollback",
  });
  await recordWatermark(client, {
    capturedAt: opened.manifest.captureEndedAt,
    runId: opened.manifest.runId,
  });
  const head = await readHead(env);
  await writeCatchup(client, {
    commit: head === ready.last_ready_commit ? null : head,
    attempts: 0,
  });

  // Once this succeeds, a later cleanup error cannot leave the journal pointing at an object it
  // expects to use for rollback. Object deletion itself stays best-effort and is reported.
  const reconciled = await clearTarget(client, ready.last_ready_run_id);
  const cleanupErrors = [];
  for (const retainedId of new Set([ready.rollback_target_object_id, sourceObjectId])) {
    if (retainedId && retainedId !== ready.last_ready_object_id) {
      await rollbackStore.delete(retainedId).catch((error) => cleanupErrors.push(errorText(error)));
    }
  }
  return {
    journal: reconciled,
    catchup: head === ready.last_ready_commit ? null : head,
    cleanupErrors,
  };
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

export async function rollbackToPrior({ client, prior, failedRunId, maintenance, rollbackStore, env, notes = [], deadlines = stagingOperationDeadlines(env), budget = null, now = undefined, signal }) {
  const recoveryBudget = budget ?? createOperationBudget("importer recovery", deadlines.recoveryMs, { now });
  // FIRST statement of the recovery path, before the journal write, before the advisory lock, and
  // before the marker read inside the restore. Whatever failed may have left this connection in an
  // aborted transaction, in which case all three fail — and the pre-existing `.catch(() => {})`
  // around the journal write made two of those failures invisible.
  recoveryBudget.assert("recovery session reset");
  const reset = await resetSessionTransactionState(client);
  recoveryBudget.assert("recovery session continuity evidence");
  await emitSessionContinuity(client, { checkpoint: "rollback-reset", failedRunId, env });
  if (reset.status !== "reset") {
    notes.push(`session reset failed: ${reset.detail}`);
    const journalRecorded = await recoveryStep("recovery-required journal transition", () => transitionJournal(client, { runId: failedRunId, from: ["draining", "importing", "verifying", "booting", "failed", "ready"], to: "failed", patch: { lastSafeCheckpoint: "recovery-required" } }), notes);
    emitReceipt("recovery-required", { failedRunId, priorRunId: prior?.manifest?.runId ?? null, checkpoint: "recovery-required", rollbackAttempted: false, journalRecorded });
    throw new Error(withNotes("the importer's database session is unusable, so NO rollback was attempted; staging remains fenced and recovery is required", notes));
  }
  try { await configurePostgresDeadline(client, recoveryBudget.remaining(deadlines.recoveryMs, "recovery deadline configuration")); }
  catch (error) {
    notes.push(`recovery deadline could not be installed: ${errorText(error)}`);
    emitReceipt("recovery-required", { failedRunId, priorRunId: prior?.manifest?.runId ?? null, checkpoint: "recovery-deadline-unavailable", rollbackAttempted: false, journalRecorded: false });
    throw new Error(withNotes("the importer could not establish a bounded recovery budget on its lock-owning session; staging remains fenced and recovery is required", notes));
  }

  // Admission is a hard boundary. A refused transition cannot be converted into permission to
  // stop services. `ready` is valid only when the caller already resolved a preserved prior target.
  recoveryBudget.assert("recovery admission transition");
  await transitionJournal(client, {
    runId: failedRunId,
    from: ["failed", "booting", "importing", "verifying", "draining", "ready"],
    to: "draining",
    patch: { lastSafeCheckpoint: "rollback" },
  });

  let driver = null;
  let session = null;
  let readyCommitted = null;
  try {
    // Stopping the services and reacquiring the exclusive lock used to sit OUTSIDE this block, so a
    // failure in either escaped raw — after the services were already stopped — and neither reached
    // the recovery-required checkpoint below nor said what state staging had been left in.
    recoveryBudget.assert("recovery service stop");
    await maintenance.stopAndVerifyAll();
    recoveryBudget.assert("recovery exclusive lock");
    await acquireExclusiveDataUseLock(client, env, "rollback");
    driver = neo4j.driver(env.NEO4J_URL, neo4j.auth.basic(env.NEO4J_USER, env.NEO4J_PASSWORD), { connectionTimeout: deadlines.connectionMs });
    session = driver.session({ database: env.NEO4J_DATABASE, defaultAccessMode: neo4j.session.WRITE });
    if (env.STAGING_PAIR_REQUIRED === "1" && env.STAGING_FAULT_ROLLBACK === "1") throw new Error("injected harness rollback failure");
    await transitionJournal(client, { runId: prior.manifest.runId, from: ["draining", "failed"], to: "importing" });
    const recoveryDeadlines = { ...deadlines, operationMs: deadlines.recoveryMs };
    const graphCleanupBudget = recoveryBudget.child("recovery graph cleanup", deadlines.cleanupMs);
    const graph = await withPrivateTempDir("aios-staging-rollback-", (directory) => installOpenedPair({ client, session, opened: prior, directory, env, maintenance, deadlines: recoveryDeadlines, budget: recoveryBudget, cleanupBudget: graphCleanupBudget, signal }));
    recoveryBudget.assert("recovery installed transition");
    await transitionJournal(client, { runId: prior.manifest.runId, from: ["importing"], to: "verifying" });
    // M2: BOTH kinds are verified against the data that landed. A full staging capture legitimately
    // carries staging's own credentials, so only the sanitation assertion is conditional — and it is
    // conditional on the SAME predicate the restore and the tester reapply used. Keying it on
    // `prior.kind === "source"` could never be true here (`openJournalPair` always reports
    // `rollback`), so a sanitized prior pair was restored without its sanitation ever rechecked.
    await verifyInstalledPair({ client, session, graph, opened: prior, sanitationExpected: !preservesCapturedStagingCredentials(prior), deadlines: recoveryDeadlines, budget: recoveryBudget });
    recoveryBudget.assert("recovery durable pair write");
    await rollbackStore.putImmutable(prior.objectId, prior.sourceBytes);
    recoveryBudget.assert("recovery boot");
    const booted = await bootExact({ client, maintenance, runId: prior.manifest.runId, objectId: prior.objectId, digest: prior.digest, commit: prior.manifest.targetCommit, mode: prior.manifest.mode, env });
    // M6, recovery side: same commit boundary, same ordering. A recovery budget that expires during
    // the restored pair's health poll must report bookkeeping pending, not unwind a serving rollback.
    readyCommitted = booted.ready;
    recoveryBudget.assert("recovery ready bookkeeping");
    await rollbackStore.writePointer("last-ready", { runId: prior.manifest.runId, objectId: prior.objectId, digest: prior.digest, commit: prior.manifest.targetCommit, mode: prior.manifest.mode, kind: prior.kind });
    await clearRollbackTarget(client, prior.manifest.runId);
    // The RECOVERY receipt: which run failed, which prior identity is now installed, and that BOTH
    // stores were restored and verified (`verifyInstalledPair` above covers Postgres sanitation, the
    // graph census and the ledger↔graph correspondence) and the pair booted ready.
    emitReceipt("prior-pair-restored", {
      failedRunId, priorRunId: prior.manifest.runId, priorKind: prior.kind,
      postgres: true, graph: true, ready: true, mode: prior.manifest.mode ?? null,
    });
    return { status: "rolled-back", runId: prior.manifest.runId, recoveryNotes: notes };
  } catch (error) {
    if (readyCommitted) {
      emitReceipt("ready-bookkeeping-pending", {
        runId: readyCommitted.last_ready_run_id,
        objectId: readyCommitted.last_ready_object_id,
        servingCommit: readyCommitted.last_ready_commit,
        detail: errorText(error).slice(0, 200),
      });
      throw new Error(`rollback pair is ready and serving; post-ready bookkeeping remains pending: ${errorText(error)}`);
    }
    // The checkpoint write is itself SQL on a connection that has just failed, so reset again and
    // report whether the checkpoint actually landed rather than assuming it did.
    const checkpointReset = await resetSessionTransactionState(client);
    if (checkpointReset.status !== "reset") notes.push(`session reset before the recovery checkpoint failed: ${checkpointReset.detail}`);
    const journalRecorded = await recoveryStep("recovery-required journal transition", () => transitionJournal(client, { runId: failedRunId, from: ["draining", "importing", "verifying", "booting"], to: "failed", patch: { lastSafeCheckpoint: "recovery-required" } }), notes);
    emitReceipt("recovery-required", { failedRunId, priorRunId: prior?.manifest?.runId ?? null, checkpoint: "recovery-required", rollbackAttempted: true, journalRecorded });
    throw new Error(withNotes(`paired rollback failed; staging remains fenced and recovery is required: ${errorText(error)}`, notes));
  } finally {
    const terminalBudget = createOperationBudget("recovery terminal cleanup", deadlines.cleanupMs, { now });
    await closeAllWithinBudget({ budget: terminalBudget, terminateGraceMs: deadlines.terminateGraceMs },
      session ? ownedCloser(() => session.close()) : null,
      driver ? ownedCloser(() => driver.close()) : null,
    );
  }
}

/**
 * @param {object} args
 * @param {boolean} [args.automatic] TRUE for the unattended daemon/tick path, FALSE (default) for an
 *   explicit `importer install <object-id>`. Only this distinguishes the two, and only the explicit
 *   invocation may re-attempt a source whose destructive install already failed — see
 *   `sourceAttemptAdmission`. It is deliberately not an environment variable or a bypass flag.
 */
export async function installObject({ client, objectId, sourceStore, rollbackStore, maintenance, env, deadlines = stagingOperationDeadlines(env), automatic = false, operations = {} }) {
  const operationBudget = operations.operationBudget ?? createOperationBudget("importer install", deadlines.operationMs, { now: operations.now });
  const verifyAndPin = operations.verifyAndPinSourceBundle ?? verifyAndPinSourceBundle;
  const compareCredentials = operations.compareEnvironmentCredentials ?? compareEnvironmentCredentials;
  const acquireLock = operations.acquireCoordinatorLock ?? acquireCoordinatorLock;
  const readCurrentJournal = operations.readJournal ?? readJournal;
  const loadPrior = operations.openPrior ?? openPrior;
  const loadRollbackTarget = operations.openRollbackTarget ?? openRollbackTarget;
  const rollback = operations.rollbackToPrior ?? rollbackToPrior;
  const reconcile = operations.reconcileReadyInstall ?? reconcileReadyInstall;
  const releaseLock = operations.releaseCoordinatorLock ?? releaseCoordinatorLock;
  // Injectable like every other durable operation here, so the admission decision can be exercised
  // without a database. They are reached only AFTER the recovery/reconciliation branches below.
  const readAttempt = operations.readSourceAttempt ?? readSourceAttempt;
  const markAttempt = operations.recordSourceAttempt ?? recordSourceAttempt;
  const finishAttempt = operations.completeSourceAttempt ?? completeSourceAttempt;
  const undoAttempt = operations.withdrawSourceAttempt ?? withdrawSourceAttempt;
  // ── The DESTRUCTIVE-PATH boundaries, injectable for the same reason as everything above ────────
  //
  // These four are the only steps between the drain and the ready commit that a test cannot stand
  // in for through `client`, `maintenance` or `rollbackStore`: they spawn `pg_restore`, talk to a
  // real Neo4j, read the staging branch head over the network, or deploy and health-poll an app.
  // Substituting them is what makes the post-ready boundary (M6) reachable as BEHAVIOUR — the
  // property that a budget expiring after `markReady` must not unwind a serving pair, which no
  // source-order guard can state.
  //
  // Every one defaults to the real implementation, so the production path is byte-for-byte the
  // path under test, and there is deliberately NO environment variable: this is a test-injection
  // seam, not a runtime bypass an operator could reach.
  const checkPostgresDestination = operations.verifyPostgresDestination ?? verifyPostgresDestination;
  const readHead = operations.readStagingHead ?? readStagingHead;
  const installPair = operations.installOpenedPair ?? installOpenedPair;
  const verifyPair = operations.verifyInstalledPair ?? verifyInstalledPair;
  const sealReady = operations.sealReadyRollback ?? sealReadyRollback;
  const boot = operations.bootExact ?? bootExact;
  const signal = operations.signal;
  const beginRecoveryWatchdog = operations.beginRecoveryWatchdog;
  // Nothing has been read, locked or stopped yet: a cancellation observed here costs an operator
  // one re-run and no maintenance window at all.
  assertNotCancelled(signal, "staging source install");
  operationBudget.assert("source admission");
  const opened = await verifyAndPin({ objectId, sourceStore, rollbackStore, env });
  compareCredentials(opened.manifest, env);
  // B4: compatibility is against this pinned runner image's OWN loader capability, never against
  // the live target catalog — the catalog is the thing being replaced, and reading it here both
  // blocked legitimate staging-only schema changes and made a half-installed target unrecoverable.
  assertCompatibleBuildIdentity(opened.manifest.build, loaderCapabilityIdentity());
  operationBudget.assert("coordinator lock acquisition");
  if (!(await acquireLock(client))) throw new Error("another importer owns the coordinator lock");
  try {
  const journal = await readCurrentJournal(client);
  if (journal.state === "failed" && journal.last_safe_checkpoint === "recovery-required") {
    throw new Error("prior-pair rollback previously failed; staging remains fenced until explicit rollback recovery");
  }
  if (journal.state !== "ready") {
    // Resolve the authenticated durable recovery target inside this branch, under the coordinator
    // lock. Prefer the target snapshotted on entry to drain; fall back to canonical last-ready for
    // older/interruption states. This preserves the intended recovery identity and avoids touching
    // the obsolete prior during same-run ready reconciliation below.
    operationBudget.assert("interrupted recovery target resolution");
    const interruptedPrior = journal.rollback_target_run_id
      ? await loadRollbackTarget({ journal, rollbackStore, env })
      : await loadPrior({ journal, rollbackStore, env });
    const recoveryBudget = createOperationBudget("interrupted importer recovery", deadlines.recoveryMs, { now: operations.now });
    const recovered = await withRecoveryWatchdog(beginRecoveryWatchdog, recoveryBudget, (recoverySignal) => rollback({ client, prior: interruptedPrior, failedRunId: journal.run_id ?? `interrupted-${Date.now()}`, maintenance, rollbackStore, env, deadlines, budget: recoveryBudget, signal: recoverySignal ?? signal }));
    return { ...recovered, status: "interrupted-run-recovered", interruptedRunId: journal.run_id };
  }
  if (journal.last_ready_run_id === opened.manifest.runId) {
    // Same-run repair derives every pointer from the JOURNAL authority and repeats the whole
    // post-ready suffix. A prior attempt may have failed at any individual bookkeeping operation.
    const reconciled = await reconcile({ client, ready: journal, opened, sourceObjectId: objectId, rollbackStore, env });
    return {
      status: "already-ready", runId: opened.manifest.runId,
      objectId: journal.last_ready_object_id, catchup: reconciled.catchup,
      cleanupErrors: reconciled.cleanupErrors,
    };
  }
  // Fable HIGH-1: THE DESTRUCTIVE-ATTEMPT ADMISSION, and its position is load-bearing.
  //
  // It sits AFTER the recovery-required guard, the interrupted-run recovery branch and the
  // already-ready reconciliation above — all three must stay reachable, because they are how
  // staging gets back to a serving state and none of them starts a new drain. It sits BEFORE the
  // watermark, the head measurement and the drain, because those are the ordinary new-attempt path.
  //
  // What it stops: a candidate that passes every pre-drain check (signature, credentials, loader
  // compatibility, watermark) and then deterministically fails AFTER entering draining. Rollback
  // restores the prior, marks it ready and clears `recovery-required`; the source watermark is
  // never advanced past the failed candidate, so the next automatic tick rediscovers exactly that
  // object and drains, stops and restores staging again — for a candidate already known to fail,
  // for as long as it remains the newest unexpired source. Bounded only by expiry or supersession,
  // which is hundreds of avoidable maintenance cycles, not a budget.
  //
  // Deliberately NOT solved in discovery: filtering attempted identities there would make the
  // selector fall back to an OLDER eligible bundle, which is the oscillation `discoverLatestSource`
  // exists to prevent. The newest identity stays selected, and stays reported as blocked.
  //
  // The cancellation check belongs HERE and not one line later: everything above this point is
  // non-destructive (the recovery branch and the ready reconciliation are how staging gets BACK to
  // serving, and a shutdown must not withhold either), while everything below it drains a `ready`
  // staging pair. A shutdown may never open a new maintenance window.
  assertNotCancelled(signal, "destructive staging install admission");
  operationBudget.assert("destructive install attempt admission");
  const priorAttempt = await readAttempt(client, objectId);
  const attemptAdmission = sourceAttemptAdmission(priorAttempt, { automatic });
  if (!attemptAdmission.ok) throw new Error(`staging refresh refused: ${attemptAdmission.reason}`);
  const prior = await loadPrior({ journal, rollbackStore, env });
  // B3: never install a capture older than the newest one already installed. Without a durable
  // watermark, discovery that skipped the installed newest run simply picked the SECOND newest —
  // an older bundle — and the next run picked the newest again, oscillating staging forever.
  const watermark = journal.source_watermark ? Date.parse(journal.source_watermark) : null;
  const captured = Date.parse(opened.manifest.captureEndedAt);
  if (!Number.isFinite(captured)) throw new Error("source bundle declares no parseable capture end");
  if (watermark !== null && Number.isFinite(watermark) && captured <= watermark) {
    throw new Error(`source run ${opened.manifest.runId} captured at or before the installed watermark; refusing to move staging backwards`);
  }
  operationBudget.assert("staging target commit measurement");
  const targetCommit = await readHead(env);
  // The harness's NEGATIVE CONTROL. A failure BEFORE the drain touches neither store, so it must not
  // be able to satisfy a scenario about recovering from a mid-install fault — which the old
  // "exited non-zero and the prior data is still there" assertion could not tell apart, because
  // nothing had been replaced in either case.
  if (env.STAGING_PAIR_REQUIRED === "1" && env.STAGING_FAULT_POINT === "before-drain") {
    emitReceipt("fault-injected", { point: "before-drain", runId: opened.manifest.runId, postgresRestored: false, graphRestored: false });
    throw new Error("injected harness fault before drain");
  }
  let destructive = false;
  let readyCommitted = null;
  // L10: the withdrawal below may only undo what THIS invocation created. An `attempted` row left by
  // an earlier killed-in-flight automatic worker is the evidence that automatic refusal is built on;
  // deleting it re-admits the unattended drain loop the record exists to stop.
  const recordedByThisInvocation = { created: false };
  try {
    operationBudget.assert("pinned importer verification");
    await maintenance.assertPinnedRunnerConfiguration(env.STAGING_IMPORTER_SERVICE_ID, env.STAGING_IMPORTER_IMAGE_DIGEST);
    operationBudget.assert("Postgres target verification before drain");
    await checkPostgresDestination({ client, maintenance, env });
    // MARKED BEFORE THE MUTATION IT AUTHORISES, under the coordinator lock and immediately before
    // entry into draining, so that a crash anywhere in the destructive path leaves the attempt
    // recorded rather than erased. Over-recording costs an explicit operator retry; under-recording
    // costs the repeated-outage loop. It lives in `staging_ops`, which the paired install does not
    // restore, so neither the rollback nor `markReady` can wipe it.
    operationBudget.assert("destructive attempt record");
    await markAttempt(client, { objectId, runId: opened.manifest.runId, digest: opened.digest });
    // Set only after the write RETURNED. A failure inside `markAttempt` may still have committed the
    // row, so this stays false and the record is left alone — over-retaining costs an explicit
    // operator retry, under-retaining costs the repeated-outage loop.
    recordedByThisInvocation.created = !priorAttempt;
    operationBudget.assert("drain transition");
    await transitionJournal(client, { runId: opened.manifest.runId, from: ["ready", "failed"], to: "draining", patch: { lastSafeCheckpoint: "ready", candidateRunId: opened.manifest.runId, candidateObjectId: objectId, candidateDigest: opened.digest, candidateMode: "copy-ready", catchupCommit: targetCommit, snapshotRollbackTarget: true } });
    destructive = true;
    operationBudget.assert("service stop");
    await maintenance.stopAndVerifyAll();
    operationBudget.assert("exclusive data lock acquisition");
    await acquireExclusiveDataUseLock(client, env, "import");
    await transitionJournal(client, { runId: opened.manifest.runId, from: ["draining"], to: "importing" });
    const driver = neo4j.driver(env.NEO4J_URL, neo4j.auth.basic(env.NEO4J_USER, env.NEO4J_PASSWORD), { connectionTimeout: deadlines.connectionMs });
    const session = driver.session({ database: env.NEO4J_DATABASE, defaultAccessMode: neo4j.session.WRITE });
    try {
      const graphCleanupBudget = operationBudget.child("install graph cleanup", deadlines.cleanupMs);
      const graph = await withPrivateTempDir("aios-staging-import-", (directory) => installPair({ client, session, opened, directory, env, maintenance, deadlines, budget: operationBudget, cleanupBudget: graphCleanupBudget, signal }));
      operationBudget.assert("installed transition");
      await transitionJournal(client, { runId: opened.manifest.runId, from: ["importing"], to: "verifying" });
      await verifyPair({ client, session, graph, opened, deadlines, budget: operationBudget });
      operationBudget.assert("ready pair sealing");
      const readyPair = sealReady(opened, targetCommit, env);
      await rollbackStore.putImmutable(readyPair.objectId, readyPair.sourceBytes);
      if (!(await rollbackStore.verify(readyPair.objectId, readyPair.digest))) throw new Error("candidate rollback pair failed durable read-back verification");
      operationBudget.assert("candidate boot");
      const booted = await boot({ client, maintenance, runId: opened.manifest.runId, objectId: readyPair.objectId, digest: readyPair.digest, commit: targetCommit, mode: "copy-ready", env });
      // M6: ASSIGNED FIRST, asserted second. `bootExact` commits `ready` — the deployment is verified
      // serving and the canonical identity is durable — so every step after it is bookkeeping. With
      // the assert first, a budget that expired during the health poll threw with `readyCommitted`
      // still null, and the catch below drained the healthy pair it had just installed.
      readyCommitted = booted.ready;
      operationBudget.assert("ready reconciliation");
      const reconciled = await reconcile({ client, ready: readyCommitted, opened, sourceObjectId: objectId, rollbackStore, env });
      // Terminal on the success side. Recorded AFTER ready is committed so a later same-object
      // invocation reaches the already-ready reconciliation branch rather than a refusal.
      await finishAttempt(client, { objectId, status: "installed" });
      return { status: "ready", runId: opened.manifest.runId, objectId: readyPair.objectId, sourceObjectId: objectId, commit: targetCommit, nodes: graph.nodes.length, relationships: graph.relationships.length, catchup: reconciled.catchup, cleanupErrors: reconciled.cleanupErrors };
    } finally {
      const terminalBudget = createOperationBudget("install terminal cleanup", deadlines.cleanupMs, { now: operations.now });
      await closeAllWithinBudget({ budget: terminalBudget, terminateGraceMs: deadlines.terminateGraceMs },
        ownedCloser(() => session.close()), ownedCloser(() => driver.close()));
    }
  } catch (error) {
    if (readyCommitted) {
      // `markReady` is the commit boundary. The deployment is verified serving and canonical
      // identity is durable; stopping it because a pointer, watermark, head read, catch-up write or
      // resource close failed would turn repairable bookkeeping into an outage.
      emitReceipt("ready-bookkeeping-pending", {
        runId: readyCommitted.last_ready_run_id,
        objectId: readyCommitted.last_ready_object_id,
        servingCommit: readyCommitted.last_ready_commit,
        detail: errorText(error).slice(0, 200),
      });
      throw new Error(`paired refresh is ready and serving; post-ready bookkeeping remains pending and will reconcile on retry: ${errorText(error)}`);
    }
    if (!destructive) {
      // POSITIVE PROOF that the drain transition never completed: nothing was stopped and neither
      // store was touched, so this attempt did not consume the candidate's automatic admission. A
      // crash cannot reach this line, which is the case the record is conservative for.
      //
      // Narrowed by BOTH conditions. A failure before `markAttempt` (a refused runner pin, a
      // destination check) created no record at all, and a failure after it on an object that
      // already carried an `attempted`/`failed` record only INCREMENTED someone else's evidence.
      // Withdrawing in either case discards the prior attempt and hands the candidate back to the
      // automatic path.
      if (recordedByThisInvocation.created) await undoAttempt(client, objectId).catch(() => {});
      throw error;
    }
    const notes = [];
    // BEFORE the journal write and BEFORE the lock release, both of which are SQL on the connection
    // the failed loader/restore may have left in an aborted transaction. Measured on PG18: with the
    // reset missing, this transition and the release both fail silently and the rollback path then
    // fails on its own first statement — while the message below still said the prior pair had been
    // restored. The lock is released on the SAME backend, so the reset must not reconnect.
    const recoveryBudget = createOperationBudget("importer recovery", deadlines.recoveryMs, { now: operations.now });
    return await withRecoveryWatchdog(beginRecoveryWatchdog, recoveryBudget, async (recoverySignal) => {
    recoveryBudget.assert("recovery initial session reset");
    const reset = await resetSessionTransactionState(client);
    await emitSessionContinuity(client, { checkpoint: "install-reset", failedRunId: opened.manifest.runId, env });
    if (reset.status !== "reset") notes.push(`session reset failed: ${reset.detail}`);
    let usable = reset.status === "reset";
    if (usable) {
      try { await configurePostgresDeadline(client, recoveryBudget.remaining(deadlines.recoveryMs, "recovery deadline configuration")); }
      catch (deadlineError) { usable = false; notes.push(`recovery deadline could not be installed: ${errorText(deadlineError)}`); }
    }
    // Terminal on the failure side, recorded BEFORE the rollback below — the rollback restores the
    // prior and marks it ready, which erases every other trace that this candidate was tried.
    // `recoveryStep` so an unusable session records the reason instead of masking the rollback.
    await recoveryStep("destructive attempt failure record", () => finishAttempt(client, { objectId, status: "failed", error: errorText(error) }), notes);
    await recoveryStep("failed-state journal transition", () => transitionJournal(client, { runId: opened.manifest.runId, from: ["draining", "importing", "verifying", "booting"], to: "failed", patch: { lastSafeCheckpoint: usable ? "ready" : "recovery-required" } }), notes);
    await recoveryStep("exclusive data-use lock release", () => releaseDataUseLock(client, "exclusive"), notes);
    if (!usable) {
      // Never call a rollback the session cannot execute, and never describe one that did not run.
      throw new Error(withNotes(`paired refresh failed and the importer's database session could not be reset, so the prior pair was NOT restored; staging remains fenced and recovery is required: ${errorText(error)}`, notes));
    }
    // Through the SAME `rollback` seam the interrupted-recovery branch above uses. Calling the
    // import directly here left one of the two recovery entries un-substitutable, which is how the
    // ready boundary's discriminating control — an identical expiry ONE STEP EARLIER, which must
    // still roll back — was unreachable without a real two-store install.
    await rollback({ client, prior, failedRunId: opened.manifest.runId, maintenance, rollbackStore, env, notes, deadlines, budget: recoveryBudget, signal: recoverySignal ?? signal });
    throw new Error(withNotes(`paired refresh failed and the prior pair was restored: ${errorText(error)}`, notes));
    });
  }
  } finally { await releaseLock(client).catch(() => {}); }
}

async function currentDeployment(maintenance) {
  const active = await maintenance.listActiveDeployments(maintenance.appServiceId);
  const current = active.filter((deployment) => deployment.status === "SUCCESS").sort((a, b) => String(b.meta?.createdAt ?? "").localeCompare(String(a.meta?.createdAt ?? "")))[0];
  const commit = current?.meta?.commitHash ?? current?.meta?.commitSha;
  if (!current || !FULL_SHA.test(String(commit ?? ""))) throw new Error("bootstrap could not measure the current successful staging deployment commit");
  return { deployment: current, commit };
}

/**
 * Re-prove a bootstrap checkpoint that a killed worker had already published, so a resume can adopt
 * it instead of orphaning it under a fresh object ID.
 *
 * This trusts the RECORD for the object's NAME only. Everything that makes the object usable is
 * measured again from the bytes: the canonical identity, the recorded digest, and a full open
 * through the ordinary rollback path (signature, decryption, manifest, checksums) bound to the
 * recorded run and baseline commit. A record naming an object that is absent, altered or about
 * another baseline refuses; it never becomes permission to proceed without one.
 */
async function adoptPublishedBootstrapCheckpoint({ rollbackStore, env, resumed, phase }) {
  const { objectId, digest, runId, commit } = resumed;
  if (!(await rollbackStore.verify(objectId, digest))) {
    throw new Error("the recorded interrupted bootstrap names a published checkpoint that is missing or no longer matches its digest; staging remains fenced and unchanged");
  }
  const readBack = openBundleBytes(await rollbackStore.read(objectId), env, "rollback", { ignoreExpiry: true });
  if (readBack.manifest.runId !== runId || readBack.manifest.build?.applicationCommit !== commit) {
    throw new Error("the recorded interrupted bootstrap checkpoint is about a different run or baseline commit than the record claims; staging remains fenced and unchanged");
  }
  phase("adopted-published-checkpoint", { objectId });
  return { objectId, digest };
}

/**
 * HARNESS FAULT — THE ORDINARY FAILURE AFTER THE VERIFIED STOP, and it is a THROW, not a kill.
 *
 * The two `bootstrap-after-*` faults are SIGKILLs precisely because the catch is what does NOT run
 * when a worker dies. This one is their complement: an ordinary in-band failure, so the catch DOES
 * run — it redeploys the untouched baseline and leaves the journal `failed` with the interruption
 * record deliberately retained. That is the state the H2 resume fix exists for and the one no
 * SIGKILL scenario can produce: the next `bootstrap-rollback` meets a LIVE, serving baseline
 * holding a shared reader lock, so it must re-enter `draining` and re-run `stopAndVerifyAll`
 * before it can take the exclusive lock. A resume that went straight for the lock (which is what
 * the code did) blocks there forever.
 *
 * Placed BEFORE the exclusive lock on both branches, so the failed attempt never held it — a retry
 * that gets stuck can then only be stuck behind the SERVING pair, which is the property under test.
 * Gated on `STAGING_PAIR_REQUIRED` like every other fault point, and fires once per invocation
 * because the variable is set on one `docker compose run` container only.
 */
function bootstrapOrdinaryFailureFault(env, { runId, resumed }) {
  if (env.STAGING_PAIR_REQUIRED !== "1" || env.STAGING_FAULT_POINT !== "bootstrap-after-stop-throw") return;
  emitReceipt("fault-injected", { point: "bootstrap-after-stop-throw", runId, resumed, thrown: true });
  throw new Error("injected harness bootstrap failure after the verified stop");
}

export async function bootstrapRollback({ client, rollbackStore, maintenance, env, deadlines = stagingOperationDeadlines(env), budget = null, signal, beginRecoveryWatchdog }) {
  const operationBudget = budget ?? createOperationBudget("bootstrap rollback", deadlines.operationMs);
  // L1: BEFORE ANY WORK AT ALL — before the coordinator lock, the journal read and the destination
  // measurement. A shutdown observed here costs an operator one re-run and no maintenance window;
  // the first thing that used to observe one was a subprocess spawn inside the capture, long after
  // the drain and the verified stop.
  assertNotCancelled(signal, "staging bootstrap rollback");
  operationBudget.assert("bootstrap coordinator lock");
  if (!(await acquireCoordinatorLock(client))) throw new Error("another importer owns the coordinator lock");
  // EVERYTHING after the acquisition is inside the release scope. The journal read, the deployment
  // measurement and the mode check all sat between the acquire and the old `try`, so any of them
  // refusing left the coordinator lock held for the life of the connection — and the next importer
  // refused with "another importer owns the coordinator lock", naming a worker that had already died.
  // Declared out here, assigned in there: the recovery `catch` reads all four, so they cannot be
  // block-scoped to the try even though every statement that fills them belongs inside it.
  const mode = env.STAGING_BOOTSTRAP_MODE;
  const runId = `bootstrap-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  let current = null;
  /**
   * L1/L3: HAS THIS INVOCATION ADMITTED A MAINTENANCE WINDOW?
   *
   * The recovery below exists to put back a baseline THIS run took down. Before admission there is
   * nothing to put back: no draining transition, no stop, no deployment change — so running it would
   * write `failed` over a journal this run never moved and redeploy an app that never stopped.
   * `current` is not that signal, because it is measured (or read from the interruption record)
   * while everything is still untouched.
   *
   * Set BEFORE the admitting statement, never after: an admission that throws may already have
   * committed, and a stop that throws may already have stopped some services. Over-recovering costs
   * a redeploy of the unchanged baseline; under-recovering leaves staging stopped and fenced.
   */
  let admitted = false;
  /**
   * The mode RECOVERY is entitled to use. For a resume this becomes the mode the interrupted worker
   * actually stopped (the recorded one), not whatever this worker happens to be configured for.
   */
  let recoveryMode = mode;
  // WHICH PHASE. Runtime 4's bootstrap "timed out" and the operation was unidentified: maintenance
  // calls, object-store reads and the health poll all have their own deadlines, and nothing said
  // which one was running. One receipt per phase, names only — no configuration, no arguments.
  // Resolved below: either this worker's own new bootstrap identity, or the one a killed worker
  // recorded and this one is resuming. Everything after the resolution uses THESE, never `runId`.
  let bootstrapRunId = runId;
  let resumed = null;
  // Reports the EFFECTIVE bootstrap run, so a resumed worker's receipts are about the bootstrap
  // being recovered rather than about the fresh identity it never used.
  const phase = (name, fields = {}) => emitReceipt("bootstrap-phase", { runId: bootstrapRunId, phase: name, ...fields });
  try {
    operationBudget.assert("bootstrap journal read");
    phase("read-journal");
    const journal = await readJournal(client);
    if (journal.last_ready_run_id) throw new Error("bootstrap rollback is one-time and last-ready already exists");
    operationBudget.assert("bootstrap Postgres target verification");
    // A first bootstrap legitimately has no marker. Its positive proof is the provider-bound
    // service instance plus this live lock-owning backend, never the marker's prior existence.
    await verifyPostgresDestination({ client, maintenance, env });

    // ── H2: RECONCILE AN INTERRUPTED FIRST BOOTSTRAP ────────────────────────────────────────────
    //
    // A SIGKILL after `stopAndVerifyAll()` succeeded leaves a state no supplied command could
    // recover: the platform reports no active deployment (that is what a verified stop MEANS), so
    // re-measuring is impossible; there is no `last_ready` and no preserved prior pair, so neither
    // `importer rollback` nor an ordinary install can restore anything; and the in-memory `current`
    // died with the worker. Both stores are untouched and correct, and staging is simply stopped
    // and fenced forever. A fresh worker therefore reconciles the durable record written BEFORE the
    // stop, rather than requiring a currently serving deployment.
    //
    // Refusal is fail-closed and mutates nothing: an unresumable or foreign record leaves staging
    // exactly as it was. This never manufactures a last-ready, marks a failed capture copy-ready,
    // guesses the branch head, clears enrollment, or restores a database a bootstrap only read.
    const verdict = bootstrapResumeVerdict(journal, env);
    if (journal.bootstrap_run_id && !verdict.resume) {
      phase("resume-refused", { detail: verdict.reason });
      throw new Error(`an interrupted bootstrap is recorded but cannot be resumed: ${verdict.reason}; staging remains fenced and unchanged`);
    }
    if (verdict.resume) {
      resumed = verdict;
      bootstrapRunId = verdict.runId;
      phase("resume-interrupted-bootstrap", { bootstrapRunId, resumedPhase: verdict.phase, deploymentId: verdict.deploymentId });
      // ⚠️ L3: THE MODE IS VALIDATED BEFORE `current` IS ASSIGNED, which is what keeps a refused
      // retry out of the mutation/recovery region entirely.
      //
      // `current` used to be assigned first, so a rejected mode threw with a measured baseline in
      // hand — and the catch below restarts "whenever current exists", using the CONFIGURED mode the
      // validation had just refused. An invalid retry could therefore transition the journal and
      // issue a deployment despite never having been admitted to anything.
      if (verdict.mode !== mode) throw new Error("the recorded interrupted bootstrap ran in a different supported staging mode than this worker is configured for");
      // The RECORDED baseline, not a fresh measurement. This is the identity the interrupted worker
      // measured while a deployment was still serving, which is the only time it was measurable —
      // and its mode is what recovery is entitled to use from here on.
      current = { deployment: { id: verdict.deploymentId }, commit: verdict.commit };
      recoveryMode = verdict.mode;
      // ⚠️ H2: A RESUME RE-ENTERS DRAINING AND RE-PROVES THE STOP. Neither is optional.
      //
      // The resume branch used to take the exclusive lock directly, on the theory that the recorded
      // run was killed after a verified stop. But the RECORD outlives ordinary failures too, and an
      // ordinary failure deliberately REDEPLOYS the baseline before leaving the journal `failed` —
      // so the documented remedy ("re-run bootstrap-rollback") met a live fenced app, timed out on
      // the exclusive lock, and could never reach `booting`, whose transition admitted only
      // `draining`/`booting`. Nothing cleared the record either: `clearBootstrapRecovery` requires
      // `ready`. Re-entering `draining` and re-running `stopAndVerifyAll` makes the resume
      // idempotent over BOTH interruption windows and over an ordinary failure, and re-establishes
      // read-back-verified "nothing is serving" rather than inheriting a claim from a dead worker.
      operationBudget.assert("bootstrap resume draining transition");
      // L1: THE ADMISSION BOUNDARY on the resume branch, and the last moment a shutdown may refuse
      // for free. Everything above is read-only (journal read, destination measurement, verdict);
      // the transition below re-enters draining and the stop that follows takes services down. A
      // shutdown may never open a NEW maintenance window — and once past this line it may never
      // withhold recovery either, which is why `admitted` is set here and the catch honours it.
      assertNotCancelled(signal, "staging bootstrap resume draining admission");
      admitted = true;
      phase("transition-draining", { from: journal.state, resumed: true });
      await transitionJournal(client, { runId: bootstrapRunId, from: ["draining", "booting", "failed"], to: "draining" });
      phase("stop-and-verify-all", { resumed: true });
      await maintenance.stopAndVerifyAll();
      bootstrapOrdinaryFailureFault(env, { runId: bootstrapRunId, resumed: true });
      operationBudget.assert("bootstrap exclusive data lock");
      phase("acquire-exclusive-data-lock");
      await acquireExclusiveDataUseLock(client, env, "rollback bootstrap resume");
    } else {
      phase("measure-current-deployment");
      current = await currentDeployment(maintenance);
      operationBudget.assert("bootstrap draining transition");
      phase("measured-current-deployment", { deploymentId: current.deployment?.id ?? null, deploymentStatus: current.deployment?.status ?? null });
      if (!new Set(["legacy-pg-only", "copy-ready"]).has(mode)) throw new Error("STAGING_BOOTSTRAP_MODE must describe the measured current staging mode");
      // ⚠️ M7: ONE STATEMENT, BEFORE anything is stopped. The ordering is the whole fix — after the
      // stop the baseline is no longer measurable, so a record written later would be a record that
      // can never exist in the window it is for — and the ATOMICITY is the other half: the record
      // and the run identity that validates it must land together, or a kill between them leaves a
      // recorded bootstrap that every later run refuses and no command can clear.
      phase("record-bootstrap-recovery", { deploymentId: current.deployment?.id ?? null });
      // L1: the same admission boundary on the FRESH branch. The deployment measurement above is a
      // read; `beginBootstrapDraining` is the write that opens the window, so the cancellation check
      // belongs between them — a signal delivered after the read-only measurement must leave the
      // journal and the serving baseline exactly as they were.
      assertNotCancelled(signal, "staging bootstrap draining admission");
      admitted = true;
      phase("transition-draining", { from: journal.state });
      await beginBootstrapDraining(client, {
        runId, deploymentId: current.deployment?.id ?? null, commit: current.commit, mode,
        environmentId: env.RAILWAY_ENVIRONMENT_ID, appServiceId: env.STAGING_APP_SERVICE_ID,
        from: [journal.state], lastSafeCheckpoint: journal.state,
      });
      phase("stop-and-verify-all");
      await maintenance.stopAndVerifyAll();
      // HARNESS FAULT — INTERRUPTION WINDOW 1: verified stop complete, checkpoint not started.
      // SIGKILL, not a thrown error: the catch is exactly what does NOT run when a worker is killed,
      // and a throwable fault would exercise the recovery path instead of the gap. After this the
      // platform reports no active deployment, so nothing can re-measure the baseline; only the
      // record written above can.
      if (env.STAGING_PAIR_REQUIRED === "1" && env.STAGING_FAULT_POINT === "bootstrap-after-stop") {
        emitReceipt("fault-injected", { point: "bootstrap-after-stop", runId, kill: "SIGKILL" });
        process.kill(process.pid, "SIGKILL");
      }
      bootstrapOrdinaryFailureFault(env, { runId, resumed: false });
      operationBudget.assert("bootstrap exclusive data lock");
      phase("acquire-exclusive-data-lock");
      await acquireExclusiveDataUseLock(client, env, "rollback bootstrap");
    }

    // The capture is READ-ONLY on both stores, so redoing it after an interruption changes nothing
    // — but a checkpoint that was already published, verified and read back is durable evidence,
    // and republishing under a fresh object ID would orphan it. A resume from `captured` therefore
    // adopts the recorded object after re-proving its identity, and only an interruption BEFORE
    // publication re-captures.
    phase("capture-checkpoint", { resumedPhase: resumed?.phase ?? null });
    const created = resumed?.phase === "captured"
      ? await adoptPublishedBootstrapCheckpoint({ rollbackStore, env, resumed, phase })
      : await withPrivateTempDir("aios-staging-bootstrap-", async (directory) => {
      const postgresTarget = parseCanonicalPostgresTarget(env.DATABASE_URL, {
        label: "bootstrap rollback Postgres", requireInternal: env.STAGING_MAINTENANCE_ADAPTER !== "local",
      });
      await captureRollbackPostgres({ client, databaseUrl: postgresTarget.connectionString, directory, operationTimeoutMs: deadlines.operationMs, terminateGraceMs: deadlines.terminateGraceMs, budget: operationBudget, signal });
      const driver = neo4j.driver(env.NEO4J_URL, neo4j.auth.basic(env.NEO4J_USER, env.NEO4J_PASSWORD), { connectionTimeout: deadlines.connectionMs });
      const session = driver.session({ database: env.NEO4J_DATABASE, defaultAccessMode: neo4j.session.READ });
      try {
        const graph = await exportGraph(session, { operationTimeoutMs: deadlines.operationMs, budget: operationBudget });
        // M2: prove the captured graph is REPLAYABLE before this checkpoint is accepted as the
        // thing recovery depends on. Codec version, shape and a round trip through the same codec
        // the restore will use — a checkpoint that cannot be replayed is not a checkpoint.
        assertReplayableGraph(graph);
        const packed = await packPair(directory, graph, { includeAuthUsers: false });
        const manifest = { kind: "staging-rollback", databaseMode: "full", formatVersion: 1, graphCodecVersion: graph.codecVersion, runId: bootstrapRunId,
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
        const bytes = Buffer.from(JSON.stringify(bundle)); const digest = sha(bytes); const objectId = canonicalObjectId(bootstrapRunId, digest);
        operationBudget.assert("bootstrap checkpoint publication");
        await rollbackStore.putImmutable(objectId, bytes);
        if (!(await rollbackStore.verify(objectId, digest))) throw new Error("bootstrap rollback failed durable read-back verification");
        // Read the sealed object BACK through the ordinary open path: signature, decryption,
        // manifest validity and checksums, exactly as a real rollback would.
        const readBack = openBundleBytes(await rollbackStore.read(objectId), env, "rollback", { ignoreExpiry: true });
        if (readBack.manifest.runId !== bootstrapRunId || readBack.manifest.build?.applicationCommit !== current.commit) {
          throw new Error("bootstrap checkpoint failed its durable read-back identity check");
        }
        // PERSIST THE VERIFIED OBJECT'S IDENTITY BEFORE ANYTHING RELIES ON IT. The publication is
        // durable and the object has just proved it opens; a kill in the next microsecond would
        // otherwise leave a perfectly good checkpoint that no replacement worker could name, and a
        // re-capture would orphan it. This is the second interruption window the record covers.
        await recordBootstrapRecovery(client, {
          runId: bootstrapRunId, phase: "captured", deploymentId: current.deployment?.id ?? null, commit: current.commit, mode,
          environmentId: env.RAILWAY_ENVIRONMENT_ID, appServiceId: env.STAGING_APP_SERVICE_ID, objectId, digest,
        });
        // HARNESS FAULT — INTERRUPTION WINDOW 2: the checkpoint is durably published, verified and
        // recorded; the journal has NOT advanced to booting and nothing is serving. A replacement
        // must adopt this exact object rather than orphan it and capture a second one.
        if (env.STAGING_PAIR_REQUIRED === "1" && env.STAGING_FAULT_POINT === "bootstrap-after-publish") {
          emitReceipt("fault-injected", { point: "bootstrap-after-publish", runId: bootstrapRunId, objectId, kill: "SIGKILL" });
          process.kill(process.pid, "SIGKILL");
        }
        return { objectId, digest };
      } finally {
        const terminalBudget = createOperationBudget("bootstrap terminal cleanup", deadlines.cleanupMs);
        await closeAllWithinBudget({ budget: terminalBudget, terminateGraceMs: deadlines.terminateGraceMs },
          ownedCloser(() => session.close()), ownedCloser(() => driver.close()));
      }
    });
    phase("captured-checkpoint", { objectId: created.objectId });
    operationBudget.assert("bootstrap boot transition");
    // Idempotent across the publication → boot → pointer → ready boundaries: a resumed worker may
    // find the journal already `booting` for this same run (killed after the transition, before
    // ready), so `booting` is an accepted source state. The identity written is unchanged, and
    // `bootAdmissionVerdict` still admits ONLY a process whose commit equals `bootCommit` and whose
    // boot run equals the journal's current run — exact boot admission is not relaxed here.
    await transitionJournal(client, { runId: bootstrapRunId, from: ["draining", "booting"], to: "booting", patch: { candidateMode: mode, bootRunId: bootstrapRunId, bootCommit: current.commit } });
    await releaseDataUseLock(client, "exclusive");
    phase("deploy-app");
    const deploymentId = await maintenance.deployApp(current.commit);
    operationBudget.assert("bootstrap health verification");
    phase("await-boot", { deploymentId, mode });
    await waitForImportedBoot({ maintenance, deploymentId, commit: current.commit, origin: env.STAGING_ORIGIN, token: env.STAGING_HEALTH_TOKEN, mode });
    phase("booted", { deploymentId });
    await rollbackStore.writePointer("last-ready", { runId: bootstrapRunId, objectId: created.objectId, digest: created.digest, commit: current.commit, mode, kind: "rollback" });
    await markReady(client, { runId: bootstrapRunId, objectId: created.objectId, digest: created.digest, commit: current.commit, mode });
    // Only NOW, once ready is committed, does the interruption record stop being needed. Clearing
    // it any earlier would remove the only way back from the very windows it exists for.
    await clearBootstrapRecovery(client, bootstrapRunId);
    return { status: resumed ? "bootstrapped-after-interruption" : "bootstrapped", runId: bootstrapRunId, objectId: created.objectId, commit: current.commit, mode, resumedFrom: resumed?.phase ?? null };
  } catch (error) {
    // ⚠️ L1/L3: A PRE-ADMISSION REFUSAL LEAVES EVERYTHING EXACTLY AS IT WAS.
    //
    // No draining transition, no stop, no deployment change — so there is nothing to recover, and
    // the block below would not be a recovery: it would write `failed` over a journal this run never
    // moved and redeploy an app that never stopped, on a mode this run may have just refused. It
    // would also convert an external shutdown into a lifecycle mutation, which is the opposite of
    // what a shutdown asked for.
    //
    // The refusal is reported as-is. Nothing here claims the baseline is healthy or serving: this
    // invocation did not stop it, and did not measure it afterwards either. Interrupted-state
    // evidence (an existing bootstrap interruption record, an existing journal state) is preserved
    // untouched for the next run to reconcile.
    if (!admitted) {
      phase("refused-before-admission", { resumed: Boolean(resumed), measuredDeployment: Boolean(current) });
      throw error;
    }
    const notes = [];
    const recoveryBudget = createOperationBudget("bootstrap recovery", deadlines.recoveryMs);
    return await withRecoveryWatchdog(beginRecoveryWatchdog, recoveryBudget, async (_recoverySignal) => {
    // Same ordering rule as the refresh path: the capture holds a read-only transaction on this
    // client, so a failure inside it can leave the session aborted and every recovery statement
    // below — the lock release and both journal transitions — would fail invisibly.
    recoveryBudget.assert("bootstrap recovery session reset");
    const reset = await resetSessionTransactionState(client);
    if (reset.status !== "reset") notes.push(`session reset failed: ${reset.detail}`);
    if (reset.status === "reset") {
      await configurePostgresDeadline(client, recoveryBudget.remaining(deadlines.recoveryMs, "bootstrap recovery deadline configuration")).catch((deadlineError) => notes.push(`recovery deadline could not be installed: ${errorText(deadlineError)}`));
    }
    await recoveryStep("exclusive data-use lock release", () => releaseDataUseLock(client, "exclusive"), notes);
    // Bootstrap performs no destructive database write, so recovery is exactly "put the UNCHANGED
    // deployment back". Two things this has to get right:
    //  - the journal must ADMIT that restart. Going straight to `failed` fences the very process
    //    recovery depends on, because the loader and startup fence both refuse a failed journal.
    //  - the probe must use the mode staging ACTUALLY runs in. Defaulting it to `copy-ready` meant a
    //    legacy-pg-only baseline could never satisfy it, and a successful restart was reported as a
    //    failed one.
    phase("recovery-restart-deployment", { measuredDeployment: Boolean(current) });
    let restored = false;
    try {
      // A failure BEFORE the deployment was measured has nothing to restart, and nothing was
      // changed either. Said plainly, rather than as a `TypeError` on `null.commit` in a note.
      if (!current) throw new Error("the current staging deployment was never measured, so there is nothing to restart (and nothing was changed)");
      // L3: the RECORDED mode, never the configured one. On a resume these are equal by validation;
      // sourcing it from the record is what stops a configuration value that was refused, or that
      // drifted after the interruption, from deciding how the baseline comes back and what the boot
      // probe accepts.
      await transitionJournal(client, { runId: bootstrapRunId, from: ["draining", "booting", "failed"], to: "booting", patch: { candidateMode: recoveryMode, bootRunId: bootstrapRunId, bootCommit: current.commit } });
      const deploymentId = await maintenance.deployApp(current.commit);
      await waitForImportedBoot({ maintenance, deploymentId, commit: current.commit, origin: env.STAGING_ORIGIN, token: env.STAGING_HEALTH_TOKEN, mode: recoveryMode });
      restored = true;
    } catch (restoreError) { restored = false; notes.push(`deployment restart failed: ${errorText(restoreError).slice(0, 200)}`); }
    await recoveryStep("bootstrap checkpoint journal transition", () => transitionJournal(client, {
      runId: bootstrapRunId, from: ["draining", "booting", "failed"], to: "failed",
      patch: { lastSafeCheckpoint: restored ? "bootstrap-failed-prior-restored" : "recovery-required" },
    }), notes);
    // The interruption record is DELIBERATELY NOT cleared here. An ordinary failure leaves the same
    // baseline identity a killed worker would have left, and the next `bootstrap-rollback` needs it
    // for exactly the same reason. It is cleared in one place only: after ready is committed.
    throw new Error(withNotes(`${errorText(error)} (prior staging deployment ${restored ? "restored unchanged" : "NOT restored — re-run `importer bootstrap-rollback`, which resumes the recorded interrupted bootstrap, or restore the deployment explicitly"})`, notes));
    });
  } finally { await releaseCoordinatorLock(client).catch(() => {}); }
}

async function serviceCatchup({ client, maintenance, env, budget = null }) {
  budget?.assert("catch-up coordinator lock");
  if (!(await acquireCoordinatorLock(client))) return { status: "catchup-busy" };
  try {
    budget?.assert("catch-up journal read");
    const journal = await readJournal(client);
    if (journal.state !== "ready") return { status: "catchup-deferred", state: journal.state };
    budget?.assert("catch-up head measurement");
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
  const providerTarget = env.STAGING_MAINTENANCE_ADAPTER === "local" ? [] : [
    "STAGING_IMPORTER_SERVICE_INSTANCE_ID", "STAGING_IMPORTER_DEPLOYMENT_ID",
    "STAGING_POSTGRES_SERVICE_ID", "STAGING_POSTGRES_SERVICE_INSTANCE_ID", "STAGING_POSTGRES_DEPLOYMENT_ID",
    "STAGING_POSTGRES_HOST", "STAGING_POSTGRES_DATABASE",
  ];
  // M1: `verify-target` requires the settings the destination proof ACTUALLY reads — the maintenance
  // adapter's scope, the pinned Postgres/importer identities, and (off the local harness) the
  // provider target pins. It deliberately requires none of the source-object, tester, origin or
  // rollback-signing configuration: those belong to actions that install or restore a pair, and
  // demanding them would make a read-only check unavailable exactly when an operator most needs it
  // — before the rest of the system has been provisioned.
  if (action === "verify-target") {
    const destination = [
      "RAILWAY_PROJECT_ID", "RAILWAY_ENVIRONMENT_ID", "STAGING_OPS_ENVIRONMENT_ID",
      "RAILWAY_STAGING_MAINTENANCE_TOKEN", "STAGING_APP_SERVICE_ID", "STAGING_GRAPHITI_SERVICE_ID",
      "STAGING_IMPORTER_SERVICE_ID",
    ];
    for (const name of [...destination, ...providerTarget]) if (!env[name]) throw new Error(`${name} is required`);
    assertActionConfiguration(env, action);
    return true;
  }
  const rollback = [];
  for (const name of [...common, ...(action === "verify" || action === "install-ops" ? [] : [...runtime, ...providerTarget]), ...rollback]) if (!env[name]) throw new Error(`${name} is required`);
  for (const name of ["EXPORTER_SIGNING_PUBLIC_KEY", "IMPORTER_ENCRYPTION_PRIVATE_KEY", ...(action === "verify" ? [] : ["ROLLBACK_SIGNING_PRIVATE_KEY", "ROLLBACK_SIGNING_PUBLIC_KEY", "ROLLBACK_ENCRYPTION_PUBLIC_KEY", "ROLLBACK_ENCRYPTION_PRIVATE_KEY"])]) keyMaterial(env, name);
  // H2: the settings this ACTION reaches for later — origin, health token, tester credentials —
  // validated here, before anything can drain, stop, restore or delete.
  assertActionConfiguration(env, action);
  createPrivateStore({ env, scope: "source", role: "source-reader" });
  createPrivateStore({ env, scope: "rollback", role: "rollback-owner" });
  return true;
}

/**
 * The idle wait between daemon ticks, raced against the shutdown.
 *
 * The traced defect: a bare `setTimeout` observed NOTHING, so a SIGTERM delivered to a daemon
 * sitting between ticks was not acted on for up to five more minutes — and the tick that eventually
 * ran then started its work under an already-aborted signal, which is the worst of both. Resolving
 * on either the timer or the abort is what lets the loop leave promptly, through the same cleanup
 * that settles owned work.
 *
 * The listener is removed on the timer path too: a five-minute daemon that never leaves the loop
 * would otherwise accumulate one abort listener per tick for the life of the process.
 */
export function waitForAbortableInterval(ms, signal) {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve("aborted");
    const finish = (reason) => { clearTimeout(timer); signal.removeEventListener("abort", onAbort); resolve(reason); };
    const onAbort = () => finish("aborted");
    const timer = setTimeout(() => finish("interval"), ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * The daemon's poll loop, extracted so the shutdown behaviour is a testable property rather than a
 * source shape. Two things it must guarantee, and neither is visible from a `grep`:
 *
 *  - A shutdown delivered while IDLE ends the loop promptly, and no further tick is admitted. The
 *    loop condition is re-checked after the wait for exactly that reason: a signal that arrives
 *    during the wait must not be followed by one more tick.
 *  - A shutdown delivered DURING a tick is not an error to log and retry. `installObject` refuses
 *    new destructive work under cancellation by design, so `STAGING_OPERATION_ABORTED` is the
 *    daemon being asked to stop, not a tick that went wrong.
 *
 * The five-minute floor stays at the CLI, where the operator-facing value is validated; passing a
 * short interval here is how a test observes a whole cycle without waiting for one.
 *
 * @param {object} args
 * @param {() => Promise<unknown>} args.tick one complete unit of daemon work
 * @param {number} args.intervalMs idle wait between ticks
 * @param {AbortSignal} args.signal the process shutdown signal
 * @param {(error: unknown) => boolean} [args.isFatal] errors that must END the daemon, not be logged
 * @param {(message: string) => void} [args.log] where a non-fatal tick failure is reported
 */
export async function runPollingDaemon({ tick, intervalMs, signal, isFatal = () => false, log = (message) => console.error(message) }) {
  while (!signal.aborted) {
    try { await tick(); }
    catch (error) {
      if (isFatal(error)) throw error;
      // L2: suppression is keyed on THIS DAEMON'S external signal, not on an error's name. Only the
      // shutdown signal ends this loop, so only a cancellation that coincides with it is the
      // expected quiet stop. Keying on the code alone silenced any ABORTED-coded failure — including
      // a tick cancelled by something the daemon was never told about — into a five-minute retry
      // with no diagnostic. An ordinary failure is still logged either way.
      const expectedShutdown = signal.aborted && error?.code === "STAGING_OPERATION_ABORTED";
      if (!expectedShutdown) {
        log(`staging importer tick failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    await waitForAbortableInterval(intervalMs, signal);
  }
  return { status: "stopped", reason: "signal" };
}

export async function runImporter(env = process.env, argv = process.argv.slice(2), { activationRunner = runActivationPreflight, activationOptions = {}, now = undefined } = {}) {
  const action = argv[0];
  if (!new Set(["install-ops", "verify", "verify-target", "install", "bootstrap-rollback", "rollback", "tick", "daemon", "activation-preflight"]).has(action)) throw new Error("importer action must be install-ops, verify, verify-target, install, bootstrap-rollback, rollback, tick, daemon, or activation-preflight");
  // The activation verifier is READ-ONLY and needs no database, no locks and no runner role: it is
  // the check an operator runs BEFORE any of this is turned on, and making it depend on the runtime
  // it is supposed to authorise would be circular. It refuses on `UNVERIFIED` as well as on
  // `NOT ACTIVATED` — "we could not look" is not permission — and its best outcome is READY TO
  // ACTIVATE, which is a readiness verdict about an inert system, not a claim that it is running.
  const deadlines = stagingOperationDeadlines(env);
  if (action === "activation-preflight") {
    const activationBudget = createOperationBudget("activation preflight", deadlines.operationMs, { now });
    activationBudget.assert("activation evidence verification");
    const result = await activationRunner(env, { ...activationOptions, budget: activationBudget });
    activationBudget.assert("activation preflight verdict");
    console.log(result.report);
    assertActivationPreflightReady(result);
    return { status: result.status, checks: result.checks };
  }
  // Validate all finite budgets before opening a DB connection or constructing a lifecycle writer.
  // A daemon gets one fresh operation budget per tick; this is not a finite daemon lifetime.
  const actionBudget = action === "daemon" ? null : createOperationBudget(`importer ${action}`, deadlines.operationMs, { now });
  actionBudget?.assert("importer preflight");
  await importerPreflight(env, action);
  const postgresTarget = parseCanonicalPostgresTarget(env.DATABASE_URL, {
    label: "importer Postgres", requireInternal: env.STAGING_MAINTENANCE_ADAPTER !== "local",
  });
  const client = new pg.Client(postgresDeadlineConfig(postgresTarget.connectionString, actionBudget?.remaining(deadlines.operationMs, "Postgres connection") ?? deadlines.operationMs, deadlines.connectionMs)); await client.connect();
  const shutdown = new AbortController();
  // Deadline cancellation is delivered to owned work. The lock-owning socket stays healthy until
  // that work has either completed or proved its subprocess group absent; only the outer cleanup
  // below may then release the fencing session. External signals share every phase signal so they
  // retain the same containment ordering, including after recovery watchdog transfer.
  const watchdogOwner = createSessionWatchdogOwner(undefined, { signal: shutdown.signal });
  const actionWatchdog = actionBudget ? watchdogOwner.arm(actionBudget) : null;
  let shuttingDown = false;
  /**
   * A SIGNAL CANCELS THIS INVOCATION'S OWN WORK. IT WRITES NO JOURNAL. ⚠️
   *
   * This used to open a SECOND Postgres connection out of band, read the singleton journal and
   * transition whatever non-ready run it found to `failed`. Nothing in that path established that
   * the row belonged to this process: it took no coordinator lock, and `transitionJournal`
   * predicates on the singleton and the observed state only — never on the current `run_id` — so it
   * accepted the stranger's run id it had just read and wrote it back as failed.
   *
   * The counterexample is the advertised READ-ONLY `verify-target`. Its handlers are installed
   * before the dispatch at the branch below and survive its awaited reads, so an operator pressing
   * Ctrl-C during a destination check marked ANOTHER importer's active `importing` run failed —
   * that run's expected `importing → verifying` transition then cannot succeed, and a healthy
   * install is forced into recovery. A cancelled read-only check must not be able to do that.
   *
   * What replaces it is nothing, deliberately. Every action that actually owns a run already records
   * its own terminal checkpoint on its own lock-held connection (`installObject`'s failed-state
   * transition, `rollbackToPrior`'s `recovery-required`, the bootstrap's failure record), and those
   * run on the cancellation path too because cancellation surfaces there as an ordinary failure. An
   * out-of-band writer could only ever add the case those cannot see — the one where this process
   * owns nothing — which is precisely the case it must not write.
   *
   * Still guaranteed here, and asserted by the tests around this: the abort is IDEMPOTENT (a second
   * signal is absorbed rather than falling through to Node's default action and dropping the fence
   * while an owned restore is alive), it reaches owned subprocesses through the phase signals, and
   * the `finally` below still closes this invocation's client within a finite cleanup budget.
   */
  const recordSignalAbort = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    shutdown.abort(Object.assign(new Error(`importer received ${signal}`), { code: "STAGING_OPERATION_ABORTED" }));
  };
  const signalHandlers = Object.fromEntries(["SIGTERM", "SIGINT"].map((signal) => [signal, () => { recordSignalAbort(signal); }]));
  // Keep the idempotent handlers installed through containment. A second signal must not fall
  // through to Node's default action and release the lock while an owned restore is still alive.
  for (const [signal, handler] of Object.entries(signalHandlers)) process.on(signal, handler);
  try {
    // Constructed INSIDE the cleanup scope. These three ran between `client.connect()` and the
    // `try`, so a store or maintenance adapter that refused its own configuration left an open
    // Postgres connection with nothing to close it.
    // `verify-target` measures the DESTINATION; it reads no bundle, so it constructs no object
    // store. Building them here would make a read-only destination check depend on source/rollback
    // storage configuration it never touches.
    const bundleStores = action !== "install-ops" && action !== "verify-target";
    const sourceStore = bundleStores ? createPrivateStore({ env, scope: "source", role: "source-reader" }) : null;
    const rollbackStore = bundleStores ? createPrivateStore({ env, scope: "rollback", role: "rollback-owner" }) : null;
    const maintenance = action === "verify" || action === "install-ops" ? null : maintenanceFor(env);
    if (action === "install-ops") { await installStagingOps(client); return { status: "installed" }; }
    // M1: READ-ONLY, and its position says so — before the deadline configuration and every
    // lifecycle branch below. It returns the measured target; nothing here drains, stops or writes.
    if (action === "verify-target") return await verifyStagingTarget({ client, maintenance, env });
    if (action === "verify") {
      const objectId = argv[1]; if (!objectId) throw new Error("canonical immutable object ID is required");
      const opened = await verifyAndPinSourceBundle({ objectId, sourceStore, rollbackStore, env }); compareEnvironmentCredentials(opened.manifest, env);
      return { status: "verified-and-pinned", runId: opened.manifest.runId, objectId, topology: verifyConfiguredTopology(env) };
    }
    // ⚠️ `return await`, NOT `return`, for every branch whose promise is still running when the
    // enclosing `finally` fires. A bare `return promise` resolves the try block IMMEDIATELY, so
    // `finally { await client.end() }` ran while the very first coordinator-lock query was still in
    // flight; `pg` destroys a connection that is ending with an active query, and the harness saw
    // exactly that: bootstrap dying with `Connection terminated` before it had read anything.
    // This applies ONLY where the promise owns enclosing cleanup — the inner `tick` helper, the
    // health wrappers and `replaceFromArchive` own none, and are deliberately left alone.
    await configurePostgresDeadline(client, actionBudget?.remaining(deadlines.operationMs, "importer deadline configuration") ?? deadlines.operationMs);
    if (action === "bootstrap-rollback") return await bootstrapRollback({
      client, rollbackStore, maintenance, env, deadlines, budget: actionBudget,
      signal: actionWatchdog?.signal ?? shutdown.signal, beginRecoveryWatchdog: (budget) => watchdogOwner.transferTo(budget),
    });
    if (action === "rollback") {
      if (!(await acquireCoordinatorLock(client))) throw new Error("another importer owns the coordinator lock");
      // The await must be INSIDE this try, not merely inside the outer one: otherwise this `finally`
      // releases the coordinator lock while the rollback it is fencing is still running, and a
      // second importer can acquire it mid-recovery — a failure independent of the connection close.
      try {
        const journal = await readJournal(client);
        const hasPreservedTarget = Boolean(journal.rollback_target_run_id);
        if (journal.state === "ready" && !hasPreservedTarget) {
          throw new Error("ready staging has no preserved prior rollback target; refusing to stop the healthy deployment");
        }
        // A shutdown may not open a NEW maintenance window. From `ready` this rollback would drain
        // and stop a healthy serving pair; from any other state it is the recovery of a run that is
        // already fenced, which a shutdown must not withhold.
        if (journal.state === "ready") assertNotCancelled(shutdown.signal, "manual rollback of a ready staging pair");
        const prior = hasPreservedTarget
          ? await openRollbackTarget({ journal, rollbackStore, env })
          : await openPrior({ journal, rollbackStore, env });
        const recoveryBudget = createOperationBudget("manual importer recovery", deadlines.recoveryMs, { now });
        return await withRecoveryWatchdog(
          (budget) => watchdogOwner.transferTo(budget),
          recoveryBudget,
          (recoverySignal) => rollbackToPrior({ client, prior, failedRunId: argv[1] ?? `manual-${Date.now()}`, maintenance, rollbackStore, env, deadlines, budget: recoveryBudget, signal: recoverySignal }),
        );
      }
      finally { await releaseCoordinatorLock(client).catch(() => {}); }
    }
    if (action === "install") {
      if (!argv[1]) throw new Error("canonical immutable object ID is required");
      return await installObject({ client, objectId: argv[1], sourceStore, rollbackStore, maintenance, env, deadlines, operations: {
        operationBudget: actionBudget, now, signal: actionWatchdog?.signal ?? shutdown.signal,
        beginRecoveryWatchdog: (budget) => watchdogOwner.transferTo(budget),
      } });
    }
    const tick = async () => {
      const tickBudget = createOperationBudget("importer daemon tick", deadlines.operationMs, { now });
      const tickWatchdog = watchdogOwner.arm(tickBudget);
      try {
      // Reset server-side statement/lock deadlines for THIS daemon operation. The connection and
      // daemon persist, but no individual tick inherits an expired or recovery-sized budget.
      await configurePostgresDeadline(client, tickBudget.remaining(deadlines.operationMs, "daemon tick deadline configuration"));
      const catchup = await serviceCatchup({ client, maintenance, env, budget: tickBudget });
      // Selection reads the watermark unlocked and `installObject` RE-CHECKS it while holding the
      // coordinator lock, so a concurrent worker cannot install between the two.
      tickBudget.assert("source discovery journal read");
      const objectId = await discoverLatestSource(sourceStore, await readJournal(client), env);
      if (!objectId) return { status: "idle", catchup };
      // `automatic: true` — THE unattended path. `install <object-id>` below is the explicit
      // operator action and is deliberately not marked automatic, so it remains the one way to
      // re-attempt a source whose destructive install already failed.
      return await installObject({ client, objectId, sourceStore, rollbackStore, maintenance, env, deadlines, automatic: true, operations: {
        operationBudget: tickBudget, now, signal: tickWatchdog.signal,
        beginRecoveryWatchdog: (budget) => watchdogOwner.transferTo(budget),
      } });
      } finally { await tickWatchdog.disarm(); }
    };
    if (action === "tick") return await tick();
    const interval = Number(env.STAGING_IMPORTER_POLL_MS ?? 300_000);
    if (!Number.isFinite(interval) || interval < 300_000) throw new Error("importer poll interval must be at least five minutes");
    // The outer cleanup below turns this into the coordinated STAGING_OPERATION_ABORTED result.
    return await runPollingDaemon({
      tick, intervalMs: interval, signal: shutdown.signal,
      // A connection whose socket is gone cannot serve another tick, and a deadline breach is the
      // daemon's own budget, not a candidate's failure. Both must end the loop rather than be
      // logged and retried in five minutes.
      isFatal: (error) => error?.code === "STAGING_OPERATION_TIMEOUT" || Boolean(client.connection?.stream?.destroyed),
    });
  } finally {
    await actionWatchdog?.disarm();
    await watchdogOwner.disarmAll();
    // Removed only HERE, after the owned work above has settled: a handler dropped earlier would let
    // a second signal take Node's default action and kill the fence-owning process mid-containment.
    // There is no signal side task left to await — the abort is synchronous and owns nothing beyond
    // this invocation — so the next statement is the one bounded cleanup of the one owned client.
    for (const [signal, handler] of Object.entries(signalHandlers)) process.removeListener(signal, handler);
    const terminalBudget = createOperationBudget("importer terminal cleanup", deadlines.cleanupMs, { now });
    await closeAllWithinBudget({ budget: terminalBudget, terminateGraceMs: deadlines.terminateGraceMs },
      ownedCloser(() => client.end(), () => client.connection?.stream?.destroy()));
    if (shutdown.signal.aborted) {
      throw Object.assign(new Error("staging importer stopped after coordinated signal cancellation; owned operations are settled"), {
        code: "STAGING_OPERATION_ABORTED", terminationConfirmed: true,
      });
    }
  }
}

// `isDirectEntry`, not the two naive spellings — both of which fail OPEN, answering "no" for an
// invocation that really is direct, so the CLI body never runs and the process exits 0 having
// printed nothing. Symlinked here means the importer silently performs no import. See the helper.
if (isDirectEntry(import.meta.url)) runImporter().then((result) => console.log(JSON.stringify(result))).catch((error) => { console.error(`staging importer refused: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; });
