import { readFileSync } from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertNotCancelled,
  installObject,
  preservesCapturedStagingCredentials,
  runPollingDaemon,
  waitForAbortableInterval,
} from "../scripts/staging-ops/importer.mjs";
import { createSessionWatchdogOwner, createOperationBudget } from "../scripts/staging-ops/operation-deadline.mjs";
import { beginBootstrapDraining, bootstrapResumeVerdict } from "../scripts/staging-ops/journal.mjs";
import {
  createSignedEncryptedBundle,
  openSignedEncryptedBundle,
  rollbackOpeningProvenance,
} from "../scripts/staging-ops/bundle-crypto.mjs";
import { loaderCapabilityIdentity } from "../scripts/staging-ops/build-identity.mjs";

/**
 * The corrections from the frozen-14ead2be review that turn on a decision rather than on a whole
 * two-store lifecycle. Each one is exercised at the tier where its failure actually lives; where a
 * property genuinely needs the real stores, that is said so out loud rather than approximated by a
 * test that would pass either way.
 */

const SHA = "a".repeat(40);
const IMPORTER_SOURCE = readFileSync("scripts/staging-ops/importer.mjs", "utf8");

// ── HIGH-1: cancellation is observed BEFORE new work, and recovery is not poisoned by it ─────────

describe("HIGH-1 — a shutdown signal stops new destructive work and nothing else", () => {
  afterEach(() => vi.unstubAllGlobals());

  const abortedSignal = () => {
    const controller = new AbortController();
    controller.abort(Object.assign(new Error("importer received SIGTERM"), { code: "STAGING_OPERATION_ABORTED" }));
    return controller.signal;
  };

  it("refuses a pre-aborted install before it reads the source, locks, or touches maintenance", async () => {
    // The traced defect: the abort signal was consumed only inside `runBoundedProcess`, so the
    // FIRST thing that observed a SIGTERM was `pg_restore --list` — by which point staging had been
    // drained, both services stopped and the exclusive lock taken. So the assertions here are about
    // what did NOT happen: no source read, no coordinator lock, no journal write, no stop.
    const verifyAndPinSourceBundle = vi.fn();
    const acquireCoordinatorLock = vi.fn();
    const readJournal = vi.fn();
    const recordSourceAttempt = vi.fn();
    const client = { query: vi.fn() };
    const maintenance = {
      stopAndVerifyAll: vi.fn(),
      deployApp: vi.fn(),
      assertPinnedRunnerConfiguration: vi.fn(),
      tokenIdentity: vi.fn(),
      listActiveDeployments: vi.fn(),
    };

    await expect(installObject({
      client, objectId: `run-1--${"b".repeat(64)}`, sourceStore: {}, rollbackStore: {}, maintenance,
      env: {} as NodeJS.ProcessEnv,
      operations: { signal: abortedSignal(), verifyAndPinSourceBundle, acquireCoordinatorLock, readJournal, recordSourceAttempt },
    })).rejects.toMatchObject({ code: "STAGING_OPERATION_ABORTED" });

    expect(verifyAndPinSourceBundle, "the source object was read after cancellation").not.toHaveBeenCalled();
    expect(acquireCoordinatorLock, "the coordinator lock was taken after cancellation").not.toHaveBeenCalled();
    expect(readJournal).not.toHaveBeenCalled();
    expect(recordSourceAttempt).not.toHaveBeenCalled();
    expect(client.query, "a journal statement ran after cancellation").not.toHaveBeenCalled();
    for (const [name, spy] of Object.entries(maintenance)) {
      expect(spy, `maintenance.${name} was called after cancellation`).not.toHaveBeenCalled();
    }
  });

  it("names the operation it refused, and passes a live signal straight through", () => {
    // The predicate itself, both ways: a refusal that could not distinguish "cancelled" from any
    // other failure would send an operator to the wrong place, and one that fired on a healthy
    // signal would make the daemon unable to do anything at all.
    const controller = new AbortController();
    expect(assertNotCancelled(controller.signal, "staging source install")).toBe(false);
    expect(assertNotCancelled(undefined, "staging source install")).toBe(false);
    controller.abort();
    expect(() => assertNotCancelled(controller.signal, "destructive staging install admission"))
      .toThrow(/destructive staging install admission refused/);
  });

  it("gives RECOVERY a fresh scope that an already-aborted shutdown cannot poison", async () => {
    // The second half of the same failure. Recovery runs precisely because the operation before it
    // failed, and an external SIGTERM is one of the ways it fails — so a recovery signal derived
    // from the shutdown signal is aborted from birth, every recovery subprocess aborts on spawn, and
    // the rollback that was supposed to put staging back never runs.
    const shutdown = new AbortController();
    const owner = createSessionWatchdogOwner(() => {}, { signal: shutdown.signal });
    const action = owner.arm(createOperationBudget("action", 60_000));
    shutdown.abort(new Error("importer received SIGTERM"));

    // The owned action DOES observe it — that is how in-flight work is cancelled.
    expect(action.signal.aborted, "the in-flight operation ignored the shutdown").toBe(true);

    const recovery = await owner.transferTo(createOperationBudget("recovery", 60_000));
    expect(recovery.signal.aborted, "recovery inherited the already-aborted shutdown signal").toBe(false);
    // Transfer is a transfer: the action's timer is retired, so nothing races the recovery budget.
    expect(owner.size).toBe(1);
    await recovery.disarm();
  });

  it("still cancels recovery at ITS OWN deadline — a fresh scope is not an unbounded one", async () => {
    const owner = createSessionWatchdogOwner(() => {}, { signal: new AbortController().signal });
    const recovery = await owner.transferTo(createOperationBudget("recovery", 50));
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(recovery.signal.aborted, "the recovery budget never cancelled its owned work").toBe(true);
    await recovery.disarm();
  });

  it("leaves the poll loop promptly when the shutdown arrives while it is IDLE", async () => {
    // BEHAVIOURAL, against the loop the CLI actually runs. The traced defect was a bare `setTimeout`
    // the shutdown could not interrupt: a SIGTERM delivered between ticks was not acted on for up to
    // five more minutes. The interval here is a minute and the assertion is that the loop returns in
    // a fraction of it — a regression to an uninterruptible sleep fails on the test timeout rather
    // than passing slowly.
    const shutdown = new AbortController();
    const ticks: number[] = [];
    const loop = runPollingDaemon({ tick: async () => { ticks.push(Date.now()); }, intervalMs: 60_000, signal: shutdown.signal });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const abortedAt = Date.now();
    shutdown.abort();
    await expect(loop).resolves.toEqual({ status: "stopped", reason: "signal" });
    expect(Date.now() - abortedAt, "the idle wait slept through the shutdown").toBeLessThan(2_000);
    // …and it admitted no new work on the way out. One tick ran, before the signal.
    expect(ticks).toHaveLength(1);
  }, 10_000);

  it("admits NO further tick when the shutdown lands during one", async () => {
    // The other half, and the reason the loop condition is re-checked AFTER the wait rather than
    // only before it: a signal that arrives mid-tick must not be followed by one more drain window.
    const shutdown = new AbortController();
    let calls = 0;
    const loop = runPollingDaemon({
      tick: async () => { calls += 1; shutdown.abort(); },
      intervalMs: 60_000, signal: shutdown.signal,
    });
    await expect(loop).resolves.toEqual({ status: "stopped", reason: "signal" });
    expect(calls, "the daemon started another tick after it had been told to stop").toBe(1);
  }, 10_000);

  it("treats a cancellation refusal as the stop it is, and an ordinary tick failure as a retry", async () => {
    // `installObject` refuses new destructive work under cancellation BY DESIGN, so logging that as
    // "tick failed" would report every clean shutdown as an error. An ordinary failure is the
    // opposite: it is logged and the daemon keeps polling.
    const shutdown = new AbortController();
    const logged: string[] = [];
    await runPollingDaemon({
      tick: async () => {
        shutdown.abort();
        throw Object.assign(new Error("importer received SIGTERM"), { code: "STAGING_OPERATION_ABORTED" });
      },
      intervalMs: 60_000, signal: shutdown.signal, log: (message) => logged.push(message),
    });
    expect(logged, "a coordinated shutdown was reported as a tick failure").toEqual([]);

    const second = new AbortController();
    let calls = 0;
    await runPollingDaemon({
      tick: async () => { calls += 1; if (calls >= 2) second.abort(); throw new Error("source discovery failed"); },
      intervalMs: 1, signal: second.signal, log: (message) => logged.push(message),
    });
    expect(calls, "an ordinary tick failure ended the daemon").toBe(2);
    expect(logged).toHaveLength(2);
    expect(logged[0]).toMatch(/staging importer tick failed: source discovery failed/);
  }, 10_000);

  it("ENDS on a fatal error rather than logging it and waiting five minutes", async () => {
    // The daemon's own budget breach and a dead connection cannot be retried by the next tick, so
    // they leave the loop. The CLI supplies both conditions.
    await expect(runPollingDaemon({
      tick: async () => { throw Object.assign(new Error("importer deadline exceeded"), { code: "STAGING_OPERATION_TIMEOUT" }); },
      intervalMs: 60_000, signal: new AbortController().signal,
      isFatal: (error: unknown) => (error as { code?: string })?.code === "STAGING_OPERATION_TIMEOUT",
    })).rejects.toThrow(/importer deadline exceeded/);
    expect(IMPORTER_SOURCE, "the CLI must still supply both fatal conditions")
      .toContain('isFatal: (error) => error?.code === "STAGING_OPERATION_TIMEOUT" || Boolean(client.connection?.stream?.destroyed)');
  }, 10_000);

  it("does not accumulate one abort listener per tick for the life of the daemon", () => {
    // A five-minute daemon that never leaves the loop registers one listener per idle wait. The
    // timer path must unregister too, not only the abort path.
    const observed = { aborted: false, added: 0, removed: 0 };
    const signal = {
      get aborted() { return observed.aborted; },
      addEventListener: () => { observed.added += 1; },
      removeEventListener: () => { observed.removed += 1; },
    } as unknown as AbortSignal;
    return waitForAbortableInterval(1, signal).then((reason) => {
      expect(reason).toBe("interval");
      expect(observed.added).toBe(1);
      expect(observed.removed, "the timer path left its abort listener attached").toBe(1);
    });
  });

  it("is the loop the CLI actually runs, with the five-minute floor still enforced there", () => {
    // Pinning the FUNCTION is not pinning the DAEMON: an extraction whose call site was deleted
    // leaves every test above green while the CLI sleeps through signals exactly as before.
    expect(IMPORTER_SOURCE).toContain("return await runPollingDaemon({");
    expect(IMPORTER_SOURCE, "the daemon must poll under the process shutdown signal, not a fresh one")
      .toContain("tick, intervalMs: interval, signal: shutdown.signal,");
    // The floor is an operator-facing validation and stays at the CLI — the loop takes whatever
    // interval it is given, which is how a test observes a whole cycle in milliseconds.
    expect(IMPORTER_SOURCE).toContain('throw new Error("importer poll interval must be at least five minutes")');
    expect(IMPORTER_SOURCE, "the idle wait must not be an uninterruptible sleep")
      .not.toMatch(/await new Promise\(\(resolve\) => setTimeout\(resolve, interval\)\)/);
  });

  it("refuses a manual rollback of a READY pair under cancellation, and only a ready one", () => {
    // Same structural caveat. The distinction is the whole point: from `ready` this rollback drains
    // a healthy serving pair, which a shutdown may never start; from any other state it is the
    // recovery of an already-fenced run, which a shutdown may never withhold.
    expect(IMPORTER_SOURCE).toContain('if (journal.state === "ready") assertNotCancelled(shutdown.signal, "manual rollback of a ready staging pair");');
  });
});

