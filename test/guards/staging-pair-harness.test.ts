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
  it("renders a fixture argv where the harness subcommand is an ARGUMENT, not the program", () => {
    // The measured failure: `entrypoint: [node]` + `command: [<script>]`. `docker compose run
    // SERVICE ARGS…` REPLACES `command` and leaves `entrypoint` alone, so `run fixture-controller
    // seed` executed `node seed` and died with `Cannot find module '/app/seed'` — after every
    // database had come up healthy, which is why it read as a much later failure than it was.
    // Asserting the filename appears somewhere in the service would have passed throughout; what
    // has to hold is the ARGV the two fields render to under `run`.
    const fixture = compose.services["fixture-controller"];
    const script = "scripts/staging-ops/staging-pair-fixture.mjs";
    expect(fixture.entrypoint).toEqual(["node", script]);
    const argv = (args: string[]) => [...fixture.entrypoint, ...(args.length ? args : fixture.command ?? [])];
    expect(argv(["seed"])).toEqual(["node", script, "seed"]);
    // `assert v1` carries a SECOND argument, so a fix that only rescued the no-argument subcommands
    // (baking an action into the entrypoint, say) fails here rather than three steps into a run.
    expect(argv(["assert", "v1"])).toEqual(["node", script, "assert", "v1"]);
    expect(argv(["kill-reader-lock"])).toEqual(["node", script, "kill-reader-lock"]);
    // Where the script actually reads them: node drops its own exec path, so the action is argv[2]
    // and the version argv[3].
    const processArgv = ["/usr/local/bin/node", ...argv(["assert", "v1"]).slice(1)];
    expect(processArgv[2]).toBe("assert");
    expect(processArgv[3]).toBe("v1");
    // The ordinary default is unchanged — a bare `run fixture-controller` performs no implicit
    // action, exactly as when the script sat in `command` with no argument.
    expect(argv([])).toEqual(["node", script]);
    const source = readFileSync(script, "utf8");
    expect(source).toContain("const action = process.argv[2]");
    for (const action of ["seed", "mutate", "assert", "assert-graph-version", "corrupt-graph-version", "kill-reader-lock"]) {
      expect(source, `${action} must stay dispatchable as an argument`).toContain(`action === "${action}"`);
    }
  });

  it("drives the fixture ONLY through compose, never a host-side node helper", () => {
    // Running the script on the host would "pass" the same assertions while proving nothing about
    // the containerised networks, the image, or the entrypoint contract above.
    expect(harness).not.toMatch(/node\s+scripts\/staging-ops\/staging-pair-fixture\.mjs/);
    for (const invocation of ["fixture-controller seed", "fixture-controller assert v1", "fixture-controller mutate v2", "fixture-controller kill-reader-lock", "fixture-controller corrupt-graph-version v99"]) {
      expect(harness, invocation).toContain(`run --rm ${invocation}`);
    }
  });

  it("makes /app itself writable by the image's runtime user, without widening anything else", () => {
    // The measured failure (runtime 5, `service-maintenance.log:17`): `next dev` died with
    // `EACCES: permission denied, open '/app/next-env.d.ts'`. It CREATES that file at startup, which
    // needs write permission on the DIRECTORY — and `WORKDIR` creates `/app` as root before the
    // `USER` switch, while `COPY --chown` only sets ownership on what it copies. So the contents
    // were owned by `node` and the directory was not.
    const dockerfile = readFileSync("docker/staging-ops.Dockerfile", "utf8");
    // The negative assertions are about INSTRUCTIONS. The comment explaining this fix necessarily
    // names the things it rules out, and a check that cannot tell a rule from its own rationale
    // would fail for writing the rationale down.
    const instructions = dockerfile.replace(/^\s*#.*$/gm, "");
    expect(instructions).toMatch(/chown node:node \/app\b/);
    // Scoped: this directory and `.next` only. No recursive chown of `/app`, no `chmod 777`, and the
    // container still runs as `node` — the fix must not become a permissions amnesty.
    expect(instructions).not.toMatch(/chown\s+-R/);
    expect(instructions).not.toMatch(/chmod\s+(-R\s+)?777/);
    expect(instructions).not.toMatch(/^\s*USER\s+root/m);
    expect(dockerfile).toContain("USER node");
    expect(dockerfile.indexOf("chown node:node /app"), "ownership must be set before the USER switch")
      .toBeLessThan(dockerfile.indexOf("USER node"));
    // This is the HARNESS image. The production Dockerfile is a different file and is untouched —
    // it does not run `next dev` and never had this failure.
    expect(dockerfile).toContain("FROM node:20-bookworm-slim");
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

  it("exercises recovery from a REAL aborted transaction, not only from a JavaScript throw", () => {
    // `after-postgres`/`after-graph` throw in JS, so recovery starts on a perfectly usable session —
    // they pin the ORDERING of `resetSessionTransactionState` and can never show it working. The
    // scenario below leaves the importer's own lock-owning session in 25P02 and requires the whole
    // two-store recovery to complete through it.
    expect(harness).toContain("STAGING_FAULT_POINT=after-graph-sql-abort");
    expect(harness).toContain("require_receipt sql-abort-recovers candidate-observed");
    expect(harness).toContain('"sqlstate":"22012"');
    expect(harness).toContain('"transactionAborted":true');
    // Both stores held the CANDIDATE before the abort, so the restore of the prior pair is a real
    // two-store undo rather than "nothing had been replaced yet".
    expect(harness).toContain('"pgVersion":"v4".*"graphVersions":"v4"');
    expect(harness).toContain('require_receipt sql-abort-recovers prior-pair-restored');
    // Same session, still fenced, at BOTH reset checkpoints — a reconnect recovers just as visibly
    // while silently dropping the advisory locks.
    expect(harness).toContain('"checkpoint":"install-reset".*"coordinatorLockHeld":true.*"exclusiveDataLockHeld":true');
    expect(harness).toContain('"checkpoint":"rollback-reset".*"coordinatorLockHeld":true');
    expect(harness).toContain("recovery did not stay on ONE backend");
    expect(harness).toContain('require_journal state ready "staging is serving again after the aborted-transaction fault"');
  });

  it("has a session-continuity assertion that can actually read a receipt log — and refuse one", () => {
    // A parser that matches nothing reports "saw 0 receipts", which is indistinguishable from a run
    // that emitted none, and would fail the lane for the wrong reason forever. The regex is lifted
    // out of the harness itself (not restated) so the two cannot drift apart, then run against the
    // exact receipt shape `emitReceipt` produces.
    const literal = /matchAll\((\/.*\/g)\)/.exec(harness)?.[1];
    expect(literal, "the harness must still embed the continuity regex").toBeTruthy();
    const pattern = () => new RegExp(literal!.slice(1, -2), "g");
    const line = (kind: string, fields: Record<string, unknown>) => `staging-ops-receipt ${kind} ${JSON.stringify(fields)}`;
    const log = (pid: number, lastPid = pid) => [
      "importer: installing candidate run-4",
      line("candidate-observed", { runId: "run-4", backendPid: pid, pgVersion: "v4", graphVersions: "v4" }),
      line("graph-restored", { runId: "run-4", kind: "source", nodes: 8, relationships: 9 }),
      line("fault-injected", { point: "after-graph-sql-abort", runId: "run-4", sqlstate: "22012", backendPid: pid, transactionAborted: true }),
      line("session-continuity", { checkpoint: "install-reset", failedRunId: "run-4", backendPid: pid, coordinatorLockHeld: true, exclusiveDataLockHeld: true }),
      line("session-continuity", { checkpoint: "rollback-reset", failedRunId: "run-4", backendPid: lastPid, coordinatorLockHeld: true, exclusiveDataLockHeld: false }),
      line("prior-pair-restored", { failedRunId: "run-4", priorRunId: "run-3", postgres: true, graph: true, ready: true }),
    ].join("\n");

    const pids = (text: string) => [...text.matchAll(pattern())].map((match) => JSON.parse(match[1]).backendPid);
    expect(pids(log(417))).toEqual([417, 417, 417, 417]);
    // The refusal it exists for: a reconnect recovers just as visibly while dropping the advisory
    // locks, and shows up only as a different backend.
    expect(new Set(pids(log(417, 923))).size).toBe(2);
    // And a log with no receipts at all is 0, not 4 — so "saw N" can never be mistaken for a pass.
    expect(pids("importer: nothing happened")).toEqual([]);
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
