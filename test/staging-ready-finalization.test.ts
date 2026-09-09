import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { credentialFingerprint } from "../scripts/staging-ops/credential-fingerprint.mjs";
import { parseReceipts } from "../scripts/staging-ops/receipts.mjs";

/**
 * THE DISPATCHER'S REPORTING BOUNDARY (`late-cancel-reporting-gap-45ab5dc4.md`).
 *
 * `runImporter`'s `finally` threw a generic `STAGING_OPERATION_ABORTED` whenever the shutdown was
 * aborted — after the action had already settled. A SIGTERM delivered during post-ready bookkeeping
 * therefore erased BOTH truthful outcomes of a committed, serving pair: the ready result, and the
 * informative "ready and serving; post-ready bookkeeping remains pending" error. The CLI printed
 * only `staging importer refused: …`, for a deployment that was up.
 *
 * These drive the REAL `runImporter` down the REAL install branch to the REAL `markReady` boundary,
 * and emit the process signal its own registered handlers observe. The helper-level test in
 * `staging-late-cancel-boot.test.ts` calls `installObject` directly and never traverses this
 * `finally`, so it cannot see the replacement. Only the transports are doubled.
 */

const COMMIT = "c".repeat(40);
const RUN_ID = "run-9";
const PRIOR_RUN = "run-8";
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

const SOURCE_BYTES = Buffer.from(JSON.stringify({ envelope: "source-bundle" }));
const PRIOR_BYTES = Buffer.from(JSON.stringify({ envelope: "prior-bundle" }));
const SOURCE_OBJECT = `${RUN_ID}--${sha(SOURCE_BYTES)}`;
const PRIOR_OBJECT = `${PRIOR_RUN}--${sha(PRIOR_BYTES)}`;

const hooks = vi.hoisted(() => ({
  /** Called inside the REAL post-ready reconciliation, i.e. strictly after `markReady` returned. */
  duringReconciliation: null as null | (() => void),
  /** Called while the read-only destination SELECT is in flight. */
  duringDestinationRead: null as null | (() => void),
  /**
   * The status the platform reports for the deployment currently being polled. Defaults to a healthy
   * deployment; the recovery-failure control answers `FAILED` for the RESTORATION's deployment only,
   * so the prior pair's boot cannot confirm ready.
   */
  deploymentStatus: null as null | (() => string),
}));

const observed = vi.hoisted(() => ({
  clients: [] as { statements: string[]; ended: number; endedWhileQueryPending: boolean; pending: number; connection: { stream: { destroyed: boolean; remoteAddress: string; destroy: () => void } } }[],
  transitions: [] as string[],
  readyCommits: 0,
  /** WHICH run each `markReady` committed — a candidate ready and the prior's are not interchangeable. */
  readyCommitRuns: [] as string[],
  deploys: 0,
  stops: 0,
}));

vi.mock("pg", () => {
  class Client {
    statements: string[] = [];
    ended = 0;
    endedWhileQueryPending = false;
    pending = 0;
    connection = { stream: { destroyed: false, remoteAddress: "10.0.0.9", destroy: () => { this.connection.stream.destroyed = true; } } };
    connectionParameters: { host: string; port: number; database: string; user: string };
    constructor(config: { connectionString?: string } = {}) {
      const parsed = new URL(config.connectionString ?? "postgresql://app:pw@staging-pg:5432/brain");
      this.connectionParameters = { host: parsed.hostname, port: Number(parsed.port), database: parsed.pathname.slice(1), user: parsed.username };
      observed.clients.push(this as never);
    }
    async connect() { /* connected by construction */ }
    async end() { this.ended += 1; if (this.pending > 0) this.endedWhileQueryPending = true; }
    async query(sql: string) {
      this.statements.push(String(sql));
      this.pending += 1;
      try {
        if (String(sql).includes("inet_server_addr")) {
          hooks.duringDestinationRead?.();
          return { rows: [{ database: this.connectionParameters.database, server_address: "10.0.0.9", server_port: this.connectionParameters.port, backend_pid: 71 }] };
        }
        if (String(sql).includes("forbidden_count")) return { rows: [{ forbidden_count: 0 }] };
        return { rows: [{}] };
      } finally { this.pending -= 1; }
    }
    on() { /* the double emits no errors */ }
  }
  return { default: { Client }, Client };
});