// ── M6: ready is a commit boundary, and the assert after it must not unwind a serving pair ───────

describe("M6 — the ready commit is recorded before the next fallible assert", () => {
  /**
   * A SOURCE-ORDER guard, and COMPLEMENTARY now rather than the whole coverage: the install path's
   * behaviour — a budget expiring immediately after the ready commit produces a
   * `ready-bookkeeping-pending` receipt, no rollback and no second drain — is exercised through the
   * real orchestration in `test/staging-ready-commit-boundary.test.ts`.
   *
   * What this still earns its place for is the RECOVERY path, which has the same boundary and no
   * behavioural test, and the fact that the defect was exactly an ordering: `markReady` had already
   * committed and the deployment was verified serving, but `readyCommitted` was still null when the
   * assert threw, so the catch drained the pair it had just installed.
   */
  it.each([
    // The boot CALL is spelled differently on the two paths — the install path goes through the
    // `bootExact` injection seam, the recovery path calls the import. Naming the right one per path
    // matters: searching for the import on the install path silently finds the RECOVERY path's call
    // far above and the guard then passes while measuring the wrong boundary entirely.
    ["install", 'operationBudget.assert("ready reconciliation")', "await boot({"],
    ["recovery", 'recoveryBudget.assert("recovery ready bookkeeping")', "await bootExact({"],
  ])("assigns readyCommitted before the %s path's post-ready assert", (_path, label, bootCall) => {
    const assertion = IMPORTER_SOURCE.indexOf(label);
    expect(assertion, `${label} is gone; this guard no longer covers anything`).toBeGreaterThan(-1);
    const assign = IMPORTER_SOURCE.lastIndexOf("readyCommitted = booted.ready;", assertion);
    expect(assign, "no readyCommitted assignment precedes the post-ready assert").toBeGreaterThan(-1);
    // …and the assignment belongs to THIS boundary, not to a distant earlier one: the boot must sit
    // between them.
    const boot = IMPORTER_SOURCE.lastIndexOf(bootCall, assign);
    expect(boot, `${bootCall} is gone; this guard no longer identifies its own boundary`).toBeGreaterThan(-1);
    expect(assign).toBeGreaterThan(boot);
    expect(assign).toBeLessThan(assertion);
  });
});

