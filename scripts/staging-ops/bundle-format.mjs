import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

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

export function validatePairManifest(manifest, now = Date.now(), { allowRollback = false } = {}) {
  const errors = [];
  if (manifest?.formatVersion !== 1 || manifest?.graphCodecVersion !== 1) errors.push("unsupported bundle/graph codec version");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(String(manifest?.runId ?? ""))) errors.push("invalid run ID");
  if (!manifest?.captureStartedAt || !manifest?.captureEndedAt || Date.parse(manifest.captureEndedAt) < Date.parse(manifest.captureStartedAt)) errors.push("invalid online capture interval");
  if (Date.parse(manifest?.expiresAt ?? "") <= now) errors.push("source bundle expired before it was pinned locally");
  const rollback = manifest?.kind === "staging-rollback";
  if (rollback && !allowRollback) errors.push("importer-owned rollback bundle is not a source bundle");
  for (const name of rollback ? ["postgres", "graph"] : ["postgres", "authUsers", "graphLedger", "graph"]) if (!/^[0-9a-f]{64}$/.test(manifest?.checksums?.[name]?.sha256 ?? "")) errors.push(`missing ${name} checksum`);
  if (!manifest?.build?.applicationCommit || !manifest?.build?.schemaFingerprint || !manifest?.build?.migrationSet?.sha256) errors.push("source build identity is incomplete");
  return { ok: errors.length === 0, errors };
}
