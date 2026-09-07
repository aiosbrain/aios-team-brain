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
  it("renders ONE absolute /data tmpfs mount per object store, options intact", () => {
    // The measured failure: `tmpfs: [/data:uid=1000,gid=1000,mode=0700]` is a YAML flow SEQUENCE, so
    // the commas inside the mount spec split it into three entries and docker refuses service
    // creation with `invalid mount path: 'gid=1000' mount path must be absolute` — after the image
    // builds, so the harness looks like it got much further than it did. Asserting the parsed shape
    // (not the file text) is what distinguishes one option-bearing scalar from three broken ones.
    for (const name of ["source-object-store", "rollback-object-store"]) {
      const tmpfs = compose.services[name].tmpfs;
      expect(tmpfs, name).toEqual(["/data:uid=1000,gid=1000,mode=0700"]);
      const [path, ...options] = tmpfs[0].split(":");
      expect(path.startsWith("/"), `${name} mount path must be absolute`).toBe(true);
      // Owner-only, owned by the non-root runner user: the parse fix must not become a permissions fix.
      expect(options.join(":")).toBe("uid=1000,gid=1000,mode=0700");
    }
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
  it("asserts each failure scenario by RECEIPT, with a control that must not satisfy it", () => {
    // The accepted HIGH: `expect_failure … && assert v3` is satisfied by any nonzero exit, and v3 was
    // installed before the scenario ran — so a preflight refusal passed the recovery test. What the
    // harness must now contain is the positive checkpoint evidence, tied to the candidate run, plus
    // the pre-drain control demonstrating those assertions can distinguish the two.
    expect(harness).toContain("STAGING_FAULT_POINT=before-drain");
    expect(harness).toContain("refuse_receipt pre-drain-control postgres-restored");
    expect(harness).toContain("refuse_receipt pre-drain-control prior-pair-restored");
    expect(harness).toContain("require_receipt install-fault-recovers fault-injected");
    expect(harness).toContain("require_receipt install-fault-recovers prior-pair-restored");
    // BOTH stores: the after-graph fault is the case where recovery has two of them to undo.
    expect(harness).toContain("STAGING_FAULT_POINT=after-graph");
    expect(harness).toContain("require_receipt graph-fault-recovers graph-restored");
    expect(harness).toContain("assert-graph-version v3");
    // A failed rollback must prove its own checkpoint, and that the whole pinned set is stopped.
    expect(harness).toContain("require_receipt failed-rollback-stays-stopped recovery-required");
    expect(harness).toContain("require_journal last_safe_checkpoint recovery-required");
    expect(harness).toContain("serviceId=graphiti-local");
    expect(harness).toContain("require_receipt explicit-recovery prior-pair-restored");
    // The interruption waits for the POSTGRES BARRIER, not for `state=importing` (which is written
    // before the restore, so a kill on it can land before any candidate data exists).
    expect(harness).toContain("receipt interrupted.log postgres-restored");
    expect(harness).not.toContain('if [[ "$state" == "importing" ]]');
    // The graph oracle's own negative control.
    expect(harness).toContain("corrupt-graph-version v99");
    expect(harness).toContain("graph facts from another capture survived");
    // Evidence outlives the harness root, without the harness root's key material.
    expect(harness).toContain("redact-artifacts.mjs");
    expect(harness).not.toMatch(/cp -r "\$harness_root"/);
  });

  it("cleans up reliably and REPORTS what it could not clean", () => {
    // The measured leftover: a run whose `up` died part-way left three containers in `Created`, and
    // `down … >/dev/null 2>&1 || true` said nothing about it — so the next run inherited them and the
    // resulting failure looked new. Cleanup still never aborts the run; it just stops being silent.
    expect(harness).not.toContain('down -v --remove-orphans >/dev/null 2>&1 || true');
    expect(harness).toContain("harness cleanup: 'compose down' failed for project");
    expect(harness).toContain('label=com.docker.compose.project=$project');
    expect(harness).toContain("docker rm -f $leftovers");
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
