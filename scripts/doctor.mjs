#!/usr/bin/env node
/**
 * doctor.mjs — preflight for an AIOS Team Brain install.
 *
 * Setup failures in this repo are overwhelmingly *silent*: the app boots fine and only
 * misbehaves later, somewhere else. This script turns each of those into a loud,
 * actionable line BEFORE they cost anyone an afternoon. Every check here maps to a real
 * trap documented in README §5 (Troubleshooting):
 *
 *   - SECRETS_KEY throws only when you first SAVE a connector, not at boot — so a bad key
 *     surfaces as a 500 on the Slack panel, hours after deploy.
 *   - APP_URL is used to build invite/magic links in server actions (no request origin to
 *     fall back on), so an unset value silently mails every teammate a broken link.
 *   - A wrong-width embeddings model throws at index time but degrades SILENTLY to zero
 *     dense hits at query time — retrieval just quietly gets worse.
 *   - Without a mail transport, production drops magic-link mail entirely (logged only
 *     server-side as `[mailer] no provider`).
 *
 * Read-only: it never writes config, never mutates the database, and never deploys.
 *
 * Usage:
 *   npm run doctor              # checks env + (if reachable) the database
 *   npm run doctor -- --no-db   # skip the connectivity/schema probe
 *
 * Exit code is 1 if any check FAILS (warnings alone still exit 0), so CI or a setup
 * agent can gate on it.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const OK = "ok";
export const WARN = "warn";
export const FAIL = "fail";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ── pure checks (exported for unit tests) ───────────────────────────────────

/**
 * Minimal .env parser — `KEY=value`, `export KEY=value`, `#` comments, optional
 * surrounding quotes. Deliberately not dotenv: the repo has no such dependency and
 * `dev:seed` just shell-sources the file, so this only needs to agree with `sh`.
 * A line with no `=` is ignored rather than throwing; doctor must never be the thing
 * that crashes on a malformed file it is trying to diagnose.
 */
export function parseEnvFile(text) {
  const out = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).replace(/^export\s+/, "").trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

export function checkNode(version = process.versions.node) {
  const major = Number.parseInt(String(version).split(".")[0], 10);
  if (!Number.isFinite(major)) return { status: FAIL, detail: `unrecognized node version ${version}` };
  return major >= 20
    ? { status: OK, detail: `node ${version}` }
    : { status: FAIL, detail: `node ${version} — package.json requires >=20`, fix: "install Node 20 or newer" };
}

export function checkDatabaseUrl(value) {
  if (!value) {
    return {
      status: FAIL,
      detail: "DATABASE_URL is not set",
      fix: "a Postgres connection string — `docker compose up` provides one automatically",
    };
  }
  if (!/^postgres(ql)?:\/\//i.test(value)) {
    return { status: FAIL, detail: "DATABASE_URL is not a postgres:// URL", fix: "expected postgres://user:pass@host:port/db" };
  }
  return { status: OK, detail: "set" };
}

export function checkAuthSecret(value) {
  if (!value) {
    return {
      status: FAIL,
      detail: "AUTH_SECRET is not set — sessions cannot be signed",
      fix: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`,
    };
  }
  if (value.length < 16) {
    return { status: FAIL, detail: `AUTH_SECRET is ${value.length} chars — the minimum is 16`, fix: "generate a 32-byte hex value" };
  }
  return { status: OK, detail: `${value.length} chars` };
}

/**
 * SECRETS_KEY must decode to EXACTLY 32 bytes (AES-256-GCM), or the first connector save 500s.
 *
 * The decoding rule MUST match `decodeKey` in `lib/secrets/crypto.ts`, which accepts **either** 64
 * hex characters **or** base64 — `test/secrets-key-rule.test.ts` asserts the two agree. An earlier
 * version of this check assumed base64 only, so it decoded a perfectly valid 64-hex key as base64
 * (48 bytes) and told the user to "convert" a key that already worked. Reporting a good config as
 * broken is worse than not checking it at all.
 */
export function checkSecretsKey(value) {
  if (!value) {
    return {
      status: WARN,
      detail: "SECRETS_KEY is not set — saving any connector in Admin → Integrations will 500",
      fix: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`,
    };
  }
  const trimmed = String(value).trim();
  const bytes = /^[0-9a-fA-F]{64}$/.test(trimmed)
    ? Buffer.from(trimmed, "hex").length
    : Buffer.from(trimmed, "base64").length;
  if (bytes !== 32) {
    return {
      status: FAIL,
      detail: `SECRETS_KEY decodes to ${bytes} bytes, not 32`,
      fix: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))" — 64 hex chars also works`,
    };
  }
  return { status: OK, detail: "32 bytes" };
}