vi.mock("neo4j-driver", () => ({
  default: {
    driver: () => ({ session: () => ({ run: async () => ({ records: [] }), close: async () => {} }), close: async () => {} }),
    auth: { basic: () => ({}) },
    session: { READ: "READ", WRITE: "WRITE" },
    int: (value: unknown) => value,
  },
}));

// The journal is the DURABLE COMMIT this test is about, so its statements are doubled and its calls
// are the oracle: `markReady` returning is what makes the outcome a confirmed ready commit.
vi.mock("../scripts/staging-ops/journal.mjs", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  acquireCoordinatorLock: async () => true,
  releaseCoordinatorLock: async () => {},
  hasCoordinatorLock: async () => true,
  hasExclusiveDataUseLock: async () => true,
  acquireDataUseLock: async () => true,
  releaseDataUseLock: async () => {},
  readJournal: async () => ({
    state: "ready", run_id: PRIOR_RUN,
    last_ready_run_id: PRIOR_RUN, last_ready_object_id: PRIOR_OBJECT, last_ready_digest: sha(PRIOR_BYTES),
    last_ready_commit: COMMIT, last_ready_mode: "copy-ready",
    source_watermark: null, rollback_target_run_id: null,
  }),
  transitionJournal: async (_client: unknown, { to }: { to: string }) => { observed.transitions.push(to); return { state: to }; },
  markReady: async (_client: unknown, { runId, objectId, digest, commit, mode }: Record<string, string>) => {
    observed.readyCommits += 1;
    observed.readyCommitRuns.push(runId);
    return { state: "ready", run_id: runId, last_ready_run_id: runId, last_ready_object_id: objectId, last_ready_digest: digest, last_ready_commit: commit, last_ready_mode: mode };
  },
  readSourceAttempt: async () => null,
  recordSourceAttempt: async () => {},
  completeSourceAttempt: async () => {},
  withdrawSourceAttempt: async () => {},
  // Inside the REAL `reconcileReadyInstall`, after the commit: the window the shutdown lands in.
  recordSourceWatermark: async () => { hooks.duringReconciliation?.(); },
  recordCatchup: async () => {},
  clearRollbackTarget: async () => ({ state: "ready" }),
}));

vi.mock("../scripts/staging-ops/object-store.mjs", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createPrivateStore: () => ({
    read: async (objectId: string) => (objectId === PRIOR_OBJECT ? PRIOR_BYTES : SOURCE_BYTES),
    list: async () => [],
    putImmutable: async () => true, verify: async () => true,
    writePointer: async () => true, delete: async () => true,
  }),
}));

/** Signed-envelope verification is not what this boundary is about; identity still is. */
vi.mock("../scripts/staging-ops/bundle-crypto.mjs", async (importOriginal) => {
  const fingerprints = (secret: string) => Object.fromEntries([
    ["auth-secret", secret], ["secrets-key", `${secret}-key`], ["neo4j-credential", `${secret}\0${secret}`],
  ].map(([credentialClass, value]) => [credentialClass, credentialFingerprint({
    credentialClass, value, comparisonKey: Buffer.alloc(32, 3), keyId: "example-key",
  })]));
  const build = { applicationCommit: COMMIT, migrationSet: "any", schemaFingerprint: "f".repeat(64) };
  return {
    ...(await importOriginal<Record<string, unknown>>()),
    openSignedEncryptedBundle: ({ bundle }: { bundle: { envelope?: string } }) => (bundle?.envelope === "prior-bundle"
      ? { manifest: { kind: "staging-rollback", databaseMode: "sanitized", runId: PRIOR_RUN, mode: "copy-ready", targetCommit: COMMIT, captureEndedAt: "2026-09-01T00:00:00.000Z", build }, payload: Buffer.from("prior") }
      : { manifest: { kind: "staging-source", databaseMode: "sanitized", runId: RUN_ID, mode: "copy-ready", captureEndedAt: "2026-09-08T00:00:00.000Z", credentialFingerprints: fingerprints("production"), build }, payload: Buffer.from("source") }),
    createSignedEncryptedBundle: () => ({ envelope: "sealed-bundle" }),
  };
});

