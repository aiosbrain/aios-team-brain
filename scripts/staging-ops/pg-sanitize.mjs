/** Tables whose rows never leave production in paired mode. `graph_episodes` is intentionally absent. */
export const EXCLUDED_PAIRED_TABLE_DATA = Object.freeze([
  "agent_tokens",
  "api_keys",
  "arc_cache",
  "auth_tokens",
  "gateway_approvals",
  "gateway_audit_log",
  "gateway_connections",
  "gateway_executions",
  "gateway_resolution_leases",
  "gateway_service_credentials",
  "gateway_service_identities",
  "integrations",
  "llm_failures",
  "llm_usage",
  "member_secrets",
  "oauth_states",
  "social_jobs",
  "usage_costs",
  "work_timeline_cache",
]);

const SUSPICIOUS = /(?:password_hash|token_hash|secret_hash|credential_hash|lease_hash|_ciphertext|_sha256|request_hash|request_envelope_hash|key_id|token_id|credential_id|nonce)$/;

function stripComments(sql) {
  return String(sql).replace(/\/\*[\s\S]*?\*\//g, "\n").split("\n").map((line) => line.replace(/--.*$/, "")).join("\n");
}

/** Enumerate load-bearing credential/hash-like columns from canonical create/alter statements. */
export function classifiedColumns(sql) {
  const found = new Set();
  let table = null;
  for (const raw of stripComments(sql).split("\n")) {
    const create = raw.match(/^\s*create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?"?([a-z0-9_]+)"?/i);
    if (create) table = create[1].toLowerCase();
    const alter = raw.match(/^\s*alter\s+table\s+(?:only\s+)?(?:public\.)?"?([a-z0-9_]+)"?/i);
    if (alter) table = alter[1].toLowerCase();
    const column = raw.match(/^\s*"?([a-z][a-z0-9_]*)"?\s+[a-z]/i);
    if (table && column && SUSPICIOUS.test(column[1].toLowerCase())) found.add(`${table}.${column[1].toLowerCase()}`);
    const added = raw.match(/\badd\s+column\s+(?:if\s+not\s+exists\s+)?"?([a-z][a-z0-9_]*)"?/i);
    if (table && added && SUSPICIOUS.test(added[1].toLowerCase())) found.add(`${table}.${added[1].toLowerCase()}`);
  }
  return [...found].sort();
}

export function credentialClassificationGaps(sql, classification) {
  const known = new Set(Object.keys(classification ?? {}));
  return classifiedColumns(sql).filter((column) => !known.has(column));
}

function quoteIdentifier(name) {
  if (!/^[a-z_][a-z0-9_]*$/i.test(name)) throw new Error(`unsupported SQL identifier: ${name}`);
  return `"${name.replaceAll('"', '""')}"`;
}

export function transformedAuthUserProjection(columns) {
  if (!Array.isArray(columns) || !columns.includes("password_hash")) throw new Error("auth_users.password_hash is required in the projected schema");
  return columns.map((column) => column === "password_hash" ? 'NULL::text AS "password_hash"' : quoteIdentifier(column)).join(", ");
}

export function transformedGraphEpisodeProjection(columns) {
  for (const required of ["pending_delete_group_id", "pending_delete_at"]) if (!columns.includes(required)) throw new Error(`graph_episodes.${required} is required in the projected schema`);
  return columns.map((column) => column === "pending_delete_group_id" ? 'NULL::text AS "pending_delete_group_id"' : column === "pending_delete_at" ? 'NULL::timestamptz AS "pending_delete_at"' : quoteIdentifier(column)).join(", ");
}

/** pg_dump arguments for public schema with transformed tables excluded from its data section. */
export function pairedDumpArguments(snapshotId, outputPath) {
  if (!snapshotId || /\s/.test(snapshotId)) throw new Error("a validated exported snapshot ID is required");
  return [
    "--format=custom",
    "--schema=public",
    `--snapshot=${snapshotId}`,
    `--file=${outputPath}`,
    "--exclude-table-data=auth_users",
    "--exclude-table-data=graph_episodes",
    ...EXCLUDED_PAIRED_TABLE_DATA.map((table) => `--exclude-table-data=${table}`),
  ];
}

export function sanitationCensus(rowsByTable) {
  return {
    excludedRows: Object.fromEntries(EXCLUDED_PAIRED_TABLE_DATA.map((table) => [table, Number(rowsByTable?.[table] ?? 0)])),
    transformedRows: { auth_users: Number(rowsByTable?.auth_users ?? 0), graph_episodes: Number(rowsByTable?.graph_episodes ?? 0) },
    graphLedgerRows: Number(rowsByTable?.graph_episodes ?? 0),
  };
}