export function checkAppUrl(value) {
  if (!value) {
    return {
      status: FAIL,
      detail: "APP_URL is not set — every invite and magic link will be broken",
      fix: "set the absolute public URL, e.g. https://your-brain.up.railway.app",
    };
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    return { status: FAIL, detail: `APP_URL is not an absolute URL: ${value}`, fix: "include the scheme, e.g. https://…" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { status: FAIL, detail: `APP_URL scheme must be http/https, got ${url.protocol}` };
  }
  return { status: OK, detail: url.origin };
}

/** Managed Postgres (Railway, Neon, RDS…) almost always needs TLS; localhost never does. */
export function checkPgSsl(env) {
  const url = env.DATABASE_URL || "";
  if (!url) return { status: WARN, detail: "no DATABASE_URL to assess" };
  const local = /@(localhost|127\.0\.0\.1|postgres|db)[:/]/.test(url);
  const ssl = /\bsslmode=require\b/.test(url) || env.PGSSL === "require" || env.PGSSLMODE === "require";
  if (local) return { status: OK, detail: ssl ? "TLS on (local)" : "local database, TLS not needed" };
  return ssl
    ? { status: OK, detail: "TLS required" }
    : {
        status: WARN,
        detail: "remote DATABASE_URL without TLS — managed providers usually reject this",
        fix: "set PGSSL=require",
      };
}

/** One text-generation path must resolve, or queries cannot be answered. */
export function checkModelProvider(env) {
  if (env.LLM_BASE_URL) return { status: OK, detail: `local endpoint ${env.LLM_BASE_URL}` };
  if (env.ANTHROPIC_API_KEY) return { status: OK, detail: "ANTHROPIC_API_KEY" };
  return {
    status: WARN,
    detail: "no model provider in env — queries cannot be answered until one is configured",
    fix: "set ANTHROPIC_API_KEY, or LLM_BASE_URL for a local endpoint, or configure a provider per-team in Admin → Integrations",
  };
}

/** Without a transport, production drops magic-link mail (logged only server-side). */
export function checkMailer(env, nodeEnv = env.NODE_ENV) {
  if (env.RESEND_API_KEY) {
    return env.RESEND_FROM
      ? { status: OK, detail: "Resend" }
      : { status: WARN, detail: "RESEND_API_KEY set but RESEND_FROM is empty", fix: 'set a verified from-address, e.g. "AIOS <noreply@yourdomain.com>"' };
  }
  if (env.SMTP_URL) return { status: OK, detail: "SMTP" };
  return nodeEnv === "production"
    ? { status: FAIL, detail: "no mail transport in production — magic links and invites are silently dropped", fix: "set RESEND_API_KEY + RESEND_FROM, or SMTP_URL" }
    : { status: WARN, detail: "no mail transport — login links print to the server console (dev only)" };
}

/**
 * The pgvector column is hardcoded `vector(1536)`. A model of another width throws at
 * index time but degrades silently to zero dense hits at query time, so a mismatch here
 * is worth failing loudly on.
 */
export function checkEmbeddings(env) {
  const configured = env.EMBEDDINGS_URL || env.EMBEDDINGS_MODEL || env.EMBEDDINGS_API_KEY;
  if (!configured) return { status: OK, detail: "not configured (keyword FTS only — no error, lower recall)" };
  const dim = env.EMBEDDINGS_DIM ? Number.parseInt(env.EMBEDDINGS_DIM, 10) : 1536;
  if (!Number.isFinite(dim)) return { status: FAIL, detail: `EMBEDDINGS_DIM is not a number: ${env.EMBEDDINGS_DIM}` };
  if (dim !== 1536) {
    return {
      status: WARN,
      detail: `EMBEDDINGS_DIM=${dim} — the shipped pgvector column is vector(1536)`,
      fix: "edit postgres/optional/pgvector.sql BEFORE first loading it, or a width mismatch degrades silently to zero dense hits",
    };
  }
  return { status: OK, detail: `dim ${dim}` };
}

/** Aggregate: worst status wins. */
export function summarize(results) {
  const counts = { ok: 0, warn: 0, fail: 0 };
  for (const r of results) counts[r.status] += 1;
  return { ...counts, exitCode: counts.fail > 0 ? 1 : 0 };
}

// ── runner ──────────────────────────────────────────────────────────────────

function loadEnv() {
  // Real environment wins over the file, matching how the app is actually run in prod.
  const file = path.join(ROOT, ".env.local");
  const fromFile = existsSync(file) ? parseEnvFile(readFileSync(file, "utf8")) : {};
  return { env: { ...fromFile, ...process.env }, usedFile: existsSync(file) };
}

const ICON = { ok: "✓", warn: "!", fail: "✗" };
const COLOR = { ok: "\x1b[32m", warn: "\x1b[33m", fail: "\x1b[31m" };
const RESET = "\x1b[0m";

function line(name, r) {
  const tint = process.stdout.isTTY ? COLOR[r.status] : "";
  const reset = process.stdout.isTTY ? RESET : "";
  console.log(`${tint}${ICON[r.status]}${reset} ${name.padEnd(18)} ${r.detail}`);
  if (r.fix && r.status !== OK) console.log(`  ${" ".repeat(18)} → ${r.fix}`);
}

async function probeDatabase(env) {
  const { default: pg } = await import("pg");
  const { shouldUseSsl } = await import("./pg-load-schema.mjs");
  const client = new pg.Client({
    connectionString: env.DATABASE_URL,
    ssl: shouldUseSsl(env.DATABASE_URL, env) ? { rejectUnauthorized: false } : undefined,
    connectionTimeoutMillis: 5000,
  });
  await client.connect();
  try {
    const { rows } = await client.query(
      "select to_regclass('public.teams') is not null as schema_loaded, to_regclass('public.item_embeddings') is not null as vector_loaded"
    );
    return rows[0];
  } finally {
    await client.end();
  }
}

async function main() {
  const skipDb = process.argv.includes("--no-db");
  const { env, usedFile } = loadEnv();

  console.log("AIOS Team Brain — doctor");
  console.log(usedFile ? "reading .env.local (real environment wins)\n" : "no .env.local found; reading the environment\n");

  const results = [];
  const run = (name, r) => {
    results.push(r);
    line(name, r);
  };

  run("node", checkNode());
  run("DATABASE_URL", checkDatabaseUrl(env.DATABASE_URL));
  run("postgres TLS", checkPgSsl(env));
  run("AUTH_SECRET", checkAuthSecret(env.AUTH_SECRET));
  run("SECRETS_KEY", checkSecretsKey(env.SECRETS_KEY));
  run("APP_URL", checkAppUrl(env.APP_URL));
  run("model provider", checkModelProvider(env));
  run("mail transport", checkMailer(env));
  run("embeddings", checkEmbeddings(env));

  if (!skipDb && env.DATABASE_URL) {
    try {
      const probe = await probeDatabase(env);
      run("database", { status: OK, detail: "reachable" });
      run(
        "schema",
        probe.schema_loaded
          ? { status: OK, detail: "loaded" }
          : { status: FAIL, detail: "tables missing", fix: "npm run pg:schema" }
      );
      run(
        "pgvector",
        probe.vector_loaded
          ? { status: OK, detail: "loaded (semantic search available)" }
          : { status: OK, detail: "not loaded (optional — keyword FTS only)" }
      );
    } catch (err) {
      run("database", {
        status: FAIL,
        detail: `unreachable — ${err instanceof Error ? err.message : err}`,
        fix: "check DATABASE_URL, that the server is running, and PGSSL for managed providers",
      });
    }
  }

  const { ok, warn, fail, exitCode } = summarize(results);
  console.log(`\n${ok} ok · ${warn} warning${warn === 1 ? "" : "s"} · ${fail} failure${fail === 1 ? "" : "s"}`);
  if (fail === 0 && warn === 0) console.log("Ready.");
  else if (fail === 0) console.log("Usable — review the warnings above.");
  else console.log("Not ready — fix the ✗ lines above.");
  process.exit(exitCode);
}

// Only run when invoked directly, so the checks above stay importable from tests.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error("doctor failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
