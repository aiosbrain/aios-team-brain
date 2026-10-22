/**
 * The ONE place that decides how a Postgres connection does TLS. Every pg client in the app,
 * the deploy hooks, and the operator scripts builds its `ssl` option here (guard:
 * `test/guards/pg-tls-single-owner.test.ts`), so a verification policy cannot drift per call site.
 *
 * Plain ESM with no TypeScript so the pruned production image (bootstrap, the schema pre-deploy
 * hook) and `node scripts/*.mjs` can import it as-is; JSDoc carries the types for the TS app.
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
import { isIP } from "node:net";
import ConnectionParameters from "pg/lib/connection-parameters.js";

/**
 * @typedef {"verify-ca" | "verify-full" | "unverified" | "disabled"} PgTlsMode
 * @typedef {"PG_CA_CERT" | "config" | "url" | "env" | "loopback"} PgTlsSource
 * @typedef {import("node:tls").ConnectionOptions | false | undefined} PgSsl
 * @typedef {{ connectionString: string, ssl: PgSsl, mode: PgTlsMode, source: PgTlsSource, pinned: boolean }} PgTlsResolution
 */

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

/**
 * Split a URL connection string into `{ base, params, fragment }` WITHOUT re-encoding the userinfo.
 * WHATWG URL (which pg-connection-string uses) starts the query at the FIRST `?` and the fragment at
 * the first `#` — a `?` cannot occur inside the authority — so `@` in a query value cannot shift it.
 */
function splitQuery(connectionString) {
  const h = connectionString.indexOf("#");
  const beforeFragment = h === -1 ? connectionString : connectionString.slice(0, h);
  const fragment = h === -1 ? "" : connectionString.slice(h);
  const q = beforeFragment.indexOf("?");
  if (q === -1) return { base: beforeFragment, params: new URLSearchParams(), fragment };
  return { base: beforeFragment.slice(0, q), params: new URLSearchParams(beforeFragment.slice(q + 1)), fragment };
}

/** Last value wins, matching pg-connection-string's entries() loop. */
function lastParam(params, key) {
  const all = params.getAll(key);
  return all.length ? all[all.length - 1] : null;
}

/** The host node-postgres will dial ("" for a unix socket directory). */
function hostOf(connectionString, env) {
  if (connectionString.startsWith("/")) return connectionString.split(" ")[0];
  const { params } = splitQuery(connectionString);
  const hostParam = lastParam(params, "host");
  if (hostParam) return hostParam;
  const m = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/?#]*@)?(\[[^\]]+\]|[^:/?#]*)/i.exec(connectionString);
  const fromUrl = m ? decodeURIComponent(m[1].replace(/^\[|\]$/g, "")) : "";
  // pg: an empty host falls back to PGHOST, then "localhost".
  return fromUrl || env.PGHOST || "localhost";
}

/** Loopback literal, `localhost`, or a unix socket: no network path an attacker can intercept. */
export function isLocalSocketOrLoopback(connectionString, env = process.env) {
  const host = hostOf(connectionString, env).toLowerCase();
  if (host.startsWith("/")) return true;
  if (host === "localhost" || host === "::1") return true;
  return isIP(host) === 4 && host.startsWith("127.");
}

/** The `ssl` node-postgres will ACTUALLY use: its own parser, merged over our config, as at connect. */
function effectiveSsl(connectionString, ssl) {
  return new ConnectionParameters({ connectionString, ssl }).ssl;
}

function classify(connectionString, effective, passed) {
  const { params } = splitQuery(connectionString);
  const urlSsl = ["sslmode", "ssl", "sslrootcert", "sslcert", "sslkey", "sslnegotiation"].some((k) => params.has(k));
  const source = effective === passed ? "config" : urlSsl ? "url" : "env";
  if (!effective) return { mode: "disabled", source };
  if (effective === true) return { mode: "verify-full", source };
  if (effective.rejectUnauthorized === false) return { mode: "unverified", source };
  if (effective.ca && effective.checkServerIdentity) return { mode: "verify-ca", source };
  return { mode: "verify-full", source };
}

/**
 * Resolve the TLS posture for one connection.
 *
 * @param {string} connectionString the DATABASE_URL being connected to
 * @param {{ legacyTls: boolean, legacySslOff?: false | undefined, env?: Record<string, string | undefined> }} opts
 *   legacyTls    — whether THIS call site asked for TLS before pinning existed (its exact old predicate)
 *   legacySslOff — what it passed when it did NOT want TLS (`undefined` for most, `false` for one script)
 *   env          — where PG_CA_CERT / PG_TLS_VERIFY_HOSTNAME are read from
 * @returns {PgTlsResolution}
 */
