import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { supervise } from "../scripts/staging-ops/startup-fence.mjs";
import { groupAlive, supervisionSupported } from "../scripts/staging-ops/owned-workload.mjs";

/**
 * The fence's half of the runtime-5 corrections.
 *
 * It supervises `npm` → `next`, so signalling its immediate child left the Next process holding
 * `0.0.0.0:3000` — and the fence then released its shared database lock because npm had exited,
 * while a process was still serving from the copied dataset. Both are lifecycle questions, and both
 * are now answered by the same owned-workload primitive the controller uses.
 *
 * Real processes, a real socket and a real chain: "the signal was sent" is not the property.
 */

const FIXTURE = fileURLToPath(new URL("./fixtures/owned-workload-wrapper.mjs", import.meta.url));
const POSIX = supervisionSupported();

async function freePort(): Promise<number> {
  return await new Promise((resolve) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}
const canBind = async (port: number) => await new Promise<boolean>((resolve) => {
  const probe = createServer();
  probe.once("error", () => resolve(false));
  probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
});
const waitFor = async (predicate: () => boolean | Promise<boolean>, timeoutMs = 8_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (await predicate()) return true; await new Promise((r) => setTimeout(r, 25)); }
  return false;
};

const groups: number[] = [];
afterEach(() => {
  for (const pgid of groups.splice(0)) { try { process.kill(-pgid, "SIGKILL"); } catch { /* gone */ } }
  vi.restoreAllMocks();
});

const COMMIT = "a".repeat(40);
const COPY_ENV = {
  STAGING_DATA_MODE: "copy-ready",
  DATABASE_URL: "postgres://app:pw@staging-pg:5432/brain",
  STAGING_OPS_ENVIRONMENT_ID: "staging-local",
  RAILWAY_ENVIRONMENT_ID: "staging-local",
  RAILWAY_GIT_COMMIT_SHA: COMMIT,
} as unknown as NodeJS.ProcessEnv;

/**
 * A fence connection that records, AT THE MOMENT IT IS RELEASED, whether the supervised group is
 * still alive. That is the ordering claim stated as an observation rather than as a timestamp
 * comparison: `groupAlive` is synchronous, so the answer cannot drift between the two events.
 */
function fenceClient(groupOf: () => number | null) {
  const events: string[] = [];
  const state = { groupAliveAtRelease: null as boolean | null };
  const handlers: Record<string, ((...args: unknown[]) => void)[]> = {};
  const client = {
    connect: vi.fn(async () => { events.push("connect"); }),
    query: vi.fn(async (sql: string) => {
      // NON-BLOCKING acquisition (M4): the fence now asks `pg_try_advisory_lock_shared` and
      // requires an explicit `acquired: true`, so this fake must answer the question rather than
      // return an empty row — a shape that would now (correctly) read as "refused".
      if (String(sql).includes("advisory_lock")) { events.push("lock"); return { rows: [{ acquired: true }] }; }
      if (String(sql).includes("to_regclass")) return { rows: [{ journal_table: "staging_ops.refresh_journal" }] };
      if (String(sql).includes("refresh_journal")) return { rows: [{ state: "ready", run_id: "run-1", last_ready_run_id: "run-1", last_ready_mode: "copy-ready" }] };
      return { rows: [] };
    }),
    end: vi.fn(async () => {
      const pgid = groupOf();
      state.groupAliveAtRelease = pgid == null ? false : groupAlive(pgid);
      events.push("release-lock");
    }),
    on: (event: string, handler: (...args: unknown[]) => void) => { (handlers[event] ??= []).push(handler); },
    emit: (event: string, ...args: unknown[]) => { for (const handler of handlers[event] ?? []) handler(...args); },
  };
  return { client, events, state };
}

/** Real spawn, with the resulting group recorded so the test can observe and clean it up. */
function recordingSpawn() {
  let pgid: number | null = null;
  const spawnImpl = ((file: string, args: string[], options: object) => {
    const child = spawn(file, args, options as never);
    pgid = child.pid ?? null;
    if (pgid != null) groups.push(pgid);
    return child;
  }) as never;
  return { spawnImpl, groupOf: () => pgid };
}

