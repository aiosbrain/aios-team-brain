#!/usr/bin/env node
import { access } from "node:fs/promises";
import { constants } from "node:fs";

const role = process.argv[2];
const expected = role === "exporter"
  ? ["exporter-signing-private.pem", "importer-encryption-public.pem", "comparison-key"]
  : role === "importer"
    ? ["exporter-signing-public.pem", "importer-encryption-private.pem", "rollback-signing-private.pem", "rollback-signing-public.pem", "rollback-encryption-private.pem", "rollback-encryption-public.pem", "comparison-key"]
    : null;
if (!expected) throw new Error("secret probe role must be exporter or importer");
for (const name of expected) await access(`/run/staging-secrets/${name}`, constants.R_OK);
const forbidden = role === "exporter" ? ["importer-encryption-private.pem", "rollback-signing-private.pem"] : ["exporter-signing-private.pem", "importer-encryption-public.pem"];
for (const name of forbidden) {
  try { await access(`/run/staging-secrets/${name}`, constants.R_OK); throw new Error(`${role} can read forbidden key ${name}`); }
  catch (error) { if (error?.code !== "ENOENT") throw error; }
}
console.log(JSON.stringify({ status: "verified-role-key-boundary", role, readable: expected.length, denied: forbidden.length }));
