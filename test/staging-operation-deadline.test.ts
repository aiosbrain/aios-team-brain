import { createHash, generateKeyPairSync } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runExporter } from "../scripts/staging-ops/exporter.mjs";
import { capturePairedPostgres, restorePairedPostgres } from "../scripts/staging-ops/pg-paired.mjs";
import { postgresDeadlineConfig, stagingOperationDeadlines } from "../scripts/staging-ops/operation-deadline.mjs";

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
  it("validates budgets and configures server-side Postgres cancellation", () => {
    expect(() => stagingOperationDeadlines({ STAGING_OPERATION_TIMEOUT_MS: "Infinity" } as NodeJS.ProcessEnv)).toThrow(/integer/);
    expect(() => stagingOperationDeadlines({ STAGING_RECOVERY_TIMEOUT_MS: "0" } as NodeJS.ProcessEnv)).toThrow(/STAGING_RECOVERY_TIMEOUT_MS/);
    const config = postgresDeadlineConfig("postgres://db/internal", 4_000, 2_000);
    expect(config).toMatchObject({ connectionTimeoutMillis: 2_000, statement_timeout: 4_000, lock_timeout: 4_000, idle_in_transaction_session_timeout: 4_000 });
    expect(config).not.toHaveProperty("query_timeout");
  });

  it("capture cancels and awaits every actual PG subprocess before rolling back its snapshot", async () => {
    const { root, file } = executable(`
      import { appendFileSync } from "node:fs";
      appendFileSync(process.env.STAGING_DEADLINE_PID_FILE, String(process.pid) + "\\n");
      process.on("SIGTERM", () => {});
      setInterval(() => {}, 1000);
    `);
    const pidFile = path.join(root, "pids");
    const old = process.env.STAGING_DEADLINE_PID_FILE;
    process.env.STAGING_DEADLINE_PID_FILE = pidFile;
    let allGoneAtRollback = false;
    const statements: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        const text = String(sql); statements.push(text);
        if (text.includes("pg_export_snapshot")) return { rows: [{ snapshot: "00000003-0000001B-1" }] };
        if (text.includes("table_name='auth_users'")) return { rows: ["id", "email", "password_hash"].map((column_name) => ({ column_name })) };
        if (text.includes("table_name='graph_episodes'")) return { rows: ["id", "pending_delete_group_id", "pending_delete_at"].map((column_name) => ({ column_name })) };
        if (text === "ROLLBACK") {
          const pids = existsSync(pidFile) ? readFileSync(pidFile, "utf8").trim().split(/\s+/).filter(Boolean).map(Number) : [];
          allGoneAtRollback = pids.length > 0 && pids.every((pid) => !alive(pid));
        }
        return { rows: [] };
      }),
    };
    try {
      await expect(capturePairedPostgres({
        client, databaseUrl: "postgres://source/db", directory: root,
        pgDump: file, psql: file, operationTimeoutMs: 1_000, terminateGraceMs: 100,
      })).rejects.toThrow(/termination confirmed/);
    } finally {
      if (old === undefined) delete process.env.STAGING_DEADLINE_PID_FILE;
      else process.env.STAGING_DEADLINE_PID_FILE = old;
    }
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
        client, databaseUrl: "postgres://target/db", directory: root, pgRestore: file,
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
});

describe("M8 — the actual exporter retries one whole private capture and publishes once", () => {
  const signing = generateKeyPairSync("ed25519");
  const encryption = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const commit = "b".repeat(40);
  const env = {
    STAGING_OPS_ROLE: "exporter", STAGING_OPS_IMAGE_DIGEST: `sha256:${"a".repeat(64)}`,
    RAILWAY_ENVIRONMENT_ID: "prod", PRODUCTION_EXPORT_ENVIRONMENT_ID: "prod",
    STAGING_MAINTENANCE_ADAPTER: "local", SOURCE_APPLICATION_COMMIT: commit,
    DATABASE_URL: "postgres://u:p@postgres.railway.internal/db", NEO4J_URL: "bolt://neo4j.railway.internal",
    NEO4J_USER: "neo4j", NEO4J_PASSWORD: "prod-password", NEO4J_DATABASE: "neo4j",
    AUTH_SECRET: "prod-auth", SECRETS_KEY: "prod-secrets",
    STAGING_COMPARISON_KEY_BASE64: Buffer.alloc(32, 7).toString("base64"), STAGING_COMPARISON_KEY_ID: "comparison-v1",
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
});
