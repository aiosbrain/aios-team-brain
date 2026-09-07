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
import { canonicalObjectId, createPrivateStore } from "./object-store.mjs";
import { assertOutboundCredentialIsolation, assertRunnerRole } from "./role-policy.mjs";
import { RailwayRunnerInspector } from "./railway-maintenance.mjs";
import { keyMaterial } from "./key-material.mjs";

const sha = (v) => createHash("sha256").update(v).digest("hex");
const FULL_SHA = /^[0-9a-f]{40}$/i;

export function itemEpisodeStem(name) {
  const match = String(name ?? "").match(/^(items:[^#]+)(?:#\d+)?$/);
  return match?.[1] ?? null;
}

export async function snapshotExportFacts(client) {
  const result = await client.query(`SELECT ge.source_table, ge.source_id::text, ge.group_id, ge.pending_delete_group_id,
    ge.content_sha256, ge.chunk_shas, ge.deferred,
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
  const allowed = new Set(); const excluded = new Set(); const ledger = [];
  for (const row of result.rows) {
    const prefix = row.source_table === "items" ? "items:" : row.source_table === "arc_corrections" ? "correction:" : "unsupported:";
    const key = `${prefix}${row.source_id}\0${row.group_id}`;
    if (row.source_eligible) allowed.add(key); else excluded.add(key);
    if (row.pending_delete_group_id) excluded.add(`${prefix}${row.source_id}\0${row.pending_delete_group_id}`);
    ledger.push({ ...row, source_id: String(row.source_id) });
  }
  const corrections = await client.query(`SELECT a.id::text, a.arc_id, a.group_key, p.graph_group_id AS team_group
    FROM arc_corrections a LEFT JOIN projects p ON p.team_id=a.team_id AND p.kind='system' AND p.slug='general'`);
  for (const row of corrections.rows) {
    const exactGroup = String(row.group_key ?? "").startsWith("g:")
      ? String(row.group_key).slice(2)
      : row.group_key === "" ? row.team_group : null;
    if (exactGroup) allowed.add(`correction:${row.arc_id}\0${exactGroup}`);
  }
  const schemaLines = await fingerprint(client);
  return { allowed, excluded, ledger, schemaLines };
}

export function validateLedgerAgainstSanitizedGraph(graph, facts) {
  const episodes = new Set(graph.nodes.filter((node) => node.labels.includes("Episodic")).map((node) => `${node.properties?.name}\0${node.properties?.group_id}`));
  const errors = [];
  for (const row of facts.ledger) {
    if (row.deferred || row.content_sha256 === "") continue;
    let names;
    if (row.source_table === "items") {
      if (facts.excluded.has(`items:${row.source_id}\0${row.group_id}`)) continue;
      const chunks = Array.isArray(row.chunk_shas) ? row.chunk_shas.length : 0;
      names = chunks > 1 ? Array.from({ length: chunks }, (_, index) => `items:${row.source_id}#${index}`) : [`items:${row.source_id}`];
    } else if (row.source_table === "arc_corrections" && row.correction_arc_id) names = [`correction:${row.correction_arc_id}`];
    else continue;
    if (!names.every((name) => episodes.has(`${name}\0${row.group_id}`))) errors.push(`${row.source_id}@${row.group_id}`);
  }
  if (errors.length) throw new Error(`sanitized graph does not satisfy current projection ledger (${errors.slice(0, 5).join(", ")})`);
}

async function readDeployedBuildMetadata(env, measuredCommit, fetchImpl = fetch) {
  const response = await fetchImpl(env.SOURCE_BUILD_METADATA_URL, { redirect: "error", headers: { "x-aios-build-metadata-token": env.SOURCE_BUILD_METADATA_TOKEN }, signal: AbortSignal.timeout(10_000) });
  const body = await response.json();
  if (!response.ok || body?.commit !== measuredCommit || !body?.migrationSet?.sha256) throw new Error("source build metadata does not match the measured deployed application");
  return body;
}

export async function runExporter(env = process.env) {
  assertRunnerRole(env, "exporter"); assertOutboundCredentialIsolation(env);
  let deployed = { commit: env.SOURCE_APPLICATION_COMMIT };
  if (env.STAGING_MAINTENANCE_ADAPTER !== "local") {
    const inspector = new RailwayRunnerInspector({ projectId: env.RAILWAY_PROJECT_ID, environmentId: env.PRODUCTION_EXPORT_ENVIRONMENT_ID, serviceId: env.PRODUCTION_EXPORTER_SERVICE_ID, token: env.RAILWAY_PRODUCTION_RUNNER_READ_TOKEN });
    await inspector.assertPinned(env.STAGING_OPS_IMAGE_DIGEST);
    deployed = await inspector.measureSuccessfulDeployment(env.PRODUCTION_APP_SERVICE_ID);
  }
  if (!FULL_SHA.test(String(deployed.commit ?? ""))) throw new Error("source application deployment commit was not measured");
  const deployedBuild = env.STAGING_MAINTENANCE_ADAPTER === "local"
    ? { commit: deployed.commit, migrationSet: migrationSetIdentity() }
    : await readDeployedBuildMetadata(env, deployed.commit);
  const client = new pg.Client({ connectionString: env.DATABASE_URL }); await client.connect();
  const driver = neo4j.driver(env.NEO4J_URL, neo4j.auth.basic(env.NEO4J_USER, env.NEO4J_PASSWORD));
  const session = driver.session({ database: env.NEO4J_DATABASE, defaultAccessMode: neo4j.session.READ });
  try {
    if (process.argv.includes("--census")) return graphCensus(session);
    const runId = env.STAGING_BUNDLE_RUN_ID || `${new Date().toISOString().replace(/[:.]/g, "-")}-${env.SOURCE_APPLICATION_COMMIT?.slice(0, 12)}`;
    const started = new Date();
    return await withPrivateTempDir("aios-staging-export-", async (directory) => {
      const captured = await capturePairedPostgres({ client, databaseUrl: env.DATABASE_URL, directory, captureSnapshotFacts: snapshotExportFacts });
      const policy = captured.snapshotFacts;
      const rawGraph = await exportGraph(session);
      const graph = sanitizeGraphExport(rawGraph, { episodeAllowed: (episode) => {
        const name = itemEpisodeStem(episode.properties?.name) ?? String(episode.properties?.name ?? "");
        const key = `${name}\0${episode.properties?.group_id ?? ""}`;
        return policy.allowed.has(key) && !policy.excluded.has(key);
      } });
      validateLedgerAgainstSanitizedGraph(graph, policy);
      const packed = await packPair(directory, graph);
      const comparisonKey = Buffer.from(env.STAGING_COMPARISON_KEY_BASE64, "base64");
      const credentialFingerprints = Object.fromEntries([
        ["auth-secret", env.AUTH_SECRET], ["secrets-key", env.SECRETS_KEY], ["neo4j-credential", `${env.NEO4J_USER}\0${env.NEO4J_PASSWORD}`],
      ].map(([credentialClass, value]) => [credentialClass, credentialFingerprint({ credentialClass, value, comparisonKey, keyId: env.STAGING_COMPARISON_KEY_ID })]));
      const ended = new Date();
      const manifest = {
        formatVersion: 1, graphCodecVersion: graph.codecVersion, runId,
        captureStartedAt: started.toISOString(), captureEndedAt: ended.toISOString(),
        expiresAt: new Date(ended.getTime() + Number(env.STAGING_EXPORT_RETENTION_DAYS ?? 14) * 86400000).toISOString(),
        onlineCaptureInterval: true, checksums: packed.checksums, sanitation: graph.sanitation,
        build: { applicationCommit: deployedBuild.commit, schemaFingerprint: schemaFingerprintDigest(policy.schemaLines), migrationSet: deployedBuild.migrationSet },
        credentialFingerprints,
      };
      const bundle = createSignedEncryptedBundle({
        payload: packed.payload,
        manifest,
        exporterSigningPrivateKey: keyMaterial(env, "EXPORTER_SIGNING_PRIVATE_KEY"),
        importerEncryptionPublicKey: keyMaterial(env, "IMPORTER_ENCRYPTION_PUBLIC_KEY"),
      });
      const bytes = Buffer.from(JSON.stringify(bundle));
      const digest = sha(bytes); const objectId = canonicalObjectId(runId, digest);
      const store = createPrivateStore({ env, scope: "source", role: "publisher" });
      await store.putImmutable(objectId, bytes);
      return { runId, objectId, sha256: digest, manifest: { ...manifest, credentialFingerprints: Object.keys(credentialFingerprints), checksums: packed.checksums } };
    });
  } finally { await session.close(); await driver.close(); await client.end(); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) runExporter().then((result) => console.log(JSON.stringify(result))).catch((error) => { console.error(`staging exporter refused: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; });
