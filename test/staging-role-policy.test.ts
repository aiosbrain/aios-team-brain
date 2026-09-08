import { describe, expect, it } from "vitest";
import { assertOutboundCredentialIsolation, assertRunnerRole } from "../scripts/staging-ops/role-policy.mjs";

const base = { STAGING_OPS_IMAGE_DIGEST: `sha256:${"a".repeat(64)}` };
describe("isolated ops runner roles", () => {
  it("refuses cross-environment endpoints, moving sources and host aliases", () => {
    expect(() => assertRunnerRole({ ...base, STAGING_OPS_ROLE: "exporter", RAILWAY_ENVIRONMENT_ID: "prod", PRODUCTION_EXPORT_ENVIRONMENT_ID: "prod", DATABASE_URL: "postgres://x@prod-postgres.railway.internal/db", NEO4J_URL: "neo4j://prod-neo4j.railway.internal", STAGING_DATABASE_URL: "postgres://staging" }, "exporter")).toThrow(/staging database/);
    expect(() => assertRunnerRole({ ...base, STAGING_OPS_ROLE: "importer", RAILWAY_ENVIRONMENT_ID: "stg", STAGING_OPS_ENVIRONMENT_ID: "stg", DATABASE_URL: "postgres://x@alias.example/db", NEO4J_URL: "neo4j://stg-neo4j.railway.internal" }, "importer")).toThrow(/internal/);
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
