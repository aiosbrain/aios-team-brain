import { timingSafeEqual } from "node:crypto";

const INTERNAL_HOST = /(?:^|\.)railway\.internal$/i;
const ALLOWED_QUERY_PARAMETERS = new Set([
  "application_name",
  "connect_timeout",
  "sslcert",
  "sslkey",
  "sslmode",
  "sslrootcert",
]);

function equalText(left, right) {
  const a = Buffer.from(String(left ?? ""), "utf8");
  const b = Buffer.from(String(right ?? ""), "utf8");
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

function decoded(value, label) {
  try { return decodeURIComponent(value); }
  catch { throw new Error(`${label} contains invalid percent encoding (value redacted)`); }
}

const normalizedAddress = (value) => String(value ?? "").toLowerCase().replace(/^::ffff:/, "");

/**
 * Parse one Postgres destination once, then reconstruct the only string Node and libpq may consume.
 * Identity-bearing query parameters are not merely blacklisted: every parameter outside this small,
 * non-routing allowlist is refused, as are duplicates whose precedence can differ by client.
 */
export function parseCanonicalPostgresTarget(raw, { label = "Postgres", requireInternal = true, requireCredentials = false } = {}) {
  const text = String(raw ?? "").trim();
  let url;
  try { url = new URL(text); }
  catch { throw new Error(`${label} connection URL is invalid (value redacted)`); }

  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") throw new Error(`${label} must use the postgres or postgresql scheme`);
  if (text.includes("#")) throw new Error(`${label} must not contain a fragment`);
  if (!url.hostname || url.hostname.includes(",") || decoded(url.hostname, `${label} hostname`).includes(",")) {
    throw new Error(`${label} must name exactly one hostname`);
  }
  const hostname = url.hostname.toLowerCase();
  if (requireInternal && !INTERNAL_HOST.test(hostname)) throw new Error(`${label} must use one exact Railway internal service hostname`);
  if (!url.port || !/^\d+$/.test(url.port) || Number(url.port) < 1 || Number(url.port) > 65535) {
    throw new Error(`${label} must declare one explicit valid port`);
  }

  const path = url.pathname.replace(/^\//, "");
  const database = decoded(path, `${label} database`);
  if (!path || url.pathname.slice(1).includes("/") || !database || database.includes("/") || database.includes("\0")) {
    throw new Error(`${label} must declare one explicit database name`);
  }
  const username = decoded(url.username, `${label} username`);
  const password = decoded(url.password, `${label} password`);
  if (username.includes("\0") || password.includes("\0")) throw new Error(`${label} credentials contain an invalid character (value redacted)`);
  if (requireCredentials && (!username || !password)) throw new Error(`${label} must contain explicit credentials`);

  const query = [];
  const seen = new Set();
  for (const [name, value] of url.searchParams) {
    const normalized = name.toLowerCase();
    if (!ALLOWED_QUERY_PARAMETERS.has(normalized)) throw new Error(`${label} contains an unsupported connection parameter (${normalized || "empty"})`);
    if (seen.has(normalized)) throw new Error(`${label} contains a duplicate connection parameter (${normalized})`);
    seen.add(normalized);
    query.push([normalized, value]);
  }
  query.sort(([left], [right]) => left.localeCompare(right));

  const authority = username
    ? `${encodeURIComponent(username)}${password ? `:${encodeURIComponent(password)}` : ""}@`
    : "";
  const hostForUrl = hostname.includes(":") && !hostname.startsWith("[") ? `[${hostname}]` : hostname;
  const parameters = new URLSearchParams(query);
  const connectionString = `postgresql://${authority}${hostForUrl}:${url.port}/${encodeURIComponent(database)}${parameters.size ? `?${parameters}` : ""}`;
  return Object.freeze({
    scheme: "postgresql",
    hostname,
    port: Number(url.port),
    database,
    username,
    connectionString,
  });
}

export function samePostgresTarget(left, right) {
  return left?.hostname === right?.hostname && left?.port === right?.port && left?.database === right?.database
    && left?.username === right?.username && equalText(left?.connectionString, right?.connectionString);
}

/** Prove the lock-owning Node session reached the same database specification handed to libpq. */
export async function assertLivePostgresTarget(client, target) {
  const configured = client?.connectionParameters;
  if (!configured || String(configured.host ?? "").toLowerCase() !== target.hostname
    || Number(configured.port) !== target.port || configured.database !== target.database
    || String(configured.user ?? "") !== target.username) {
    throw new Error("the lock-owning Postgres client configuration differs from the canonical target");
  }
  const result = await client.query(`SELECT current_database() AS database,
    host(inet_server_addr()) AS server_address, inet_server_port() AS server_port,
    pg_backend_pid() AS backend_pid`);
  const row = result.rows?.[0];
  const socketAddress = normalizedAddress(client?.connection?.stream?.remoteAddress);
  const serverAddress = normalizedAddress(row?.server_address);
  if (!row || row.database !== target.database || Number(row.server_port) !== target.port
    || !serverAddress || !socketAddress || socketAddress !== serverAddress
    || !Number.isInteger(Number(row.backend_pid))) {
    throw new Error("the live lock-owning Postgres backend differs from the canonical database target");
  }
  return Object.freeze({ database: row.database, serverAddress, serverPort: Number(row.server_port), backendPid: Number(row.backend_pid) });
}

export function assertProviderPostgresTarget(evidence, target, pins) {
  if (!evidence || evidence.projectId !== pins.projectId || evidence.environmentId !== pins.environmentId
    || evidence.serviceId !== pins.serviceId || evidence.serviceInstanceId !== pins.serviceInstanceId
    || evidence.deploymentId !== pins.deploymentId || evidence.importerServiceId !== pins.importerServiceId
    || evidence.importerServiceInstanceId !== pins.importerServiceInstanceId
    || evidence.importerDeploymentId !== pins.importerDeploymentId) {
    throw new Error("provider Postgres evidence differs from the pinned project/environment/service-instance/deployment identity");
  }
  if (evidence.hostname !== target.hostname || evidence.hostname !== String(pins.hostname ?? "").toLowerCase()
    || evidence.database !== target.database || evidence.database !== pins.database
    || evidence.port !== target.port || evidence.currentMatchesDeployment !== true
    || evidence.importerReferenceBound !== true) {
    throw new Error("provider Postgres endpoint/database/reference evidence differs from the canonical target");
  }
  return true;
}
