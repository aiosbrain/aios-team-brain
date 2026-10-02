import { defineConfig } from "vitest/config";
import httpConfig from "./vitest.http.config";
import { scrubbedEnv } from "./scripts/test-env-scrub";

// The real `/api/v1/query` route over a real socket (TIERRET-1 AC-03/AC-05/AC-11), answered by a
// test-only loopback fake OpenAI-compatible endpoint and spied on by a loopback fake Graphiti. Inherits
// the HTTP tier's DATABASE_TEST_URL guard and pins, but swaps in its own global setup
// (test/http/tierret1-query-global-setup.ts), which pins LLM_BASE_URL/GRAPHITI_URL to the fakes in the
// `next start` child only. The ordinary HTTP tier (vitest.http.config.ts → *.http.test.ts) is untouched
// and keeps its no-LLM server; its include glob does not match this file, nor do the unit/dm configs.
// Run by `npm run test:http:tierret1-query` (a separate, sequential step of the CI HTTP job, after the
// production build) — never concurrently with the ordinary HTTP tier (same port and test DB).
//
// This process (fixture seeding) stays model-free: it keeps the inherited blank LLM_BASE_URL, and cloud
// credentials are blanked here too. The scrub is imported from `scripts/` (a pure, walked module), not
// from `test/http/`: a root file's runtime import into an excluded test source fails AC18-07.
Object.assign(process.env, scrubbedEnv(process.env));

export default defineConfig({
  ...httpConfig,
  test: {
    ...httpConfig.test,
    include: ["test/http/tierret1-query.test.ts"],
    globalSetup: ["test/http/tierret1-query-global-setup.ts"],
  },
});
