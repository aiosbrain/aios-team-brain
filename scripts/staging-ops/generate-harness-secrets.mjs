#!/usr/bin/env node
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const directory = process.argv[2];
if (!directory || !path.isAbsolute(directory)) throw new Error("absolute harness secret directory is required");
mkdirSync(directory, { recursive: true, mode: 0o700 });
for (const role of ["exporter", "importer"]) mkdirSync(path.join(directory, role), { mode: 0o755 });
const exporter = generateKeyPairSync("ed25519");
const importer = generateKeyPairSync("rsa", { modulusLength: 2048 });
const rollback = generateKeyPairSync("ed25519");
const rollbackEncryption = generateKeyPairSync("rsa", { modulusLength: 2048 });
const comparisonKey = randomBytes(32).toString("base64");
const files = {
  "exporter/exporter-signing-private.pem": exporter.privateKey.export({ format: "pem", type: "pkcs8" }),
  "exporter/importer-encryption-public.pem": importer.publicKey.export({ format: "pem", type: "spki" }),
  "exporter/comparison-key": comparisonKey,
  "importer/exporter-signing-public.pem": exporter.publicKey.export({ format: "pem", type: "spki" }),
  "importer/importer-encryption-private.pem": importer.privateKey.export({ format: "pem", type: "pkcs8" }),
  "importer/rollback-signing-private.pem": rollback.privateKey.export({ format: "pem", type: "pkcs8" }),
  "importer/rollback-signing-public.pem": rollback.publicKey.export({ format: "pem", type: "spki" }),
  "importer/rollback-encryption-private.pem": rollbackEncryption.privateKey.export({ format: "pem", type: "pkcs8" }),
  "importer/rollback-encryption-public.pem": rollbackEncryption.publicKey.export({ format: "pem", type: "spki" }),
  "importer/comparison-key": comparisonKey,
};
for (const [name, value] of Object.entries(files)) writeFileSync(path.join(directory, name), value, { mode: 0o644 });
