import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Data-mechanics tier: real Postgres (DB_BACKEND=postgres), stubbed model. Catches
// persistence & access to the observable outcome — what the in-memory FakeSupabase
// can't (RLS-less app-code enforcement, constraints, the generated `search` column).

// No-prod-fallback guard (skeleton B): refuse to run without the dedicated test DB.
const databaseTestUrl = process.env.DATABASE_TEST_URL;
if (!databaseTestUrl) {
  throw new Error(
    "Data-mechanics tier requires DATABASE_TEST_URL (the dedicated test Postgres). " +
      "Refusing to run — never fall back to a prod/dev URL. " +
      "Use `npm run test:datamechanics:local` (it sets it after `npm run db:test:up`)."
  );
}

// The pg adapter (lib/db/pg/pool) reads DATABASE_URL; the backend selector reads
// DB_BACKEND. Pin both to the test DB for every worker before any module loads.
process.env.DB_BACKEND = "postgres";
process.env.NEXT_PUBLIC_DB_BACKEND = "postgres";
process.env.DATABASE_URL = databaseTestUrl;
// Fixed test key for connector-secret crypto (lib/secrets); not a real secret.
process.env.SECRETS_KEY ??= Buffer.alloc(32, 7).toString("base64");

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/datamechanics/**/*.datamechanics.test.ts"],
    setupFiles: ["test/datamechanics/setup.ts"],
    fileParallelism: false, // shared DB → serialize files; truncate per test
    hookTimeout: 30_000,
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./", import.meta.url)),
      "server-only": fileURLToPath(new URL("./test/stubs/empty.ts", import.meta.url)),
    },
  },
});
