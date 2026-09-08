import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fingerprintWellFormed, REQUIRED_ENVIRONMENT_CREDENTIAL_CLASSES } from "./credential-fingerprint.mjs";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

export async function packPair(directory, graph, { includeAuthUsers = true, includeGraphLedger = includeAuthUsers } = {}) {
  const postgres = await readFile(path.join(directory, "postgres.dump"));
  const graphBytes = Buffer.from(JSON.stringify(graph));
  const files = { postgres, graph: graphBytes };
  if (includeAuthUsers) files.authUsers = await readFile(path.join(directory, "auth_users.csv"));
  if (includeGraphLedger) files.graphLedger = await readFile(path.join(directory, "graph_episodes.csv"));
  return {
    payload: Buffer.from(JSON.stringify(Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, bytes.toString("base64")])))),
    checksums: Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, { sha256: sha(bytes), bytes: bytes.length }])),
  };
}

export async function unpackPair(payload, directory, expected) {
  let parsed;
  try { parsed = JSON.parse(Buffer.from(payload).toString("utf8")); } catch { throw new Error("bundle payload is not valid paired JSON"); }
  for (const [name, filename] of [["postgres", "postgres.dump"], ["authUsers", "auth_users.csv"], ["graphLedger", "graph_episodes.csv"], ["graph", "graph.json"]]) {
    if (!expected?.[name] && (name === "authUsers" || name === "graphLedger")) continue;
    const encoded = parsed[name];
    if (typeof encoded !== "string") throw new Error(`bundle payload missing ${name}`);
    const bytes = Buffer.from(encoded, "base64");
    if (sha(bytes) !== expected?.[name]?.sha256 || bytes.length !== expected?.[name]?.bytes) throw new Error(`bundle ${name} checksum/size mismatch`);
    await writeFile(path.join(directory, filename), bytes, { mode: 0o600 });
  }
  return JSON.parse(await readFile(path.join(directory, "graph.json"), "utf8"));
}

/**
 * The database modes a pair may declare.
 *
 * `full` means "this archive contains the whole database as captured, credentials included", and it
 * is the term `preservesCapturedStagingCredentials` reads to choose the whole-database restore and
 * to SKIP the tester reapply. `sanitized` is everything else. There is no third value, and an
 * unrecognised one must not reach either decision.
 */
const SUPPORTED_DATABASE_MODES = new Set(["sanitized", "full"]);

export function validatePairManifest(manifest, now = Date.now(), { allowRollback = false } = {}) {
  const errors = [];
  if (manifest?.formatVersion !== 1 || manifest?.graphCodecVersion !== 1) errors.push("unsupported bundle/graph codec version");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(String(manifest?.runId ?? ""))) errors.push("invalid run ID");
  if (!manifest?.captureStartedAt || !manifest?.captureEndedAt || Date.parse(manifest.captureEndedAt) < Date.parse(manifest.captureStartedAt)) errors.push("invalid online capture interval");
  if (Date.parse(manifest?.expiresAt ?? "") <= now) errors.push("source bundle expired before it was pinned locally");
  const rollback = manifest?.kind === "staging-rollback";
  if (rollback && !allowRollback) errors.push("importer-owned rollback bundle is not a source bundle");
  // M3: `databaseMode` was never validated here, and the value travels: `sealReadyRollback` used to
  // copy it out of the SOURCE manifest into the importer-signed rollback envelope, so a source that
  // simply declared `full` came back as a provenance-valid FULL rollback — one whose archive is
  // sanitized and therefore lacks the projected auth/ledger rows a full restore expects, and whose
  // credential reapply and sanitation verification are both skipped.
  //
  // A source bundle is sanitized by construction. The current exporter omits the field entirely, so
  // ABSENT stays supported and means sanitized (never full); an EXPLICIT non-sanitized claim on a
  // source manifest is refused at admission rather than carried anywhere. `full` remains exclusive
  // to importer-captured, importer-authenticated staging checkpoints.
  const declaredMode = manifest?.databaseMode;
  if (declaredMode !== undefined && declaredMode !== null) {
    if (typeof declaredMode !== "string" || !SUPPORTED_DATABASE_MODES.has(declaredMode)) {
      errors.push(`unsupported database mode ${JSON.stringify(String(declaredMode).slice(0, 32))}`);
    } else if (!rollback && declaredMode !== "sanitized") {
      errors.push(`source bundle declares database mode ${declaredMode}; a source capture is sanitized`);
    }
  }
  for (const name of rollback ? ["postgres", "graph"] : ["postgres", "authUsers", "graphLedger", "graph"]) if (!/^[0-9a-f]{64}$/.test(manifest?.checksums?.[name]?.sha256 ?? "")) errors.push(`missing ${name} checksum`);
  if (!manifest?.build?.applicationCommit || !manifest?.build?.schemaFingerprint || !manifest?.build?.migrationSet?.sha256) errors.push("source build identity is incomplete");
  // A rollback envelope is staging-owned and may legitimately contain staging's own credentials.
  // Source bundles, however, must carry complete authenticated production evidence: absence or a
  // malformed value is incomparable, never evidence that the environments differ.
  if (!rollback) {
    for (const credentialClass of REQUIRED_ENVIRONMENT_CREDENTIAL_CLASSES) {
      const value = manifest?.credentialFingerprints?.[credentialClass];
      if (!fingerprintWellFormed(value) || value.credentialClass !== credentialClass) {
        errors.push(`missing or malformed ${credentialClass} credential fingerprint`);
      }
    }
  }
  return { ok: errors.length === 0, errors };
}