// ── AC-06 / item 4: only a validated full staging checkpoint keeps its captured credentials ──────

describe("AC-06 — the captured-credential exception is selected by provenance, not by a claim", () => {
  const signing = generateKeyPairSync("ed25519");
  const encryption = generateKeyPairSync("rsa", { modulusLength: 2048 });

  /** An opened pair exactly as the importer builds one, with real provenance when asked for. */
  const opened = (manifest: Record<string, unknown>, { authenticated = false } = {}) => {
    const bundle = createSignedEncryptedBundle({
      payload: Buffer.from("payload"), manifest,
      exporterSigningPrivateKey: signing.privateKey, importerEncryptionPublicKey: encryption.publicKey,
    });
    const result = openSignedEncryptedBundle({
      bundle, exporterSigningPublicKey: signing.publicKey, importerEncryptionPrivateKey: encryption.privateKey,
      signerPurpose: authenticated ? "rollback" : "source",
    });
    return { ...result, sourceProvenance: rollbackOpeningProvenance(result) };
  };

  it("preserves captured credentials for a full checkpoint opened with the importer rollback key", () => {
    const checkpoint = opened({ kind: "staging-rollback", databaseMode: "full", runId: "bootstrap-1" }, { authenticated: true });
    expect(preservesCapturedStagingCredentials(checkpoint)).toBe(true);
  });

  it.each([
    ["a SOURCE bundle that forges kind and databaseMode", { kind: "staging-rollback", databaseMode: "full", runId: "run-1" }, false],
    ["a source bundle that forges databaseMode only", { kind: "paired", databaseMode: "full", runId: "run-1" }, false],
  ] as const)("refuses the exception to %s", (_label, manifest, expected) => {
    // The load-bearing negative. `kind` and `databaseMode` are signed manifest CLAIMS, so on their
    // own a forged source manifest would take the whole-database restore path AND skip the tester
    // reapply — installing unsanitized credentials and calling it a baseline. The third term is not
    // a claim: the provenance token is minted only by an open that verified the importer-owned
    // rollback signing key, and a manifest cannot spell it.
    expect(preservesCapturedStagingCredentials(opened(manifest))).toBe(expected);
  });

  it("refuses the exception to an authenticated rollback that is NOT full mode", () => {
    // A sanitized staging rollback checkpoint is a re-sealed source payload: its tester credentials
    // must be reapplied strictly, exactly like the source install it came from.
    const sanitized = opened({ kind: "staging-rollback", databaseMode: "sanitized", runId: "run-2" }, { authenticated: true });
    expect(preservesCapturedStagingCredentials(sanitized)).toBe(false);
  });

  it("refuses a hand-built lookalike provenance value", () => {
    for (const sourceProvenance of [{ kind: "staging-rollback" }, { authenticated: true }, true, "full", null]) {
      expect(preservesCapturedStagingCredentials({
        manifest: { kind: "staging-rollback", databaseMode: "full" }, sourceProvenance,
      })).toBe(false);
    }
  });

  it("wires that ONE predicate to both the restore shape and the credential handling", () => {
    // If the restore path and the tester decision were computed separately they could disagree about
    // what a pair is — which is how a forged `databaseMode: full` reached `restoreRollbackPostgres`
    // in the first place.
    expect(IMPORTER_SOURCE).toContain("const fullStagingCheckpoint = preservesCapturedStagingCredentials(opened);");
    expect(IMPORTER_SOURCE).toContain("if (fullStagingCheckpoint) await restoreRollbackPostgres(");
    expect(IMPORTER_SOURCE).toContain("await reapplyTesters(env,");
    expect(IMPORTER_SOURCE, "the tester reapply must not be reachable for a full checkpoint")
      .not.toMatch(/databaseMode === "full"\) await restoreRollbackPostgres/);
  });
});