export function resolvePgTls(connectionString, { legacyTls, legacySslOff = undefined, env = process.env }) {
  if (typeof connectionString !== "string" || connectionString === "") {
    throw new Error("resolvePgTls needs the Postgres connection string");
  }
  const caRaw = env.PG_CA_CERT;
  const verifyHostnameFlag = parseVerifyHostname(env.PG_TLS_VERIFY_HOSTNAME);

  if (caRaw == null || caRaw === "") {
    if (verifyHostnameFlag) {
      throw new Error("PG_TLS_VERIFY_HOSTNAME=1 needs PG_CA_CERT (the CA to verify against) — set it, or unset the flag");
    }
    /** @type {PgSsl} */
    const ssl = legacyTls ? { rejectUnauthorized: false } : legacySslOff;
    return { connectionString, ssl, ...classify(connectionString, effectiveSsl(connectionString, ssl), ssl), pinned: false };
  }

  const ca = parseCaCert(caRaw);
  const { base, params, fragment } = splitQuery(connectionString);
  const sslmodes = params.getAll("sslmode");
  const sslFlags = params.getAll("ssl");
  if (sslmodes.includes("disable") || env.PGSSLMODE === "disable" || sslFlags.includes("false") || sslFlags.includes("0")) {
    throw new Error("PG_CA_CERT is set but the connection disables TLS (sslmode=disable / ssl=false / PGSSLMODE=disable) — remove one of them");
  }
  if (URL_CLIENT_CERT_PARAMS.some((k) => params.has(k))) {
    throw new Error("PG_CA_CERT cannot be combined with sslcert/sslkey in DATABASE_URL (client certificates are not supported by this helper)");
  }

  if (!legacyTls && isLocalSocketOrLoopback(connectionString, env)) {
    return { connectionString, ssl: legacySslOff, mode: "disabled", source: "loopback", pinned: true };
  }

  // An explicit sslmode=verify-full in the URL is a request for the hostname check; honour it.
  const verifyHostname = verifyHostnameFlag || lastParam(params, "sslmode") === "verify-full";
  let stripped = connectionString;
  if (URL_SSL_PARAMS.some((k) => params.has(k))) {
    for (const k of URL_SSL_PARAMS) params.delete(k);
    const rest = params.toString();
    stripped = (rest ? `${base}?${rest}` : base) + fragment;
  }
  /** @type {PgSsl} */
  const ssl = verifyHostname
    ? { ca, rejectUnauthorized: true }
    : { ca, rejectUnauthorized: true, checkServerIdentity: () => undefined };

  // Fail closed on the property, not on our parsing: whatever node-postgres derives from the final
  // string must be EXACTLY the pinned object. Anything else (a param we did not strip, a parser
  // change in a pg upgrade) refuses rather than connecting with weaker or different TLS.
  let effective;
  try {
    effective = effectiveSsl(stripped, ssl);
  } catch (err) {
    throw new Error(`PG_CA_CERT is set but DATABASE_URL could not be parsed (${err instanceof Error ? err.message : "invalid"}) — refusing to connect`);
  }
  if (effective !== ssl) {
    throw new Error("PG_CA_CERT is set but DATABASE_URL parameters (e.g. sslnegotiation) would replace the pinned TLS settings — remove them");
  }
  return { connectionString: stripped, ssl, mode: verifyHostname ? "verify-full" : "verify-ca", source: "PG_CA_CERT", pinned: true };
}

/**
 * The `{ connectionString, ssl }` pair to spread into `new pg.Client(...)` / `new Pool(...)`.
 * @param {string} connectionString
 * @param {{ legacyTls: boolean, legacySslOff?: false | undefined, env?: Record<string, string | undefined> }} opts
 * @returns {{ connectionString: string, ssl: PgSsl }}
 */
export function pgConnectionConfig(connectionString, opts) {
  const { connectionString: cs, ssl } = resolvePgTls(connectionString, opts);
  return { connectionString: cs, ssl };
}

/**
 * The repo's long-standing "did the operator ask for TLS" predicate (sslmode=require / PGSSL / PGSSLMODE).
 * @param {string} databaseUrl
 * @param {Record<string, string | undefined>} [env]
 */
export function shouldUseSsl(databaseUrl, env = process.env) {
  return /\bsslmode=require\b/.test(databaseUrl) || env.PGSSL === "require" || env.PGSSLMODE === "require";
}
