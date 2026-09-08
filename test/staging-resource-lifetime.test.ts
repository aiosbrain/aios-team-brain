import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { closeAll, closeAllWithinBudget, ownedCloser } from "../scripts/staging-ops/resource-cleanup.mjs";
import { createOperationBudget } from "../scripts/staging-ops/operation-deadline.mjs";

/**
 * The measured failure (`runtime-lifetime-adjudication.md`): the isolated harness died at
 * `importer bootstrap-rollback` with **`Connection terminated`**, before reading anything. The
 * dispatcher's branches were `return somePromise` inside `try … finally { await client.end() }`.
 * A bare `return promise` settles the try block IMMEDIATELY, so the `finally` ran while the very
 * first coordinator-lock query was still in flight, and `pg` destroys a connection that is ending
 * with an active query.
 *
 * These drive the REAL `runImporter` branches, because that is where the defect lives: the inner
 * helpers are correct, and the existing coordinator and recovery tests call `rollbackToPrior`
 * directly — never entering a dispatcher — so none of them could have caught it.
 *
 * ⚠️ SCOPE. Every boundary here is a double. They prove ORDERING — cleanup does not begin until the
 * promise that owns it has settled — and they do NOT prove live behaviour. A real Postgres backend
 * holding a real advisory lock across a real manual rollback is the parent's live diagnostic, and
 * nothing in this file substitutes for it.
 */

/** A promise whose settlement this test controls, so "still running" is an observable state. */
function deferred<T = unknown>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const settle = async () => { for (let i = 0; i < 4; i += 1) await new Promise((r) => setImmediate(r)); };

/**
 * ONE gate across every async resource the dispatcher can touch first. Which boundary that is
 * differs per branch — the coordinator-lock query for `bootstrap-rollback`, the object-store read
 * for `install` — and the property under test is the same either way: whatever the branch reached
 * first is still running, so nothing may be torn down yet.
 */
const gate = vi.hoisted(() => ({
  armed: false,
  /** Boundaries to let through before holding one — used to reach a specific point in a branch. */
  skip: 0,
  held: null as null | { promise: Promise<unknown>; resolve: (v: unknown) => void; reject: (r: unknown) => void },
  take(): Promise<unknown> | null {
    if (!this.armed || !this.held) return null;
    if (this.skip > 0) { this.skip -= 1; return null; }
    this.armed = false;
    return this.held.promise;
  },
}));

const pgState = vi.hoisted(() => ({
  clients: [] as { statements: string[]; ended: number; endedWhileQueryPending: boolean; pending: number; connection: { stream: { destroyed: boolean; destroyCalls: number; destroy: (error?: unknown) => void } } }[],
  rows: [{ acquired: true }] as Record<string, unknown>[],
  journal: {} as Record<string, unknown>,
}));

vi.mock("pg", () => {
  class Client {
    statements: string[] = [];
    ended = 0;
    endedWhileQueryPending = false;
    pending = 0;
    connection = { stream: {
      destroyed: false,
      destroyCalls: 0,
      remoteAddress: "10.0.0.9",
      destroy: (_error?: unknown) => { this.connection.stream.destroyed = true; this.connection.stream.destroyCalls += 1; },
    } };
    connectionParameters: { host: string; port: number; database: string; user: string };
    constructor(config: { connectionString?: string } = {}) {
      const parsed = new URL(config.connectionString ?? "postgresql://app:pw@staging-pg.railway.internal:5432/brain");
      this.connectionParameters = { host: parsed.hostname, port: Number(parsed.port), database: parsed.pathname.slice(1), user: parsed.username };
      pgState.clients.push(this as never);
    }
    async connect() { /* connected by construction */ }
    async end() {
      this.ended += 1;
      if (this.pending > 0) this.endedWhileQueryPending = true;
    }
    async query(sql: string) {
      if (this.connection.stream.destroyed) throw new Error("connection destroyed by stale watchdog");
      this.statements.push(String(sql));
      this.pending += 1;
      try {
        if (String(sql).includes("inet_server_addr")) return { rows: [{ database: this.connectionParameters.database, server_address: "10.0.0.9", server_port: this.connectionParameters.port, backend_pid: 71 }] };
        const held = gate.take();
        if (held) return await held;
        if (String(sql).includes("pg_export_snapshot")) return { rows: [{ snapshot: "00000003-0000001B-1" }] };
        if (String(sql).includes("FROM staging_ops.refresh_journal")) return { rows: [pgState.journal] };
        return { rows: pgState.rows };
      } finally { this.pending -= 1; }
    }
    on() { /* pg emits errors; the double has none */ }
  }
  return { default: { Client }, Client };
});

