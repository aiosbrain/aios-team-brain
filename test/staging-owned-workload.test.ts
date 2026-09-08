import { execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { groupAlive, spawnOwnedWorkload, supervisionSupported } from "../scripts/staging-ops/owned-workload.mjs";

/**
 * Runtime 5 measured two defects that a mocked `kill()` assertion could never have caught, so these
 * run REAL processes:
 *
 *  1. PID 18 exited with `exitCode:null, exitSignal:SIGTERM` — its first stop completed in 2 ms.
 *     Because both the active listing and the stop guard tested `exitCode` alone, it was reported
 *     alive, a SECOND stop was requested, and that stop waited 10,007 ms for an exit event that had
 *     already fired.
 *  2. PID 17's stop "completed", and the replacement deployment 10 s later died with
 *     `EADDRINUSE 0.0.0.0:3000`. The chain is controller → fence → npm → Next: the tracked child
 *     exited and a descendant kept the listener.
 *
 * "The signal was delivered" is not the property. The property is that the OWNED WORKLOAD is gone,
 * the address can be REBOUND, and everything we do not own is untouched — so each test below binds
 * a real socket, records PID/PPID/PGID, and keeps an unrelated sentinel running throughout.
 */

const FIXTURE = fileURLToPath(new URL("./fixtures/owned-workload-wrapper.mjs", import.meta.url));
const POSIX = supervisionSupported();

/** A free localhost port, released before use — the fixture binds it for real. */
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
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
};

/**
 * PID → {ppid, pgid}, read from the OS for EXACTLY the pids named. This is evidence collection in a
 * test, addressed by pid — not the broad process enumeration the implementation is forbidden from
 * doing, and nothing here signals anything.
 */
function processAncestry(pids: number[]): Map<number, { ppid: number; pgid: number }> {
  const out = new Map<number, { ppid: number; pgid: number }>();
  const listed = execFileSync("ps", ["-o", "pid=,ppid=,pgid=", "-p", pids.join(",")], { encoding: "utf8" });
  for (const line of listed.split("\n")) {
    const [pid, ppid, pgid] = line.trim().split(/\s+/).map(Number);
    if (Number.isFinite(pid)) out.set(pid, { ppid, pgid });
  }
  return out;
}

/** Everything started here, so an aborted test cannot leave a real process behind. */
const started: { pgid: number | null }[] = [];
afterEach(() => {
  for (const { pgid } of started.splice(0)) {
    if (pgid != null) { try { process.kill(-pgid, "SIGKILL"); } catch { /* already gone */ } }
  }
});

function start(args: string[], stdio: "ignore" | "pipe" = "pipe") {
  const workload = spawnOwnedWorkload({ command: [process.execPath, FIXTURE, ...args], stdio, label: "fixture" });
  started.push({ pgid: workload.pgid });
  return workload;
}

/** The JSON lines the fixture prints: role, pid, ppid, pgid — no arguments, no environment. */
function collectRoles(workload: ReturnType<typeof spawnOwnedWorkload>) {
  const seen: Record<string, unknown>[] = [];
  workload.child.stdout?.on("data", (chunk: Buffer) => {
    for (const line of String(chunk).split("\n")) {
      if (!line.trim()) continue;
      try { seen.push(JSON.parse(line)); } catch { /* not a fixture line */ }
    }
  });
  return seen;
}

describe.runIf(POSIX)("terminal outcomes settle exactly once, from the OS", () => {
  it("settles a numeric exit", async () => {
    const workload = spawnOwnedWorkload({ command: [process.execPath, "-e", "process.exit(3)"], stdio: "ignore", label: "numeric" });
    started.push({ pgid: workload.pgid });
    expect(await workload.completion).toMatchObject({ kind: "exited", code: 3, signal: null });
    expect(workload.terminal()).toMatchObject({ code: 3 });
  });

  it("settles a SIGNAL exit — the case `exitCode` alone cannot see", async () => {
    // The measured defect in one line: this outcome has `code: null`, and every liveness test that
    // read `exitCode == null` called it alive.
    const workload = start(["0", "0", "0"], "ignore");
    await waitFor(() => Boolean(workload.pid));
    process.kill(workload.pid!, "SIGTERM");
    const outcome = await workload.completion;
    expect(outcome).toMatchObject({ kind: "exited", code: null, signal: "SIGTERM" });
    expect(workload.terminal(), "a settled terminal outcome, not a null exit code").not.toBeNull();
  });

  it("settles a SPAWN FAILURE as its own outcome, not as an exit", async () => {
    const workload = spawnOwnedWorkload({ command: ["/nonexistent/definitely-not-a-binary"], stdio: "ignore", label: "spawn-fail" });
    const outcome = await workload.completion;
    expect(outcome.kind).toBe("spawn-failed");
    expect(outcome.errorCode).toBe("ENOENT");
  });
});

