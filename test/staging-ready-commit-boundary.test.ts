import { afterEach, describe, expect, it, vi } from "vitest";
import { installObject } from "../scripts/staging-ops/importer.mjs";
import { loaderCapabilityIdentity } from "../scripts/staging-ops/build-identity.mjs";
import { parseReceipts } from "../scripts/staging-ops/receipts.mjs";

/**
 * M6 — `markReady` IS the commit boundary, exercised as BEHAVIOUR.
 *
 * The defect: `bootExact` had committed `ready` (the deployment verified serving, the canonical
 * identity durable) but `readyCommitted` was still null when the very next `operationBudget.assert`
 * threw — so the destructive catch below it rolled the pair back and drained the healthy staging it
 * had just installed. Repairable bookkeeping became an outage.
 *
 * The previous pass could only pin the SOURCE ORDER of the assignment and the assert, which is
 * strictly weaker: it says the two statements are the right way round, never that a budget expiring
 * between them produces a pending-bookkeeping receipt and no rollback. This runs the real
 * `installObject` orchestration down the production branch to that exact boundary, with only the
 * four steps that spawn `pg_restore`, talk to Neo4j, read the branch head over the network, or
 * deploy and health-poll an app substituted at the seam `installObject` already exposes.
 *
 * The clock is the real budget's clock, not a stubbed `assert`: the injected boot advances it past
 * the deadline, so the failure is a genuine `StagingDeadlineExceededError` raised by the real
 * `createOperationBudget` at the real call site.
 */

const RUN_ID = "run-9";
const SOURCE_OBJECT = `${RUN_ID}--${"a".repeat(64)}`;
const READY_OBJECT = `${RUN_ID}--${"b".repeat(64)}`;
const SOURCE_COMMIT = "c".repeat(40);
const HEAD_COMMIT = "d".repeat(40);
const BUDGET_MS = 60_000;

const deadlines = Object.freeze({
  operationMs: BUDGET_MS, captureMs: BUDGET_MS, recoveryMs: BUDGET_MS,
  cleanupMs: BUDGET_MS, connectionMs: 5_000, terminateGraceMs: 100,
});

const env = Object.freeze({
  NEO4J_URL: "bolt://127.0.0.1:7687", NEO4J_USER: "neo4j", NEO4J_PASSWORD: "FAKE-unused-in-this-tier",
  NEO4J_DATABASE: "neo4j", STAGING_DATA_LOCK_TIMEOUT_MS: "5000",
}) as unknown as NodeJS.ProcessEnv;

const readyJournal = () => ({
  state: "ready", run_id: "run-8",
  last_ready_run_id: "run-8", last_ready_object_id: `run-8--${"e".repeat(64)}`,
  last_ready_digest: "e".repeat(64), last_ready_commit: SOURCE_COMMIT, last_ready_mode: "copy-ready",
  source_watermark: null, rollback_target_run_id: null,
});

const opened = () => ({
  kind: "source", digest: "a".repeat(64), payload: Buffer.from("payload"),
  manifest: {
    runId: RUN_ID, kind: "staging-source", mode: "copy-ready", databaseMode: "sanitized",
    captureEndedAt: "2026-09-08T00:00:00.000Z",
    build: {
      applicationCommit: SOURCE_COMMIT,
      migrationSet: loaderCapabilityIdentity().migrationSet,
      schemaFingerprint: "f".repeat(64),
    },
  },
});

/** The ready row `markReady` would have committed, as `bootExact` returns it. */
const readyRow = () => ({
  state: "ready", run_id: RUN_ID,
  last_ready_run_id: RUN_ID, last_ready_object_id: READY_OBJECT,
  last_ready_digest: "b".repeat(64), last_ready_commit: HEAD_COMMIT, last_ready_mode: "copy-ready",
});

/**
 * Postgres, reduced to the two statements this path issues through the REAL journal helpers: the
 * advisory data-use lock and the singleton journal UPDATE. Both are recorded, so the assertions can
 * ask what the orchestration did to the journal rather than trusting that it did nothing.
 */