/** The bytes the rollback store hands back; the journal double advertises this digest. */
const PRIOR_BYTES = vi.hoisted(() => Buffer.from(JSON.stringify({ manifest: { kind: "staging-rollback" } })));

vi.mock("../scripts/staging-ops/object-store.mjs", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createPrivateStore: () => ({
    read: async () => { const held = gate.take(); return held ? ((await held) as never) : PRIOR_BYTES; },
    list: async () => { const held = gate.take(); return held ? ((await held) as never) : []; },
    putImmutable: async () => true, verify: async () => true,
    writePointer: async () => true, delete: async () => true,
  }),
}));

const maintenanceState = vi.hoisted(() => ({ stopDelayMs: 0, stopError: null as Error | null }));

// Reaching `rollbackToPrior` through the REAL dispatcher means getting past `openPrior`, which
// verifies a signed, encrypted, manifest-validated rollback bundle. None of that cryptography is
// what these tests are about, so the three verification seams are neutralised — the dispatcher, the
// lock scope and `rollbackToPrior` itself stay real, which is where the lifetime defect lives.
vi.mock("../scripts/staging-ops/bundle-crypto.mjs", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  openSignedEncryptedBundle: () => ({
    manifest: { kind: "staging-rollback", runId: "prior-run", targetCommit: "b".repeat(40), mode: "copy-ready" },
    payload: Buffer.alloc(0),
  }),
}));
vi.mock("../scripts/staging-ops/bundle-format.mjs", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  validatePairManifest: () => ({ ok: true, errors: [] }),
}));
vi.mock("../scripts/staging-ops/build-identity.mjs", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  assertCompatibleBuildIdentity: () => true,
}));

// The dispatcher's preflight is a wall of configuration this defect has nothing to do with. Its
// three collaborators are neutralised so the branch under test is reached; `runImporter`, its
// cleanup scope and every branch body remain the real thing.
vi.mock("../scripts/staging-ops/role-policy.mjs", () => ({
  assertRunnerRole: () => true, assertOutboundCredentialIsolation: () => true,
}));
vi.mock("../scripts/staging-ops/key-material.mjs", () => ({ keyMaterial: () => Buffer.alloc(32, 1) }));
vi.mock("../scripts/staging-ops/action-preflight.mjs", () => ({ assertActionConfiguration: () => true }));
vi.mock("../scripts/staging-ops/local-maintenance.mjs", () => ({
  LocalMaintenance: class {
    appServiceId = "app-local";
    async stopAndVerifyAll() {
      if (maintenanceState.stopDelayMs) await new Promise((resolve) => setTimeout(resolve, maintenanceState.stopDelayMs));
      if (maintenanceState.stopError) throw maintenanceState.stopError;
      return true;
    }
    async tokenIdentity() { return {}; }
    async listActiveDeployments() {
      return [{ id: "dep-1", status: "SUCCESS", meta: { commitHash: "b".repeat(40), createdAt: "2026-09-07T00:00:00Z" } }];
    }
    async deployApp() { return "dep-2"; }
  },
}));

// The exporter's graph side. `graphCensus` runs THREE sequential Cypher queries; the census case
// below asserts all three complete before the session, driver and Postgres client are closed.
const graphState = vi.hoisted(() => ({
  queries: [] as string[],
  closed: [] as string[],
  /** A bolt session whose close rejects — the ordinary way a dropped connection presents. */
  sessionCloseFails: false,
  next: (() => Promise.resolve({ records: [] })) as (cypher: string) => Promise<unknown>,
}));

vi.mock("neo4j-driver", () => {
  const session = {
    run: (cypher: string) => { graphState.queries.push(String(cypher)); return graphState.next(String(cypher)); },
    close: async () => {
      graphState.closed.push("session");
      if (graphState.sessionCloseFails) throw new Error("bolt session was already gone");
    },
  };
  return {
    default: {
      driver: () => ({ session: () => session, close: async () => { graphState.closed.push("driver"); } }),
      auth: { basic: () => ({}) },
      session: { READ: "READ", WRITE: "WRITE" },
      int: (v: unknown) => v,
    },
  };
});

