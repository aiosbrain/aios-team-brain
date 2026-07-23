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
process.env.LLM_BASE_URL = ""; // no summary LLM in the http tier
process.env.NEXT_PUBLIC_DB_BACKEND = "postgres";
process.env.DATABASE_URL = databaseTestUrl;
// Fixed test key for integration-secret crypto (lib/secrets); not a real secret.
process.env.SECRETS_KEY ??= Buffer.alloc(32, 7).toString("base64");
// The login route signs sessions with AUTH_SECRET (lib/auth/pg-session requires >=16 chars).
process.env.AUTH_SECRET ??= "http-tier-test-secret-not-for-production";
// Trusted base URL for emailed magic links (appBaseUrl). Without it the request-magic-link after-job
// no-ops (no safe link to build), so the known-email delivery assertion needs it set. No mail
// provider is configured, so sendMagicLink still drops to a dev-log — the token row is what we assert.
process.env.APP_URL ??= `http://127.0.0.1:${process.env.HTTP_TEST_PORT ?? "3010"}`;
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
