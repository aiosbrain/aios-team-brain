import { afterAll, beforeEach, inject } from "vitest";
import { Client } from "pg";
import { RUN_ID_PROVIDED, adoptRunId, assertRunSafe, noteSetupModuleCheck, noteTruncationHook } from "./run-fatal-latch";

// MODULE SCOPE — evaluated before the test module is imported and before any `beforeAll`. A run
// that has been stopped, or that still carries an in-flight harness scope (a test that raced real
// sessions and never proved them gone — after a failure, a timeout or an interruption), may not
// load another test file, let alone truncate for it. Throwing here fails the whole file.
adoptRunId(inject(RUN_ID_PROVIDED));
assertRunSafe();
noteSetupModuleCheck();

// Per-test isolation against the shared test Postgres: truncate all data tables
// before each test. One dedicated connection (separate from the app's pool) so
// truncation can't deadlock against in-flight adapter queries.
const DATA_TABLES = [
  "codebase_finding_events",
  "codebase_findings",
  "gateway_audit_log",
  "gateway_service_credentials",
  "gateway_approvals",
  "gateway_executions",
  "gateway_resolution_leases",
  "gateway_connections",
  "executor_subject_bindings",
  "gateway_service_identities",
  "publication_analytics",
  "social_publications",
  "content_approvals",
  "social_settings",
  "media_assets",
  "content_variants",
  "content_plans",
  "social_opportunities",
  "brand_assets",
  "brand_profiles",
  "social_jobs",
  "integrations",
  "github_issues",
  "code_contributions",
  "code_metrics",
  "codebases",
  "actions",
  "approval_requests",
  "policies",
  "query_log",
  "graph_relationships",
  "graph_entities",
  "decisions",
  "task_pm_links",
  "tasks",
  "item_versions",
  "source_item_mappings",
  "items",
  "projects",
  "rate_limits",
  "audit_log",
  "api_keys",
  "members",
  "teams",
  "auth_tokens",
  "auth_users",
  "oauth_states",
];

const client = new Client({ connectionString: process.env.DATABASE_URL });
let connected = false;

async function ensureConnected(): Promise<void> {
  if (!connected) {
    await client.connect();
    connected = true;
  }
}

beforeEach(async () => {
  // AGAIN, and FIRST — before this hook connects or truncates anything. A test that could not prove
  // its database sessions gone has stopped the run, and one that never finished its cleanup still
  // has its in-flight marker on file (`run-fatal-latch`): truncating now would block on, or clean
  // up around, work that may still be in flight. This hook is registered by the setup file, so it
  // runs before any test file's own `beforeEach`; the refusal is therefore earlier than every later
  // test's cleanup, in this worker and in the workers of every later file.
  assertRunSafe();
  noteTruncationHook();
  await ensureConnected();
  // Only truncate tables that exist (schema may evolve); RESTART IDENTITY + CASCADE.
  const { rows } = await client.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename = ANY($1)`,
    [DATA_TABLES]
  );
  const present = rows.map((r) => `"${r.tablename}"`);
  if (present.length) {
    await client.query(`TRUNCATE ${present.join(", ")} RESTART IDENTITY CASCADE`);
  }
});

afterAll(async () => {
  if (connected) await client.end();
});
