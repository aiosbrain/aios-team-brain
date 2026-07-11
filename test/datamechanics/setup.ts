import { afterAll, beforeEach } from "vitest";
import { Client } from "pg";

// Per-test isolation against the shared test Postgres: truncate all data tables
// before each test. One dedicated connection (separate from the app's pool) so
// truncation can't deadlock against in-flight adapter queries.
const DATA_TABLES = [
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
