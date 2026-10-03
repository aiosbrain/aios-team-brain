import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { scrubbedEnv } from "./scripts/test-env-scrub";

// AIO-1210 dev-login WIRE carrier: the real `/auth/dev-login` route over a real loopback socket,
// against (1) the production build started under NODE_ENV=production and under NODE_ENV=development,
// then (2) actual `next dev` children with the opt-in explicitly off and on. Separate from the
// ordinary HTTP tier (vitest.http.config.ts → *.http.test.ts): that tier's include glob does not match
// `dev-login.dev-http.test.ts`, the unit config excludes `test/http/**`, and nothing here touches the
// shared `next start` server, its port or its global setup.
//
// Run by `npm run test:http:dev-login`, AFTER a successful `npm run build` and never concurrently with
// another suite on the same test database. The global setup (test/http/dev-login-dev-setup.ts) is the
// preflight: it refuses a checkout holding a Next-loaded env file, an absent/unsafe DATABASE_TEST_URL,
// or a missing build — before any child is spawned. This file may not import from `test/` at runtime
// (AC18-07), so the setup is referenced by path and the shared scrub comes from `scripts/`.

// No-prod-fallback guard (same contract as the other real-database tiers).
const databaseTestUrl = process.env.DATABASE_TEST_URL;
if (!databaseTestUrl) {
  throw new Error(
    "SETUP_FAILURE[database-url-missing]: the dev-login wire carrier requires DATABASE_TEST_URL (the " +
      "task-owned synthetic Postgres). Refusing to run — never fall back to a prod/dev URL."
  );
}

// This process only seeds synthetic fixtures and verifies cookies; it calls no provider. Blank the
// credential/outbound set anyway so an ambient key can never be read here. The spawned children do
// NOT inherit this environment: theirs is built from a finite allowlist (buildChildEnv).
Object.assign(process.env, scrubbedEnv(process.env));
process.env.DB_BACKEND = "postgres";
process.env.NEXT_PUBLIC_DB_BACKEND = "postgres";
process.env.DATABASE_URL = databaseTestUrl;

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/http/dev-login.dev-http.test.ts"],
    globalSetup: ["test/http/dev-login-dev-setup.ts"],
    // One file, one owned child at a time (production children first, then dev off, then dev on).
    fileParallelism: false,
    // A test may start a child (finite readiness deadline inside) and wait for a first dev compile.
    testTimeout: 300_000,
    hookTimeout: 120_000,
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./", import.meta.url)),
      "server-only": fileURLToPath(new URL("./test/stubs/empty.ts", import.meta.url)),
    },
  },
});