const { runImporter } = await import("../scripts/staging-ops/importer.mjs");
const { runExporter } = await import("../scripts/staging-ops/exporter.mjs");

const ENV = Object.fromEntries([
  ["STAGING_OPS_ROLE", "importer"], ["STAGING_MAINTENANCE_ADAPTER", "local"],
  ["DATABASE_URL", "postgres://app:pw@staging-pg:5432/brain"],
  ["STAGING_COMPARISON_KEY_BASE64", Buffer.alloc(32, 3).toString("base64")],
  ["STAGING_COMPARISON_KEY_ID", "example-key"],
  ["STAGING_NEO4J_SERVICE_NAME", "staging-neo4j"], ["STAGING_NEO4J_DATABASE", "neo4j"],
  ["STAGING_OPS_ENVIRONMENT_ID", "staging-local"], ["RAILWAY_ENVIRONMENT_ID", "staging-local"],
  ["RAILWAY_PROJECT_ID", "local-project"], ["STAGING_APP_SERVICE_ID", "app-local"],
  ["STAGING_GRAPHITI_SERVICE_ID", "graphiti-local"], ["RAILWAY_STAGING_MAINTENANCE_TOKEN", "token"],
  ["STAGING_IMPORTER_SERVICE_ID", "importer-local"], ["STAGING_IMPORTER_IMAGE_DIGEST", "sha256:" + "d".repeat(64)],
  ["STAGING_BOOTSTRAP_MODE", "copy-ready"],
]) as unknown as NodeJS.ProcessEnv;

const OBJECT_ID = `run-1--${"a".repeat(64)}`;

afterEach(() => {
  maintenanceState.stopDelayMs = 0;
  maintenanceState.stopError = null;
});

/** Start a real dispatcher branch and hold open the first async resource it reaches. */
function driveBranch(argv: string[], { holdAfter = 0 } = {}) {
  pgState.clients.length = 0;
  pgState.rows = [{ acquired: true }];
  // A journal that `openPrior` accepts: a canonical last-ready pair whose digest matches the bytes
  // the store double returns, so the rollback branch can actually reach `rollbackToPrior`.
  pgState.journal = {
    state: "failed", run_id: "failed-run",
    last_ready_run_id: "prior-run", last_ready_object_id: `prior-run--${"a".repeat(64)}`,
    last_ready_digest: createHash("sha256").update(PRIOR_BYTES).digest("hex"),
    last_ready_commit: "b".repeat(40), last_ready_mode: "copy-ready",
  };
  const held = deferred();
  gate.held = held as never;
  gate.skip = holdAfter;
  gate.armed = true;
  const outcome = runImporter(ENV, argv).then(() => "resolved", (error) => error);
  return { outcome, held, client: () => pgState.clients[0] };
}

const BRANCHES: [string, string[]][] = [
  ["bootstrap-rollback", ["bootstrap-rollback"]],
  ["install", ["install", OBJECT_ID]],
  ["tick", ["tick"]],
  ["rollback", ["rollback", "failed-run"]],
];

describe("the importer entrypoint validates finite budgets before acquiring resources", () => {
  it("refuses an infinite operation deadline before opening Postgres", async () => {
    pgState.clients.length = 0;
    await expect(runImporter({ ...ENV, STAGING_OPERATION_TIMEOUT_MS: "Infinity" } as NodeJS.ProcessEnv, ["tick"]))
      .rejects.toThrow(/STAGING_OPERATION_TIMEOUT_MS must be an integer/);
    expect(pgState.clients).toHaveLength(0);
  });
});

