import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseReceipts } from "../scripts/staging-ops/receipts.mjs";

/**
 * BOOTSTRAP'S OWN READY-COMMIT BOUNDARY, on both sides of `markReady`.
 *
 * `adjudication-45ab-bootstrap-cancel.md` (pre-ready) and `reporting-closure-83d16394.md`
 * (post-ready) describe one seam that bootstrap alone did not implement. `bootExact` — which the
 * install and rollback paths use — checks the signal and the budget immediately before submitting
 * ready, and its callers latch the returned row. Bootstrap builds its own sequence and had neither:
 *
 *  - PRE-READY: it awaited the boot health probe (signal-aware), then awaited
 *    `rollbackStore.writePointer("last-ready", …)`, then submitted `markReady` with nothing in
 *    between. A health check made BEFORE an asynchronous storage operation cannot establish
 *    cancellation status AFTER it, so a SIGTERM or a phase deadline observed while that write was
 *    pending still produced a new bootstrap ready commit when the write returned.
 *  - POST-READY: it discarded `markReady`'s return, so a signal during the interruption-record clear
 *    made `runImporter`'s finalizer replace a durable bootstrap success with a generic
 *    `STAGING_OPERATION_ABORTED`; and with no confirmed-ready latch, a FAILING clear fell into the
 *    pre-ready baseline recovery, which redeploys the baseline and writes the journal `failed` —
 *    about a checkpoint that is committed and serving.
 *
 * These drive the REAL `runImporter` down the REAL `bootstrap-rollback` branch to the REAL
 * `markReady` boundary, holding the REAL `writePointer` dependency pending across the window that
 * used to be unguarded. Only the transports are doubled; `bootstrapResumeVerdict`, the object
 * identity/read-back checks and both boundary decisions stay real. A source-string guard cannot see
 * any of this, because the defect is about WHEN the check runs relative to an await.
 */

const COMMIT = "c".repeat(40);
const RESUMED_RUN = "bootstrap-2026-09-08T00-00-00-000Z";

/**
 * The budget clock, injected into `runImporter`. It is FROZEN unless a test advances it, so the
 * phase deadline can be breached at one exact await without a wall-clock race — and without the
 * watchdog (whose `setTimeout` is measured in real milliseconds from arm time) also firing, which is
 * what keeps "the budget expired" distinguishable from "the operator sent a signal".
 */
const clock = vi.hoisted(() => ({ ms: 0 }));

const hooks = vi.hoisted(() => ({
  /** Awaited INSIDE the real `writePointer`, i.e. while the publication is genuinely pending. */
  duringPointerWrite: null as null | (() => Promise<void>),
  /** Called inside `clearBootstrapRecovery`, i.e. strictly after `markReady` returned. */
  duringClear: null as null | (() => void),
}));

const journalState = vi.hoisted(() => ({
  row: {} as Record<string, unknown>,
}));

const observed = vi.hoisted(() => ({
  clients: [] as { ended: number; endedWhileQueryPending: boolean; pending: number; connection: { stream: { destroyed: boolean; destroy: () => void } } }[],
  transitions: [] as string[],
  checkpoints: [] as (string | null)[],
  drainings: 0,
  recordedRecoveries: 0,
  clears: 0,
  readyCommits: 0,
  readyRunIds: [] as string[],
  pointerWrites: [] as { name: string; value: Record<string, unknown> }[],
  deploys: 0,
  stops: 0,
}));

const store = vi.hoisted(() => ({ objects: new Map<string, Buffer>() }));

