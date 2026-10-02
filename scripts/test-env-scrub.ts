/**
 * The credential/outbound-endpoint SCRUB policy for test harnesses that boot a real server process
 * (today: the TIERRET-1 query harness — `vitest.tierret1-query.config.ts` and its global setup in
 * `test/http/`). PURE: no imports, no I/O, no side effects; it maps an environment to the blanks.
 *
 * Why it lives here and not beside the fakes in `test/http/`: the root Vitest config needs it at
 * RUNTIME, and the AUDITFIX-18 entry-surface guard (AC18-07) refuses a runtime reference from a
 * walked source (a root-level file) into an EXCLUDED one (`test/`) — such a reference is a hole in
 * the import closure. The policy is shared rather than copied so the seeding process and the
 * `next start` child can never scrub different sets. Keep it pure: anything that imports `test/`,
 * a product writer, or starts a server does not belong in this module.
 *
 * Variables are set to "" rather than deleted: Next.js reads `process.env` FIRST and stops once a
 * variable is found, so an empty value also stops a local `.env*` file from re-supplying a real key.
 */
const SCRUBBED = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_ORG_ID",
  "OPENROUTER_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GROQ_API_KEY",
  "MISTRAL_API_KEY",
  "TOGETHER_API_KEY",
  "EMBEDDINGS_URL",
  "EMBEDDINGS_API_KEY",
  "RERANK_URL",
  "RERANK_TOKEN",
  "RETRIEVAL_AUGMENT_URL",
  "RETRIEVAL_AUGMENT_TOKEN",
  "NEO4J_URL",
  "NEO4J_USER",
  "NEO4J_PASSWORD",
  "GRAPH_LLM_PROXY_SECRET",
  "RESEND_API_KEY",
  "SMTP_URL",
  "SENTRY_DSN",
  "NEXT_PUBLIC_SENTRY_DSN",
  "SENTRY_AUTH_TOKEN",
  "STAGING_DATA_MODE",
  "STAGING_OPS_ENVIRONMENT_ID",
  "RAILWAY_ENVIRONMENT_ID",
  "STAGING_QUERY_LLM_ENABLED",
  "STAGING_QUERY_LLM_BUDGET_USD",
];
/** Harness secrets the server legitimately needs (fixed test values set by vitest.http.config.ts). */
const KEEP = new Set(["AUTH_SECRET", "SECRETS_KEY", "DATABASE_URL", "DATABASE_TEST_URL"]);
const SECRET_SHAPED = /(API_KEY|_TOKEN|_SECRET|PASSWORD)$/;

export function scrubbedEnv(base: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of SCRUBBED) out[k] = "";
  for (const k of Object.keys(base)) if (SECRET_SHAPED.test(k) && !KEEP.has(k)) out[k] = "";
  return out;
}
