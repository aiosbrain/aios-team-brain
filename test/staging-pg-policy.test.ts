import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import classification from "../scripts/staging-ops/credential-classification.json";
import {
  EXCLUDED_PAIRED_TABLE_DATA,
  credentialClassificationGaps,
  transformedAuthUserProjection,
  transformedGraphEpisodeProjection,
} from "../scripts/staging-ops/pg-sanitize.mjs";

describe("paired Postgres sanitation policy", () => {
  const schema = readFileSync(join(__dirname, "..", "postgres", "schema.sql"), "utf8");

  it("classifies every credential-like/hash column in the current canonical schema", () => {
    expect(credentialClassificationGaps(schema, classification)).toEqual([]);
  });

  it("keeps identities but forces password hashes null in the exported projection", () => {
    expect(transformedAuthUserProjection(["id", "email", "password_hash", "created_at"])).toBe('"id", "email", NULL::text AS "password_hash", "created_at"');
  });
  it("keeps the current graph ledger but clears fully sanitized old-group cleanup metadata", () => {
    expect(transformedGraphEpisodeProjection(["id", "pending_delete_group_id", "pending_delete_at"])).toBe('"id", NULL::text AS "pending_delete_group_id", NULL::timestamptz AS "pending_delete_at"');
  });

  it("excludes every credential, outbound queue, production usage and generated cache table", () => {
    expect(EXCLUDED_PAIRED_TABLE_DATA).toEqual(expect.arrayContaining([
      "auth_tokens", "oauth_states", "api_keys", "agent_tokens", "integrations", "member_secrets",
      "gateway_service_identities", "gateway_service_credentials", "gateway_connections",
      "gateway_resolution_leases", "gateway_executions", "gateway_approvals", "gateway_audit_log",
      "social_jobs", "llm_usage", "llm_failures", "usage_costs", "arc_cache", "work_timeline_cache",
    ]));
    expect(EXCLUDED_PAIRED_TABLE_DATA).not.toContain("graph_episodes");
  });
});
