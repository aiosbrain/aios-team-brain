import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Integration (HTTP) tier: spec-derived tests that exercise the API over a REAL
// socket against a production Next.js server (`next start`) + the real test
// Postgres. This is the only tier that crosses the wire — TCP fetch, the Next
// route runtime (middleware, cookies, headers), and the JSON wire format — which
// the in-process data-mechanics tier (it imports route handlers directly) cannot.

// No-prod-fallback guard (same contract as the data-mechanics tier): refuse to run
// without the dedicated test DB. Both this process (seeding via lib/ingest) and the
// spawned server talk to it.
const databaseTestUrl = process.env.DATABASE_TEST_URL;
if (!databaseTestUrl) {
  throw new Error(
    "Integration (HTTP) tier requires DATABASE_TEST_URL (the dedicated test Postgres). " +
      "Refusing to run — never fall back to a prod/dev URL. " +
      "Use `npm run test:http:local` (it builds, then sets it after `npm run db:test:up`)."
  );
}

// Pin the backend for this process (the seed helpers run the real app code) AND,
// by inheritance through spawn, for the server child started in global-setup.
process.env.DB_BACKEND = "postgres";
process.env.NEXT_PUBLIC_DB_BACKEND = "postgres";
process.env.DATABASE_URL = databaseTestUrl;
// Fixed test key for integration-secret crypto (lib/secrets); not a real secret.
process.env.SECRETS_KEY ??= Buffer.alloc(32, 7).toString("base64");
// The login route signs sessions with AUTH_SECRET (lib/auth/pg-session requires >=16 chars).
process.env.AUTH_SECRET ??= "http-tier-test-secret-not-for-production";
// Several other HTTP-tier test files use the direct-by-email POST /api/auth/login as a
// convenience helper to establish a session for testing unrelated pages — not to test
// login itself. That route (like /auth/dev-login) is now dev-only in production, so the
// spawned `next start` server needs this same escape hatch for those helpers to keep working.
process.env.ALLOW_DEV_LOGIN ??= "1";
// Server port override (default 3010 — see test/http/server-url.ts, which derives
// the URL both the server and clients use). We avoid process.env.BASE_URL: Vite
// reserves that name and pins it to "/".
process.env.HTTP_TEST_PORT ??= "3010";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/http/**/*.http.test.ts"],
    // Boot one production server for the whole suite (not per file).
    globalSetup: ["test/http/global-setup.ts"],
    // Reuse the data-mechanics per-test truncation (TRUNCATE ... CASCADE clears the
    // same shared DB the server reads from).
    setupFiles: ["test/datamechanics/setup.ts"],
    fileParallelism: false, // shared DB + single server → serialize files
    hookTimeout: 60_000, // server boot + readiness headroom
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./", import.meta.url)),
      "server-only": fileURLToPath(new URL("./test/stubs/empty.ts", import.meta.url)),
    },
  },
});
