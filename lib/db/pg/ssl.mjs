/**
 * The ONE place that decides how a Postgres connection does TLS. Every pg client in the app,
 * the deploy hooks, and the operator scripts builds its `ssl` option here (guard:
 * `test/guards/pg-tls-single-owner.test.ts`), so a verification policy cannot drift per call site.
 *
 * Plain ESM with no TypeScript so the pruned production image (bootstrap, the schema pre-deploy
 * hook) and `node scripts/*.mjs` can import it as-is; `ssl.d.mts` carries the types for the app.
 *
 * Modes (libpq vocabulary):
 *   • verify-ca   — `PG_CA_CERT` is set: the server chain must verify against that pinned CA, but
 *                   the hostname is NOT checked. This is the mode Railway's Postgres needs: its leaf
 *                   is issued for `localhost`, so a hostname check can never pass on
 *                   `postgres.railway.internal`, while the chain to the per-database `root-ca` can.
 *   • verify-full — `PG_CA_CERT` plus `PG_TLS_VERIFY_HOSTNAME=1`: chain AND hostname (Node default).
 *   • unverified  — no `PG_CA_CERT`, call site asked for TLS: encrypted, NOT authenticated
 *                   (`rejectUnauthorized: false`). Preserved byte-for-byte for existing installs so
 *                   a one-click deploy does not break, and reported by `npm run doctor`.
 *   • disabled    — plaintext (local/docker Postgres, or a remote URL that never asked for TLS).
 *
 * Fail-closed rules: a set-but-unparseable `PG_CA_CERT`, an unknown `PG_TLS_VERIFY_HOSTNAME`, or a
 * pinned CA combined with `sslmode=disable` THROWS — it never quietly falls back to `unverified`.
 * Setting `PG_CA_CERT` turns TLS ON even where the call site would not have asked for it (the
 * operator stated intent to authenticate the server); the only exception is a loopback host or a
 * unix socket, which no network attacker can sit in front of.
 */
import { X509Certificate } from "node:crypto";

const PEM_BLOCK = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;
// Connection-string params that make node-postgres REPLACE the `ssl` object we pass (its parser
// result is merged over the config). With a pinned CA they must go, or `sslmode=require` would
// silently swap our verify-ca object for pg's own.
const URL_SSL_PARAMS = ["sslmode", "ssl", "sslrootcert", "uselibpqcompat"];
const URL_CLIENT_CERT_PARAMS = ["sslcert", "sslkey"];

/** Decode `PG_CA_CERT` (PEM, PEM with literal `\n`, or base64 of a PEM) into a validated PEM bundle. */
export function parseCaCert(raw) {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new Error("PG_CA_CERT is empty — unset it, or set it to the Postgres server's CA certificate (PEM or base64 PEM)");
  }
  let text = raw.trim();
  if (!text.includes("-----BEGIN")) {
    const compact = text.replace(/\s+/g, "");
    if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(compact)) {
      throw new Error("PG_CA_CERT is neither a PEM certificate nor base64 — refusing to connect without the pinned CA");
    }
    text = Buffer.from(compact, "base64").toString("utf8").trim();
    if (!text.includes("-----BEGIN")) {
      throw new Error("PG_CA_CERT decoded from base64 but is not a PEM certificate — refusing to connect without the pinned CA");
    }
  }
  // Env UIs and copy/paste deliver PEMs with literal "\n" or CRLF line endings; normalise both.
  text = text.replace(/\\r\\n|\\n/g, "\n").replace(/\r\n?/g, "\n");
  const blocks = text.match(PEM_BLOCK) ?? [];
  if (blocks.length === 0) {
    throw new Error("PG_CA_CERT contains no -----BEGIN CERTIFICATE----- block (a private key or CSR is not a CA) — refusing to connect");
  }
  for (const [i, block] of blocks.entries()) {
    try {
      new X509Certificate(block);
    } catch (err) {
      throw new Error(`PG_CA_CERT certificate #${i + 1} does not parse (${err instanceof Error ? err.message : err}) — refusing to connect`);
    }
  }
  return blocks.join("\n") + "\n";
}

/** `PG_TLS_VERIFY_HOSTNAME`: unset/""/0/false → off, 1/true → on, anything else throws. */
export function parseVerifyHostname(raw) {
  if (raw == null) return false;
  const v = String(raw).trim().toLowerCase();
  if (v === "" || v === "0" || v === "false") return false;
  if (v === "1" || v === "true") return true;
  throw new Error(`PG_TLS_VERIFY_HOSTNAME must be 1 or 0 (got ${JSON.stringify(raw)})`);
}

/** Split a connection string into { base, params } without re-encoding the userinfo. */
function splitQuery(connectionString) {
  const at = connectionString.lastIndexOf("@");
  const q = connectionString.indexOf("?", at + 1);
  if (q === -1) return { base: connectionString, params: new URLSearchParams() };
  return { base: connectionString.slice(0, q), params: new URLSearchParams(connectionString.slice(q + 1)) };
}

/** The host the connection string points at ("" for a unix socket / unparseable). */
function hostOf(connectionString) {
  if (connectionString.startsWith("/")) return "";
  const { params } = splitQuery(connectionString);
  const hostParam = params.get("host");
  if (hostParam) return hostParam;
  const m = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/?#]*@)?(\[[^\]]+\]|[^:/?#]*)/i.exec(connectionString);
  return m ? m[1].replace(/^\[|\]$/g, "") : "";
}