function fakeClient() {
  const transitions: string[] = [];
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    if (/pg_try_advisory_lock/.test(sql)) return { rows: [{ acquired: true }] };
    if (/pg_advisory_unlock/.test(sql)) return { rows: [{}] };
    if (/UPDATE staging_ops\.refresh_journal/.test(sql)) {
      transitions.push(String((params as unknown[])?.[1]));
      return { rows: [{ ...readyJournal(), state: String((params as unknown[])?.[1]), run_id: String((params as unknown[])?.[0]) }] };
    }
    return { rows: [] };
  });
  return { query, transitions };
}

function scenario({ expireAfterBoot = true } = {}) {
  const clock = { ms: 0 };
  const client = fakeClient();
  const maintenance = {
    stopAndVerifyAll: vi.fn(async () => {}),
    deployApp: vi.fn(async () => "deployment-1"),
    assertPinnedRunnerConfiguration: vi.fn(async () => {}),
    listActiveDeployments: vi.fn(async () => []),
    tokenIdentity: vi.fn(async () => ({})),
  };
  const rollbackStore = {
    putImmutable: vi.fn(async () => {}),
    verify: vi.fn(async () => true),
    writePointer: vi.fn(async () => {}),
    read: vi.fn(async () => Buffer.alloc(0)),
    delete: vi.fn(async () => true),
  };
  const operations = {
    now: () => clock.ms,
    // ── admission, already injectable before this change ──────────────────────────────────────
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
    rollbackToPrior: vi.fn(async () => ({ status: "rolled-back" })),
    reconcileReadyInstall: vi.fn(async () => ({ catchup: null, cleanupErrors: [] })),
    // ── the destructive-path boundaries ───────────────────────────────────────────────────────
    verifyPostgresDestination: vi.fn(async () => ({})),
    readStagingHead: vi.fn(async () => HEAD_COMMIT),
    installOpenedPair: vi.fn(async () => ({ nodes: [], relationships: [] })),
    verifyInstalledPair: vi.fn(async () => {}),
    sealReadyRollback: vi.fn(() => ({ objectId: READY_OBJECT, digest: "b".repeat(64), sourceBytes: Buffer.from("sealed") })),
    bootExact: vi.fn(async () => {
      // THE BOUNDARY. `markReady` has committed and the deployment is verified serving; the budget
      // runs out in the same instant. Everything after this point is bookkeeping.
      if (expireAfterBoot) clock.ms = BUDGET_MS + 1;
      return { ready: readyRow(), deploymentId: "deployment-1" };
    }),
  };
  return { client, maintenance, rollbackStore, operations, clock };
}

const run = ({ client, maintenance, rollbackStore, operations }: ReturnType<typeof scenario>) =>
  installObject({
    client, objectId: SOURCE_OBJECT, sourceStore: {}, rollbackStore, maintenance,
    env, deadlines, automatic: true, operations,
  });

