import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bootExact, installObject, waitForImportedBoot } from "../scripts/staging-ops/importer.mjs";
import { createOperationBudget, createSessionWatchdogOwner } from "../scripts/staging-ops/operation-deadline.mjs";
import { loaderCapabilityIdentity } from "../scripts/staging-ops/build-identity.mjs";
import { parseReceipts } from "../scripts/staging-ops/receipts.mjs";

/**
 * LATE CANCELLATION DURING CANDIDATE BOOT (`adjudication-47c3-late-cancel.md`).
 *
 * The defect: `bootExact` took no signal and no budget. `pollDeployedHealth` consulted only its own
 * per-fetch timeout and swallowed every fetch failure, so a SIGTERM delivered while a successful
 * boot health response was in flight neither ended the poll nor prevented `markReady` — the
 * candidate was committed ready and the outer `finally` then reported the run as aborted.
 *
 * These tests reach the REAL health acceptance and ready boundary: the production
 * `pollDeployedHealth`/`waitForImportedBoot`/`bootExact` run, with only the transports substituted
 * (an injected/stubbed `fetch`, the maintenance adapter, the Postgres client). No test injects a
 * `bootExact` that throws before the boundary — that would establish nothing about this defect.
 */

const COMMIT = "c".repeat(40);
const IMPORTER_SOURCE = readFileSync("scripts/staging-ops/importer.mjs", "utf8");

/** The abort a real SIGTERM produces — `recordSignalAbort`'s exact reason shape. */
const sigterm = () => Object.assign(new Error("importer received SIGTERM"), { code: "STAGING_OPERATION_ABORTED" });

const BOOTED = { booted: true, commit: COMMIT };