// ── M7: the first bootstrap record and its drain transition are one statement ────────────────────

describe("M7 — the bootstrap record and the draining transition land together or not at all", () => {
  const fields = {
    runId: "bootstrap-2026-09-08T04-00-00-000Z", deploymentId: "dep-baseline", commit: SHA,
    mode: "legacy-pg-only", environmentId: "env-staging", appServiceId: "service-app",
    from: ["failed"],
  };

  it("issues exactly ONE statement carrying both the record and the state", async () => {
    // The window this closes: `bootstrapResumeVerdict` requires the record's run to equal the
    // journal's current run, which only the transition establishes. Written as two statements, a
    // kill between them left a recorded bootstrap that every later run refused with nothing stopped
    // and no command able to clear it.
    const query = vi.fn(async () => ({ rows: [{ state: "draining" }] }));
    await beginBootstrapDraining({ query }, fields);
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, values] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toMatch(/state='draining'/);
    expect(sql).toMatch(/bootstrap_run_id=\$1/);
    expect(sql).toMatch(/run_id=\$1/);
    expect(sql).toMatch(/bootstrap_phase='stopping'/);
    // The run identity written into BOTH columns is the same parameter, so they cannot diverge.
    expect(values[0]).toBe(fields.runId);
  });

  it("still refuses from a state the caller did not admit", async () => {
    // Atomicity must not become permission: an UPDATE matching no row is a refusal, not a silent no-op.
    const query = vi.fn(async () => ({ rows: [] }));
    await expect(beginBootstrapDraining({ query }, fields)).rejects.toThrow(/refused from the current journal state/);
  });

  it.each([
    ["an inexact baseline commit", { commit: "abc" }, /exact measured deployment commit/],
    ["a missing measured deployment", { deploymentId: null }, /measured deployment and its pinned/],
    ["no pinned environment", { environmentId: "" }, /measured deployment and its pinned/],
    ["no admitted source states", { from: [] }, /states it may proceed from/],
  ] as const)("validates before issuing any statement when there is %s", async (_label, over, reason) => {
    const query = vi.fn();
    await expect(beginBootstrapDraining({ query }, { ...fields, ...over })).rejects.toThrow(reason);
    expect(query, "a malformed record still reached the database").not.toHaveBeenCalled();
  });
});

