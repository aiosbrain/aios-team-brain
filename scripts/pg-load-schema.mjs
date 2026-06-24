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
import { Client } from "pg";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");

  const pgDir = path.join(process.cwd(), "postgres");
  const sql = readFileSync(path.join(pgDir, "schema.sql"), "utf8");
  const useSsl =
    /\bsslmode=require\b/.test(url) ||
    process.env.PGSSL === "require" ||
    process.env.PGSSLMODE === "require";

  const client = new Client({
    connectionString: url,
    ssl: useSsl ? { rejectUnauthorized: false } : undefined,
  });
  await client.connect();
  try {
    await client.query(sql);
    console.log("✓ postgres/schema.sql loaded");

    const migDir = path.join(pgDir, "migrations");
    const files = existsSync(migDir)
      ? readdirSync(migDir).filter((f) => f.endsWith(".sql")).sort()
      : [];
    for (const f of files) {
      await client.query(readFileSync(path.join(migDir, f), "utf8"));
      console.log(`✓ postgres/migrations/${f} applied`);
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error("schema load failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
