import { describe, expect, it, vi } from "vitest";
import { bootAdmissionVerdict } from "../scripts/staging-ops/journal.mjs";
import { acquireStartupFence } from "../scripts/staging-ops/startup-fence.mjs";
import { loadSchema } from "../scripts/pg-load-schema.mjs";

const SELECTED = "a".repeat(40);
const OTHER = "b".repeat(40);

const booting = (over: Record<string, unknown> = {}) => ({
  state: "booting",
  run_id: "run-7",
  boot_run_id: "run-7",
  boot_commit: SELECTED,
  candidate_mode: "copy-ready",
  ...over,
});

describe("B1 — the boot admission shared by the schema loader and the startup fence", () => {
  it("admits the exact deployment the importer selected while the journal still says booting", () => {
    // The regression: the importer deploys the app during `booting`, so a ready-only gate failed
    // the predeploy of the very deployment the refresh was waiting for.
    expect(bootAdmissionVerdict(booting(), { RAILWAY_GIT_COMMIT_SHA: SELECTED } as NodeJS.ProcessEnv))
      .toEqual({ ok: true, reason: "selected booting deployment" });
  });

  it("admits an ordinary ready journal", () => {
    expect(bootAdmissionVerdict({ state: "ready", run_id: "run-7" }, {} as NodeJS.ProcessEnv).ok).toBe(true);
  });

  it.each([
    ["a different commit", booting(), { RAILWAY_GIT_COMMIT_SHA: OTHER }, /not the selected booting deployment/],
    ["no commit identity at all", booting(), {}, /reports no exact commit identity/],
    ["no recorded boot identity", booting({ boot_commit: null }), { RAILWAY_GIT_COMMIT_SHA: SELECTED }, /no exact selected boot identity/],
    ["a boot run that is not the current run", booting({ boot_run_id: "run-6" }), { RAILWAY_GIT_COMMIT_SHA: SELECTED }, /does not match its current run/],
    ["a ready journal with no run identity", { state: "ready", run_id: null }, {}, /no run identity/],
    ["any other state", { state: "importing", run_id: "run-7" }, { RAILWAY_GIT_COMMIT_SHA: SELECTED }, /refresh state is importing/],
    ["a failed state", { state: "failed", run_id: "run-7" }, { RAILWAY_GIT_COMMIT_SHA: SELECTED }, /refresh state is failed/],
  ])("refuses %s", (_label, journal, env, reason) => {
    const verdict = bootAdmissionVerdict(journal, env as NodeJS.ProcessEnv);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(reason as RegExp);
  });
});

describe("B1 — both admission sites apply that one verdict", () => {
  const env = {
    STAGING_DATA_MODE: "copy-ready",
    DATABASE_URL: "postgres://db/x",
    STAGING_OPS_ENVIRONMENT_ID: "stg",
    RAILWAY_ENVIRONMENT_ID: "stg",
    RAILWAY_GIT_COMMIT_SHA: SELECTED,
  } as NodeJS.ProcessEnv;

  function fakeClient(journalRow: Record<string, unknown>) {
    const query = vi.fn(async (sql: string) => {
      if (String(sql).includes("pg_try_advisory_lock_shared")) return { rows: [{ acquired: true }] };
      if (String(sql).includes("to_regclass")) return { rows: [{ journal_table: "staging_ops.refresh_journal" }] };
      if (String(sql).includes("refresh_journal")) return { rows: [journalRow] };
      return { rows: [] };
    });
    return { connect: vi.fn(), query, end: vi.fn(), on: vi.fn() };
  }

  it("lets the startup fence admit the selected booting deployment", async () => {
    const client = fakeClient(booting());
    const fence = await acquireStartupFence({ env, createClient: () => client });
    expect(fence?.journal.state).toBe("booting");
    expect(client.end).not.toHaveBeenCalled();
  });

  it("lets the schema loader admit the same selected booting deployment", async () => {
    const client = fakeClient(booting());
    await loadSchema({
      cwd: "/nonexistent-schema-root",
      databaseUrl: "postgres://db/x",
      env,
      createClient: () => client,
      exists: () => false,
      readFile: () => "",
      readDir: () => [],
      logger: { log: () => {} },
    });
    // Reaching the loader body at all is the assertion: before this fix the same journal row threw.
    const statements = client.query.mock.calls.map((call) => String(call[0]));
    expect(statements.some((sql) => sql.includes("pg_try_advisory_lock_shared"))).toBe(true);
    expect(statements.some((sql) => sql.includes("lock_timeout"))).toBe(true);
  });

  it("keeps the loader refusing every state that is neither ready nor the selected boot", async () => {
    const client = fakeClient({ state: "importing", run_id: "run-7" });
    await expect(loadSchema({
      cwd: "/nonexistent-schema-root",
      databaseUrl: "postgres://db/x",
      env,
      createClient: () => client,
      exists: () => false,
      readFile: () => "",
      readDir: () => [],
      logger: { log: () => {} },
    })).rejects.toThrow(/staging schema loader refused: refresh state is importing/);
  });

  it.each([undefined, "corrupted"])("refuses activated importing state with %s mode before schema SQL", async (mode) => {
    const client = fakeClient({ state: "importing", run_id: "run-8", last_ready_run_id: "run-7" });
    await expect(loadSchema({
      cwd: "/nonexistent-schema-root",
      databaseUrl: "postgres://db/x",
      env: {
        ...(mode === undefined ? {} : { STAGING_DATA_MODE: mode }),
        STAGING_OPS_ENVIRONMENT_ID: "stg", RAILWAY_ENVIRONMENT_ID: "stg",
      } as NodeJS.ProcessEnv,
      createClient: () => client,
      exists: () => false,
      readFile: () => "schema mutation must not run",
      readDir: () => [],
      logger: { log: () => {} },
    })).rejects.toThrow(/activated staging requires STAGING_DATA_MODE/);
    const statements = client.query.mock.calls.map((call) => String(call[0]));
    expect(statements.some((sql) => sql.includes("schema mutation must not run") || sql.includes("lock_timeout"))).toBe(false);
  });

  it("keeps an activated explicit legacy rollback under the common fence", async () => {
    const client = fakeClient({ state: "ready", run_id: "legacy-ready", last_ready_run_id: "legacy-ready", last_ready_mode: "legacy-pg-only" });
    await loadSchema({
      cwd: "/nonexistent-schema-root", databaseUrl: "postgres://db/x",
      env: { STAGING_DATA_MODE: "legacy-pg-only", STAGING_OPS_ENVIRONMENT_ID: "stg", RAILWAY_ENVIRONMENT_ID: "stg" } as NodeJS.ProcessEnv,
      createClient: () => client, exists: () => false, readFile: () => "", readDir: () => [], logger: { log: () => {} },
    });
    const statements = client.query.mock.calls.map((call) => String(call[0]));
    expect(statements.some((sql) => sql.includes("pg_try_advisory_lock_shared"))).toBe(true);
    expect(statements.some((sql) => sql.includes("lock_timeout"))).toBe(true);
  });
});
