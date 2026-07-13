/**
 * Load postgres/schema.sql into the database at DATABASE_URL, then apply every additive delta in
 * postgres/migrations/ (in lexical filename order). Both are idempotent, so this is safe to re-run
 * and is the prod rollout step for schema changes (`npm run pg:schema`).
 *
 * Pure node + the `pg` runtime dependency (NO tsx) so it runs in the pruned production image — it
 * is the Railway pre-deploy hook (railway.json `deploy.preDeployCommand`), so every deploy
 * self-applies pending migrations before the new app version goes live. A failure here aborts the
 * release rather than shipping app code ahead of its schema.
 *
 * Usage: DATABASE_URL=postgres://… node scripts/pg-load-schema.mjs
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { assertServiceIdentity } from "./service-guard.mjs";

export function shouldUseSsl(databaseUrl, env = process.env) {
  return (
    /\bsslmode=require\b/.test(databaseUrl) ||
    env.PGSSL === "require" ||
    env.PGSSLMODE === "require"
  );
}

export async function loadSchema({
  cwd = process.cwd(),
  databaseUrl = process.env.DATABASE_URL,
  env = process.env,
  createClient,
  readFile = readFileSync,
  exists = existsSync,
  readDir = readdirSync,
  logger = console,
} = {}) {
  // On Railway, refuse to run if this app landed on a non-AIOS service — the
  // 2026-06-27 vector: this preDeployCommand ran against Kula's DATABASE_URL and
  // injected our schema into Kula's prod DB. Abort BEFORE reading DATABASE_URL or
  // opening any database connection.
  assertServiceIdentity("load the AIOS schema");

  if (!databaseUrl) throw new Error("DATABASE_URL is required");

  const pgDir = path.join(cwd, "postgres");
  const sql = readFile(path.join(pgDir, "schema.sql"), "utf8");
  const useSsl = shouldUseSsl(databaseUrl, env);

  const makeClient = createClient ?? ((config) => new Client(config));
  const client = makeClient({
    connectionString: databaseUrl,
    ssl: useSsl ? { rejectUnauthorized: false } : undefined,
  });
  await client.connect();
  try {
    // Bound how long any DDL below will WAIT for a table lock (not how long it runs once acquired —
    // a legit long CREATE INDEX is unaffected). This runs on every deploy (Railway preDeployCommand),
    // so without it a single stuck reader holding ACCESS SHARE makes an `ALTER` wait forever at the
    // head of the lock queue, and every ordinary query then queues behind that ALTER — the mechanism
    // behind the 2026-07-13 outage. With a bounded lock_timeout the migration fails fast, the release
    // aborts (schema ahead of app is never shipped), Railway retries, and live traffic keeps flowing.
    const lockTimeoutMs = Number(env.PG_MIGRATION_LOCK_TIMEOUT_MS ?? 15_000);
    await client.query(`SET lock_timeout = ${Math.max(0, Math.trunc(lockTimeoutMs))}`);

    await client.query(sql);
    logger.log("✓ postgres/schema.sql loaded");

    const migDir = path.join(pgDir, "migrations");
    const files = exists(migDir)
      ? readDir(migDir).filter((f) => f.endsWith(".sql")).sort()
      : [];
    for (const f of files) {
      await client.query(readFile(path.join(migDir, f), "utf8"));
      logger.log(`✓ postgres/migrations/${f} applied`);
    }
  } finally {
    await client.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  loadSchema().catch((err) => {
    console.error("schema load failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