/** A probe whose response is HELD until the test releases it, after the cancellation. */
function heldProbe(body: unknown = BOOTED, status = 202) {
  let release!: () => void;
  let observe!: () => void;
  const inFlight = new Promise<void>((resolve) => { observe = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const fetchImpl = vi.fn(async () => { observe(); await gate; return Response.json(body, { status }); });
  return { fetchImpl, inFlight, release };
}

const maintenance = (over: Record<string, unknown> = {}) => ({
  readDeployment: vi.fn(async () => ({ id: "dep-1", status: "SUCCESS" })),
  deployApp: vi.fn(async () => "dep-1"),
  stopAndVerifyAll: vi.fn(async () => {}),
  assertPinnedRunnerConfiguration: vi.fn(async () => {}),
  listActiveDeployments: vi.fn(async () => []),
  tokenIdentity: vi.fn(async () => ({})),
  ...over,
});

const probeArgs = (fetchImpl: unknown, maint: unknown) => ({
  maintenance: maint as never, deploymentId: "dep-1", commit: COMMIT,
  origin: "https://staging.example.com", token: "t".repeat(32),
  fetchImpl: fetchImpl as never,
});

const captureReceipts = async (run: () => Promise<unknown>) => {
  const lines: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((line: string) => void lines.push(line));
  try {
    const outcome = await run().then(() => null, (error: unknown) => error);
    return { outcome, receipts: parseReceipts(lines.join("\n")), lines };
  } finally { log.mockRestore(); }
};

// ── the poll itself: cancellation ends it, and is never mistaken for a transient probe ───────────

describe("the boot health poll observes the owning cancellation", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("does NOT accept a successful response that arrived after the cancellation", async () => {
    // The traced path, at the poll level: the response is in flight when the signal lands, and it
    // would have passed. Acceptance here is what let `markReady` run for a withdrawn candidate.
    const controller = new AbortController();
    const { fetchImpl, inFlight, release } = heldProbe();
    const waiting = waitForImportedBoot({
      ...probeArgs(fetchImpl, maintenance()), mode: "copy-ready",
      timeoutMs: 30_000, sleep: async () => {}, signal: controller.signal,
    });
    await inFlight;
    controller.abort(sigterm());
    release();
    await expect(waiting).rejects.toMatchObject({ code: "STAGING_OPERATION_ABORTED" });
    expect(fetchImpl, "the poll kept probing after it was told to stop").toHaveBeenCalledTimes(1);
  });

  it("is not vacuous: the SAME held response is accepted when nothing cancels it", async () => {
    const { fetchImpl, inFlight, release } = heldProbe();
    const waiting = waitForImportedBoot({
      ...probeArgs(fetchImpl, maintenance()), mode: "copy-ready",
      timeoutMs: 30_000, sleep: async () => {}, signal: new AbortController().signal,
    });
    await inFlight;
    release();
    await expect(waiting).resolves.toBe(true);
  });

  it("stops retrying at the cancellation instead of polling on to the health ceiling", async () => {
    // A cancellation observed during the inter-probe wait must end the poll. Before this the wait
    // was an uninterruptible sleep and the loop simply carried on to the next probe.
    const controller = new AbortController();
    const fetchImpl = vi.fn(async () => Response.json({ ok: false }, { status: 503 }));
    let sleeps = 0;
    await expect(waitForImportedBoot({
      ...probeArgs(fetchImpl, maintenance()), mode: "copy-ready", timeoutMs: 30_000,
      sleep: async () => { sleeps += 1; controller.abort(sigterm()); },
      signal: controller.signal,
    })).rejects.toMatchObject({ code: "STAGING_OPERATION_ABORTED" });
    expect(sleeps).toBe(1);
    expect(fetchImpl, "the poll probed again after the cancellation").toHaveBeenCalledTimes(1);
  });

  it("does not report a cancellation as an ordinary failed probe", async () => {
    // The `.catch(() => null)` around the fetch treats every failure as retryable. A probe that
    // fails BECAUSE the owning operation was cancelled is not that, and reporting it as a health
    // timeout hides the shutdown behind an unrelated diagnosis.
    const controller = new AbortController();
    const probeSignals: AbortSignal[] = [];
    const fetchImpl = vi.fn(async (_url: unknown, init: { signal: AbortSignal }) => {
      probeSignals.push(init.signal);
      // The shutdown lands mid-probe, and the probe's own signal carries it: the per-fetch timeout
      // is COMBINED with the owning cancellation rather than being the only abort condition.
      controller.abort(sigterm());
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (init.signal.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
      return Response.json(BOOTED, { status: 202 });
    });
    const { outcome, receipts } = await captureReceipts(() => waitForImportedBoot({
      ...probeArgs(fetchImpl, maintenance()), mode: "copy-ready",
      timeoutMs: 30_000, sleep: async () => {}, signal: controller.signal,
    }));
    expect(probeSignals[0].aborted, "the owning cancellation never reached the probe").toBe(true);
    expect(outcome).toMatchObject({ code: "STAGING_OPERATION_ABORTED" });
    expect((outcome as Error).message).not.toMatch(/did not pass/);
    expect(fetchImpl, "the aborted probe was retried as an ordinary transient failure").toHaveBeenCalledTimes(1);
    expect(receipts.map((receipt) => receipt.kind)).not.toContain("health-poll-timed-out");

    // The discriminating control: the same transport failure with a LIVE signal is still an
    // ordinary retryable probe, and still ends in the bounded health refusal.
    const live = vi.fn(async () => { throw Object.assign(new Error("connect ECONNREFUSED"), { name: "TypeError" }); });
    const ordinary = await captureReceipts(() => waitForImportedBoot({
      ...probeArgs(live, maintenance()), mode: "copy-ready",
      timeoutMs: 30, sleep: async () => {}, signal: new AbortController().signal,
    }));
    expect((ordinary.outcome as Error).message).toMatch(/did not pass the bounded authenticated boot probe/);
    expect(ordinary.receipts.map((receipt) => receipt.kind)).toContain("health-poll-timed-out");
  });

  it("spends the owning budget's REMAINING time, not a fresh five-minute allowance", async () => {
    // `timeoutMs` here is the production default. With the budget ignored this poll runs for five
    // minutes — a regression fails on the test timeout rather than passing slowly.
    const budget = createOperationBudget("importer install", 40, { now: () => 0 });
    const fetchImpl = vi.fn(async () => Response.json({ ok: false }, { status: 503 }));
    await expect(waitForImportedBoot({
      ...probeArgs(fetchImpl, maintenance()), mode: "copy-ready", timeoutMs: 300_000,
      sleep: () => new Promise((resolve) => setTimeout(resolve, 5)), budget,
    })).rejects.toThrow(/did not pass the bounded authenticated boot probe/);
  }, 5_000);

  it("carries a DEADLINE breach out with timeout semantics, not as an operator shutdown", async () => {
    // The signal owned work receives is `AbortSignal.any([external, watchdog])`, so the abort that
    // reaches the poll is just as often the operation's own budget expiring. The daemon acts on the
    // two differently, so the classification has to survive the health boundary.
    const owner = createSessionWatchdogOwner(() => {}, { signal: new AbortController().signal });
    const watchdog = owner.arm(createOperationBudget("importer daemon tick", 30));
    const fetchImpl = vi.fn(async () => Response.json({ ok: false }, { status: 503 }));
    try {
      await expect(waitForImportedBoot({
        ...probeArgs(fetchImpl, maintenance()), mode: "copy-ready", timeoutMs: 10_000,
        sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 5))),
        signal: watchdog.signal,
      })).rejects.toMatchObject({ code: "STAGING_OPERATION_TIMEOUT" });
    } finally { await watchdog.disarm(); }
  }, 10_000);

  // ── the loop's EXHAUSTION, where the exit is a wall-clock test and not a signal check ──────────
  //
  // The poll's deadline is capped by the SAME owning budget whose watchdog raises
  // STAGING_OPERATION_TIMEOUT. When that budget expires as the loop gives up, the outcome used to
  // depend on which of the two landed first: the watchdog callback (typed timeout) or
  // `Date.now() <= deadline` going false (a codeless "did not pass health" refusal). Both orderings
  // must classify the same way, so both are exercised — and each passes a REAL budget together with
  // the watchdog-derived signal armed on it, which is the pairing production uses.

  it("classifies an exhausted owning budget as a timeout when the watchdog notification HAS landed", async () => {
    const clock = { ms: 0 };
    const budget = createOperationBudget("importer daemon tick", 15, { now: () => clock.ms });
    const owner = createSessionWatchdogOwner(() => {}, { signal: new AbortController().signal });
    const watchdog = owner.arm(budget);
    const fetchImpl = vi.fn(async () => Response.json({ ok: false }, { status: 503 }));
    try {
      const { outcome, receipts } = await captureReceipts(() => waitForImportedBoot({
        ...probeArgs(fetchImpl, maintenance()), mode: "copy-ready", timeoutMs: 300_000,
        // The budget's own 15ms watchdog timer fires inside this wait, so the abort is delivered
        // before the loop re-tests its wall clock.
        sleep: async () => { clock.ms = 1_000; await new Promise((resolve) => setTimeout(resolve, 40)); },
        signal: watchdog.signal, budget,
      }));
      expect(watchdog.signal.aborted, "the watchdog never notified; this case does not cover the delivered one").toBe(true);
      // TIMEOUT, not ABORTED and not a generic health refusal: this is the code the CLI's daemon
      // treats as fatal (`staging-cancellation-recovery.test.ts` covers that consumer).
      expect(outcome).toMatchObject({ code: "STAGING_OPERATION_TIMEOUT" });
      expect((outcome as Error).message).not.toMatch(/did not pass/);
      expect(receipts.map((receipt) => receipt.kind)).not.toContain("health-poll-timed-out");
    } finally { await watchdog.disarm(); }
  }, 10_000);

  it("classifies it as a timeout even when the watchdog notification has NOT been processed yet", async () => {
    // The scheduling case the classification may not depend on: only the clock the budget reads has
    // moved, so the signal is still live while the owning allowance is already spent.
    const clock = { ms: 0 };
    const budget = createOperationBudget("importer daemon tick", 60_000, { now: () => clock.ms });
    const owner = createSessionWatchdogOwner(() => {}, { signal: new AbortController().signal });
    const watchdog = owner.arm(budget);
    const fetchImpl = vi.fn(async () => Response.json({ ok: false }, { status: 503 }));
    try {
      const { outcome, receipts } = await captureReceipts(() => waitForImportedBoot({
        // A health ceiling far shorter than the budget, so the loop exits on its own wall clock…
        ...probeArgs(fetchImpl, maintenance()), mode: "copy-ready", timeoutMs: 15,
        // …while the owning budget is exhausted with its 60s watchdog timer still pending.
        sleep: async () => { clock.ms = 60_001; await new Promise((resolve) => setTimeout(resolve, 30)); },
        signal: watchdog.signal, budget,
      }));
      expect(watchdog.signal.aborted, "the notification was delivered; this case no longer covers the unprocessed one").toBe(false);
      expect(outcome).toMatchObject({ code: "STAGING_OPERATION_TIMEOUT" });
      expect(receipts.map((receipt) => receipt.kind)).not.toContain("health-poll-timed-out");
    } finally { await watchdog.disarm(); }
  }, 10_000);

  it("is disjoint: a shorter HEALTH ceiling under a live budget is still an ordinary health failure", async () => {
    // The positive control. Without it, classifying every exhausted poll as an operation timeout
    // would satisfy both rows above — and an unhealthy deployment would be reported as the daemon's
    // own budget breach, ending the loop instead of failing the candidate.
    const budget = createOperationBudget("importer daemon tick", 60_000);
    const owner = createSessionWatchdogOwner(() => {}, { signal: new AbortController().signal });
    const watchdog = owner.arm(budget);
    const fetchImpl = vi.fn(async () => Response.json({ ok: false }, { status: 503 }));
    try {
      const { outcome, receipts } = await captureReceipts(() => waitForImportedBoot({
        ...probeArgs(fetchImpl, maintenance()), mode: "copy-ready", timeoutMs: 20,
        sleep: async () => { await new Promise((resolve) => setTimeout(resolve, 25)); },
        signal: watchdog.signal, budget,
      }));
      expect((outcome as Error).message).toMatch(/did not pass the bounded authenticated boot probe/);
      expect((outcome as { code?: string }).code, "an unhealthy deployment was reported as an operation timeout").toBeUndefined();
      expect(receipts.map((receipt) => receipt.kind)).toContain("health-poll-timed-out");
    } finally { await watchdog.disarm(); }
  }, 10_000);
});

