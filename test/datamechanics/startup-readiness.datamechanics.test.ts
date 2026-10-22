import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, Pool } from "pg";
import { expect, it } from "vitest";
import { probePostgres } from "@/lib/health/readiness";
const exec = promisify(execFile);
const env = () => ({
  ...process.env,
  DATABASE_URL: process.env.DATABASE_TEST_URL,
  SEED_DEMO: "false",
  TEAM_SLUG: "",
  DEV_SECRETS_FILE: "",
  PG_MIGRATION_LOCK_TIMEOUT_MS: "100",
});
it("runtime bootstrap avoids DDL locks but default Docker bootstrap still migrates", async () => {
  const lock = new Client({ connectionString: process.env.DATABASE_TEST_URL });
  await lock.connect();
  const dir = mkdtempSync(join(tmpdir(), "readiness-bootstrap-"));
  try {
    await lock.query("begin");
    await lock.query("lock table tasks in access share mode");
    const secrets = join(dir, "secrets");
    const bootEnv = {
      ...env(),
      DEV_SECRETS_FILE: secrets,
      AUTH_SECRET: "",
      SECRETS_KEY: "",
    };
    const runtime = await exec(
      process.execPath,
      ["docker/bootstrap.mjs", "--schema=predeployed"],
      { env: bootEnv, timeout: 10000 },
    );
    expect(runtime.stdout).toContain("schema owned by pre-deploy");
    const first = readFileSync(secrets, "utf8");
    expect(first).toContain("AUTH_SECRET=");
    await exec(
      process.execPath,
      ["docker/bootstrap.mjs", "--schema=predeployed"],
      { env: bootEnv, timeout: 10000 },
    );
    expect(readFileSync(secrets, "utf8")).toBe(first);
    await expect(
      exec(process.execPath, ["docker/bootstrap.mjs"], {
        env: env(),
        timeout: 15000,
      }),
    ).rejects.toMatchObject({ code: 1 });
    await lock.query("rollback");
    const normal = await exec(process.execPath, ["docker/bootstrap.mjs"], {
      env: env(),
      timeout: 15000,
    });
    expect(normal.stdout).toContain("loading schema");
    expect(normal.stdout).toContain("postgres/schema.sql");
  } finally {
    await lock.query("rollback");
    await lock.end();
    rmSync(dir, { recursive: true, force: true });
  }
}, 30000);
it("predeployed mode still provisions an operator and preserves an existing credential", async () => {
  const setup = {
    ...env(),
    TEAM_SLUG: "startup-fixture",
    TEAM_NAME: "Startup fixture",
    ADMIN_EMAIL: "startup@example.test",
    ADMIN_NAME: "Operator",
    ADMIN_PASSWORD: "synthetic-startup-password", // aios-secret-fixture:synthetic-startup-password
  };
  const db = new Client({ connectionString: process.env.DATABASE_TEST_URL });
  await db.connect();
  try {
    await exec(
      process.execPath,
      ["docker/bootstrap.mjs", "--schema=predeployed"],
      { env: setup, timeout: 15000 },
    );
    const first = (
      await db.query("select password_hash from auth_users where email=$1", [
        setup.ADMIN_EMAIL,
      ])
    ).rows[0].password_hash;
    expect(first).toBeTruthy();
    await exec(
      process.execPath,
      ["docker/bootstrap.mjs", "--schema=predeployed"],
      {
        env: { ...setup, ADMIN_PASSWORD: "synthetic-replacement-password" }, // aios-secret-fixture:synthetic-replacement-password
        timeout: 15000,
      },
    );
    expect(
      (
        await db.query("select password_hash from auth_users where email=$1", [
          setup.ADMIN_EMAIL,
        ])
      ).rows[0].password_hash,
    ).toBe(first);
  } finally {
    await db.end();
  }
}, 35000);
it("real pool exhaustion is bounded, late checkout is released and readiness recovers", async () => {
  const pool = new Pool({
    connectionString: process.env.DATABASE_TEST_URL,
    max: 1,
    connectionTimeoutMillis: 1000,
  });
  const held = await pool.connect();
  try {
    const start = Date.now();
    expect(await probePostgres(() => pool.connect(), 50)).toBe(false);
    expect(Date.now() - start).toBeLessThan(1000);
    held.release();
    expect(await probePostgres(() => pool.connect(), 500)).toBe(true);
    expect(pool.totalCount).toBe(1);
  } finally {
    await pool.end();
  }
});
it("real terminated checked-out connection fails safely and next probe recovers", async () => {
  const pool = new Pool({
    connectionString: process.env.DATABASE_TEST_URL,
    max: 1,
  });
  const killer = new Client({
    connectionString: process.env.DATABASE_TEST_URL,
  });
  await killer.connect();
  try {
    const c = await pool.connect();
    const pid = (await c.query("select pg_backend_pid() pid")).rows[0].pid;
    // Queue a real blocking query ahead of the health SELECT, then terminate it.
    const blocked = c.query("select pg_sleep(5)").catch(() => undefined);
    const probe = probePostgres(async () => c, 1000);
    await new Promise((r) => setTimeout(r, 20));
    await killer.query("select pg_terminate_backend($1)", [pid]);
    expect(await probe).toBe(false);
    await blocked;
    expect(await probePostgres(() => pool.connect(), 1000)).toBe(true);
  } finally {
    await killer.end();
    await pool.end();
  }
});
