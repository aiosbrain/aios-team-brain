import { describe, expect, it } from "vitest";
import { assertOutboundCredentialIsolation, assertRunnerRole } from "../scripts/staging-ops/role-policy.mjs";
import { parseCanonicalPostgresTarget } from "../scripts/staging-ops/postgres-target.mjs";

const base = { STAGING_OPS_IMAGE_DIGEST: `sha256:${"a".repeat(64)}` };
describe("isolated ops runner roles", () => {
  it("refuses cross-environment endpoints, moving sources and host aliases", () => {
    expect(() => assertRunnerRole({ ...base, STAGING_OPS_ROLE: "exporter", RAILWAY_ENVIRONMENT_ID: "prod", PRODUCTION_EXPORT_ENVIRONMENT_ID: "prod", DATABASE_URL: "postgres://x:p@prod-postgres.railway.internal:5432/db", NEO4J_URL: "neo4j://prod-neo4j.railway.internal", STAGING_DATABASE_URL: "postgres://staging" }, "exporter")).toThrow(/staging database/);
    expect(() => assertRunnerRole({ ...base, STAGING_OPS_ROLE: "importer", RAILWAY_ENVIRONMENT_ID: "stg", STAGING_OPS_ENVIRONMENT_ID: "stg", DATABASE_URL: "postgres://x:p@alias.example:5432/db", NEO4J_URL: "neo4j://stg-neo4j.railway.internal" }, "importer")).toThrow(/internal/);
  });

  it("admits one explicit internal Postgres target and canonicalizes non-routing options", () => {
    const target = parseCanonicalPostgresTarget("postgres://app:p%40ss@postgres.railway.internal:5432/brain?sslmode=require&application_name=importer");
    expect(target).toMatchObject({ hostname: "postgres.railway.internal", port: 5432, database: "brain", username: "app" });
    expect(target.connectionString).toBe("postgresql://app:p%40ss@postgres.railway.internal:5432/brain?application_name=importer&sslmode=require");
    expect(assertRunnerRole({
      ...base, STAGING_OPS_ROLE: "importer", RAILWAY_ENVIRONMENT_ID: "stg", STAGING_OPS_ENVIRONMENT_ID: "stg",
      DATABASE_URL: target.connectionString, NEO4J_URL: "bolt://neo4j.railway.internal:7687",
    }, "importer")).toBe(true);
  });

  it.each([
    "postgres://app:pw@postgres.railway.internal:5432/brain?host=outside.example",
    "postgres://app:pw@postgres.railway.internal:5432/brain?hostaddr=203.0.113.10",
    "postgres://app:pw@postgres.railway.internal:5432/brain?dbname=other",
    "postgres://app:pw@postgres.railway.internal:5432/brain?database=other",
    "postgres://app:pw@postgres.railway.internal:5432/brain?user=other",
    "postgres://app:pw@postgres.railway.internal:5432/brain?password=other",
    "postgres://app:pw@postgres.railway.internal:5432/brain?port=6432",
    "postgres://app:pw@postgres.railway.internal:5432/brain?service=other",
    "postgres://app:pw@postgres.railway.internal:5432/brain?%68ost=outside.example",
    "postgres://app:pw@postgres.railway.internal:5432/brain?sslmode=require&sslmode=disable",
    "postgres://app:pw@postgres.railway.internal:5432/brain?unknown=value",
  ])("refuses routing, encoded, duplicate, or unknown option in %s", (databaseUrl) => {
    expect(() => parseCanonicalPostgresTarget(databaseUrl)).toThrow(/unsupported connection parameter|duplicate connection parameter/);
  });

  it.each([
    "mysql://app:pw@postgres.railway.internal:5432/brain",
    "postgres://app:pw@postgres.railway.internal/brain",
    "postgres://app:pw@postgres.railway.internal:5432/",
    "postgres://app:pw@one.railway.internal,two.railway.internal:5432/brain",
    "postgres://app:pw@postgres.railway.internal:5432/brain/other",
  ])("refuses ambiguous or incomplete destination %s", (databaseUrl) => {
    expect(() => parseCanonicalPostgresTarget(databaseUrl)).toThrow();
  });
  it("fails preflight on production outbound/provider credentials", () => {
    expect(() => assertOutboundCredentialIsolation({ OPENAI_API_KEY: "present", RESEND_API_KEY: "present" })).toThrow(/OPENAI_API_KEY/);
  });

  /**
   * ONE CREDENTIAL PER CASE. The case above supplies two, so it is satisfied by a policy that
   * catches either — and four names with real runtime readers were in fact missing:
   * `EMBEDDINGS_API_KEY` (lib/query/embedding-key.ts), `RETRIEVAL_AUGMENT_TOKEN` and `RERANK_TOKEN`
   * (lib/query/retrieve.ts, lib/query/external-provider.ts, which read AND send them), and
   * `E2B_API_KEY` (lib/actions/sandbox/e2b.ts).
   *
   * The list is written out rather than imported from the implementation on purpose: deriving the
   * expectation from the constant under test would let REMOVING a forbidden name delete its own
   * test and stay green.
   */
  const FORBIDDEN = [
    "RESEND_API_KEY", "SMTP_URL", "SENTRY_DSN", "NEXT_PUBLIC_SENTRY_DSN", "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY", "OPENROUTER_API_KEY", "SLACK_BOT_TOKEN", "GITHUB_TOKEN",
    "EMBEDDINGS_API_KEY", "RETRIEVAL_AUGMENT_TOKEN", "RERANK_TOKEN", "E2B_API_KEY",
  ] as const;

  it.each(FORBIDDEN)("refuses a runner holding only %s", (name) => {
    const attempt = () => assertOutboundCredentialIsolation({ [name]: "synthetic-nonblank-value" });
    expect(attempt).toThrow(new RegExp(name));
    // The diagnostic names the VARIABLE and never echoes its value.
    expect(attempt).not.toThrow(/synthetic-nonblank-value/);
  });

  it("admits an absent, empty or whitespace-only value, so presence means presence", () => {
    // The negative control the cases above need: a policy that threw unconditionally would pass
    // all thirteen of them.
    expect(() => assertOutboundCredentialIsolation({})).not.toThrow();
    for (const name of FORBIDDEN) {
      expect(() => assertOutboundCredentialIsolation({ [name]: "" }), name).not.toThrow();
      expect(() => assertOutboundCredentialIsolation({ [name]: "   " }), name).not.toThrow();
    }
  });
});