describe.runIf(POSIX)("stops are idempotent and never wait on an exit that already happened", () => {
  it("returns promptly when the workload is ALREADY terminal", async () => {
    // THE 10,007 ms HANG. Stop after exit used to await an event that had fired minutes earlier.
    const workload = spawnOwnedWorkload({ command: [process.execPath, "-e", "process.exit(0)"], stdio: "ignore", label: "already-exited" });
    started.push({ pgid: workload.pgid });
    await workload.completion;
    const started_at = Date.now();
    const outcome = await workload.stop();
    expect(outcome.stopped).toBe(true);
    expect(outcome.reason).toBe("already-terminal");
    expect(Date.now() - started_at, "a stop after exit must not wait").toBeLessThan(1_000);
  });

  it("reuses ONE operation for simultaneous stops", async () => {
    const workload = start(["0", "0", "0"], "ignore");
    await waitFor(() => Boolean(workload.pid));
    const [a, b, c] = await Promise.all([workload.stop(), workload.stop(), workload.stop()]);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(a.stopped).toBe(true);
  });

  it("survives a stop RACING the workload's own termination", async () => {
    const workload = start(["0", "0", "0"], "ignore");
    await waitFor(() => Boolean(workload.pid));
    // Terminate underneath the stop, so the exit lands while the stop is mid-flight.
    const racing = workload.stop();
    try { process.kill(workload.pid!, "SIGKILL"); } catch { /* it may already be gone */ }
    const outcome = await racing;
    expect(outcome.stopped).toBe(true);
    // A repeat still returns immediately rather than hanging.
    expect((await workload.stop()).stopped).toBe(true);
  });

  it("retries a previously unverified stop instead of memoizing failure forever", async () => {
    const child = new EventEmitter() as EventEmitter & { pid: number };
    child.pid = 4242;
    let alive = true;
    const kill = vi.fn((_pid: number, signal: string | number) => {
      if (signal === 0 && alive) return true;
      throw Object.assign(new Error("unavailable"), { code: alive ? "EPERM" : "ESRCH" });
    });
    const workload = spawnOwnedWorkload({
      command: ["synthetic"], spawnImpl: (() => child) as never, kill: kill as never,
      label: "retryable-stop",
    });
    child.emit("exit", 0, null);
    const first = await workload.stop({ graceMs: 0, verifyMs: 0 });
    expect(first).toMatchObject({ stopped: false, reason: "group-survived" });

    alive = false;
    const second = await workload.stop({ graceMs: 0, verifyMs: 0 });
    expect(second).toMatchObject({ stopped: true, reason: "already-terminal" });
    expect(second).not.toBe(first);
  });
});

