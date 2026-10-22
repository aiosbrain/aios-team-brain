import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * L4 — THE CATCH-UP DEPLOYMENT IS A NEW SUBMISSION, and it is admitted like one.
 *
 * `serviceCatchup` received the owning tick's scope for the HEALTH WAIT only, which is a fact about a
 * moment that has already passed by the time the deployment is submitted: the attempt record, the
 * runner pin, the private-store construction and the prior-pair read all settle in between. A
 * shutdown observed during any of them therefore still deployed staging, and only the poll that
 * followed noticed it.
 *
 * The real `serviceCatchup` runs here — its real journal reads, its real prior-pair open, the real
 * re-seal and the real expected-ready probe. Only the transports are doubled.
 */

const PRIOR_RUN = "run-8";
const READY_COMMIT = "c".repeat(40);
const HEAD_COMMIT = "d".repeat(40);

const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const PRIOR_BYTES = Buffer.from(JSON.stringify({ envelope: "prior-bundle" }));
const PRIOR_DIGEST = sha(PRIOR_BYTES);
const PRIOR_OBJECT = `${PRIOR_RUN}--${PRIOR_DIGEST}`;

const observed = vi.hoisted(() => ({ catchupWrites: [] as unknown[], stores: 0 }));

vi.mock("../scripts/staging-ops/journal.mjs", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  acquireCoordinatorLock: async () => true,
  releaseCoordinatorLock: async () => {},
  readJournal: async () => ({
    state: "ready", run_id: PRIOR_RUN,
    last_ready_run_id: PRIOR_RUN, last_ready_object_id: PRIOR_OBJECT, last_ready_digest: PRIOR_DIGEST,
    last_ready_commit: READY_COMMIT, last_ready_mode: "copy-ready",
    catchup_commit: null, catchup_attempts: 0,
  }),
  recordCatchup: async (_client: unknown, patch: unknown) => { observed.catchupWrites.push(patch); },
}));

vi.mock("../scripts/staging-ops/object-store.mjs", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createPrivateStore: () => {
    observed.stores += 1;
    return {
      read: async () => PRIOR_BYTES,
      list: async () => [], putImmutable: async () => true, verify: async () => true,
      writePointer: async () => true, delete: async () => true,
    };
  },
}));

vi.mock("../scripts/staging-ops/bundle-crypto.mjs", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  openSignedEncryptedBundle: ({ bundle }: { bundle: { envelope?: string } }) => ({
    manifest: {
      kind: "staging-rollback", databaseMode: "sanitized", runId: PRIOR_RUN, mode: "copy-ready",
      // The prior pair is bound to the INSTALLED commit; the re-seal advances it to the branch head.
      targetCommit: bundle?.envelope === "sealed-bundle" ? HEAD_COMMIT : READY_COMMIT,
      captureEndedAt: "2026-09-01T00:00:00.000Z",
      build: { applicationCommit: READY_COMMIT, migrationSet: "any", schemaFingerprint: "f".repeat(64) },
    },
    payload: Buffer.from("prior"),
  }),
  createSignedEncryptedBundle: () => ({ envelope: "sealed-bundle" }),
}));

vi.mock("../scripts/staging-ops/bundle-format.mjs", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  validatePairManifest: () => ({ ok: true, errors: [] }),
}));
vi.mock("../scripts/staging-ops/build-identity.mjs", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  assertCompatibleBuildIdentity: () => true,
}));
vi.mock("../scripts/staging-ops/key-material.mjs", () => ({ keyMaterial: () => Buffer.alloc(32, 1) }));
vi.mock("../scripts/staging-ops/local-maintenance.mjs", () => ({
  // `readStagingHead` builds its own adapter, so the branch head is doubled here rather than injected.
  LocalMaintenance: class { async readStagingHead() { return HEAD_COMMIT; } },
}));

const { serviceCatchup } = await import("../scripts/staging-ops/importer.mjs");
const { createOperationBudget } = await import("../scripts/staging-ops/operation-deadline.mjs");

