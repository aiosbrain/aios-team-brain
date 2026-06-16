/**
 * Load postgres/schema.sql into the database at DATABASE_URL.
 * Usage: DATABASE_URL=postgres://… npx tsx scripts/pg-load-schema.ts
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");

  const sql = readFileSync(path.join(process.cwd(), "postgres", "schema.sql"), "utf8");
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
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error("schema load failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