// ── HIGH-2: an ordinary bootstrap failure stays resumable, and a resume re-proves the stop ───────

describe("HIGH-2 — a bootstrap that failed ordinarily can be retried to ready", () => {
  const record = (over: Record<string, unknown> = {}) => ({
    run_id: "bootstrap-1", state: "failed", last_safe_checkpoint: "bootstrap-failed-prior-restored",
    bootstrap_run_id: "bootstrap-1", bootstrap_phase: "stopping", bootstrap_deployment_id: "dep-baseline",
    bootstrap_commit: SHA, bootstrap_mode: "copy-ready",
    bootstrap_environment_id: "env-staging", bootstrap_app_service_id: "service-app",
    ...over,
  });
  const env = { RAILWAY_ENVIRONMENT_ID: "env-staging", STAGING_APP_SERVICE_ID: "service-app" } as NodeJS.ProcessEnv;

  it("resumes a record whose journal is FAILED — the state an ordinary failure leaves", () => {
    // The retained record is deliberately not cleared by the ordinary-failure path, and
    // `clearBootstrapRecovery` requires `ready`, so `failed` is the state a documented re-run meets.
    // A verdict that keyed on `draining` would refuse the very retry the runbook prescribes.
    expect(bootstrapResumeVerdict(record(), env)).toMatchObject({ resume: true, runId: "bootstrap-1", phase: "stopping" });
    expect(bootstrapResumeVerdict(record({ state: "draining" }), env).resume).toBe(true);
    expect(bootstrapResumeVerdict(record({ state: "booting" }), env).resume).toBe(true);
  });

  it("re-enters draining and re-verifies the stop BEFORE taking the exclusive lock", () => {
    // Structural, and COMPLEMENTARY: the behaviour needs a live fenced app, and the paired harness
    // now owns it — `bootstrap-after-stop-throw` fails a resume ordinarily so its catch redeploys
    // the baseline, and the following retry has to stop a genuinely serving pair before it can take
    // the exclusive lock (`scripts/staging-pair-isolated.sh`, checked by
    // `scripts/staging-ops/assert-bootstrap-resume-order.mjs`). What THIS pins is the ordering the
    // defect violated — the resume branch used to take the exclusive lock directly, so a retry after
    // an ordinary failure met the baseline the failure had just REDEPLOYED, timed out on the lock,
    // and could never reach `booting`.
    const branch = IMPORTER_SOURCE.slice(
      IMPORTER_SOURCE.indexOf("if (verdict.resume) {"),
      IMPORTER_SOURCE.indexOf("} else {", IMPORTER_SOURCE.indexOf("if (verdict.resume) {")),
    );
    expect(branch, "the resume branch no longer exists in the shape this guard reads").toContain("resume-interrupted-bootstrap");
    const drain = branch.indexOf('to: "draining"');
    const stop = branch.indexOf("maintenance.stopAndVerifyAll()");
    const lock = branch.indexOf("acquireExclusiveDataUseLock");
    expect(drain, "a resume no longer re-enters draining").toBeGreaterThan(-1);
    expect(stop, "a resume no longer re-verifies the stop").toBeGreaterThan(-1);
    expect(lock).toBeGreaterThan(-1);
    expect(drain).toBeLessThan(stop);
    expect(stop).toBeLessThan(lock);
    // The states a resume may re-enter draining from are exactly the ones an interruption or an
    // ordinary failure can leave.
    expect(branch).toContain('from: ["draining", "booting", "failed"]');
  });

  it("gates the ordinary-failure fault on the harness, on BOTH bootstrap branches", () => {
    // The fault that makes the harness scenario possible is an injected THROW, so unlike a SIGKILL
    // it could in principle fire on a real runner. It must therefore be unreachable without
    // `STAGING_PAIR_REQUIRED=1` — the same gate every other fault point carries — and it must sit
    // after the verified stop on both branches, or the resume half of the scenario is untestable.
    const fault = IMPORTER_SOURCE.slice(IMPORTER_SOURCE.indexOf("function bootstrapOrdinaryFailureFault("));
    expect(fault.slice(0, 400)).toContain('env.STAGING_PAIR_REQUIRED !== "1"');
    expect(fault.slice(0, 400)).toContain('env.STAGING_FAULT_POINT !== "bootstrap-after-stop-throw"');
    // `runId` is shorthand on the non-resume branch (`{ runId, resumed: false }`) and explicit on the
    // resume branch (`{ runId: bootstrapRunId, … }`), because each branch names a different identity.
    // A pattern that admitted only the explicit form matched ONE call and read as "the fault is
    // missing from a branch" — the guard failing on production code that is correct.
    const calls = [...IMPORTER_SOURCE.matchAll(/bootstrapOrdinaryFailureFault\(env, \{ runId(?:: \w+)?, resumed: (true|false) \}\)/g)];
    expect(calls.map((call) => call[1]).sort(), "the fault must sit on both bootstrap branches").toEqual(["false", "true"]);
    // …and inside its branch's stop→lock window, so a failed attempt can never be what blocks the
    // retry. "Some acquisition appears later in the file" would be satisfied by the OTHER branch's,
    // which is why the span between the two is required to contain no further stop.
    for (const call of calls) {
      const acquire = IMPORTER_SOURCE.indexOf("await acquireExclusiveDataUseLock(client, env,", call.index!);
      expect(acquire, "no exclusive-lock acquisition follows the fault at all").toBeGreaterThan(-1);
      expect(IMPORTER_SOURCE.slice(call.index!, acquire), "the fault belongs to a different branch than the lock that follows it")
        .not.toContain("stopAndVerifyAll");
    }
  });

  it("accepts the resumed run's original identity at the boot transition", () => {
    // The other half of "retry reaches ready with the ORIGINAL identity": the boot transition must
    // admit the state the resume put the journal into, for the run the record names.
    expect(IMPORTER_SOURCE).toContain('await transitionJournal(client, { runId: bootstrapRunId, from: ["draining", "booting"], to: "booting"');
  });
});