const ENV = Object.freeze({
  STAGING_MAINTENANCE_ADAPTER: "local", STAGING_OPS_ENVIRONMENT_ID: "staging-local",
  STAGING_APP_SERVICE_ID: "app-local", STAGING_GRAPHITI_SERVICE_ID: "graphiti-local",
  RAILWAY_STAGING_MAINTENANCE_TOKEN: "token",
  STAGING_IMPORTER_SERVICE_ID: "importer-local", STAGING_IMPORTER_IMAGE_DIGEST: `sha256:${"d".repeat(64)}`,
  STAGING_ORIGIN: "https://staging.example.com", STAGING_HEALTH_TOKEN: "t".repeat(32),
}) as unknown as NodeJS.ProcessEnv;

/** The abort a real SIGTERM produces — `recordSignalAbort`'s exact reason shape. */
const sigterm = () => Object.assign(new Error("importer received SIGTERM"), { code: "STAGING_OPERATION_ABORTED" });

/** The health answer a caught-up staging app gives: the journal never leaves `ready`. */
const caughtUpBody = { ok: true, mode: "copy-ready", commit: HEAD_COMMIT, refreshRunId: PRIOR_RUN };

function scenario({ cancelDuringPin = false } = {}) {
  const controller = new AbortController();
  const statements: string[] = [];
  const client = { query: vi.fn(async (sql: string) => { statements.push(String(sql)); return { rows: [] }; }) };
  const maintenance = {
    // The PIN RESOLUTION — one of the awaited pre-deploy steps a shutdown can land in.
    assertPinnedRunnerConfiguration: vi.fn(async () => { if (cancelDuringPin) controller.abort(sigterm()); }),
    deployApp: vi.fn(async () => "dep-1"),
    readDeployment: vi.fn(async () => ({ id: "dep-1", status: "SUCCESS" })),
  };
  const fetchImpl = vi.fn(async () => Response.json(caughtUpBody, { status: 200 }));
  vi.stubGlobal("fetch", fetchImpl);
  const budget = createOperationBudget("importer daemon tick", 60_000);
  const run = () => serviceCatchup({ client, maintenance, env: ENV, budget, signal: controller.signal });
  return { client, maintenance, fetchImpl, controller, statements, run };
}

afterEach(() => {
  observed.catchupWrites.length = 0;
  observed.stores = 0;
  vi.unstubAllGlobals();
});

describe("catch-up admits its deployment against the owning scope", () => {
  it("does not deploy when the shutdown landed during the pre-deploy pin and prior-pair read", async () => {
    const context = scenario({ cancelDuringPin: true });

    await expect(context.run()).rejects.toMatchObject({ code: "STAGING_OPERATION_ABORTED" });

    // The submission is what the check exists to prevent — and the health probe that would have
    // followed it never runs either.
    expect(context.maintenance.deployApp, "a withdrawn catch-up deployed staging anyway").not.toHaveBeenCalled();
    expect(context.fetchImpl, "a deployment that was never submitted was health-polled").not.toHaveBeenCalled();
    // The awaited pre-deploy work really did complete, so the refusal is the new boundary rather
    // than an earlier one: the pin ran and the prior pair was read from its private store.
    expect(context.maintenance.assertPinnedRunnerConfiguration).toHaveBeenCalledTimes(1);
    expect(observed.stores, "the prior-pair read never happened").toBe(1);
    // ATTEMPT ACCOUNTING IS UNCHANGED: this is a cancellation boundary, not an undo. The attempt
    // this call consumed stands, against a head that will still be there for the next tick.
    expect(observed.catchupWrites).toEqual([{ commit: HEAD_COMMIT, attempts: 1 }]);
  });

  it("is not vacuous: the same catch-up deploys and completes with no cancellation", async () => {
    const context = scenario();

    await expect(context.run()).resolves.toMatchObject({ status: "caught-up", commit: HEAD_COMMIT });
    expect(context.maintenance.deployApp).toHaveBeenCalledWith(HEAD_COMMIT);
    expect(context.fetchImpl).toHaveBeenCalledTimes(1);
    // The journal advances to the caught-up identity: the ready-state behaviour this boundary leaves
    // exactly as it was.
    expect(context.statements.some((sql) => /catchup_commit=NULL/.test(sql))).toBe(true);
  });
});