describe.runIf(POSIX)("the fence holds its lock until the WORKLOAD is gone", () => {
  it("releases the lock only after the owned workload has stopped — not when the wrapper exits", async () => {
    // The measured shape: the wrapper exits first and a descendant keeps the listener. Releasing on
    // the wrapper's exit would drop the fence while that descendant was still serving.
    const port = await freePort();
    const { spawnImpl, groupOf } = recordingSpawn();
    const { client, events, state } = fenceClient(groupOf);

    const outcome = await supervise([process.execPath, FIXTURE, String(port), "0", "150"], {
      env: COPY_ENV, createClient: () => client as never, spawnImpl,
    });

    expect(outcome.code).toBe(0);
    expect(events).toEqual(["connect", "lock", "release-lock"]);
    expect(state.groupAliveAtRelease, "the lock was released while the workload was still alive").toBe(false);
    expect(await waitFor(() => canBind(port)), "a descendant still holds the address").toBe(true);
  }, 30_000);

  it("terminates promptly on a lost database connection, and claims no protection", async () => {
    // The lock is ALREADY gone when the connection drops, so waiting politely protects nothing.
    const port = await freePort();
    const { spawnImpl, groupOf } = recordingSpawn();
    const { client, events } = fenceClient(groupOf);

    const supervising = supervise([process.execPath, FIXTURE, String(port), "0", "0"], {
      env: COPY_ENV, createClient: () => client as never, spawnImpl,
    });
    expect(await waitFor(() => canBind(port).then((free) => !free)), "the fixture never bound the port").toBe(true);

    client.emit("error", new Error("connection terminated unexpectedly"));

    await supervising;
    expect(events).toContain("release-lock");
    expect(await waitFor(() => canBind(port)), "the workload outlived the lost lock").toBe(true);
    expect(groupOf() != null && groupAlive(groupOf()!)).toBe(false);
  }, 30_000);

  it("ends the fence connection when the payload cannot be spawned at all", async () => {
    const { client, events } = fenceClient(() => null);
    await expect(supervise(["/nonexistent/definitely-not-a-binary"], { env: COPY_ENV, createClient: () => client as never }))
      .rejects.toThrow(/failed to spawn \(ENOENT\)/);
    expect(events).toContain("release-lock");
  }, 20_000);

  it("refuses to supervise on a platform with no ownership mechanism, and releases the lock", async () => {
    const { client, events } = fenceClient(() => null);
    await expect(supervise([process.execPath, "-e", "0"], { env: COPY_ENV, createClient: () => client as never, platform: "win32" }))
      .rejects.toThrow(/POSIX process groups/);
    expect(events, "a refusal must not leak the fence connection").toEqual(["connect", "lock", "release-lock"]);
  }, 20_000);
});

describe.runIf(POSIX)("every shutdown path converges on ONE idempotent cleanup", () => {
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    it(`${signal} stops the whole owned workload and frees the address`, async () => {
      const port = await freePort();
      const { spawnImpl, groupOf } = recordingSpawn();
      // No fence in legacy mode, so this isolates the SIGNAL path from the lock path.
      const supervising = supervise([process.execPath, FIXTURE, String(port), "0", "0"], {
        env: { STAGING_DATA_MODE: "legacy-pg-only" } as unknown as NodeJS.ProcessEnv, spawnImpl,
      });
      expect(await waitFor(() => canBind(port).then((free) => !free))).toBe(true);

      // The fence installs `process.once(signal, …)`; emitting it drives the real handler without
      // signalling the test runner itself.
      process.emit(signal as never);

      await supervising;
      expect(await waitFor(() => canBind(port)), `${signal} left the workload holding the address`).toBe(true);
      expect(groupAlive(groupOf()!)).toBe(false);
    }, 30_000);
  }
});

describe("failed healthy-fence cleanup remains contained", () => {
  function syntheticChild(pid = 4242) {
    const child = new EventEmitter() as EventEmitter & { pid: number };
    child.pid = pid;
    return child;
  }

  it.each(["EPERM", "EACCES"])("retains the healthy lock across %s signal failure and releases once after verified disappearance", async (errorCode) => {
    const child = syntheticChild();
    let alive = true;
    let stopAttempts = 0;
    const kill = vi.fn((_pid: number, signal: string | number) => {
      if (signal === 0) {
        if (alive) return true;
        throw Object.assign(new Error("gone"), { code: "ESRCH" });
      }
      stopAttempts += 1;
      throw Object.assign(new Error("signal refused"), { code: errorCode });
    });
    const { client } = fenceClient(() => child.pid);
    const supervising = supervise(["synthetic"], {
      env: COPY_ENV,
      createClient: () => client as never,
      spawnImpl: (() => child) as never,
      kill: kill as never,
      stopOptions: { graceMs: 0, verifyMs: 2, pollMs: 1 },
      cleanupRetryMs: 2,
    });
    expect(await waitFor(() => child.listenerCount("exit") > 0, 1_000)).toBe(true);
    child.emit("exit", 0, null);

    expect(await waitFor(() => stopAttempts >= 2, 1_000)).toBe(true);
    expect(client.end, "a healthy lock must remain held while workload absence is unverified").not.toHaveBeenCalled();

    alive = false;
    await expect(supervising).resolves.toEqual({ code: 0, signal: null });
    expect(client.end).toHaveBeenCalledTimes(1);
  });
});
