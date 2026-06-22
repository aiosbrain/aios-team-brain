/**
 * Load postgres/schema.sql into the database at DATABASE_URL, then apply every additive
 * delta in postgres/migrations/ (in lexical filename order).
 *
 * schema.sql is `create … if not exists` throughout, so it is a no-op on an EXISTING table —
 * it cannot add a column to a table prod already has. postgres/migrations/ holds the idempotent
 * `alter table … add column if not exists` deltas that catch an existing DB up. Both are
 * idempotent, so this is safe to re-run and is the prod rollout step (`npm run pg:schema`).
 *
 * Usage: DATABASE_URL=postgres://… npx tsx scripts/pg-load-schema.ts
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

    // Additive deltas that `create … if not exists` can't apply to an existing table.
    const migDir = path.join(pgDir, "migrations");
    const files = existsSync(migDir)
      ? readdirSync(migDir)
          .filter((f) => f.endsWith(".sql"))
          .sort()
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