vi.mock("pg", () => {
  class Client {
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
      this.pending += 1;
      try {
        if (String(sql).includes("inet_server_addr")) {
          return { rows: [{ database: this.connectionParameters.database, server_address: "10.0.0.9", server_port: this.connectionParameters.port, backend_pid: 71 }] };
        }
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

// `markReady` returning is what makes an outcome a confirmed ready commit, and `clearBootstrapRecovery`
// is the fallible suffix that follows it — so both are the oracle here. `bootstrapResumeVerdict` is
// deliberately NOT doubled: the resumed case must earn its identity through the real verdict.
vi.mock("../scripts/staging-ops/journal.mjs", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  installStagingOps: async () => true,
  acquireCoordinatorLock: async () => true,
  releaseCoordinatorLock: async () => {},
  hasCoordinatorLock: async () => true,
  hasExclusiveDataUseLock: async () => true,
  acquireDataUseLock: async () => true,
  releaseDataUseLock: async () => {},
  readJournal: async () => journalState.row,
  transitionJournal: async (_client: unknown, { to, patch }: { to: string; patch?: { lastSafeCheckpoint?: string } }) => {
    observed.transitions.push(to);
    observed.checkpoints.push(patch?.lastSafeCheckpoint ?? null);
    return { state: to };
  },
  beginBootstrapDraining: async () => { observed.drainings += 1; return { state: "draining" }; },
  recordBootstrapRecovery: async () => { observed.recordedRecoveries += 1; return { state: "draining" }; },
  clearBootstrapRecovery: async (_client: unknown, runId: string) => {
    observed.clears += 1;
    hooks.duringClear?.();
    return { state: "ready", run_id: runId };
  },
  markReady: async (_client: unknown, { runId, objectId, digest, commit, mode }: Record<string, string>) => {
    observed.readyCommits += 1;
    observed.readyRunIds.push(runId);
    return { state: "ready", run_id: runId, last_ready_run_id: runId, last_ready_object_id: objectId, last_ready_digest: digest, last_ready_commit: commit, last_ready_mode: mode };
  },
}));

// A REAL in-memory object store: `putImmutable`/`verify`/`read` keep the checkpoint's digest and
// read-back identity checks honest, and `writePointer` is the dependency these tests hold pending.
vi.mock("../scripts/staging-ops/object-store.mjs", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createPrivateStore: () => ({
    read: async (objectId: string) => store.objects.get(objectId),
    list: async () => [...store.objects.keys()],
    putImmutable: async (objectId: string, bytes: Buffer) => { store.objects.set(objectId, bytes); return true; },
    verify: async (objectId: string, digest: string) => {
      const bytes = store.objects.get(objectId);
      return Boolean(bytes) && createHash("sha256").update(bytes as Buffer).digest("hex") === digest;
    },
    // The hold happens BEFORE the publication is recorded, so the test acts while the write is
    // genuinely pending and the write still SUCCEEDS afterwards — the exact window the boundary
    // check exists for. A cancellation must not race, abandon or delete this.
    writePointer: async (name: string, value: Record<string, unknown>) => {
      await hooks.duringPointerWrite?.();
      observed.pointerWrites.push({ name, value });
      return true;
    },
    delete: async (objectId: string) => store.objects.delete(objectId),
  }),
}));

/** The sealed envelope carries its own manifest, so the real read-back identity check has teeth. */
vi.mock("../scripts/staging-ops/bundle-crypto.mjs", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createSignedEncryptedBundle: ({ manifest }: { manifest: unknown }) => ({ envelope: "sealed-bootstrap", manifest }),
  openSignedEncryptedBundle: ({ bundle }: { bundle: { manifest: unknown } }) => ({ manifest: bundle.manifest, payload: Buffer.alloc(0) }),
  rollbackOpeningProvenance: () => ({ authenticated: true, signerPurpose: "rollback" }),
}));

