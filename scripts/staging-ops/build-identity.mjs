import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const digest = (value) => createHash("sha256").update(value).digest("hex");

export function migrationSetIdentity(root = process.cwd()) {
  const schema = readFileSync(path.join(root, "postgres/schema.sql"));
  const migrationDir = path.join(root, "postgres/migrations");
  const migrations = existsSync(migrationDir) ? readdirSync(migrationDir).filter((name) => name.endsWith(".sql")).sort() : [];
  const entries = [
    { path: "postgres/schema.sql", sha256: digest(schema) },
    ...migrations.map((name) => ({ path: `postgres/migrations/${name}`, sha256: digest(readFileSync(path.join(migrationDir, name))) })),
  ];
  return { version: 1, entries, sha256: digest(JSON.stringify(entries)) };
}

export function schemaFingerprintDigest(lines) {
  if (!Array.isArray(lines) || lines.length === 0) throw new Error("canonical database schema fingerprint is empty");
  return digest(`${[...lines].sort().join("\n")}\n`);
}

export function assertCompatibleBuildIdentity(source, loader) {
  if (!source?.applicationCommit || !/^[0-9a-f]{40}$/i.test(source.applicationCommit)) throw new Error("source application commit/build identity is absent or unknown");
  if (!source?.migrationSet?.sha256 || source.migrationSet.sha256 !== loader?.migrationSet?.sha256) {
    throw new Error("runner loader migration set is incompatible with the source build; upgrade the pinned runner image separately");
  }
  if (!source?.schemaFingerprint || source.schemaFingerprint !== loader?.schemaFingerprint) throw new Error("canonical database schema fingerprint is incompatible");
}