describe("M6 — a budget that expires after the ready commit leaves the serving pair alone", () => {
  let logged: string[] = [];
  afterEach(() => { vi.restoreAllMocks(); logged = []; });
  const captureReceipts = () => {
    logged = [];
    vi.spyOn(console, "log").mockImplementation((line?: unknown) => { logged.push(String(line)); });
  };

  it("reports pending bookkeeping instead of rolling back the pair it just installed", async () => {
    captureReceipts();
    const context = scenario();
    await expect(run(context)).rejects.toThrow(/ready and serving; post-ready bookkeeping remains pending/);

    // NO ROLLBACK, and no second maintenance window. `stopAndVerifyAll` belongs to the ONE drain
    // this install legitimately performed; a second call is the outage the fix exists to prevent.
    expect(context.operations.rollbackToPrior, "the ready pair was rolled back").not.toHaveBeenCalled();
    expect(context.maintenance.stopAndVerifyAll).toHaveBeenCalledTimes(1);
    // The journal is not walked back either: after the boot no transition is issued at all, so the
    // recorded sequence ends at the pre-boot states.
    expect(context.client.transitions).toEqual(["draining", "importing", "verifying"]);

    // …and the bookkeeping really is PENDING, not silently completed.
    expect(context.operations.reconcileReadyInstall).not.toHaveBeenCalled();
    expect(context.operations.completeSourceAttempt).not.toHaveBeenCalled();
    // The attempt record survives: withdrawal is only for a failure that never drained.
    expect(context.operations.withdrawSourceAttempt).not.toHaveBeenCalled();
    // The coordinator lock is still released — the boundary is about staging, not about fencing.
    expect(context.operations.releaseCoordinatorLock).toHaveBeenCalled();
  });

  it("emits a ready-bookkeeping-pending receipt naming the identity that IS serving", async () => {
    captureReceipts();
    await expect(run(scenario())).rejects.toThrow();
    const pending = parseReceipts(logged.join("\n")).filter((receipt) => receipt.kind === "ready-bookkeeping-pending");
    expect(pending, "the serving identity was not reported to the operator").toHaveLength(1);
    expect(pending[0].fields).toMatchObject({
      runId: RUN_ID, objectId: READY_OBJECT, servingCommit: HEAD_COMMIT,
    });
    // The detail names the operation that ran out, so "pending" is attributable rather than generic.
    expect(String(pending[0].fields.detail)).toMatch(/ready reconciliation/);
    // A recovery receipt would mean the catch took the destructive branch after all.
    expect(parseReceipts(logged.join("\n")).map((receipt) => receipt.kind)).not.toContain("prior-pair-restored");
    expect(parseReceipts(logged.join("\n")).map((receipt) => receipt.kind)).not.toContain("recovery-required");
  });

  it("is not vacuous: the SAME orchestration reaches ready when the budget survives the boot", async () => {
    // The positive control. Without it, a path that refused before the drain — or one that never
    // reached `bootExact` at all — would satisfy every assertion above by never getting there.
    captureReceipts();
    const context = scenario({ expireAfterBoot: false });
    await expect(run(context)).resolves.toMatchObject({ status: "ready", runId: RUN_ID, objectId: READY_OBJECT, commit: HEAD_COMMIT });
    expect(context.operations.bootExact).toHaveBeenCalledTimes(1);
    expect(context.operations.reconcileReadyInstall).toHaveBeenCalledTimes(1);
    expect(context.operations.completeSourceAttempt).toHaveBeenCalledWith(expect.anything(), { objectId: SOURCE_OBJECT, status: "installed" });
    expect(context.maintenance.stopAndVerifyAll).toHaveBeenCalledTimes(1);
    expect(parseReceipts(logged.join("\n")).map((receipt) => receipt.kind)).not.toContain("ready-bookkeeping-pending");
  });

  it("STILL rolls back when the same budget expires BEFORE the ready commit", async () => {
    // The discriminating case, and the reason the boundary is a boundary: an identical expiry one
    // step earlier is a failed install with nothing serving, and it must recover the prior pair. An
    // implementation that simply stopped rolling back would pass both tests above and fail here.
    captureReceipts();
    const context = scenario({ expireAfterBoot: false });
    context.operations.verifyInstalledPair.mockImplementation(async () => { context.clock.ms = BUDGET_MS + 1; });
    await expect(run(context)).rejects.toThrow(/paired refresh failed and the prior pair was restored/);
    expect(context.operations.bootExact, "the pre-ready failure booted the candidate anyway").not.toHaveBeenCalled();
    expect(context.operations.rollbackToPrior, "a failure before the ready commit did not recover the prior pair").toHaveBeenCalledTimes(1);
    // The failure is terminal for THIS candidate, and recorded as such before the prior is restored.
    expect(context.operations.completeSourceAttempt).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ objectId: SOURCE_OBJECT, status: "failed" }));
    expect(parseReceipts(logged.join("\n")).map((receipt) => receipt.kind)).not.toContain("ready-bookkeeping-pending");
  });
});