vi.mock("../scripts/staging-ops/bundle-format.mjs", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  validatePairManifest: () => ({ ok: true, errors: [] }),
  unpackPair: async () => ({ nodes: [], relationships: [], codecVersion: 1 }),
}));
vi.mock("../scripts/staging-ops/graph-bundle.mjs", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  exportGraph: async () => ({ nodes: [], relationships: [], codecVersion: 1 }),
}));
vi.mock("../scripts/staging-ops/build-identity.mjs", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  assertCompatibleBuildIdentity: () => true,
  assertInstalledSchemaMatches: () => true,
}));
vi.mock("../scripts/schema-fingerprint.mjs", () => ({ fingerprint: async () => [] }));
vi.mock("../scripts/staging-ops/neo4j-replace.mjs", () => ({
  replaceNeo4jGraph: async () => ({ nodes: 0, relationships: 0 }),
  assertReplaceTarget: () => true,
}));
vi.mock("../scripts/staging-ops/pg-paired.mjs", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  restorePairedPostgres: async () => true,
  restoreRollbackPostgres: async () => true,
  resetSessionTransactionState: async () => ({ status: "reset" }),
}));
vi.mock("../scripts/staging-ops/exporter.mjs", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  snapshotExportFacts: async () => ({}),
  assertResolvedCorrectionScopes: () => true,
  validateLedgerAgainstSanitizedGraph: () => true,
}));
vi.mock("../scripts/staging-ops/bounded-process.mjs", () => ({ runBoundedProcess: async () => ({ stdout: "", stderr: "" }) }));
vi.mock("../scripts/staging-ops/role-policy.mjs", () => ({ assertRunnerRole: () => true, assertOutboundCredentialIsolation: () => true }));
vi.mock("../scripts/staging-ops/key-material.mjs", () => ({ keyMaterial: () => Buffer.alloc(32, 1) }));
vi.mock("../scripts/staging-ops/action-preflight.mjs", () => ({ assertActionConfiguration: () => true }));
vi.mock("../scripts/staging-ops/local-maintenance.mjs", () => ({
  LocalMaintenance: class {
    appServiceId = "app-local";
    async stopAndVerifyAll() { observed.stops += 1; return true; }
    async tokenIdentity() { return { environmentId: "staging-local" }; }
    async listActiveDeployments() { return [{ id: "dep-1", status: "SUCCESS" }]; }
    async readDeployment() { return { id: "dep-1", status: hooks.deploymentStatus?.() ?? "SUCCESS" }; }
    async deployApp() { observed.deploys += 1; return "dep-1"; }
    async assertPinnedRunnerConfiguration() { return true; }
    async readStagingHead() { return COMMIT; }
  },
}));

const { runImporter } = await import("../scripts/staging-ops/importer.mjs");