// ── L10: withdraw only the attempt record THIS invocation created ────────────────────────────────

describe("L10 — a pre-drain failure withdraws only its own attempt record", () => {
  afterEach(() => vi.unstubAllGlobals());

  const OBJECT_ID = `run-9--${"c".repeat(64)}`;

  /** A lock-owning session double that satisfies the live destination proof and nothing more. */
  const fakeClient = (onUpdate: () => void = () => {}) => ({
    connectionParameters: { host: "staging-pg.railway.internal", port: 5432, database: "brain", user: "app" },
    connection: { stream: { remoteAddress: "10.0.0.7" } },
    query: vi.fn(async (sql: string) => {
      const text = String(sql);
      if (text.includes("inet_server_addr")) {
        return { rows: [{ database: "brain", server_address: "10.0.0.7", server_port: 5432, backend_pid: 41 }] };
      }
      if (text.includes("UPDATE staging_ops.refresh_journal")) { onUpdate(); }
      return { rows: [{}] };
    }),
  });

  const ENV = {
    STAGING_MAINTENANCE_ADAPTER: "local",
    DATABASE_URL: "postgres://app:pass@staging-pg.railway.internal:5432/brain",
    LOCAL_MAINTENANCE_URL: "http://maintenance:8080",
    RAILWAY_STAGING_MAINTENANCE_TOKEN: "token",
    STAGING_OPS_ENVIRONMENT_ID: "staging-local",
    STAGING_APP_SERVICE_ID: "app-local",
    STAGING_GRAPHITI_SERVICE_ID: "graphiti-local",
    STAGING_IMPORTER_SERVICE_ID: "importer-local",
    STAGING_IMPORTER_IMAGE_DIGEST: `sha256:${"d".repeat(64)}`,
  } as unknown as NodeJS.ProcessEnv;

  const opened = {
    manifest: {
      runId: "run-9", captureEndedAt: "2026-09-08T00:00:00.000Z",
      build: { ...loaderCapabilityIdentity(), applicationCommit: SHA, schemaFingerprint: "c".repeat(64) },
    },
    digest: "c".repeat(64), objectId: OBJECT_ID, kind: "source",
  };

  const journal = {
    state: "ready", run_id: "prior-run", last_ready_run_id: "prior-run",
    last_safe_checkpoint: "ready", source_watermark: null, rollback_target_run_id: null,
  };

  /**
   * @param failAt `pin` = before the attempt record is written; `drain` = after it is written.
   */
  const runInstall = async ({ priorAttempt, failAt }: { priorAttempt: unknown; failAt: "pin" | "drain" }) => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ commit: SHA })));
    const withdrawSourceAttempt = vi.fn(async () => true);
    const recordSourceAttempt = vi.fn(async () => ({ object_id: OBJECT_ID }));
    const client = fakeClient(() => { if (failAt === "drain") throw new Error("injected drain refusal"); });
    const maintenance = {
      assertPinnedRunnerConfiguration: vi.fn(async () => {
        if (failAt === "pin") throw new Error("injected pinned-runner refusal");
        return true;
      }),
      stopAndVerifyAll: vi.fn(),
      tokenIdentity: vi.fn(async () => ({ environmentId: "staging-local" })),
    };
    const outcome = await installObject({
      client, objectId: OBJECT_ID, sourceStore: {}, rollbackStore: {}, maintenance, env: ENV,
      operations: {
        verifyAndPinSourceBundle: async () => opened,
        compareEnvironmentCredentials: () => true,
        acquireCoordinatorLock: async () => true,
        releaseCoordinatorLock: async () => true,
        readJournal: async () => journal,
        openPrior: async () => ({ manifest: { runId: "prior-run" }, kind: "rollback" }),
        readSourceAttempt: async () => priorAttempt,
        recordSourceAttempt, withdrawSourceAttempt,
      },
    }).then(() => null, (error: Error) => error);
    return { outcome, withdrawSourceAttempt, recordSourceAttempt, maintenance };
  };

  it("withdraws when this invocation created the record and the drain never completed", async () => {
    // The case the withdrawal exists for: a pre-drain environment fault the next tick would have
    // handled by itself, with no outage either way, must not cost an operator round trip.
    const { outcome, withdrawSourceAttempt, recordSourceAttempt, maintenance } =
      await runInstall({ priorAttempt: null, failAt: "drain" });
    expect(outcome, "the injected drain refusal must reach the caller").toBeInstanceOf(Error);
    expect(recordSourceAttempt).toHaveBeenCalledTimes(1);
    expect(withdrawSourceAttempt).toHaveBeenCalledWith(expect.anything(), OBJECT_ID);
    expect(maintenance.stopAndVerifyAll, "nothing may be stopped on a pre-drain failure").not.toHaveBeenCalled();
  });

  it("KEEPS an attempt record left by an earlier killed automatic worker", async () => {
    // The defect: the withdrawal deleted any row in `attempted`, including one this invocation only
    // incremented. That row is the evidence automatic refusal is built on, so deleting it hands the
    // candidate straight back to the unattended drain loop it exists to stop.
    const { outcome, withdrawSourceAttempt, recordSourceAttempt } = await runInstall({
      priorAttempt: { object_id: OBJECT_ID, status: "attempted", attempts: 1 }, failAt: "drain",
    });
    expect(outcome).toBeInstanceOf(Error);
    expect(recordSourceAttempt).toHaveBeenCalledTimes(1);
    expect(withdrawSourceAttempt, "a prior worker's attempt evidence was withdrawn").not.toHaveBeenCalled();
  });

  it("withdraws nothing when the failure preceded the record entirely", async () => {
    // There is nothing of this invocation's to withdraw, and a blanket delete would take a prior
    // record with it.
    const { outcome, withdrawSourceAttempt, recordSourceAttempt } =
      await runInstall({ priorAttempt: null, failAt: "pin" });
    expect(outcome).toBeInstanceOf(Error);
    expect(recordSourceAttempt).not.toHaveBeenCalled();
    expect(withdrawSourceAttempt).not.toHaveBeenCalled();
  });

  it("leaves a prior FAILED record alone when the failure preceded the record", async () => {
    const { outcome, withdrawSourceAttempt } = await runInstall({
      priorAttempt: { object_id: OBJECT_ID, status: "failed", attempts: 2 }, failAt: "pin",
    });
    expect(outcome).toBeInstanceOf(Error);
    expect(withdrawSourceAttempt).not.toHaveBeenCalled();
  });
});
