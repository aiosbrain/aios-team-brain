/**
 * Load the OPTIONAL pgvector schema (postgres/optional/pgvector.sql) into DATABASE_URL — the
 * opt-in dense-retrieval add-on. Run AFTER `npm run pg:schema` (it references teams/items + the
 * access_tier enum), and only against a Postgres with the `vector` extension available.
 *
 * This is deliberately NOT part of `pg:schema` / the deploy pre-hook, so the default install stays
 * extension-free and portable. Idempotent. Usage: DATABASE_URL=… node scripts/pg-load-vector.mjs
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");

  const file = path.join(process.cwd(), "postgres", "optional", "pgvector.sql");
  const sql = readFileSync(file, "utf8");
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
    console.log("✓ postgres/optional/pgvector.sql loaded (dense retrieval available)");
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