vi.mock("../scripts/staging-ops/bundle-format.mjs", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  validatePairManifest: () => ({ ok: true, errors: [] }),
  packPair: async () => ({ payload: Buffer.alloc(0), checksums: { postgres: "p", graph: "g" } }),
}));
vi.mock("../scripts/staging-ops/graph-bundle.mjs", async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  return { ...original, exportGraph: async () => ({ nodes: [], relationships: [], codecVersion: original.GRAPH_CODEC_VERSION }) };
});
vi.mock("../scripts/staging-ops/build-identity.mjs", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loaderCapabilityIdentity: () => ({ migrationSet: "harness-migration-set" }),
  schemaFingerprintDigest: () => "f".repeat(64),
}));
vi.mock("../scripts/schema-fingerprint.mjs", () => ({ fingerprint: async () => [] }));
vi.mock("../scripts/staging-ops/pg-paired.mjs", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  captureRollbackPostgres: async () => true,
  resetSessionTransactionState: async () => ({ status: "reset" }),
}));
vi.mock("../scripts/staging-ops/private-store.mjs", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  withPrivateTempDir: async (_prefix: string, body: (directory: string) => Promise<unknown>) => body("bootstrap-harness-directory"),
}));
vi.mock("../scripts/staging-ops/role-policy.mjs", () => ({ assertRunnerRole: () => true, assertOutboundCredentialIsolation: () => true }));
vi.mock("../scripts/staging-ops/key-material.mjs", () => ({ keyMaterial: () => Buffer.alloc(32, 1) }));
vi.mock("../scripts/staging-ops/action-preflight.mjs", () => ({ assertActionConfiguration: () => true }));
vi.mock("../scripts/staging-ops/local-maintenance.mjs", () => ({
  LocalMaintenance: class {
    appServiceId = "app-local";
    async stopAndVerifyAll() { observed.stops += 1; return true; }
    async tokenIdentity() { return { environmentId: "staging-local" }; }
    async listActiveDeployments() { return [{ id: "dep-1", status: "SUCCESS", meta: { commitHash: COMMIT, createdAt: "2026-09-07T00:00:00Z" } }]; }
    async readDeployment() { return { id: "dep-2", status: "SUCCESS" }; }
    async deployApp() { observed.deploys += 1; return `dep-${observed.deploys + 1}`; }
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
  ["STAGING_DATA_LOCK_TIMEOUT_MS", "1000"], ["STAGING_BOOTSTRAP_MODE", "copy-ready"],
]) as unknown as NodeJS.ProcessEnv;

/** A first bootstrap: nothing is ready, and no interrupted bootstrap is recorded. */
const FRESH_JOURNAL = {
  state: "idle", run_id: null, last_ready_run_id: null, last_ready_object_id: null,
  last_ready_digest: null, last_ready_commit: null, last_ready_mode: null,
  bootstrap_run_id: null, bootstrap_phase: null,
};

/**
 * A bootstrap killed after its verified stop, before publication. The REAL `bootstrapResumeVerdict`
 * accepts it, so the run identity below comes from the record — which is how the ready marker proves
 * it is not hard-coded to a freshly generated `bootstrap-<timestamp>`.
 */
const RESUMED_JOURNAL = {
  ...FRESH_JOURNAL,
  state: "draining", run_id: RESUMED_RUN,
  bootstrap_run_id: RESUMED_RUN, bootstrap_phase: "stopping",
  bootstrap_commit: COMMIT, bootstrap_mode: "copy-ready", bootstrap_deployment_id: "dep-0",
  bootstrap_environment_id: "staging-local", bootstrap_app_service_id: "app-local",
  bootstrap_object_id: null, bootstrap_digest: null,
};

const healthyBoot = () => vi.stubGlobal("fetch", vi.fn(async () => Response.json({ booted: true, commit: COMMIT }, { status: 202 })));

/** Hold the pointer publication pending, act mid-flight, then let it SUCCEED. */
const holdPointerThen = (act: () => void) => async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  act();
  await new Promise((resolve) => setTimeout(resolve, 0));
};

/** Run the real dispatcher's bootstrap branch on the injected budget clock. */
async function bootstrap() {
  const lines: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((line: string) => void lines.push(line));
  try {
    const outcome = await runImporter(ENV, ["bootstrap-rollback"], { now: () => clock.ms })
      .then((result) => ({ result }), (error: Error) => ({ error }));
    return { ...outcome, receipts: parseReceipts(lines.join("\n")) } as { result?: Record<string, unknown>; error?: Error; receipts: { kind: string }[] };
  } finally { log.mockRestore(); }
}

const kinds = (receipts: { kind: string }[]) => receipts.map((receipt) => receipt.kind);

afterEach(() => {
  clock.ms = 0;
  hooks.duringPointerWrite = null;
  hooks.duringClear = null;
  journalState.row = { ...FRESH_JOURNAL };
  store.objects.clear();
  observed.clients.length = 0;
  observed.transitions.length = 0;
  observed.checkpoints.length = 0;
  observed.pointerWrites.length = 0;
  observed.readyRunIds.length = 0;
  observed.drainings = 0;
  observed.recordedRecoveries = 0;
  observed.clears = 0;
  observed.readyCommits = 0;
  observed.deploys = 0;
  observed.stops = 0;
  vi.unstubAllGlobals();
});

describe("bootstrap does not submit ready for permission withdrawn while the pointer write was pending", () => {
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    it(`${signal} delivered during the last-ready publication prevents the bootstrap ready commit`, async () => {
      healthyBoot();
      journalState.row = { ...FRESH_JOURNAL };
      hooks.duringPointerWrite = holdPointerThen(() => { process.emit(signal as never); });

      const { result, error, receipts } = await bootstrap();

      // THE ASSERTION. Health passed before the signal; the signal landed while the storage write was
      // in flight; the write then succeeded. Nothing between them used to observe the cancellation.
      expect(observed.readyCommits, "a bootstrap ready commit was submitted after the signal").toBe(0);
      expect(observed.clears, "the interruption record was cleared for a bootstrap that never committed").toBe(0);
      expect(result).toBeUndefined();
      // The publication itself is retained, not raced or deleted.
      expect(observed.pointerWrites).toHaveLength(1);
      expect(observed.pointerWrites[0]).toMatchObject({ name: "last-ready", value: { commit: COMMIT, kind: "rollback" } });
      // BASELINE RECOVERY RAN, on its own fresh scope: the unchanged baseline was redeployed (a
      // second deploy) and its health poll succeeded despite the aborted primary signal.
      expect(observed.deploys, "recovery did not restart the untouched baseline").toBe(2);
      expect(observed.transitions).toEqual(["booting", "booting", "failed"]);
      expect(observed.checkpoints.at(-1)).toBe("bootstrap-failed-prior-restored");
      expect(kinds(receipts)).toContain("bootstrap-phase");
      // A pre-ready cancellation owns no commit, so the coordinated shutdown remains the outcome.
      expect(error).toMatchObject({ code: "STAGING_OPERATION_ABORTED", terminationConfirmed: true });
      expect(observed.clients[0].ended).toBe(1);
      expect(observed.clients[0].endedWhileQueryPending).toBe(false);
    }, 20_000);
  }

  it("a phase DEADLINE breached during the same publication refuses as a timeout, not as a shutdown", async () => {
    // The discriminating twin: no signal is sent, so only the operation budget can refuse — and the
    // classification must stay `STAGING_OPERATION_TIMEOUT`, which the daemon acts on differently.
    healthyBoot();
    journalState.row = { ...FRESH_JOURNAL };
    hooks.duringPointerWrite = holdPointerThen(() => { clock.ms += 60 * 60_000; });

    const { result, error } = await bootstrap();

    expect(observed.readyCommits, "an expired bootstrap submitted ready anyway").toBe(0);
    expect(observed.clears).toBe(0);
    expect(result).toBeUndefined();
    expect(observed.pointerWrites).toHaveLength(1);
    // NOT the shutdown classification, and not a bare abort either.
    expect((error as { code?: string })?.code).toBeUndefined();
    expect(error?.message).toMatch(/exhausted its total time budget/);
    expect(error?.message).toMatch(/prior staging deployment restored unchanged/);
    expect(observed.deploys).toBe(2);
    expect(observed.transitions).toEqual(["booting", "booting", "failed"]);
    expect(observed.checkpoints.at(-1)).toBe("bootstrap-failed-prior-restored");
  }, 20_000);

  it("POSITIVE CONTROL: the identical publication with a live signal and budget commits ready and clears its record", async () => {
    healthyBoot();
    journalState.row = { ...FRESH_JOURNAL };
    // Held exactly as above — only the cancellation is removed, so the hold itself proves nothing.
    hooks.duringPointerWrite = holdPointerThen(() => {});

    const { result, error } = await bootstrap();

    expect(error).toBeUndefined();
    expect(result).toMatchObject({
      status: "bootstrapped", commit: COMMIT, mode: "copy-ready", resumedFrom: null,
      readyCommit: { commit: COMMIT, bookkeeping: "completed" },
    });
    expect(observed.readyCommits).toBe(1);
    expect(observed.clears, "the interruption record outlived the ready commit").toBe(1);
    expect(observed.deploys, "the baseline was restarted on a successful bootstrap").toBe(1);
    expect(observed.transitions).toEqual(["booting"]);
    expect(observed.pointerWrites).toHaveLength(1);
  }, 20_000);
});