/** Loopback or unix socket: no network path an attacker can intercept. */
export function isLocalSocketOrLoopback(connectionString) {
  const host = hostOf(connectionString).toLowerCase();
  return host === "" || host.startsWith("/") || host === "localhost" || host === "::1" || /^127\./.test(host);
}

/** Classify the `ssl` that node-postgres will ACTUALLY use, honouring the connection-string override. */
function effectiveMode(connectionString, ssl) {
  const { params } = splitQuery(connectionString);
  const sslmode = params.get("sslmode");
  const libpq = params.get("uselibpqcompat") === "true";
  // pg-connection-string's result is merged OVER our config, so URL ssl params decide when present.
  if (sslmode === "disable") return { mode: "disabled", source: "url" };
  if (sslmode === "no-verify") return { mode: "unverified", source: "url" };
  if (libpq && sslmode) {
    if (sslmode === "verify-full") return { mode: "verify-full", source: "url" };
    if (sslmode === "verify-ca") return { mode: "verify-ca", source: "url" };
    return { mode: params.get("sslrootcert") && sslmode === "require" ? "verify-ca" : "unverified", source: "url" };
  }
  if (sslmode || params.get("sslrootcert") || params.get("sslcert") || params.get("sslkey")) {
    // prefer/require/verify-ca/verify-full are all verify-full aliases in pg 8 (system CAs + hostname).
    return { mode: "verify-full", source: "url" };
  }
  const urlSsl = params.get("ssl");
  if (urlSsl === "true" || urlSsl === "1") return { mode: "verify-full", source: "url" };
  if (urlSsl === "0" || urlSsl === "false") return { mode: "disabled", source: "url" };
  if (urlSsl === "no-verify") return { mode: "unverified", source: "url" };
  if (!ssl) return { mode: "disabled", source: "config" };
  if (ssl.rejectUnauthorized === false) return { mode: "unverified", source: "config" };
  if (ssl.ca && ssl.checkServerIdentity) return { mode: "verify-ca", source: "config" };
  return { mode: "verify-full", source: "config" };
}

/**
 * Resolve the TLS posture for one connection.
 *
 * @param connectionString the DATABASE_URL being connected to
 * @param opts.legacyTls   whether THIS call site asked for TLS before pinning existed — the exact
 *                         predicate it used to gate `{ rejectUnauthorized: false }`
 * @param opts.legacySslOff the value the call site passed when it did NOT want TLS (`undefined` for
 *                         most, `false` for one script) — preserved so pg's env fallback is unchanged
 * @param opts.env         environment to read PG_CA_CERT / PG_TLS_VERIFY_HOSTNAME from
 */
export function resolvePgTls(connectionString, { legacyTls, legacySslOff = undefined, env = process.env } = {}) {
  if (typeof connectionString !== "string" || connectionString === "") {
    throw new Error("resolvePgTls needs the Postgres connection string");
  }
  const caRaw = env.PG_CA_CERT;
  const verifyHostname = parseVerifyHostname(env.PG_TLS_VERIFY_HOSTNAME);

  if (caRaw == null || caRaw === "") {
    const ssl = legacyTls ? { rejectUnauthorized: false } : legacySslOff;
    const { mode, source } = effectiveMode(connectionString, ssl);
    return { connectionString, ssl, mode, source, pinned: false };
  }

  const ca = parseCaCert(caRaw);
  const { base, params } = splitQuery(connectionString);
  const sslmode = params.get("sslmode") ?? env.PGSSLMODE;
  if (sslmode === "disable" || params.get("ssl") === "false" || params.get("ssl") === "0") {
    throw new Error("PG_CA_CERT is set but the connection disables TLS (sslmode=disable / ssl=false) — remove one of them");
  }
  if (URL_CLIENT_CERT_PARAMS.some((k) => params.has(k))) {
    throw new Error("PG_CA_CERT cannot be combined with sslcert/sslkey in DATABASE_URL (client certificates are not supported by this helper)");
  }

  if (!legacyTls && isLocalSocketOrLoopback(connectionString)) {
    return { connectionString, ssl: legacySslOff, mode: "disabled", source: "loopback", pinned: true };
  }

  let stripped = connectionString;
  if (URL_SSL_PARAMS.some((k) => params.has(k))) {
    for (const k of URL_SSL_PARAMS) params.delete(k);
    const rest = params.toString();
    stripped = rest ? `${base}?${rest}` : base;
  }
  const ssl = verifyHostname
    ? { ca, rejectUnauthorized: true }
    : { ca, rejectUnauthorized: true, checkServerIdentity: () => undefined };
  return { connectionString: stripped, ssl, mode: verifyHostname ? "verify-full" : "verify-ca", source: "PG_CA_CERT", pinned: true };
}

/** The `{ connectionString, ssl }` pair to spread into `new pg.Client(...)` / `new Pool(...)`. */
export function pgConnectionConfig(connectionString, opts) {
  const { connectionString: cs, ssl } = resolvePgTls(connectionString, opts);
  return { connectionString: cs, ssl };
}

/** The repo's long-standing "did the operator ask for TLS" predicate (sslmode=require / PGSSL / PGSSLMODE). */
export function shouldUseSsl(databaseUrl, env = process.env) {
  return /\bsslmode=require\b/.test(databaseUrl) || env.PGSSL === "require" || env.PGSSLMODE === "require";
}
