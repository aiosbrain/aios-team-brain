#!/usr/bin/env node
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";
import neo4j from "neo4j-driver";
import { fingerprint } from "../schema-fingerprint.mjs";
import { migrationSetIdentity, schemaFingerprintDigest } from "./build-identity.mjs";
import { createSignedEncryptedBundle } from "./bundle-crypto.mjs";
import { packPair } from "./bundle-format.mjs";
import { credentialFingerprint } from "./credential-fingerprint.mjs";
import { exportGraph, graphCensus, sanitizeGraphExport } from "./graph-bundle.mjs";
import { capturePairedPostgres } from "./pg-paired.mjs";
import { withPrivateTempDir } from "./private-store.mjs";
import { closeAllWithinBudget, ownedCloser } from "./resource-cleanup.mjs";
import { canonicalObjectId, createPrivateStore } from "./object-store.mjs";
import { assertOutboundCredentialIsolation, assertRunnerRole } from "./role-policy.mjs";
import { RailwayRunnerInspector } from "./railway-maintenance.mjs";
import { keyMaterial } from "./key-material.mjs";
import { armBudgetWatchdog, createOperationBudget, postgresDeadlineConfig, stagingOperationDeadlines } from "./operation-deadline.mjs";
import { publishActivationEvidence } from "./activation-evidence.mjs";

const sha = (v) => createHash("sha256").update(v).digest("hex");
const FULL_SHA = /^[0-9a-f]{40}$/i;