describe("the dispatcher keeps Postgres open until the branch it started has finished", () => {
  for (const [label, argv] of BRANCHES) {
    it(`${label}: does not tear down the connection while the branch is still running`, async () => {
      const { outcome, held, client } = driveBranch(argv);
      await settle();

      expect(client(), "the branch never reached the database client").toBeDefined();
      expect(gate.armed, "the branch never reached an async resource, so this proves nothing").toBe(false);
      // THE ASSERTION. Before the fix this was already 1, and `pg` then produced the harness's
      // exact `Connection terminated`.
      expect(client().ended, "cleanup began while the branch was still running").toBe(0);

      held.reject(new Error("staging is unavailable"));
      const settled = await outcome;
      expect(settled, "the branch's own failure must reach the caller").toBeInstanceOf(Error);
      expect(client().ended, "closed exactly once").toBe(1);
      expect(client().endedWhileQueryPending, "closed underneath an in-flight query").toBe(false);
    });

    it(`${label}: closes the connection exactly once when the branch settles normally`, async () => {
      const { outcome, held, client } = driveBranch(argv);
      await settle();
      held.resolve({ rows: [{ acquired: false }] });
      await outcome;
      expect(client().ended).toBe(1);
      expect(client().endedWhileQueryPending).toBe(false);
    });
  }

  it("manual rollback holds the coordinator lock until the recovery it fences has settled", async () => {
    // The adjudication's second required regression, as an ORDERING inequality: the release must not
    // appear while the rollback is still running. Its `finally` sat outside the awaited promise, so
    // the lock was released mid-recovery — a failure independent of the connection close, which is
    // why it needs its own case. The live second-connection attempt is the parent's diagnostic.
    // Held INSIDE `rollbackToPrior`: the lock is acquired, the journal read and the prior-pair open
    // pass through, and the first statement of the recovery itself (the session reset) is what stays
    // in flight. A boundary before `rollbackToPrior` would suspend on its own `await` and never
    // exercise the un-awaited return this case exists for.
    // One additional query now installs the finite operation budget on this SAME session before
    // dispatch. Hold after it so the recovery's own first ROLLBACK remains the in-flight boundary.
    const { outcome, held, client } = driveBranch(["rollback", "failed-run"], { holdAfter: 4 });
    await settle();
    const unlocked = () => client().statements.some((sql) => sql.includes("pg_advisory_unlock"));
    expect(client().statements.some((sql) => sql.includes("pg_try_advisory_lock")), "the lock was taken").toBe(true);
    expect(client().statements.at(-1), "the recovery itself must be the thing in flight").toBe("ROLLBACK");
    expect(unlocked(), "the coordinator lock was released while recovery was still running").toBe(false);
    expect(client().ended, "the connection was closed while recovery was still running").toBe(0);

    held.reject(new Error("journal unreadable"));
    await outcome;
    // Only now, and in this order: release, then close.
    expect(unlocked()).toBe(true);
    expect(client().ended).toBe(1);
  });

  it("manual recovery keeps the session alive after the original action deadline", async () => {
    pgState.clients.length = 0;
    pgState.rows = [{ acquired: true }];
    pgState.journal = {
      state: "failed", run_id: "failed-run",
      last_ready_run_id: "prior-run", last_ready_object_id: `prior-run--${"a".repeat(64)}`,
      last_ready_digest: createHash("sha256").update(PRIOR_BYTES).digest("hex"),
      last_ready_commit: "b".repeat(40), last_ready_mode: "copy-ready",
    };
    gate.armed = false;
    maintenanceState.stopDelayMs = 1_150;
    maintenanceState.stopError = new Error("controlled recovery stop refusal");

    const outcome = await runImporter({
      ...ENV, STAGING_OPERATION_TIMEOUT_MS: "1000", STAGING_RECOVERY_TIMEOUT_MS: "5000",
      STAGING_CLEANUP_TIMEOUT_MS: "1000", STAGING_TERMINATE_GRACE_MS: "100",
    } as NodeJS.ProcessEnv, ["rollback", "failed-run"]).then(() => null, (error: Error) => error);

    expect(outcome).toBeInstanceOf(Error);
    expect(outcome?.message).toMatch(/controlled recovery stop refusal/);
    expect(pgState.clients[0].connection.stream.destroyCalls, "the retired action watchdog destroyed recovery's lock-owning session").toBe(0);
    expect(pgState.clients[0].statements.some((sql) => sql === "ROLLBACK"), "recovery never started").toBe(true);
  }, 15_000);
});

