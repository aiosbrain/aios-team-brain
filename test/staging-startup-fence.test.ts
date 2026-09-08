import { describe, expect, it, vi } from "vitest";
import { acquireStartupFence, copyFenceRequired } from "../scripts/staging-ops/startup-fence.mjs";

describe("copy-mode startup fence", () => {
  it("preserves production defaults and pins staging identity", async () => {
    expect(copyFenceRequired({} as NodeJS.ProcessEnv)).toBe(false);
    expect(copyFenceRequired({ RAILWAY_ENVIRONMENT_ID: "production" } as NodeJS.ProcessEnv)).toBe(false);
    await expect(acquireStartupFence({ env: { STAGING_DATA_MODE: "copy-ready" } as NodeJS.ProcessEnv })).rejects.toThrow(/environment identity/);
  });

  const fakeClient = (journal: Record<string, unknown> | null) => ({
    connect: vi.fn(),
    query: vi.fn(async (sql: string) => {
      if (sql.includes("pg_try_advisory_lock_shared")) return { rows: [{ acquired: true }] };
      if (sql.includes("to_regclass")) return { rows: [{ journal_table: journal ? "staging_ops.refresh_journal" : null }] };
      if (sql.includes("refresh_journal")) return { rows: journal ? [journal] : [] };
      return { rows: [] };
    }),
    end: vi.fn(), on: vi.fn(),
  });

  it("M4: refuses PROMPTLY, by name, when maintenance holds the exclusive lock", async () => {
    // It used to acquire with `wait=true`, so an ordinary boot during a refresh queued inside
    // `pg_advisory_lock_shared` for the WHOLE import. AC-06 says admission refuses while
    // maintenance owns the data, and a request that waits an unbounded time is not a refusal — it
    // is the same outage with no diagnostic. The safety exclusion is unchanged; only the waiting is.
    const client = {
      connect: vi.fn(),
      // `acquired: false` is exactly what `pg_try_advisory_lock_shared` returns against an
      // exclusive holder. No statement_timeout is configured here, so nothing but the refusal
      // itself can end this call.
      query: vi.fn(async (sql: string) => (String(sql).includes("pg_try_advisory_lock_shared") ? { rows: [{ acquired: false }] } : { rows: [] })),
      end: vi.fn(), on: vi.fn(),
    };
    await expect(acquireStartupFence({
      env: { STAGING_DATA_MODE: "copy-ready", DATABASE_URL: "postgres://db/x", STAGING_OPS_ENVIRONMENT_ID: "stg", RAILWAY_ENVIRONMENT_ID: "stg" } as NodeJS.ProcessEnv,
      createClient: () => client,
    })).rejects.toThrow(/staging maintenance holds the exclusive data-use lock/);
    // The refusal happened BEFORE any journal classification, and did not leak the connection.
    expect(client.query.mock.calls.length).toBe(1);
    expect(client.end).toHaveBeenCalled();
  });

  it("holds a shared session lock and rechecks ready before returning", async () => {
    const client = fakeClient({ state: "ready", run_id: "run-1" });
    const result = await acquireStartupFence({
      env: { STAGING_DATA_MODE: "copy-ready", DATABASE_URL: "postgres://db/x", STAGING_OPS_ENVIRONMENT_ID: "stg", RAILWAY_ENVIRONMENT_ID: "stg" } as NodeJS.ProcessEnv,
      createClient: () => client,
    });
    expect(result?.client).toBe(client);
    expect(client.query.mock.calls[0][0]).toContain("pg_try_advisory_lock_shared");
    expect(client.end).not.toHaveBeenCalled();
  });

  it("fails closed and releases the connection when journal is not ready", async () => {
    const client = fakeClient({ state: "importing", run_id: "run-1" });
    await expect(acquireStartupFence({
      env: { STAGING_DATA_MODE: "copy-ready", DATABASE_URL: "postgres://db/x", STAGING_OPS_ENVIRONMENT_ID: "stg", RAILWAY_ENVIRONMENT_ID: "stg" } as NodeJS.ProcessEnv,
      createClient: () => client,
    })).rejects.toThrow(/importing/);
    expect(client.end).toHaveBeenCalled();
  });

  it("admits only the exact selected commit during booting", async () => {
    const journal = { state: "booting", run_id: "run-2", boot_run_id: "run-2", boot_commit: "a".repeat(40) };
    const env = { STAGING_DATA_MODE: "copy-ready", DATABASE_URL: "postgres://db/x", STAGING_OPS_ENVIRONMENT_ID: "stg", RAILWAY_ENVIRONMENT_ID: "stg", RAILWAY_GIT_COMMIT_SHA: "b".repeat(40) } as NodeJS.ProcessEnv;
    const client = fakeClient(journal);
    await expect(acquireStartupFence({ env, createClient: () => client }))
      .rejects.toThrow(/not the selected booting deployment/);
    expect(client.end).toHaveBeenCalled();

    // …and the SAME journal admits the process that IS that selected deployment (B1).
    const admitted = fakeClient(journal);
    const fence = await acquireStartupFence({ env: { ...env, RAILWAY_GIT_COMMIT_SHA: "a".repeat(40) }, createClient: () => admitted });
    expect(fence?.journal.run_id).toBe("run-2");
  });

  it.each([undefined, "corrupted"])("refuses activated staging with %s mode before startup", async (mode) => {
    const client = fakeClient({ state: "importing", run_id: "run-3", last_ready_run_id: "run-2" });
    await expect(acquireStartupFence({
      env: {
        ...(mode === undefined ? {} : { STAGING_DATA_MODE: mode }),
        DATABASE_URL: "postgres://db/x", STAGING_OPS_ENVIRONMENT_ID: "stg", RAILWAY_ENVIRONMENT_ID: "stg",
      } as NodeJS.ProcessEnv,
      createClient: () => client,
    })).rejects.toThrow(/activated staging requires STAGING_DATA_MODE/);
    expect(client.end).toHaveBeenCalledTimes(1);
  });

  it("preserves pinned preactivation legacy compatibility while still holding the shared fence", async () => {
    const client = fakeClient(null);
    const result = await acquireStartupFence({
      env: { DATABASE_URL: "postgres://db/x", STAGING_OPS_ENVIRONMENT_ID: "stg", RAILWAY_ENVIRONMENT_ID: "stg" } as NodeJS.ProcessEnv,
      createClient: () => client,
    });
    expect(result?.admission).toMatchObject({ activated: false, mode: "legacy-pg-only" });
    expect(client.query.mock.calls[0][0]).toContain("pg_try_advisory_lock_shared");
    expect(client.end).not.toHaveBeenCalled();
  });

  it("does not treat the installer's empty failed singleton as activation", async () => {
    const client = fakeClient({ state: "failed", run_id: null, last_ready_run_id: null });
    const result = await acquireStartupFence({
      env: { STAGING_DATA_MODE: "legacy-pg-only", DATABASE_URL: "postgres://db/x", STAGING_OPS_ENVIRONMENT_ID: "stg", RAILWAY_ENVIRONMENT_ID: "stg" } as NodeJS.ProcessEnv,
      createClient: () => client,
    });
    expect(result?.admission).toMatchObject({ activated: false, reason: "empty-installer-journal" });
  });
});
