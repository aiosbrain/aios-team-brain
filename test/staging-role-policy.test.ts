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
});