describe("the actual importer signal handler coordinates owned subprocess cancellation", () => {
  it("keeps its owner session until a slow rollback capture is confirmed stopped, including repeated signals", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "importer-signal-cancel-"));
    const pidFile = path.join(directory, "owned-pid");
    const executable = path.join(directory, "pg_dump");
    writeFileSync(executable, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
writeFileSync(process.env.STAGING_SIGNAL_PID_FILE, String(process.pid));
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
`, { mode: 0o700 });
    chmodSync(executable, 0o700);
    const oldPath = process.env.PATH;
    const oldPidFile = process.env.STAGING_SIGNAL_PID_FILE;
    process.env.PATH = `${directory}:${oldPath ?? ""}`;
    process.env.STAGING_SIGNAL_PID_FILE = pidFile;
    pgState.clients.length = 0;
    pgState.rows = [{ acquired: true }];
    pgState.journal = { state: "failed", run_id: null, last_ready_run_id: null };
    gate.armed = false;
    const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    try {
      const running = runImporter({
        ...ENV, STAGING_OPERATION_TIMEOUT_MS: "10000", STAGING_RECOVERY_TIMEOUT_MS: "5000",
        STAGING_CLEANUP_TIMEOUT_MS: "1000", STAGING_TERMINATE_GRACE_MS: "100",
      } as NodeJS.ProcessEnv, ["bootstrap-rollback"]);
      for (let attempt = 0; attempt < 300 && !existsSync(pidFile); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(existsSync(pidFile), "the owned rollback capture never started").toBe(true);
      const pid = Number(readFileSync(pidFile, "utf8"));
      expect(alive(pid)).toBe(true);

      process.emit("SIGTERM");
      process.emit("SIGTERM");
      const outcome = await running.then(() => null, (error: Error & { code?: string; terminationConfirmed?: boolean }) => error);

      expect(outcome).toMatchObject({ code: "STAGING_OPERATION_ABORTED", terminationConfirmed: true });
      expect(alive(pid), "the importer returned while its owned process was alive").toBe(false);
      expect(pgState.clients[0].ended, "the owner session was not closed after containment").toBe(1);
      expect(pgState.clients[0].statements.some((sql) => sql.includes("pg_advisory_unlock")), "the coordinator lock was never released after containment").toBe(true);
    } finally {
      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;
      if (oldPidFile === undefined) delete process.env.STAGING_SIGNAL_PID_FILE;
      else process.env.STAGING_SIGNAL_PID_FILE = oldPidFile;
      rmSync(directory, { recursive: true, force: true });
    }
  }, 20_000);
});

describe("nothing is constructed outside the scope that cleans it up", () => {
  it("closes Postgres when a store or maintenance adapter refuses its own configuration", async () => {
    // The third adjacent gap: the two private stores and the maintenance adapter were built between
    // `client.connect()` and the dispatcher's `try`, so an adapter that refused left a connected
    // Postgres client with nothing to close it — one leaked backend per failed invocation.
    pgState.clients.length = 0;
    const store = await import("../scripts/staging-ops/object-store.mjs");
    const original = store.createPrivateStore;
    // The preflight builds these stores too, and a failure THERE happens before the connection is
    // opened — a different, already-safe path. The refusal is aimed at the dispatcher's own two
    // constructions, which is where the leak was.
    let built = 0;
    const refuse = vi.spyOn(store, "createPrivateStore").mockImplementation(((...args: unknown[]) => {
      built += 1;
      if (built <= 2) return (original as (...a: unknown[]) => unknown)(...args);
      throw new Error("private object store refused its configuration");
    }) as never);
    try {
      const outcome = await runImporter(ENV, ["tick"]).then(() => "resolved", (error: Error) => error);
      expect(outcome).toBeInstanceOf(Error);
      expect((outcome as Error).message).toMatch(/refused its configuration/);
      expect(pgState.clients[0], "the connection was opened").toBeDefined();
      expect(pgState.clients[0].ended, "the Postgres connection was leaked").toBe(1);
    } finally { refuse.mockRestore(); }
  });
});

describe("a lock is never held outside the scope that releases it", () => {
  it("bootstrap releases the coordinator lock when a step BETWEEN the acquire and the old try fails", async () => {
    // The adjacent gap: `acquireCoordinatorLock` ran, then the journal read, the deployment
    // measurement and the mode check ran OUTSIDE any release scope. Any of them refusing left the
    // lock held for the life of the connection, and the next importer refused with "another importer
    // owns the coordinator lock" — naming a worker that had already exited.
    // `STAGING_BOOTSTRAP_MODE` is removed here, so the mode check is the step that refuses.
    const { STAGING_BOOTSTRAP_MODE: _dropped, ...withoutMode } = ENV as unknown as Record<string, string>;
    pgState.clients.length = 0;
    pgState.rows = [{ acquired: true }];
    pgState.journal = { state: "ready", run_id: null };
    gate.armed = false; gate.skip = 0;

    const outcome = await runImporter(withoutMode as unknown as NodeJS.ProcessEnv, ["bootstrap-rollback"])
      .then(() => "resolved", (error: Error) => error);

    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toMatch(/STAGING_BOOTSTRAP_MODE/);
    const client = pgState.clients[0];
    expect(client.statements.some((sql) => sql.includes("pg_try_advisory_lock")), "the lock was taken").toBe(true);
    expect(client.statements.some((sql) => sql.includes("pg_advisory_unlock")), "the coordinator lock was never released").toBe(true);
    expect(client.ended).toBe(1);
  });
});

describe("the exporter census finishes before anything is closed", () => {
  const CENSUS_ENV = {
    STAGING_OPS_ROLE: "exporter", STAGING_MAINTENANCE_ADAPTER: "local",
    SOURCE_APPLICATION_COMMIT: "a".repeat(40),
    DATABASE_URL: "postgres://app:pw@prod-pg.railway.internal:5432/brain",
    NEO4J_URL: "bolt://prod-neo4j:7687", NEO4J_USER: "neo4j", NEO4J_PASSWORD: "pw", NEO4J_DATABASE: "neo4j",
  } as unknown as NodeJS.ProcessEnv;

  /** `runExporter` selects the census from `process.argv`, so the flag is installed for the call. */
  async function runCensus(next: (cypher: string) => Promise<unknown>) {
    pgState.clients.length = 0;
    graphState.queries.length = 0; graphState.closed.length = 0;
    graphState.sessionCloseFails = false;
    graphState.next = next;
    const argv = process.argv;
    process.argv = [...argv, "--census"];
    try { return await runExporter(CENSUS_ENV).then((value) => value, (error: unknown) => error); }
    finally { process.argv = argv; }
  }

  const record = (value: unknown) => ({ get: () => value, count: 0 });
  const rows = () => ({ records: [{ get: (key: string) => (key === "count" ? { toString: () => "0" } : "Entity") }] });

  it("runs all three census queries, and closes only afterwards", async () => {
    // A bare `return graphCensus(session)` settled the try block after the FIRST query was merely
    // started, so the `finally` closed the session under the second and third.
    const seen: string[] = [];
    const outcome = await runCensus(async (cypher) => {
      seen.push(cypher);
      // Every query yields to the event loop, which is exactly when a premature `finally` fires.
      await new Promise((resolve) => setImmediate(resolve));
      expect(graphState.closed, "a resource was closed while the census was still running").toEqual([]);
      expect(pgState.clients[0]?.ended ?? 0, "Postgres was closed mid-census").toBe(0);
      return rows();
    });
    void record;
    expect(outcome).not.toBeInstanceOf(Error);
    expect(graphState.queries.length, "the census issues three sequential queries").toBe(3);
    expect(seen.length).toBe(3);
    expect(graphState.closed).toEqual(["session", "driver"]);
    expect(pgState.clients[0].ended).toBe(1);
  });

  it("closes every resource when a census query REJECTS, and not before", async () => {
    let issued = 0;
    const outcome = await runCensus(async () => {
      issued += 1;
      await new Promise((resolve) => setImmediate(resolve));
      expect(graphState.closed, "cleanup began before the failing query settled").toEqual([]);
      if (issued === 2) throw new Error("bolt connection reset mid-census");
      return rows();
    });
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toMatch(/bolt connection reset mid-census/);
    expect(graphState.closed).toEqual(["session", "driver"]);
    expect(pgState.clients[0].ended).toBe(1);
  });

  it("closes the driver AND Postgres even when the session close itself rejects", async () => {
    // The other half of the cleanup gap, and the one a sequential `await a; await b; await c;` gets
    // wrong: a rejecting session close skipped the driver and the Postgres connection entirely, and
    // the process kept both alive for its remaining lifetime.
    const outcome = await runCensus(async () => {
      graphState.sessionCloseFails = true;
      return rows();
    });
    expect(outcome).toBeInstanceOf(Error);
    // The cleanup failure is still reported, not swallowed…
    expect((outcome as Error).message).toMatch(/bolt session was already gone/);
    // …and every later resource was closed anyway.
    expect(graphState.closed).toEqual(["session", "driver"]);
    expect(pgState.clients[0].ended, "the Postgres connection was leaked by a failing bolt close").toBe(1);
  });
});

describe("closeAll reaches every resource", () => {
  it("closes the later resources even when an earlier close rejects", async () => {
    // The measured shape: `await session.close(); await driver.close(); await client.end();` leaks
    // the driver AND the Postgres connection the moment the session close rejects.
    const closed: string[] = [];
    const failing = async () => { closed.push("session"); throw new Error("bolt connection already gone"); };
    await expect(closeAll(failing, async () => { closed.push("driver"); }, async () => { closed.push("client"); }))
      .rejects.toThrow(/bolt connection already gone/);
    expect(closed).toEqual(["session", "driver", "client"]);
  });

  it("still reports a cleanup failure rather than swallowing it, and keeps the others", async () => {
    const error = await closeAll(
      async () => { throw new Error("first"); },
      async () => { throw new Error("second"); },
    ).catch((caught: Error & { otherCleanupFailures?: Error[] }) => caught);
    expect(error.message).toBe("first");
    expect(error.otherCleanupFailures?.map((e) => e.message)).toEqual(["second"]);
  });

  it("skips absent resources and reports success", async () => {
    const closed: string[] = [];
    await expect(closeAll(null, undefined, async () => { closed.push("driver"); })).resolves.toBe(true);
    expect(closed).toEqual(["driver"]);
  });

  it("terminates and settles a stalled closer before attempting the next resource", async () => {
    let release!: () => void;
    const stalled = new Promise<void>((resolve) => { release = resolve; });
    const events: string[] = [];
    const budget = createOperationBudget("test cleanup", 10);
    await expect(closeAllWithinBudget({ budget, terminateGraceMs: 50, terminateWorker: async () => { throw new Error("worker termination should not be needed"); } },
      ownedCloser(() => stalled.then(() => { events.push("first-closed"); }), async () => { events.push("first-terminated"); release(); }),
      ownedCloser(async () => { events.push("second-closed"); }),
    )).resolves.toBe(true);
    expect(events).toEqual(["first-terminated", "first-closed", "second-closed"]);
  });

  it("hard-stops within the shared reserve when both close and terminate remain pending", async () => {
    const never = new Promise<void>(() => {});
    const hardStop = vi.fn();
    const budget = createOperationBudget("stalled cleanup", 5);
    await expect(closeAllWithinBudget({ budget, terminateGraceMs: 10, terminateWorker: hardStop },
      ownedCloser(() => never, () => never),
      ownedCloser(async () => { throw new Error("must not claim later ownership release after hard stop"); }),
    )).rejects.toThrow(/did not settle after bounded cleanup termination/);
    expect(hardStop).toHaveBeenCalledTimes(1);
  });

  it("hard-stops when terminate settles but the original close remains pending", async () => {
    const never = new Promise<void>(() => {});
    const hardStop = vi.fn();
    await expect(closeAllWithinBudget({ budget: createOperationBudget("stalled close", 5), terminateGraceMs: 10, terminateWorker: hardStop },
      ownedCloser(() => never, async () => undefined),
    )).rejects.toThrow(/did not settle after bounded cleanup termination/);
    expect(hardStop).toHaveBeenCalledTimes(1);
  });

  it("bounds a rejected termination, preserves that failure, and still attempts later resources when close settles", async () => {
    let release!: () => void;
    const stalled = new Promise<void>((resolve) => { release = resolve; });
    const events: string[] = [];
    const terminationError = new Error("termination transport refused");
    const error = await closeAllWithinBudget({
      budget: createOperationBudget("rejecting termination", 5), terminateGraceMs: 40,
      terminateWorker: async () => { throw new Error("hard stop should not be needed"); },
    },
    ownedCloser(() => stalled, async () => { release(); throw terminationError; }),
    ownedCloser(async () => { events.push("later-close"); }),
    ).catch((caught: Error) => caught);
    expect(error).toBe(terminationError);
    expect(events).toEqual(["later-close"]);
  });
});