export function itemEpisodeStem(name) {
  const match = String(name ?? "").match(/^(items:[^#]+)(?:#\d+)?$/);
  return match?.[1] ?? null;
}

export async function snapshotExportFacts(client) {
  const result = await client.query(`SELECT ge.source_table, ge.source_id::text, ge.group_id, ge.pending_delete_group_id,
    ge.content_sha256, ge.episode_uuid, ge.chunk_shas, ge.deferred,
    CASE WHEN ge.source_table='arc_corrections' THEN (SELECT ac.arc_id FROM arc_corrections ac WHERE ac.id=ge.source_id AND ac.team_id=ge.team_id) END AS correction_arc_id,
    CASE WHEN ge.source_table='items' THEN EXISTS(
      SELECT 1 FROM items i
      JOIN projects target ON target.team_id=i.team_id AND target.graph_group_id=ge.group_id
      WHERE i.id=ge.source_id AND i.team_id=ge.team_id AND (
        target.id=i.project_id OR
        (target.kind='system' AND target.slug='general' AND i.access='team' AND (
          NOT EXISTS (SELECT 1 FROM project_context_units u WHERE u.team_id=i.team_id AND u.source_item_id=i.id AND u.state='active') OR
          EXISTS (SELECT 1 FROM project_context_units u JOIN project_context_memberships m ON m.context_unit_id=u.id AND m.team_id=u.team_id
            WHERE u.team_id=i.team_id AND u.source_item_id=i.id AND u.state='active' AND m.project_id=target.id AND m.decision='include' AND m.valid_to IS NULL))) OR
        (target.kind='system' AND target.slug='external-shared' AND i.access='external' AND (
          NOT EXISTS (SELECT 1 FROM project_context_units u WHERE u.team_id=i.team_id AND u.source_item_id=i.id AND u.state='active') OR
          EXISTS (SELECT 1 FROM project_context_units u JOIN project_context_memberships m ON m.context_unit_id=u.id AND m.team_id=u.team_id
            WHERE u.team_id=i.team_id AND u.source_item_id=i.id AND u.state='active' AND m.project_id=target.id AND m.decision='include' AND m.valid_to IS NULL))) OR
        (target.kind='initiative' AND EXISTS (SELECT 1 FROM project_context_units u JOIN project_context_memberships m ON m.context_unit_id=u.id AND m.team_id=u.team_id
          WHERE u.team_id=i.team_id AND u.source_item_id=i.id AND u.state='active' AND m.project_id=target.id AND m.decision='include' AND m.valid_to IS NULL))
      ))
      ELSE false END AS source_eligible
    FROM graph_episodes ge`);
  // A correction episode is named `correction:<arc_id>`, NOT `correction:<arc_corrections.id>`.
  // Keying the ledger by the row id produced a key no episode could ever match, which silently
  // disarmed both the allow and the pending-delete EXCLUDE for every correction.
  const correctionScope = await resolveCorrectionScopes(client);
  const allowed = new Set(); const excluded = new Set(); const ledger = [];
  const unresolvedCorrections = [];
  for (const row of result.rows) {
    // A deferred or blank-content row is not a CURRENT projection, so it is neither copied nor a
    // reason to refuse the whole capture.
    const current = !row.deferred && row.content_sha256 !== "";
    let name;
    let scopeProven = true;
    if (row.source_table === "arc_corrections") {
      const scope = correctionScope.get(String(row.source_id));
      name = scope?.arcId ? `correction:${scope.arcId}` : `unresolved-correction:${row.source_id}`;
      scopeProven = scope?.resolvedGroup === row.group_id;
      if (current && !scopeProven) {
        unresolvedCorrections.push(!scope?.arcId ? `${row.source_id}: ledger row has no arc_corrections row`
          : scope.resolvedGroup ? `${scope.arcId}: stored scope ${scope.resolvedGroup} disagrees with ledger group ${row.group_id}`
          : `${scope.arcId}: ${scope.reason}`);
      }
    } else name = row.source_table === "items" ? `items:${row.source_id}` : `unsupported:${row.source_id}`;
    const key = `${name}\0${row.group_id}`;
    // Item eligibility is the fan-out oracle; correction eligibility is a PROVEN stored scope.
    const eligible = row.source_table === "items" ? row.source_eligible === true
      : row.source_table === "arc_corrections" ? scopeProven
      : false;
    if (eligible) allowed.add(key); else excluded.add(key);
    if (row.pending_delete_group_id) excluded.add(`${name}\0${row.pending_delete_group_id}`);
    ledger.push({ ...row, source_id: String(row.source_id), episodeName: name });
  }
  const schemaLines = await fingerprint(client);
  return { allowed, excluded, ledger, schemaLines, unresolvedCorrections };
}

/**
 * Resolve each correction's stored SYNTHESIS SCOPE to an exact graph group, by PROOF.
 *
 * Since PRET-3 the scope key is always `g:<graph_group_id>`, and the only legitimate resolution is
 * a project in the same team that actually owns that group. Everything else — a legacy tier scope
 * (`''`), a retired partition key (`p:<projectId>`), or a `g:` key naming a group no project owns —
 * is UNRESOLVED. It is not mapped by resemblance and it is not quietly given the team's general
 * group: that would move an editorial act into a scope its author never made it in, which is a tier
 * decision dressed up as a string parse. Unresolved scopes are named and refused by the caller.
 */
export async function resolveCorrectionScopes(client) {
  const result = await client.query(`SELECT a.id::text AS id, a.arc_id, a.group_key,
      CASE WHEN a.group_key LIKE 'g:%' THEN (
        SELECT p.graph_group_id FROM projects p
         WHERE p.team_id = a.team_id AND p.graph_group_id = substr(a.group_key, 3)
         LIMIT 1) END AS proven_group
    FROM arc_corrections a`);
  const scopes = new Map();
  for (const row of result.rows) {
    const key = String(row.group_key ?? "");
    const reason = !key ? "legacy tier-scope correction has no exact graph group"
      : !key.startsWith("g:") ? `unsupported correction scope key namespace ${key.split(":")[0]}:`
      : !row.proven_group ? `scope key ${key} names a group no project in this team owns`
      : null;
    scopes.set(row.id, { arcId: row.arc_id, resolvedGroup: row.proven_group ?? null, reason });
  }
  return scopes;
}

/** Unknown/ambiguous correction scope is an actionable named refusal, never a silent drop. */
export function assertResolvedCorrectionScopes(facts) {
  const unresolved = facts?.unresolvedCorrections ?? [];
  if (unresolved.length === 0) return true;
  throw new Error(`correction episodes with unresolved synthesis scope refuse the bundle: ${unresolved.slice(0, 10).join("; ")}`);
}

export function validateLedgerAgainstSanitizedGraph(graph, facts) {
  const episodeNodes = graph.nodes.filter((node) => node.labels.includes("Episodic"));
  const episodes = new Set(episodeNodes.map((node) => `${node.properties?.name}\0${node.properties?.group_id}`));
  // UUID identity is group-scoped. The same UUID may legitimately exist in another group, so a
  // UUID-only set would let that other group's episode satisfy this ledger row.
  const episodeByUuid = new Map(episodeNodes.map((node) => [
    `${node.properties?.uuid}\0${node.properties?.group_id}`,
    String(node.properties?.name ?? ""),
  ]));
  const errors = [];
  for (const row of facts.ledger) {
    if (row.deferred || row.content_sha256 === "") continue;
    // No UUID means the current row has not been reconcile-confirmed yet. Preserve that pending
    // truth rather than inventing confirmation from a same-named graph node. Once a UUID exists,
    // both its group-scoped identity and the complete chunk-name set are mandatory.
    if (!row.episode_uuid) continue;
    // The excluded check is per SOURCE TABLE by construction: `episodeName` already carries the
    // exact episode naming (`items:<id>` / `correction:<arc_id>`) this ledger row projects under.
    const stem = row.episodeName ?? `${row.source_table === "items" ? "items" : "unsupported"}:${row.source_id}`;
    if (facts.excluded.has(`${stem}\0${row.group_id}`)) continue;
    let names;
    if (row.source_table === "items") {
      const chunks = Array.isArray(row.chunk_shas) ? row.chunk_shas.length : 0;
      names = chunks > 1 ? Array.from({ length: chunks }, (_, index) => `${stem}#${index}`) : [stem];
    } else if (row.source_table === "arc_corrections" && stem.startsWith("correction:")) names = [stem];
    else continue;
    const uuidEpisodeName = episodeByUuid.get(`${row.episode_uuid}\0${row.group_id}`);
    if (!uuidEpisodeName || !names.includes(uuidEpisodeName) ||
        !names.every((name) => episodes.has(`${name}\0${row.group_id}`))) {
      errors.push(`${row.source_id}@${row.group_id}`);
    }
  }
  if (errors.length) throw new Error(`sanitized graph does not satisfy current projection ledger (${errors.slice(0, 5).join(", ")})`);
}

async function readDeployedBuildMetadata(env, measuredCommit, fetchImpl = fetch) {
  const response = await fetchImpl(env.SOURCE_BUILD_METADATA_URL, { redirect: "error", headers: { "x-aios-build-metadata-token": env.SOURCE_BUILD_METADATA_TOKEN }, signal: AbortSignal.timeout(10_000) });
  const body = await response.json();
  if (!response.ok || body?.commit !== measuredCommit || !body?.migrationSet?.sha256) throw new Error("source build metadata does not match the measured deployed application");
  return body;
}

export function isTransientCaptureFailure(error) {
  if (error?.transient === true) return true;
  const code = String(error?.code ?? error?.cause?.code ?? "");
  if (/^(ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|57P01|57P02|57P03|40001|40P01)$/.test(code)) return true;
  const name = String(error?.name ?? error?.cause?.name ?? "");
  if (/ServiceUnavailable|SessionExpired|TransientError/.test(name)) return true;
  const message = String(error?.message ?? error);
  return /sanitized graph does not satisfy current projection ledger|connection (?:reset|terminated)|snapshot.*(?:invalid|lost)|temporar(?:y|ily) unavailable/i.test(message);
}

/** Exactly one retry of the WHOLE, still-private capture. Publication happens only afterward. */
export async function captureWithOneTransientRetry(captureAttempt, { transient = isTransientCaptureFailure, budget = null } = {}) {
  let firstError;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    budget?.assert(`capture attempt ${attempt}`);
    try {
      const captured = await captureAttempt(attempt, budget);
      budget?.assert(`capture attempt ${attempt} completion`);
      return { ...captured, attempts: attempt };
    }
    catch (error) {
      if (attempt === 1 && transient(error)) { firstError = error; continue; }
      if (firstError && error && typeof error === "object") Object.defineProperty(error, "firstCaptureFailure", { value: firstError, enumerable: false });
      throw error;
    }
  }
  throw new Error("unreachable capture retry state");
}

export async function runExporter(env = process.env, operations = {}, argv = process.argv.slice(2)) {
  assertRunnerRole(env, "exporter"); assertOutboundCredentialIsolation(env);
  const deadlines = stagingOperationDeadlines(env);
  const runBudget = createOperationBudget("exporter run", deadlines.operationMs, { now: operations.now });
  if (argv[0] === "activation-evidence") {
    runBudget.assert("activation evidence acquisition");
    const result = await publishActivationEvidence({ env, fetchImpl: operations.fetchImpl ?? fetch, store: operations.store, budget: runBudget });
    runBudget.assert("activation evidence publication");
    return result;
  }
  const captureBudget = runBudget.child("exporter capture", deadlines.captureMs);
  let deployed = { commit: env.SOURCE_APPLICATION_COMMIT };
  if (operations.deployedBuild) {
    deployed = { commit: operations.deployedBuild.commit };
  } else if (env.STAGING_MAINTENANCE_ADAPTER !== "local") {
    const inspector = new RailwayRunnerInspector({ projectId: env.RAILWAY_PROJECT_ID, environmentId: env.PRODUCTION_EXPORT_ENVIRONMENT_ID, serviceId: env.PRODUCTION_EXPORTER_SERVICE_ID, token: env.RAILWAY_PRODUCTION_RUNNER_READ_TOKEN });
    runBudget.assert("exporter deployment inspection");
    await inspector.assertPinned(env.STAGING_OPS_IMAGE_DIGEST);
    runBudget.assert("exporter deployment measurement");
    deployed = await inspector.measureSuccessfulDeployment(env.PRODUCTION_APP_SERVICE_ID);
  }
  if (!FULL_SHA.test(String(deployed.commit ?? ""))) throw new Error("source application deployment commit was not measured");
  const deployedBuild = operations.deployedBuild ?? (env.STAGING_MAINTENANCE_ADAPTER === "local"
    ? { commit: deployed.commit, migrationSet: migrationSetIdentity() }
    : await readDeployedBuildMetadata(env, deployed.commit));
  runBudget.assert("exporter database connection");
  const client = operations.client ?? new pg.Client(postgresDeadlineConfig(env.DATABASE_URL, deadlines.operationMs, deadlines.connectionMs));
  if (!operations.client) await client.connect();
  const driver = operations.driver ?? neo4j.driver(env.NEO4J_URL, neo4j.auth.basic(env.NEO4J_USER, env.NEO4J_PASSWORD), { connectionTimeout: deadlines.connectionMs });
  const watchdog = armBudgetWatchdog(runBudget, async (error) => {
    client.connection?.stream?.destroy(error);
    await driver.close().catch(() => {});
  });
  let session = operations.session ?? null;
  try {
    // `return await`: the census runs THREE sequential queries, and a bare `return` resolved this
    // try block after the first one was merely started — so the `finally` closed the session, the
    // driver and the Postgres client underneath it. Same failure shape as the importer dispatcher.
    if (process.argv.includes("--census")) {
      session ??= driver.session({ database: env.NEO4J_DATABASE, defaultAccessMode: neo4j.session.READ });
      return await graphCensus(session, { operationTimeoutMs: deadlines.operationMs, budget: runBudget });
    }
    // The run ID names the MEASURED deployed commit, never the declared env var: on the Railway
    // path `SOURCE_APPLICATION_COMMIT` is unset, and `undefined?.slice()` had been stamping the
    // literal string "undefined" into a bundle's immutable identity.
    const runId = env.STAGING_BUNDLE_RUN_ID || `${new Date().toISOString().replace(/[:.]/g, "-")}-${deployedBuild.commit.slice(0, 12)}`;
    const defaultCaptureAttempt = () => withPrivateTempDir("aios-staging-export-", async (directory) => {
      captureBudget.assert("Postgres capture");
      const started = new Date();
      const postgres = await capturePairedPostgres({
        client, databaseUrl: env.DATABASE_URL, directory, captureSnapshotFacts: snapshotExportFacts,
        operationTimeoutMs: deadlines.captureMs, terminateGraceMs: deadlines.terminateGraceMs,
        budget: captureBudget,
      });
      const policy = postgres.snapshotFacts;
      assertResolvedCorrectionScopes(policy);
      // A retry gets a fresh Bolt session as well as a fresh PG snapshot/temp directory. A Neo4j
      // SessionExpired error cannot be repaired by issuing the same read on the dead session.
      const attemptSession = driver.session({ database: env.NEO4J_DATABASE, defaultAccessMode: neo4j.session.READ });
      let rawGraph;
      try { rawGraph = await exportGraph(attemptSession, { operationTimeoutMs: deadlines.captureMs, budget: captureBudget }); }
      finally { await attemptSession.close(); }
      const graph = sanitizeGraphExport(rawGraph, { episodeAllowed: (episode) => {
        const name = itemEpisodeStem(episode.properties?.name) ?? String(episode.properties?.name ?? "");
        const key = `${name}\0${episode.properties?.group_id ?? ""}`;
        return policy.allowed.has(key) && !policy.excluded.has(key);
      } });
      validateLedgerAgainstSanitizedGraph(graph, policy);
      captureBudget.assert("capture packing");
      const packed = await packPair(directory, graph);
      captureBudget.assert("capture completion");
      return { started, ended: new Date(), graph, policy, packed };
    });
    const captured = await captureWithOneTransientRetry(operations.captureAttempt ?? defaultCaptureAttempt, { budget: captureBudget });
    const { started, ended, graph, policy, packed } = captured;
    const comparisonKey = Buffer.from(env.STAGING_COMPARISON_KEY_BASE64, "base64");
    const credentialFingerprints = Object.fromEntries([
      ["auth-secret", env.AUTH_SECRET], ["secrets-key", env.SECRETS_KEY], ["neo4j-credential", `${env.NEO4J_USER}\0${env.NEO4J_PASSWORD}`],
    ].map(([credentialClass, value]) => [credentialClass, credentialFingerprint({ credentialClass, value, comparisonKey, keyId: env.STAGING_COMPARISON_KEY_ID })]));
    const manifest = {
      formatVersion: 1, graphCodecVersion: graph.codecVersion, runId,
      captureStartedAt: started.toISOString(), captureEndedAt: ended.toISOString(),
      expiresAt: new Date(ended.getTime() + Number(env.STAGING_EXPORT_RETENTION_DAYS ?? 14) * 86400000).toISOString(),
      onlineCaptureInterval: true, checksums: packed.checksums, sanitation: graph.sanitation,
      build: { applicationCommit: deployedBuild.commit, schemaFingerprint: schemaFingerprintDigest(policy.schemaLines), migrationSet: deployedBuild.migrationSet },
      credentialFingerprints,
    };
    runBudget.assert("bundle signing");
    const bundle = createSignedEncryptedBundle({
      payload: packed.payload,
      manifest,
      exporterSigningPrivateKey: keyMaterial(env, "EXPORTER_SIGNING_PRIVATE_KEY"),
      importerEncryptionPublicKey: keyMaterial(env, "IMPORTER_ENCRYPTION_PUBLIC_KEY"),
    });
    const bytes = Buffer.from(JSON.stringify(bundle));
    const digest = sha(bytes); const objectId = canonicalObjectId(runId, digest);
    const store = operations.store ?? createPrivateStore({ env, scope: "source", role: "publisher" });
    runBudget.assert("immutable bundle publication");
    await store.putImmutable(objectId, bytes);
    runBudget.assert("immutable bundle publication completion");
    return { runId, objectId, sha256: digest, captureAttempts: captured.attempts, manifest: { ...manifest, credentialFingerprints: Object.keys(credentialFingerprints), checksums: packed.checksums } };
  } finally {
    await watchdog.disarm();
    const cleanupBudget = createOperationBudget("exporter terminal cleanup", deadlines.cleanupMs, { now: operations.now });
    await closeAllWithinBudget({ budget: cleanupBudget, terminateGraceMs: deadlines.terminateGraceMs },
      session ? ownedCloser(() => session.close()) : null,
      operations.driver ? null : ownedCloser(() => driver.close()),
      operations.client ? null : ownedCloser(() => client.end(), () => client.connection?.stream?.destroy()),
    );
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) runExporter().then((result) => console.log(JSON.stringify(result))).catch((error) => { console.error(`staging exporter refused: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; });
