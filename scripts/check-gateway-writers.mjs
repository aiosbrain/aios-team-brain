#!/usr/bin/env node
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const OWNERS = new Set([
  join("lib", "gateway", "persistence.ts"),
  join("lib", "gateway", "admin-persistence.ts"),
]);
const TABLES = [
  "gateway_service_identities",
  "gateway_service_credentials",
  "executor_subject_bindings",
  "gateway_connections",
  "gateway_resolution_leases",
  "gateway_executions",
  "gateway_approvals",
  "gateway_audit_log",
  "gateway_rate_limits",
];
const SECRET_FIELDS = [
  "credential_hash",
  "secret_hash",
  "credential_ciphertext",
  "lease_hash",
  "encrypted_request_envelope",
];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(?:ts|tsx|js|mjs)$/.test(name)) out.push(path);
  }
  return out;
}

const scanDirs = process.env.GATEWAY_WRITER_SCAN_DIRS?.split(",").filter(Boolean) ?? ["app", "lib", "scripts"];
const violations = [];
for (const top of scanDirs) {
  for (const file of walk(join(ROOT, top))) {
    const rel = relative(ROOT, file);
    if (OWNERS.has(rel) || rel === join("scripts", "check-gateway-writers.mjs")) continue;
    const source = readFileSync(file, "utf8");
    for (const table of TABLES) {
      const queryBuilder = new RegExp(`from\\(\\s*["']${table}["']\\s*\\)\\s*\\.\\s*(?:insert|update|upsert|delete)\\b`, "i");
      const sqlIdentifier = `(?:(?:"?public"?)\\s*\\.\\s*)?"?${table}"?`;
      const rawSql = new RegExp(`\\b(?:insert\\s+into|update|delete\\s+from)\\s+${sqlIdentifier}(?=\\s|\\()`, "i");
      if (queryBuilder.test(source) || rawSql.test(source)) violations.push(`${rel}: writes ${table}`);
    }
    for (const field of SECRET_FIELDS) {
      const assignment = new RegExp(`\\b${field}\\b\\s*[:=]`, "i");
      if (assignment.test(source)) violations.push(`${rel}: assigns secret-bearing ${field}`);
    }
  }
}

if (violations.length) {
  console.error("Gateway writer boundary violated:\n" + violations.sort().join("\n"));
  process.exit(1);
}
console.log(`gateway writer guard: OK (${OWNERS.size} owners, ${TABLES.length} tables, ${SECRET_FIELDS.length} secret fields)`);
