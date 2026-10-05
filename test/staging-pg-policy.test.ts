import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import classification from "../scripts/staging-ops/credential-classification.json";
import {
  EXCLUDED_PAIRED_TABLE_DATA,
  credentialClassificationGaps,
  pairedDumpArguments,
  transformedAuthUserProjection,
  transformedGraphEpisodeProjection,
} from "../scripts/staging-ops/pg-sanitize.mjs";
import { EXCLUDED_TABLE_DATA, fkDependents } from "../scripts/staging-refresh-decision.mjs";

describe("paired Postgres sanitation policy", () => {
  const schema = readFileSync(join(__dirname, "..", "postgres", "schema.sql"), "utf8");

  it("classifies every credential-like/hash column in the current canonical schema", () => {
    expect(credentialClassificationGaps(schema, classification)).toEqual([]);
  });

  it("excludes credential-bound governed history from the actual dump arguments", () => {
    expect(classification["governed_action_identities.request_hash"]).toBe("exclude-table-noncredential");
    expect(classification["governed_actions.credential_id"]).toBe("exclude-table");
    const args = pairedDumpArguments("00000003-0000001B-1", "/fixture/postgres.dump");
    for (const table of ["api_keys", "governed_action_identities", "governed_actions"]) {
      expect(args.filter((arg: string) => arg === `--exclude-table-data=${table}`)).toHaveLength(1);
      expect(args).not.toContain(`--exclude-table=${table}`);
    }
  });

  // AIO-1167. `connector_api_key_id` and `actor_api_key_id` are foreign keys to `api_keys(id)`, whose
  // rows never leave production — the same shape as `governed_actions.credential_id` above, and
  // unlike `audit_log.api_key_id`, which has no constraint and can keep a dangling id. A retained
  // row would fail the restore when its constraint is created, so the classification is only true
  // if the tables are really absent from the dump.
  const DRIVE_CONNECTION_TABLES = [
    "gdrive_cleanup_obligations", "gdrive_connection_authority", "gdrive_item_claim_projects",
    "gdrive_item_claims", "gdrive_run_requests",
  ];

  it("excludes Drive connection state bound to excluded API keys from the actual dump arguments", () => {
    expect(classification["gdrive_connection_authority.connector_api_key_id"]).toBe("exclude-table");
    expect(classification["gdrive_cleanup_obligations.actor_api_key_id"]).toBe("exclude-table");
    const args = pairedDumpArguments("00000003-0000001B-1", "/fixture/postgres.dump");
    for (const table of DRIVE_CONNECTION_TABLES) {
      expect(args.filter((arg: string) => arg === `--exclude-table-data=${table}`), table).toHaveLength(1);
      expect(args).not.toContain(`--exclude-table=${table}`);
    }
  });

  it("closes the Drive exclusion over its foreign keys and agrees with the legacy refresh policy", () => {
    // Non-vacuous: these are the constraints that make the exclusion necessary.
    expect(fkDependents(schema, "api_keys")).toEqual(expect.arrayContaining(["gdrive_cleanup_obligations", "gdrive_connection_authority"]));
    expect(fkDependents(schema, "integrations")).toEqual(expect.arrayContaining(["gdrive_connection_authority", "gdrive_run_requests"]));
    expect(fkDependents(schema, "gdrive_connection_authority")).toContain("gdrive_item_claims");
    expect(fkDependents(schema, "gdrive_item_claims")).toContain("gdrive_item_claim_projects");

    // Every Drive table hanging off an excluded parent — directly or through another Drive table —
    // is excluded too.
    const excluded = new Set<string>(EXCLUDED_PAIRED_TABLE_DATA);
    for (const parent of ["integrations", "api_keys", ...DRIVE_CONNECTION_TABLES]) {
      for (const dependent of fkDependents(schema, parent).filter((table: string) => table.startsWith("gdrive_"))) {
        expect(excluded.has(dependent), `${dependent} references excluded ${parent}`).toBe(true);
      }
    }
    // One Drive table set for both refresh paths; the paired list had drifted from the legacy one.
    const drive = (tables: readonly string[]) => tables.filter((table) => table.startsWith("gdrive_")).sort();
    expect(drive(EXCLUDED_PAIRED_TABLE_DATA)).toEqual([...DRIVE_CONNECTION_TABLES].sort());
    expect(drive(EXCLUDED_PAIRED_TABLE_DATA)).toEqual(drive(EXCLUDED_TABLE_DATA));
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
      "governed_action_identities", "governed_actions",
      "social_jobs", "llm_usage", "llm_failures", "usage_costs", "arc_cache", "work_timeline_cache",
    ]));
    expect(EXCLUDED_PAIRED_TABLE_DATA).not.toContain("graph_episodes");
  });
});
