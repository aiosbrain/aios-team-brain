import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

describe("paired refresh isolated harness", () => {
  const raw = readFileSync("compose.test.staging-pair.yml", "utf8");
  const compose = YAML.parse(raw, { merge: true });
  const harness = readFileSync("scripts/staging-pair-isolated.sh", "utf8");
  it("uses two Postgres 18 and two Neo4j stores without shared host ports or PG18's legacy tmpfs path", () => {
    expect(["prod-pg", "staging-pg"].map((n) => compose.services[n].image)).toEqual(["postgres:18", "postgres:18"]);
    for (const name of ["prod-pg", "staging-pg", "prod-neo4j", "staging-neo4j"]) expect(compose.services[name].ports).toBeUndefined();
    expect(compose.services["prod-pg"].tmpfs).toEqual(["/var/lib/postgresql"]);
    expect(compose.services["staging-pg"].tmpfs).toEqual(["/var/lib/postgresql"]);
  });
  it("role containers cannot route to the opposite database network", () => {
    expect(compose.services.exporter.networks).toEqual(["production", "source-store"]);
    expect(compose.services.importer.networks).toEqual(["staging", "source-store", "rollback-store"]);
    expect(compose.services.exporter.environment.STAGING_OBJECT_STORE).toBe("s3");
    expect(compose.services.importer.environment.STAGING_OBJECT_STORE).toBe("s3");
  });
  it("enforces independent source and rollback ACLs in object-store services", () => {
    const source = JSON.parse(compose.services["source-object-store"].environment.LOCAL_OBJECT_STORE_POLICIES_JSON);
    const rollback = JSON.parse(compose.services["rollback-object-store"].environment.LOCAL_OBJECT_STORE_POLICIES_JSON);
    expect(source["source-publish"].operations).toEqual(["put"]);
    expect(source["source-read"].operations).toEqual(["get", "list"]);
    expect(rollback["rollback-owner"].operations).toEqual(["get", "put", "list", "delete"]);
    expect(compose.services.exporter.networks).not.toContain("rollback-store");
  });
  it("ships disabled-by-default concrete weekly export and five-minute import schedules", () => {
    const schedules = JSON.parse(readFileSync("config/staging-ops/schedules.json", "utf8"));
    expect(schedules.activated).toBe(false);
    expect(schedules.services["aios-staging-export"].schedule).toBe("0 3 * * 0");
    expect(schedules.services["aios-staging-import"].schedule).toBe("*/5 * * * *");
    expect(schedules.services["aios-staging-import"].command).toEqual(["node", "scripts/staging-ops/importer.mjs", "tick"]);
    expect(schedules.storage.sourceBundles.retentionDays).toBe(14);
    expect(schedules.storage.rollbackBundles.ownerOperations).toContain("delete");
  });
  it("drives the real role CLIs, app oracle, ACL/network denials and recovery paths", () => {
    expect(harness).toContain("importer.mjs bootstrap-rollback");
    expect(harness).toContain("STAGING_BUNDLE_RUN_ID=run-1 exporter");
    expect(harness).toContain("object-store-acl-probe.mjs expect-access-denied-get");
    expect(harness).toContain("network-boundary-probe.mjs deny staging-pg.railway.internal");
    expect(harness).toContain("fixture-controller assert v1");
    expect(harness).toContain("STAGING_HARNESS_PAUSE_AFTER_POSTGRES_MS=120000");
    expect(harness).toContain("STAGING_FAULT_ROLLBACK=1");
    expect(harness).toContain("kill-reader-lock");
    expect(harness).toContain("concurrent-a.log");
  });
  it("turns a missing engine into a FAILURE in the required lane, never a quiet pass", () => {
    // "Docker is not installed" and "every assertion held" must not be the same green tick.
    expect(harness).toContain('if [[ "${STAGING_PAIR_REQUIRED:-}" == "1" ]]; then');
    expect(harness).toContain("docker compose version");
    expect(harness).toContain("docker info");
    const ci = readFileSync(".github/workflows/ci.yml", "utf8");
    const job = ci.slice(ci.indexOf("  staging-paired-refresh:"), ci.indexOf("  ingestion-tests:"));
    expect(job).toContain('STAGING_PAIR_REQUIRED: "1"');
    expect(job).toContain("npm ci");
    expect(job).toContain("actions/setup-node");
  });
});
