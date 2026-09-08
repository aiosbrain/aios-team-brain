import { createHash, generateKeyPairSync } from "node:crypto";
import { spawn as nodeSpawn, type SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runExporter } from "../scripts/staging-ops/exporter.mjs";
import { capturePairedPostgres, restorePairedPostgres } from "../scripts/staging-ops/pg-paired.mjs";
import { armBudgetWatchdog, createOperationBudget, createSessionWatchdogOwner, postgresDeadlineConfig, stagingOperationDeadlines } from "../scripts/staging-ops/operation-deadline.mjs";
import { runBoundedProcess } from "../scripts/staging-ops/bounded-process.mjs";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

const alive = (pid: number) => {
  try { process.kill(pid, 0); return true; }
  catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    throw error;
  }
};

function executable(body: string) {
  const root = mkdtempSync(path.join(os.tmpdir(), "staging-deadline-"));
  roots.push(root);
  const file = path.join(root, "worker.mjs");
  writeFileSync(file, `#!/usr/bin/env node\n${body}\n`, { mode: 0o700 });
  chmodSync(file, 0o700);
  return { root, file };
}

describe("M8 — finite operation deadlines terminate real work", () => {
  it("hard-stops and never unwinds ownership when an owned process group remains uncontained", async () => {
    const child = new EventEmitter() as EventEmitter & {
      pid: number; stdout: EventEmitter; stderr: EventEmitter;
    };
    child.pid = 4242;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    const hardStop = vi.fn();
    const running = runBoundedProcess("synthetic", [], {
      timeoutMs: 5,
      terminateGraceMs: 5,
      spawnImpl: (() => child) as never,
      kill: (() => true) as never,
      hardStop,
      // A pending Promise alone does not keep Node alive, so the production default owns the
      // referenced handle. This seam lets the test observe the non-unwinding state without leaking.
      holdUncontained: () => new Promise(() => {}),
    });
    setTimeout(() => child.emit("close", null, "SIGKILL"), 10);
    const outcome = await Promise.race([
      running.then(() => "resolved", () => "rejected"),
      new Promise((resolve) => setTimeout(() => resolve("still-owned"), 80)),
    ]);
    expect(hardStop).toHaveBeenCalledTimes(1);
    expect(outcome).toBe("still-owned");
  });

  it("validates budgets and configures server-side Postgres cancellation", () => {
    expect(() => stagingOperationDeadlines({ STAGING_OPERATION_TIMEOUT_MS: "Infinity" } as NodeJS.ProcessEnv)).toThrow(/integer/);
    expect(() => stagingOperationDeadlines({ STAGING_RECOVERY_TIMEOUT_MS: "0" } as NodeJS.ProcessEnv)).toThrow(/STAGING_RECOVERY_TIMEOUT_MS/);
    const config = postgresDeadlineConfig("postgres://db/internal", 4_000, 2_000);
    expect(config).toMatchObject({ connectionTimeoutMillis: 2_000, statement_timeout: 4_000, lock_timeout: 4_000, idle_in_transaction_session_timeout: 4_000 });
    expect(config).not.toHaveProperty("query_timeout");
  });

  it("uses one monotonic allowance across sequential operations and cannot renew it through a child", () => {
    let now = 100;
    const run = createOperationBudget("importer tick", 1_000, { now: () => now });
    expect(run.remaining(800, "first query")).toBe(800);
    now += 700;
    const restore = run.child("restore", 900);
    expect(restore.remaining(900, "second query")).toBe(300);
    now += 301;
    expect(() => restore.remaining(900, "later mutation")).toThrow(/later mutation exhausted its total time budget/);
  });

  it("actively terminates an owned stalled transport at the absolute boundary and settles cancellation", async () => {
    const terminated: string[] = [];
    const watchdog = armBudgetWatchdog(createOperationBudget("connected database response", 10), async (error) => {
      await Promise.resolve();
      terminated.push(error.code);
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await watchdog.disarm();
    expect(watchdog.expired).toBe(true);
    expect(terminated).toEqual(["STAGING_OPERATION_TIMEOUT"]);
  });

  it("retires every enclosing watchdog before a longer recovery budget crosses the old deadline", async () => {
    const terminated: string[] = [];
    const owner = createSessionWatchdogOwner((error) => { terminated.push(error.code); });
    owner.arm(createOperationBudget("action", 30));
    owner.arm(createOperationBudget("daemon tick", 35));
    await new Promise((resolve) => setTimeout(resolve, 10));
    const recovery = await owner.transferTo(createOperationBudget("recovery", 150));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(terminated, "an enclosing timer destroyed the session during recovery").toEqual([]);
    expect(owner.size).toBe(1);
    await recovery.disarm();
    expect(owner.size).toBe(0);
  });

  it("refuses same-session recovery when an enclosing watchdog already fired", async () => {
    const terminate = vi.fn();
    const owner = createSessionWatchdogOwner(terminate);
    owner.arm(createOperationBudget("expired action", 5));
    await new Promise((resolve) => setTimeout(resolve, 15));
    await expect(owner.transferTo(createOperationBudget("recovery", 100)))
      .rejects.toThrow(/same-session recovery is unsafe/);
    expect(terminate).toHaveBeenCalledTimes(1);
    expect(owner.size).toBe(0);
  });

  it("capture cancels and awaits every actual PG subprocess before rolling back its snapshot", async () => {
    const { root, file } = executable(`
      process.on("SIGTERM", () => {});
      setInterval(() => {}, 1000);
    `);
    const spawnedPids: number[] = [];
    const spawnImpl = (command: string, args: readonly string[], options: SpawnOptions) => {
      const child = nodeSpawn(command, [...args], options);
      if (child.pid) spawnedPids.push(child.pid);
      return child;
    };
    let allGoneAtRollback = false;
    const statements: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        const text = String(sql); statements.push(text);
        if (text.includes("pg_export_snapshot")) return { rows: [{ snapshot: "00000003-0000001B-1" }] };
        if (text.includes("table_name='auth_users'")) return { rows: ["id", "email", "password_hash"].map((column_name) => ({ column_name })) };
        if (text.includes("table_name='graph_episodes'")) return { rows: ["id", "pending_delete_group_id", "pending_delete_at"].map((column_name) => ({ column_name })) };
        if (text === "ROLLBACK") {
          allGoneAtRollback = spawnedPids.length === 3 && spawnedPids.every((pid) => !alive(pid));
        }
        return { rows: [] };
      }),
    };
    await expect(capturePairedPostgres({
      client, databaseUrl: "postgres://app:pw@source.railway.internal:5432/db", directory: root,
      pgDump: file, psql: file, operationTimeoutMs: 1_000, terminateGraceMs: 100, spawnImpl,
    })).rejects.toThrow(/termination confirmed/);
    expect(spawnedPids, "all three snapshot consumers must actually have spawned").toHaveLength(3);
    expect(statements.at(-1)).toBe("ROLLBACK");
    expect(allGoneAtRollback, "ROLLBACK must follow confirmed absence of all snapshot consumers").toBe(true);
  });

  it("restore terminates and awaits a stalled actual pg_restore before returning the failure", async () => {
    const { root, file } = executable(`
      import { appendFileSync } from "node:fs";
      if (process.argv.includes("--list")) {
        console.log("215; 1259 16388 TABLE public items postgres");
        process.exit(0);
      }
      appendFileSync(process.env.STAGING_DEADLINE_PID_FILE, String(process.pid) + "\\n");
      process.on("SIGTERM", () => {});
      setInterval(() => {}, 1000);
    `);
    const pidFile = path.join(root, "pids");
    const old = process.env.STAGING_DEADLINE_PID_FILE;
    process.env.STAGING_DEADLINE_PID_FILE = pidFile;
    const client = {
      query: vi.fn(async (sql: string) => {
        const text = String(sql);
        if (text.includes("to_regclass")) return { rows: [{ present: false }], fields: [] };
        return { rows: [], fields: [] };
      }),
      on: vi.fn(),
    };
    try {
      await expect(restorePairedPostgres({
        client, databaseUrl: "postgres://app:pw@target.railway.internal:5432/db", directory: root, pgRestore: file,
        operationTimeoutMs: 1_000, terminateGraceMs: 100, verifiedStagingTarget: true,
      })).rejects.toThrow(/termination confirmed/);
    } finally {
      if (old === undefined) delete process.env.STAGING_DEADLINE_PID_FILE;
      else process.env.STAGING_DEADLINE_PID_FILE = old;
    }
    const pids = readFileSync(pidFile, "utf8").trim().split(/\s+/).map(Number);
    expect(pids).toHaveLength(1);
    expect(pids.every((pid) => !alive(pid)), "restore rejection must mean its child is gone").toBe(true);
  });

  it("an explicit importer cancellation signal terminates and confirms a slow restore before returning", async () => {
    const { root, file } = executable(`
      import { appendFileSync } from "node:fs";
      if (process.argv.includes("--list")) {
        console.log("215; 1259 16388 TABLE public items postgres");
        process.exit(0);
      }
      appendFileSync(process.env.STAGING_DEADLINE_PID_FILE, String(process.pid) + "\\n");
      process.on("SIGTERM", () => {});
      setInterval(() => {}, 1000);
    `);
    const pidFile = path.join(root, "signal-pids");
    const old = process.env.STAGING_DEADLINE_PID_FILE;
    process.env.STAGING_DEADLINE_PID_FILE = pidFile;
    const controller = new AbortController();
    const client = {
      query: vi.fn(async (sql: string) => String(sql).includes("to_regclass")
        ? { rows: [{ present: false }], fields: [] }
        : { rows: [], fields: [] }),
      on: vi.fn(),
    };
    try {
      const restoring = restorePairedPostgres({
        client, databaseUrl: "postgres://app:pw@target.railway.internal:5432/db", directory: root, pgRestore: file,
        operationTimeoutMs: 10_000, terminateGraceMs: 100, verifiedStagingTarget: true,
        signal: controller.signal,
      });
      for (let attempt = 0; attempt < 200 && !existsSync(pidFile); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(existsSync(pidFile), "the destructive restore never started").toBe(true);
      controller.abort(new Error("SIGTERM"));
      await expect(restoring).rejects.toThrow(/operation aborted; subprocess termination confirmed/);
      const pids = readFileSync(pidFile, "utf8").trim().split(/\s+/).map(Number);
      expect(pids.every((pid) => !alive(pid)), "cancellation returned while the restore survived").toBe(true);
    } finally {
      if (old === undefined) delete process.env.STAGING_DEADLINE_PID_FILE;
      else process.env.STAGING_DEADLINE_PID_FILE = old;
    }
  });
});