describe("a confirmed bootstrap ready commit survives what happens after it", () => {
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    it(`${signal} during the post-commit record clear still reports the bootstrapped identity`, async () => {
      healthyBoot();
      journalState.row = { ...FRESH_JOURNAL };
      hooks.duringClear = () => { process.emit(signal as never); };

      const { result, error } = await bootstrap();

      // Before the latch, `runImporter`'s finalizer replaced this durable success with a generic
      // cancellation and the CLI printed a refusal for a staging that was serving.
      expect(error, `${signal} after the commit was reported as a refusal`).toBeUndefined();
      expect(result).toMatchObject({
        status: "bootstrapped", commit: COMMIT,
        readyCommit: { commit: COMMIT, bookkeeping: "completed" },
      });
      expect(observed.readyCommits).toBe(1);
      expect(observed.deploys, "a committed bootstrap was redeployed by recovery").toBe(1);
      expect(observed.transitions, "a serving bootstrap was journalled failed").toEqual(["booting"]);
    }, 20_000);
  }

  it("a FAILING post-commit clear reports bookkeeping pending and never re-enters baseline recovery", async () => {
    healthyBoot();
    journalState.row = { ...FRESH_JOURNAL };
    hooks.duringClear = () => { throw new Error("interruption record clear failed"); };

    const { result, error, receipts } = await bootstrap();

    expect(result).toBeUndefined();
    expect(error?.message).toMatch(/bootstrap checkpoint is ready and serving; post-ready bookkeeping remains pending/);
    expect(error?.message).toMatch(/interruption record clear failed/);
    expect((error as { readyCommit?: Record<string, unknown> })?.readyCommit).toMatchObject({ commit: COMMIT, bookkeeping: "pending" });
    expect(kinds(receipts)).toContain("ready-bookkeeping-pending");
    // THE SECOND HALF: the pre-ready recovery is for a bootstrap that never committed. It must not
    // redeploy the baseline over a serving checkpoint, nor call the run failed.
    expect(observed.readyCommits).toBe(1);
    expect(observed.deploys, "recovery redeployed over a committed bootstrap").toBe(1);
    expect(observed.transitions, "a committed bootstrap was journalled failed").toEqual(["booting"]);
    expect(observed.checkpoints).not.toContain("recovery-required");
  }, 20_000);

  it("the marker carries the RESUMED run identity, not a freshly generated one", async () => {
    // Same post-commit suffix, reached through the real resume verdict. The fresh identity this
    // worker generated is a `bootstrap-<now>` string that is not `RESUMED_RUN`, so a marker
    // hard-coded to the fresh run — or built from an intended rather than a returned row — fails here.
    healthyBoot();
    journalState.row = { ...RESUMED_JOURNAL };
    hooks.duringClear = () => { process.emit("SIGTERM" as never); };

    const { result, error } = await bootstrap();

    expect(error).toBeUndefined();
    expect(result).toMatchObject({
      status: "bootstrapped-after-interruption", runId: RESUMED_RUN, resumedFrom: "stopping",
      readyCommit: { runId: RESUMED_RUN, commit: COMMIT, bookkeeping: "completed" },
    });
    expect(observed.readyRunIds).toEqual([RESUMED_RUN]);
    // A resume re-enters draining and re-proves the stop before it captures.
    expect(observed.transitions).toEqual(["draining", "booting"]);
    expect(observed.stops).toBe(1);
    expect(observed.clears).toBe(1);
  }, 20_000);

  it("a FAILING clear on the RESUMED run reports pending against that same recorded identity", async () => {
    healthyBoot();
    journalState.row = { ...RESUMED_JOURNAL };
    hooks.duringClear = () => { throw new Error("interruption record clear failed"); };

    const { error } = await bootstrap();

    expect((error as { readyCommit?: Record<string, unknown> })?.readyCommit).toMatchObject({
      runId: RESUMED_RUN, commit: COMMIT, bookkeeping: "pending",
    });
    expect(observed.readyCommits).toBe(1);
    expect(observed.deploys).toBe(1);
    expect(observed.transitions).toEqual(["draining", "booting"]);
  }, 20_000);
});