const ENV = Object.fromEntries([
  ["STAGING_OPS_ROLE", "importer"], ["STAGING_MAINTENANCE_ADAPTER", "local"],
  ["DATABASE_URL", "postgres://app:pw@staging-pg:5432/brain"],
  ["STAGING_COMPARISON_KEY_BASE64", Buffer.alloc(32, 3).toString("base64")],
  ["STAGING_COMPARISON_KEY_ID", "example-key"],
  ["STAGING_NEO4J_SERVICE_NAME", "staging-neo4j"], ["STAGING_NEO4J_DATABASE", "neo4j"],
  ["NEO4J_URL", "bolt://staging-neo4j:7687"], ["NEO4J_USER", "neo4j"], ["NEO4J_PASSWORD", "staging-secret"],
  ["NEO4J_DATABASE", "neo4j"], ["AUTH_SECRET", "staging-auth"], ["SECRETS_KEY", "staging-secrets"],
  ["STAGING_OPS_ENVIRONMENT_ID", "staging-local"], ["RAILWAY_ENVIRONMENT_ID", "staging-local"],
  ["RAILWAY_PROJECT_ID", "local-project"], ["STAGING_APP_SERVICE_ID", "app-local"],
  ["STAGING_GRAPHITI_SERVICE_ID", "graphiti-local"], ["RAILWAY_STAGING_MAINTENANCE_TOKEN", "token"],
  ["STAGING_IMPORTER_SERVICE_ID", "importer-local"], ["STAGING_IMPORTER_IMAGE_DIGEST", `sha256:${"d".repeat(64)}`],
  ["STAGING_ORIGIN", "https://staging.example.com"], ["STAGING_HEALTH_TOKEN", "t".repeat(32)],
  ["STAGING_DATA_LOCK_TIMEOUT_MS", "5000"],
]) as unknown as NodeJS.ProcessEnv;

const healthyBoot = () => vi.stubGlobal("fetch", vi.fn(async () => Response.json({ booted: true, commit: COMMIT }, { status: 202 })));

/**
 * The CANDIDATE's boot probe, held open until the test releases it — the window a late signal lands
 * in. Every later probe (the restoration's own boot) answers healthily and immediately, so the
 * recovery this test is about is not itself starved by the harness.
 */