describe("M8 — the actual exporter retries one whole private capture and publishes once", () => {
  const signing = generateKeyPairSync("ed25519");
  const encryption = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const commit = "b".repeat(40);
  const env = {
    STAGING_OPS_ROLE: "exporter", STAGING_OPS_IMAGE_DIGEST: `sha256:${"a".repeat(64)}`,
    RAILWAY_ENVIRONMENT_ID: "prod", PRODUCTION_EXPORT_ENVIRONMENT_ID: "prod",
    STAGING_MAINTENANCE_ADAPTER: "local", SOURCE_APPLICATION_COMMIT: commit,
    DATABASE_URL: "postgres://u:p@postgres.railway.internal:5432/db", NEO4J_URL: "bolt://neo4j.railway.internal",
    NEO4J_USER: "neo4j", NEO4J_PASSWORD: "prod-password", NEO4J_DATABASE: "neo4j",
    AUTH_SECRET: "prod-auth", SECRETS_KEY: "prod-secrets",
    STAGING_COMPARISON_KEY_BASE64: Buffer.alloc(32, 7).toString("base64"), STAGING_COMPARISON_KEY_ID: "ops-v2",
    EXPORTER_SIGNING_PRIVATE_KEY: signing.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    IMPORTER_ENCRYPTION_PUBLIC_KEY: encryption.publicKey.export({ format: "pem", type: "spki" }).toString(),
  } as NodeJS.ProcessEnv;
  const checksums = Object.fromEntries(["postgres", "authUsers", "graphLedger", "graph"].map((name) => [name, { sha256: createHash("sha256").update(name).digest("hex") }]));
  const successfulCapture = (attempt: number) => ({
    started: new Date(`2026-09-08T00:00:0${attempt}Z`), ended: new Date(`2026-09-08T00:00:1${attempt}Z`),
    graph: { codecVersion: 1, nodes: [], relationships: [], sanitation: {} },
    policy: { schemaLines: ["table\titems\tstable"] }, packed: { payload: Buffer.from(`capture-${attempt}`), checksums },
  });
  const harness = (captureAttempt: ReturnType<typeof vi.fn>) => {
    const store = { putImmutable: vi.fn().mockResolvedValue(undefined) };
    return {
      store,
      operations: {
        deployedBuild: { commit, migrationSet: { sha256: "d".repeat(64), files: [] } },
        client: {}, driver: {}, session: { close: vi.fn().mockResolvedValue(undefined) }, store, captureAttempt,
      },
    };
  };

  it("retries a transient failure with a fresh attempt and publishes only the successful bytes", async () => {
    const attempts: number[] = [];
    const captureAttempt = vi.fn(async (attempt: number) => {
      attempts.push(attempt);
      if (attempt === 1) throw Object.assign(new Error("online ledger changed during capture"), { transient: true });
      return successfulCapture(attempt);
    });
    const run = harness(captureAttempt);
    await expect(runExporter(env, run.operations)).resolves.toMatchObject({ captureAttempts: 2 });
    expect(attempts).toEqual([1, 2]);
    expect(run.store.putImmutable).toHaveBeenCalledTimes(1);
  });

  it("does not retry a permanent refusal and publishes nothing", async () => {
    const captureAttempt = vi.fn().mockRejectedValue(new Error("unsupported graph schema"));
    const run = harness(captureAttempt);
    await expect(runExporter(env, run.operations)).rejects.toThrow(/unsupported graph schema/);
    expect(captureAttempt).toHaveBeenCalledTimes(1);
    expect(run.store.putImmutable).not.toHaveBeenCalled();
  });

  it("stops after exactly two transient attempts and publishes nothing", async () => {
    const captureAttempt = vi.fn().mockRejectedValue(Object.assign(new Error("connection reset"), { transient: true }));
    const run = harness(captureAttempt);
    await expect(runExporter(env, run.operations)).rejects.toThrow(/connection reset/);
    expect(captureAttempt).toHaveBeenCalledTimes(2);
    expect(run.store.putImmutable).not.toHaveBeenCalled();
  });

  it("refuses publication when successful sequential capture work consumes the shared run budget", async () => {
    let now = 0;
    const captureAttempt = vi.fn(async () => {
      now += 1_001;
      return successfulCapture(1);
    });
    const run = harness(captureAttempt);
    const boundedEnv = { ...env, STAGING_OPERATION_TIMEOUT_MS: "1000", STAGING_CAPTURE_TIMEOUT_MS: "1000" };
    await expect(runExporter(boundedEnv, { ...run.operations, now: () => now })).rejects.toThrow(/capture attempt 1 completion exhausted its total time budget/);
    expect(run.store.putImmutable).not.toHaveBeenCalled();
  });
});