describe.runIf(POSIX)("the OWNED WORKLOAD stops, and nothing else does", () => {
  it("terminates a wrapper → child → grandchild chain and frees the address", async () => {
    const port = await freePort();
    const workload = start([String(port), "0", "0"]);
    const roles = collectRoles(workload);

    expect(await waitFor(() => roles.some((r) => r.role === "grandchild" && r.listening === port)), "the fixture never bound the port").toBe(true);
    expect(await canBind(port), "the grandchild holds the address").toBe(false);

    // ANCESTRY EVIDENCE, read from the OS rather than assumed: three distinct PIDs, each reporting
    // its parent, and all three in the workload's ONE process group. This is what makes "the group
    // is the unit of ownership" a measurement instead of a design claim.
    const pids = roles.filter((r) => typeof r.pid === "number") as { role: string; pid: number; ppid: number }[];
    expect(new Set(pids.map((r) => r.pid)).size).toBe(3);
    const ancestry = processAncestry(pids.map((r) => r.pid));
    for (const record of pids) {
      expect(ancestry.get(record.pid)?.pgid, `${record.role} is outside the owned group`).toBe(workload.pgid);
      expect(ancestry.get(record.pid)?.ppid, `${record.role} ancestry disagrees with its own report`).toBe(record.ppid);
    }
    // …and the chain really is a chain: the grandchild's parent is the child, not the wrapper.
    const byRole = Object.fromEntries(pids.map((r) => [r.role, r]));
    expect(byRole.child.ppid).toBe(byRole.wrapper.pid);
    expect(byRole.grandchild.ppid).toBe(byRole.child.pid);

    const outcome = await workload.stop({ graceMs: 2_000, verifyMs: 3_000 });
    expect(outcome.stopped).toBe(true);
    expect(groupAlive(workload.pgid!)).toBe(false);
    // THE PROPERTY THE RUNTIME-5 FAILURE VIOLATED: the address can be rebound.
    expect(await waitFor(() => canBind(port)), "the address was still held after a completed stop").toBe(true);
  }, 30_000);

  it("escalates to the owned group when a descendant IGNORES SIGTERM", async () => {
    const port = await freePort();
    const workload = start([String(port), "1", "0"]);
    const roles = collectRoles(workload);
    expect(await waitFor(() => roles.some((r) => r.listening === port))).toBe(true);

    const outcome = await workload.stop({ graceMs: 300, verifyMs: 5_000 });
    expect(outcome.escalated, "a SIGTERM-ignoring descendant must force escalation").toBe(true);
    expect(outcome.stopped).toBe(true);
    expect(await waitFor(() => canBind(port))).toBe(true);
  }, 30_000);

  it("stops descendants ORPHANED by a wrapper that exited first", async () => {
    // The exact runtime-5 shape: the tracked child is gone, the listener is not.
    const port = await freePort();
    const workload = start([String(port), "0", "150"]);
    const roles = collectRoles(workload);
    expect(await waitFor(() => roles.some((r) => r.listening === port))).toBe(true);
    await workload.completion; // the wrapper exits first, on its own
    expect(await canBind(port), "the orphaned descendant should still hold the port").toBe(false);

    const outcome = await workload.stop({ graceMs: 1_000, verifyMs: 5_000 });
    expect(outcome.stopped).toBe(true);
    expect(await waitFor(() => canBind(port)), "a wrapper exit is not a workload stop").toBe(true);
  }, 30_000);

  it("leaves an UNRELATED sentinel and its listener completely alone", async () => {
    // Nothing here kills by name, by command substring, by port occupancy or by enumeration, so a
    // process we did not start must be untouched — and its socket must stay bound.
    const sentinelPort = await freePort();
    const sentinel = spawnOwnedWorkload({ command: [process.execPath, FIXTURE, String(sentinelPort), "0", "0"], stdio: "pipe", label: "sentinel" });
    started.push({ pgid: sentinel.pgid });
    const sentinelRoles = collectRoles(sentinel);
    expect(await waitFor(() => sentinelRoles.some((r) => r.listening === sentinelPort))).toBe(true);

    const port = await freePort();
    const workload = start([String(port), "0", "0"]);
    const roles = collectRoles(workload);
    expect(await waitFor(() => roles.some((r) => r.listening === port))).toBe(true);
    expect(sentinel.pgid, "the two workloads must own DIFFERENT groups").not.toBe(workload.pgid);

    await workload.stop({ graceMs: 1_000, verifyMs: 5_000 });

    expect(groupAlive(sentinel.pgid!), "the unrelated sentinel was killed").toBe(true);
    expect(sentinel.terminal(), "the unrelated sentinel exited").toBeNull();
    expect(await canBind(sentinelPort), "the unrelated listener lost its socket").toBe(false);
  }, 30_000);
});

describe("platform ownership is explicit, never a silent fallback", () => {
  it("refuses supervision on Windows BEFORE spawning anything", () => {
    // Falling back to immediate-child termination there would preserve the defect silently.
    const spawnImpl = vi.fn();
    expect(() => spawnOwnedWorkload({ command: ["node"], platform: "win32", spawnImpl, label: "windows" }))
      .toThrow(/POSIX process groups; win32 has no supported ownership mechanism/);
    expect(spawnImpl, "nothing may be started that cannot then be contained").not.toHaveBeenCalled();
    expect(supervisionSupported("win32")).toBe(false);
    expect(supervisionSupported("linux")).toBe(true);
  });

  it("signals the GROUP, never the bare pid", () => {
    // A positive pid would signal the wrapper alone and re-create the measured defect. The sign is
    // applied inside the primitive so no caller can get it wrong.
    const kill = vi.fn();
    const child = { pid: 4242, once: vi.fn(), killed: false };
    const workload = spawnOwnedWorkload({
      command: ["node"], platform: "linux", label: "signal-shape",
      spawnImpl: () => child as never, kill: kill as never,
      setTimer: ((fn: () => void) => { fn(); return { unref() {} }; }) as never,
      clearTimer: (() => {}) as never,
    });
    void workload.stop({ graceMs: 0, verifyMs: 0 });
    expect(kill.mock.calls.every(([pid]) => Number(pid) < 0), "a positive pid signals only the wrapper").toBe(true);
    expect(kill.mock.calls.some(([pid, signal]) => pid === -4242 && signal === "SIGTERM")).toBe(true);
  });
});