// ── the ready boundary itself, through the real bootExact ────────────────────────────────────────

describe("bootExact — observed cancellation before the submission prevents it, and only that", () => {
  afterEach(() => vi.unstubAllGlobals());

  /** The two statements this path issues, recorded so the journal can be asked what happened. */
  const bootClient = ({ onReady = () => {} }: { onReady?: () => void } = {}) => {
    const transitions: string[] = [];
    const readyCommits: unknown[][] = [];
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (/pg_advisory_unlock/.test(sql)) return { rows: [{}] };
      if (/UPDATE staging_ops\.refresh_journal SET state='ready'/.test(sql)) {
        readyCommits.push(params as unknown[]);
        onReady();
        return { rows: [{ state: "ready", run_id: "run-9", last_ready_run_id: "run-9", last_ready_commit: COMMIT }] };
      }
      if (/UPDATE staging_ops\.refresh_journal/.test(sql)) {
        transitions.push(String((params as unknown[])?.[1]));
        return { rows: [{ state: String((params as unknown[])?.[1]) }] };
      }
      return { rows: [] };
    });
    return { query, transitions, readyCommits };
  };

  const bootArgs = (client: unknown, maint: unknown) => ({
    client: client as never, maintenance: maint as never, runId: "run-9",
    objectId: `run-9--${"b".repeat(64)}`, digest: "b".repeat(64), commit: COMMIT, mode: "copy-ready",
    env: { STAGING_ORIGIN: "https://staging.example.com", STAGING_HEALTH_TOKEN: "t".repeat(32) } as unknown as NodeJS.ProcessEnv,
  });

  it("does not submit ready when the shutdown lands while the health response is in flight", async () => {
    const controller = new AbortController();
    const { fetchImpl, inFlight, release } = heldProbe();
    vi.stubGlobal("fetch", fetchImpl);
    const client = bootClient();
    const maint = maintenance();

    const booting = bootExact({ ...bootArgs(client, maint), signal: controller.signal });
    await inFlight;
    controller.abort(sigterm());
    release();

    await expect(booting).rejects.toMatchObject({ code: "STAGING_OPERATION_ABORTED" });
    expect(client.readyCommits, "a cancelled candidate was committed ready").toHaveLength(0);
    // The candidate did enter `booting` and was deployed — that is the window the defect lives in,
    // and the caller's rollback is what puts the prior pair back from here.
    expect(client.transitions).toEqual(["booting"]);
    expect(maint.deployApp).toHaveBeenCalledTimes(1);
  });

  it("commits ready on the same response with no signal, and with a live one", async () => {
    for (const signal of [undefined, new AbortController().signal]) {
      vi.stubGlobal("fetch", vi.fn(async () => Response.json(BOOTED, { status: 202 })));
      const client = bootClient();
      await expect(bootExact({ ...bootArgs(client, maintenance()), signal })).resolves.toMatchObject({
        deploymentId: "dep-1", ready: { state: "ready", last_ready_run_id: "run-9" },
      });
      expect(client.readyCommits).toHaveLength(1);
    }
  });

  it("refuses BEFORE the boot transition when the cancellation is already visible", async () => {
    // The cheapest refusal: nothing is deployed and the exclusive data-use lock is not released.
    const controller = new AbortController();
    controller.abort(sigterm());
    const client = bootClient();
    const maint = maintenance();
    await expect(bootExact({ ...bootArgs(client, maint), signal: controller.signal }))
      .rejects.toMatchObject({ code: "STAGING_OPERATION_ABORTED" });
    expect(client.transitions).toEqual([]);
    expect(maint.deployApp).not.toHaveBeenCalled();
    expect(client.query).not.toHaveBeenCalled();
  });

  it("reaches ready under a FRESH RECOVERY scope while the external shutdown is aborted", async () => {
    // The rollback path's entitlement, at the boundary itself. Mandatory recovery runs on the scope
    // `transferTo` mints; an external SIGTERM may not withhold the restoration of the prior pair.
    const shutdown = new AbortController();
    const owner = createSessionWatchdogOwner(() => {}, { signal: shutdown.signal });
    const action = owner.arm(createOperationBudget("importer install", 60_000));
    shutdown.abort(sigterm());
    expect(action.signal.aborted, "the in-flight action ignored the shutdown").toBe(true);

    const recoveryBudget = createOperationBudget("importer recovery", 60_000);
    const recovery = await owner.transferTo(recoveryBudget);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(BOOTED, { status: 202 })));
    const client = bootClient();
    try {
      await expect(bootExact({ ...bootArgs(client, maintenance()), signal: recovery.signal, budget: recoveryBudget }))
        .resolves.toMatchObject({ ready: { state: "ready" } });
      expect(client.readyCommits, "the restored prior pair was never committed ready").toHaveLength(1);
    } finally { await recovery.disarm(); }
  });

  it("honours a ready commit that was already in flight when the signal arrived", async () => {
    // No retroactive cancellation of a committed transaction: the SQL is awaited to settlement and
    // never raced against the signal, so its actual result is what gets reported.
    const controller = new AbortController();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(BOOTED, { status: 202 })));
    const client = bootClient({ onReady: () => controller.abort(sigterm()) });
    await expect(bootExact({ ...bootArgs(client, maintenance()), signal: controller.signal }))
      .resolves.toMatchObject({ ready: { state: "ready", last_ready_run_id: "run-9" } });
    expect(client.readyCommits).toHaveLength(1);
  });
});