function heldCandidateProbe() {
  let release!: () => void;
  let observe!: () => void;
  const inFlight = new Promise<void>((resolve) => { observe = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  const fetchImpl = vi.fn(async () => {
    calls += 1;
    if (calls === 1) { observe(); await gate; }
    return Response.json({ booted: true, commit: COMMIT }, { status: 202 });
  });
  vi.stubGlobal("fetch", fetchImpl);
  return { fetchImpl, inFlight, release };
}

/** Run the real dispatcher, capturing its receipts and whichever way it settled. */
async function install() {
  const lines: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((line: string) => void lines.push(line));
  try {
    const outcome = await runImporter(ENV, ["install", SOURCE_OBJECT]).then((result) => ({ result }), (error: Error) => ({ error }));
    return { ...outcome, receipts: parseReceipts(lines.join("\n")) };
  } finally { log.mockRestore(); }
}

const kinds = (receipts: { kind: string }[]) => receipts.map((receipt) => receipt.kind);

afterEach(() => {
  hooks.duringReconciliation = null;
  hooks.duringDestinationRead = null;
  hooks.deploymentStatus = null;
  observed.clients.length = 0;
  observed.transitions.length = 0;
  observed.readyCommits = 0;
  observed.readyCommitRuns.length = 0;
  observed.deploys = 0;
  observed.stops = 0;
  vi.unstubAllGlobals();
});

describe("a signal after the ready commit does not erase the outcome it arrived too late for", () => {
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    it(`${signal} during post-ready bookkeeping still reports the committed ready identity`, async () => {
      // (a) The bookkeeping SUCCEEDS. Before this fix the finalizer replaced this whole result with
      // `staging importer stopped after coordinated signal cancellation`, and the CLI printed a
      // refusal for a deployment that was serving.
      healthyBoot();
      hooks.duringReconciliation = () => { process.emit(signal as never); };
      const { result, error, receipts } = await install();

      expect(error, `${signal} after the commit was reported as a refusal`).toBeUndefined();
      expect(result).toMatchObject({
        status: "ready", runId: RUN_ID, commit: COMMIT,
        readyCommit: { runId: RUN_ID, commit: COMMIT, bookkeeping: "completed" },
      });
      expect(observed.readyCommits, "the real ready commit never happened").toBe(1);
      // NO ROLLBACK: the committed pair was neither failed nor restored, and nothing redeployed.
      expect(observed.transitions).toEqual(["draining", "importing", "verifying", "booting"]);
      expect(kinds(receipts)).not.toContain("prior-pair-restored");
      expect(observed.deploys).toBe(1);
      // BOUNDED CLEANUP: the one owned connection, closed once, not under its own query.
      expect(observed.clients).toHaveLength(1);
      expect(observed.clients[0].ended).toBe(1);
      expect(observed.clients[0].endedWhileQueryPending).toBe(false);
    }, 20_000);

    it(`${signal} during FAILING post-ready bookkeeping keeps the pending outcome, not a generic refusal`, async () => {
      // (b) The informative error is the one the operator needs: the pair is serving, the suffix is
      // not done. A cancellation must not overwrite it, and must not convert it into success either.
      healthyBoot();
      hooks.duringReconciliation = () => {
        process.emit(signal as never);
        throw new Error("catch-up head read failed");
      };
      const { result, error, receipts } = await install();

      expect(result).toBeUndefined();
      expect(error?.message).toMatch(/ready and serving; post-ready bookkeeping remains pending/);
      expect((error as { code?: string })?.code, "the pending failure was replaced by the generic abort").toBeUndefined();
      expect((error as { readyCommit?: unknown })?.readyCommit).toEqual({
        runId: RUN_ID, objectId: expect.stringContaining(`${RUN_ID}--`), commit: COMMIT, bookkeeping: "pending",
      });
      expect(observed.readyCommits).toBe(1);
      expect(observed.transitions, "a serving pair was failed or rolled back").toEqual(["draining", "importing", "verifying", "booting"]);
      expect(kinds(receipts)).toContain("ready-bookkeeping-pending");
      expect(kinds(receipts)).not.toContain("prior-pair-restored");
      expect(observed.clients[0].ended).toBe(1);
    }, 20_000);
  }

  it("is not vacuous: the same install reports ready when no signal arrives", async () => {
    healthyBoot();
    const { result, error } = await install();
    expect(error).toBeUndefined();
    expect(result).toMatchObject({ status: "ready", readyCommit: { bookkeeping: "completed" } });
    expect(observed.readyCommits).toBe(1);
  }, 20_000);

  it("a cancelled read-only verify-target owns no commit and is still reported as cancelled", async () => {
    // (c) The discriminating control. `verify-target` writes nothing, so there is no ready identity
    // to preserve and the coordinated cancellation remains the honest outcome.
    hooks.duringDestinationRead = () => { process.emit("SIGTERM" as never); };
    const outcome = await runImporter(ENV, ["verify-target"]).then(() => null, (error: Error) => error);

    expect(outcome).toMatchObject({ code: "STAGING_OPERATION_ABORTED", terminationConfirmed: true });
    expect(observed.readyCommits, "a read-only check committed ready").toBe(0);
    expect(observed.transitions, "a read-only check wrote the journal").toEqual([]);
    expect(observed.clients).toHaveLength(1);
    expect(observed.clients[0].ended).toBe(1);
  }, 20_000);
});

/**
 * THE OTHER OUTCOME THAT OWNS A CONFIRMED READY COMMIT: the RESTORATION's.
 *
 * A signal during the candidate's boot is a failed install — but the recovery that follows boots the
 * prior pair and `markReady` commits it, so staging IS serving a known identity when `installObject`
 * throws "the prior pair was restored". That error carried no marker, so this same `finally` replaced
 * the one message naming what is serving with `STAGING_OPERATION_ABORTED`.
 *
 * These run the REAL dispatcher: the process signal, its registered handlers, the real
 * `installObject` recovery branch, the real `rollbackToPrior` and the real finalizer. An
 * `installObject`-level test with a rollback double returns no marker at all and cannot see this gap.
 */
describe("a cancelled candidate install keeps the restoration's confirmed ready identity", () => {
  /** Cancel the candidate's boot mid-probe, then let the restoration proceed on its fresh scope. */
  async function cancelDuringCandidateBoot(signal: "SIGTERM" | "SIGINT") {
    const { inFlight, release } = heldCandidateProbe();
    const running = install();
    await inFlight;
    process.emit(signal as never);
    release();
    return running;
  }

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    it(`${signal} during the candidate boot still reports the restored prior identity`, async () => {
      const { result, error, receipts } = await cancelDuringCandidateBoot(signal);

      expect(result, "a failed candidate install was reported as a success").toBeUndefined();
      expect(error?.message).toMatch(/paired refresh failed and the prior pair was restored/);
      expect((error as { code?: string })?.code, "the restoration outcome was replaced by the generic abort").toBeUndefined();
      // The marker is the RESTORED PRIOR's, exactly as `rollbackToPrior` latched it — including the
      // bookkeeping state, which completed here.
      expect((error as { readyCommit?: unknown })?.readyCommit).toEqual({
        runId: PRIOR_RUN, objectId: PRIOR_OBJECT, commit: COMMIT, bookkeeping: "completed",
      });
      // The candidate itself is NOT ready: the only commit is the one the recovery made.
      expect(observed.readyCommitRuns).toEqual([PRIOR_RUN]);
      expect(kinds(receipts)).toContain("prior-pair-restored");
      expect(kinds(receipts)).not.toContain("recovery-required");
      expect(kinds(receipts)).not.toContain("ready-bookkeeping-pending");
      // The candidate failed and the prior pair went back through the real two-store recovery.
      expect(observed.transitions).toEqual([
        "draining", "importing", "verifying", "booting",
        "failed", "draining", "importing", "verifying", "booting",
      ]);
      // ONE coordinated cleanup of the ONE owned client, not closed under its own query.
      expect(observed.clients).toHaveLength(1);
      expect(observed.clients[0].ended).toBe(1);
      expect(observed.clients[0].endedWhileQueryPending).toBe(false);
    }, 20_000);
  }

  it("fabricates nothing when the recovery cannot confirm ready", async () => {
    // The negative control, and the reason the marker above is evidence rather than decoration: the
    // SAME cancellation with a restoration that never reaches `markReady` must fail with no marker.
    // The prior pair's own deployment is dead, so nothing is serving a known identity.
    hooks.deploymentStatus = () => (observed.deploys >= 2 ? "FAILED" : "SUCCESS");
    const { result, error, receipts } = await cancelDuringCandidateBoot("SIGTERM");

    expect(result).toBeUndefined();
    expect((error as { readyCommit?: unknown })?.readyCommit, "a ready marker was invented for a restoration that never committed").toBeUndefined();
    expect(observed.readyCommitRuns, "something was committed ready after a failed restoration").toEqual([]);
    expect(kinds(receipts)).toContain("recovery-required");
    expect(kinds(receipts)).not.toContain("prior-pair-restored");
    // Owning no commit at all, the run is still reported as the coordinated cancellation it is.
    expect(error).toMatchObject({ code: "STAGING_OPERATION_ABORTED", terminationConfirmed: true });
    expect(observed.clients).toHaveLength(1);
    expect(observed.clients[0].ended).toBe(1);
  }, 20_000);

  it("is not vacuous: the same install with no signal never reaches the restoration at all", async () => {
    const { fetchImpl, inFlight, release } = heldCandidateProbe();
    const running = install();
    await inFlight;
    release();
    const { result, error } = await running;

    expect(error).toBeUndefined();
    expect(result).toMatchObject({ status: "ready", runId: RUN_ID, readyCommit: { runId: RUN_ID, bookkeeping: "completed" } });
    expect(observed.readyCommitRuns).toEqual([RUN_ID]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  }, 20_000);
});
