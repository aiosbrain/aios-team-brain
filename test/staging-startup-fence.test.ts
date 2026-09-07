import { describe, expect, it, vi } from "vitest";
import { acquireStartupFence, copyFenceRequired } from "../scripts/staging-ops/startup-fence.mjs";

describe("copy-mode startup fence", () => {
  it("preserves production defaults and pins staging identity", async () => {
    expect(copyFenceRequired({} as NodeJS.ProcessEnv)).toBe(false);
    await expect(acquireStartupFence({ env: { STAGING_DATA_MODE: "copy-ready" } as NodeJS.ProcessEnv })).rejects.toThrow(/DATABASE_URL/);
  });

  it("holds a shared session lock and rechecks ready before returning", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ acquired: true }] })
      .mockResolvedValueOnce({ rows: [{ state: "ready", run_id: "run-1" }] });
    const client = { connect: vi.fn(), query, end: vi.fn(), on: vi.fn() };
    const result = await acquireStartupFence({
      env: { STAGING_DATA_MODE: "copy-ready", DATABASE_URL: "postgres://db/x", STAGING_OPS_ENVIRONMENT_ID: "stg", RAILWAY_ENVIRONMENT_ID: "stg" } as NodeJS.ProcessEnv,
      createClient: () => client,
    });
    expect(result?.client).toBe(client);
    expect(query.mock.calls[0][0]).toContain("pg_advisory_lock_shared");
    expect(client.end).not.toHaveBeenCalled();
  });

  it("fails closed and releases the connection when journal is not ready", async () => {
    const client = { connect: vi.fn(), query: vi.fn().mockResolvedValueOnce({ rows: [{}] }).mockResolvedValueOnce({ rows: [{ state: "importing", run_id: "run-1" }] }), end: vi.fn(), on: vi.fn() };
    await expect(acquireStartupFence({
      env: { STAGING_DATA_MODE: "copy-ready", DATABASE_URL: "postgres://db/x", STAGING_OPS_ENVIRONMENT_ID: "stg", RAILWAY_ENVIRONMENT_ID: "stg" } as NodeJS.ProcessEnv,
      createClient: () => client,
    })).rejects.toThrow(/importing/);
    expect(client.end).toHaveBeenCalled();
  });

  it("admits only the exact selected commit during booting", async () => {
    const client = { connect: vi.fn(), query: vi.fn().mockResolvedValueOnce({ rows: [{}] }).mockResolvedValueOnce({ rows: [{ state: "booting", run_id: "run-2", catchup_commit: "a".repeat(40) }] }), end: vi.fn(), on: vi.fn() };
    await expect(acquireStartupFence({ env: { STAGING_DATA_MODE: "copy-ready", DATABASE_URL: "postgres://db/x", STAGING_OPS_ENVIRONMENT_ID: "stg", RAILWAY_ENVIRONMENT_ID: "stg", RAILWAY_GIT_COMMIT_SHA: "b".repeat(40) } as NodeJS.ProcessEnv, createClient: () => client })).rejects.toThrow(/booting/);
  });
});