// ── the whole install, down the production branch, with the real boot/health/ready path ──────────

describe("installObject — a late cancellation recovers instead of committing a new candidate", () => {
  afterEach(() => vi.unstubAllGlobals());

  const RUN_ID = "run-9";
  const SOURCE_OBJECT = `${RUN_ID}--${"a".repeat(64)}`;
  const READY_OBJECT = `${RUN_ID}--${"b".repeat(64)}`;

  const deadlines = Object.freeze({
    operationMs: 60_000, captureMs: 60_000, recoveryMs: 60_000,
    cleanupMs: 60_000, connectionMs: 5_000, terminateGraceMs: 100,
  });

  const env = Object.freeze({
    NEO4J_URL: "bolt://127.0.0.1:7687", NEO4J_USER: "neo4j", NEO4J_PASSWORD: "FAKE-unused-in-this-tier",
    NEO4J_DATABASE: "neo4j", STAGING_DATA_LOCK_TIMEOUT_MS: "5000",
    STAGING_ORIGIN: "https://staging.example.com", STAGING_HEALTH_TOKEN: "t".repeat(32),
  }) as unknown as NodeJS.ProcessEnv;

  const readyJournal = () => ({
    state: "ready", run_id: "run-8",
    last_ready_run_id: "run-8", last_ready_object_id: `run-8--${"e".repeat(64)}`,
    last_ready_digest: "e".repeat(64), last_ready_commit: COMMIT, last_ready_mode: "copy-ready",
    source_watermark: null, rollback_target_run_id: null,
  });

  const opened = () => ({
    kind: "source", digest: "a".repeat(64), payload: Buffer.from("payload"),
    manifest: {
      runId: RUN_ID, kind: "staging-source", mode: "copy-ready", databaseMode: "sanitized",
      captureEndedAt: "2026-09-08T00:00:00.000Z",
      build: {
        applicationCommit: COMMIT, migrationSet: loaderCapabilityIdentity().migrationSet,
        schemaFingerprint: "f".repeat(64),
      },
    },
  });

  function scenario() {
    const transitions: string[] = [];
    const readyCommits: unknown[][] = [];
    const client = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (/pg_try_advisory_lock/.test(sql)) return { rows: [{ acquired: true }] };
        if (/pg_advisory_unlock/.test(sql)) return { rows: [{}] };
        if (/UPDATE staging_ops\.refresh_journal SET state='ready'/.test(sql)) {
          readyCommits.push(params as unknown[]);
          return { rows: [{ ...readyJournal(), state: "ready", run_id: RUN_ID, last_ready_run_id: RUN_ID, last_ready_object_id: READY_OBJECT, last_ready_commit: COMMIT }] };
        }
        if (/UPDATE staging_ops\.refresh_journal/.test(sql)) {
          transitions.push(String((params as unknown[])?.[1]));
          return { rows: [{ ...readyJournal(), state: String((params as unknown[])?.[1]) }] };
        }
        return { rows: [] };
      }),
    };
    // The CLI's own wiring: one owner over the process shutdown, the action signal handed to owned
    // work, and `transferTo` as the recovery scope. Nothing here is a stand-in for that composition.
    const shutdown = new AbortController();
    const operationBudget = createOperationBudget("importer install", 60_000);
    const owner = createSessionWatchdogOwner(() => {}, { signal: shutdown.signal });
    const actionWatchdog = owner.arm(operationBudget);
    const recovered: { signalAborted: unknown; budgetLabel: unknown }[] = [];
    const maint = maintenance();
    const operations = {
      operationBudget, signal: actionWatchdog.signal,
      beginRecoveryWatchdog: (budget: never) => owner.transferTo(budget),
      verifyAndPinSourceBundle: vi.fn(async () => opened()),
      compareEnvironmentCredentials: vi.fn(() => {}),
      acquireCoordinatorLock: vi.fn(async () => true),
      releaseCoordinatorLock: vi.fn(async () => {}),
      readJournal: vi.fn(async () => readyJournal()),
      openPrior: vi.fn(async () => ({ kind: "rollback", manifest: { runId: "run-8" } })),
      readSourceAttempt: vi.fn(async () => null),
      recordSourceAttempt: vi.fn(async () => {}),
      completeSourceAttempt: vi.fn(async () => {}),
      withdrawSourceAttempt: vi.fn(async () => {}),
      rollbackToPrior: vi.fn(async ({ signal, budget }: { signal?: AbortSignal; budget?: { label: string } }) => {
        recovered.push({ signalAborted: signal ? signal.aborted : "no signal", budgetLabel: budget?.label });
        return { status: "rolled-back" };
      }),
      reconcileReadyInstall: vi.fn(async () => ({ catchup: null, cleanupErrors: [] })),
      verifyPostgresDestination: vi.fn(async () => ({})),
      readStagingHead: vi.fn(async () => COMMIT),
      installOpenedPair: vi.fn(async () => ({ nodes: [], relationships: [] })),
      verifyInstalledPair: vi.fn(async () => {}),
      sealReadyRollback: vi.fn(() => ({ objectId: READY_OBJECT, digest: "b".repeat(64), sourceBytes: Buffer.from("sealed") })),
      // `bootExact` is DELIBERATELY not injected: the real boot, health poll and ready commit run.
    };
    const rollbackStore = {
      putImmutable: vi.fn(async () => {}), verify: vi.fn(async () => true),
      writePointer: vi.fn(async () => {}), read: vi.fn(async () => Buffer.alloc(0)), delete: vi.fn(async () => true),
    };
    const run = () => installObject({
      client, objectId: SOURCE_OBJECT, sourceStore: {}, rollbackStore, maintenance: maint,
      env, deadlines, automatic: true, operations,
    });
    return { client, maintenance: maint, operations, rollbackStore, shutdown, recovered, transitions, readyCommits, run };
  }

  it("holds the health response, takes the shutdown, and never marks the candidate ready", async () => {
    // The required regression, end to end over the production orchestration. The shutdown is the
    // one `recordSignalAbort` raises, delivered through the same action signal the CLI hands to
    // owned work; the held response would have passed.
    const { fetchImpl, inFlight, release } = heldProbe();
    vi.stubGlobal("fetch", fetchImpl);
    const context = scenario();
    const { outcome, receipts } = await captureReceipts(async () => {
      const running = context.run();
      await inFlight;
      context.shutdown.abort(sigterm());
      release();
      return running;
    });

    expect((outcome as Error).message).toMatch(/paired refresh failed and the prior pair was restored/);
    expect(context.readyCommits, "a candidate observed to be cancelled was committed ready").toHaveLength(0);
    expect(context.transitions).toEqual(["draining", "importing", "verifying", "booting", "failed"]);
    // The candidate's failure is terminal and recorded before the prior pair goes back.
    expect(context.operations.completeSourceAttempt)
      .toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ objectId: SOURCE_OBJECT, status: "failed" }));
    // MANDATORY ROLLBACK, on a scope the shutdown did not poison and a budget that bounds it.
    expect(context.recovered).toEqual([{ signalAborted: false, budgetLabel: "importer recovery" }]);
    expect(receipts.map((receipt) => receipt.kind)).not.toContain("ready-bookkeeping-pending");
  });

  it("is not vacuous: the same install reaches ready when no shutdown arrives", async () => {
    const { fetchImpl, inFlight, release } = heldProbe();
    vi.stubGlobal("fetch", fetchImpl);
    const context = scenario();
    const running = context.run();
    await inFlight;
    release();

    await expect(running).resolves.toMatchObject({ status: "ready", runId: RUN_ID, objectId: READY_OBJECT });
    expect(context.readyCommits, "the real markReady never ran").toHaveLength(1);
    expect(context.operations.rollbackToPrior).not.toHaveBeenCalled();
    expect(context.maintenance.stopAndVerifyAll).toHaveBeenCalledTimes(1);
  });

  it("preserves a ready commit the shutdown arrived AFTER, with a truthful pending outcome", async () => {
    // The other side of the boundary. `markReady` has committed and the deployment is serving, so a
    // shutdown that becomes visible during bookkeeping is repair work, not permission to drain.
    const context = scenario();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(BOOTED, { status: 202 })));
    context.operations.reconcileReadyInstall.mockImplementation(async () => {
      context.shutdown.abort(sigterm());
      throw new Error("catch-up head read failed");
    });
    const { outcome, receipts } = await captureReceipts(context.run);

    expect((outcome as Error).message).toMatch(/ready and serving; post-ready bookkeeping remains pending/);
    expect(context.readyCommits).toHaveLength(1);
    expect(context.operations.rollbackToPrior, "a committed, serving pair was rolled back").not.toHaveBeenCalled();
    expect(context.maintenance.stopAndVerifyAll).toHaveBeenCalledTimes(1);
    const pending = receipts.filter((receipt) => receipt.kind === "ready-bookkeeping-pending");
    expect(pending).toHaveLength(1);
    expect(pending[0].fields).toMatchObject({ runId: RUN_ID, objectId: READY_OBJECT, servingCommit: COMMIT });
  });
});

// ── wiring: the scopes the CLI and the recovery path actually hand to the boot ───────────────────

describe("the owning scope reaches every boot the importer performs", () => {
  it("gives the install's boot this invocation's signal and budget", () => {
    expect(IMPORTER_SOURCE).toContain('mode: "copy-ready", env, budget: operationBudget, signal });');
  });

  it("gives the rollback's boot the RECOVERY scope, never the aborted shutdown", () => {
    // `rollbackToPrior` receives the recovery signal by contract, and neither `installObject` entry
    // may substitute the owning signal for it: that fallback handed recovery the very shutdown it
    // exists to survive.
    expect(IMPORTER_SOURCE).toContain("mode: prior.manifest.mode, env, budget: recoveryBudget, signal });");
    expect(IMPORTER_SOURCE, "recovery may not inherit the owning cancellation")
      .not.toContain("signal: recoverySignal ?? signal");
  });

  it("separates bootstrap's primary boot from its recovery restart", () => {
    expect(IMPORTER_SOURCE).toContain("token: env.STAGING_HEALTH_TOKEN, mode, signal, budget: operationBudget });");
    expect(IMPORTER_SOURCE).toContain("mode: recoveryMode, signal: recoverySignal, budget: recoveryBudget });");
  });

  it("is reached from the CLI: the shutdown the signal handlers abort is what owned work receives", () => {
    // Pinning `bootExact` is not pinning the RUNNER. Without these the boot could take a scope
    // nothing ever cancels and every behavioural test above would still pass.
    expect(IMPORTER_SOURCE).toContain('shutdown.abort(Object.assign(new Error(`importer received ${signal}`), { code: "STAGING_OPERATION_ABORTED" }));');
    expect(IMPORTER_SOURCE).toContain('const signalHandlers = Object.fromEntries(["SIGTERM", "SIGINT"].map(');
    expect(IMPORTER_SOURCE).toContain("operationBudget: actionBudget, now, signal: actionWatchdog?.signal ?? shutdown.signal,");
    expect(IMPORTER_SOURCE).toContain("operationBudget: tickBudget, now, signal: tickWatchdog.signal,");
  });

  it("hands catch-up the tick's own scope without changing its ready-state semantics", () => {
    expect(IMPORTER_SOURCE).toContain("serviceCatchup({ client, maintenance, env, budget: tickBudget, signal: tickWatchdog.signal })");
    // Catch-up still never leaves `ready`, and still admits only the expected-ready shape.
    expect(IMPORTER_SOURCE).toContain("mode: journal.last_ready_mode, runId: journal.last_ready_run_id,");
  });
});
