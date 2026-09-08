/**
 * ONE lifecycle for a supervised workload, with EXPLICIT OWNERSHIP.
 *
 * Measured in runtime 5 (`runtime-fifth-adjudication.md` + `service-maintenance.log`), two distinct
 * defects, both from improvising shutdown twice:
 *
 *   1. **A stop that waits for an exit that already happened.** PID 18 exited with
 *      `exitCode:null, exitSignal:SIGTERM` — its first stop completed in 2 ms. The active-listing
 *      filter and the stop guard both tested `exitCode != null`, which is still null for a
 *      signal-terminated child, so the process was listed as alive and a SECOND stop was requested.
 *      That stop awaited an `exit` event that had already fired, and bootstrap timed out at
 *      10,007 ms. `child.killed` does not help: it means "a signal was requested", not "it died".
 *   2. **A tracked child that exited while its descendants did not.** PID 17's stop completed, and
 *      the replacement deployment 10 s later failed with `EADDRINUSE 0.0.0.0:3000`. The chain is
 *      controller → startup fence → npm → Next, and killing the immediate child says nothing about
 *      the grandchild holding the listener.
 *
 * So: a terminal outcome is settled ONCE, at the point the OS reports it; the completion promise is
 * created at spawn time so no one can miss the event; every stop reuses one in-flight operation and
 * an already-stopped workload returns immediately; and "the tracked child exited" is kept strictly
 * separate from "the owned workload is gone".
 *
 * OWNERSHIP IS THE WHOLE MECHANISM. The payload is spawned into its OWN process group
 * (`detached: true`, so the child's PID is the PGID) and escalation signals **that group and
 * nothing else** — `process.kill(-pgid, …)`. Nothing here kills by executable name, by command
 * substring, by whoever holds a port, or by enumerating processes: a workload we did not start is
 * not ours to stop, and an unrelated listener must produce a clear refusal while staying alive.
 * `detached` here means "owns a group", never "fire and forget" — the supervisor keeps the handle
 * referenced and awaits it.
 *
 * PLATFORM. POSIX group signalling is the mechanism and Linux is the measured target. On Windows
 * there is no equivalent, so this refuses BEFORE spawning rather than silently falling back to
 * immediate-child termination, which is exactly the defect above.
 *
 * What this cannot do: contain a descendant that deliberately leaves the group (`setsid` of its
 * own). That is not claimed anywhere, and `verifyGone` reports the group as still present rather
 * than reporting a success it cannot establish.
 */

import { spawn as nodeSpawn } from "node:child_process";
import { emitReceipt } from "./receipts.mjs";

/** Signal a whole process group. Separated so tests can observe the target without a real kill. */
function signalGroup(pgid, signal, kill = process.kill) {
  // The NEGATIVE pid is the group. A positive one would signal the wrapper alone and re-create the
  // exact defect this module exists for, so the sign is applied here and never by a caller.
  kill(-pgid, signal);
}

/** Is the group still present? `signal 0` delivers nothing and only asks the question. */
export function groupAlive(pgid, kill = process.kill) {
  try { kill(-pgid, 0); return true; }
  catch (error) { return error?.code === "EPERM"; }
}

export function supervisionSupported(platform = process.platform) {
  return platform !== "win32";
}

/**
 * @param {object} options
 * @param {string[]} options.command argv; `command[0]` is the executable
 * @returns {{
 *   pid: number|null, pgid: number|null, child: import("node:child_process").ChildProcess,
 *   completion: Promise<{kind: string, code: number|null, signal: string|null, errorCode: string|null}>,
 *   terminal: () => object|null, stop: (options?: object) => Promise<object>,
 * }}
 */
export function spawnOwnedWorkload({
  command, env = process.env, stdio = "inherit", label = "workload",
  spawnImpl = nodeSpawn, kill = process.kill, platform = process.platform,
  now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout,
}) {
  if (!Array.isArray(command) || command.length === 0) throw new Error(`${label} requires a command`);
  if (!supervisionSupported(platform)) {
    // REFUSE BEFORE SPAWNING. Starting the workload and then discovering we cannot contain it is
    // worse than not starting it.
    throw new Error(`${label} supervision requires POSIX process groups; ${platform} has no supported ownership mechanism here`);
  }

  const child = spawnImpl(command[0], command.slice(1), { stdio, env, detached: true });

  // Settled ONCE, by whichever of these the OS reports first. The promise exists before any caller
  // can await it, so a stop issued after the exit still finds a resolved completion instead of
  // waiting forever on an event that already fired.
  let terminal = null;
  let settle;
  const completion = new Promise((resolve) => { settle = resolve; });
  const finish = (outcome) => {
    if (terminal) return terminal;
    terminal = outcome;
    settle(outcome);
    return terminal;
  };
  child.once("exit", (code, signal) => finish({ kind: "exited", code, signal: signal ?? null, errorCode: null }));
  child.once("error", (error) => finish({ kind: "spawn-failed", code: null, signal: null, errorCode: error?.code ?? error?.name ?? "Error" }));

  // With `detached: true` the child leads its own group, so PGID === PID. Captured here because
  // after the exit the handle's `pid` is still readable but the group is gone.
  const pgid = child.pid ?? null;

  let stopping = null;

  async function stop({ graceMs = 5_000, verifyMs = 2_000, pollMs = 50, escalate = true } = {}) {
    // ONE IN-FLIGHT stop operation. Concurrent callers await the same promise and a verified
    // success remains memoized. A failed verification is deliberately retryable: permanently
    // memoizing `group-survived` made eventual cleanup impossible even after the group disappeared.
    if (stopping) return stopping;
    stopping = (async () => {
      const startedAt = now();
      if (pgid == null) {
        if (terminal?.kind === "spawn-failed") {
          return { stopped: true, reason: "spawn-failed-no-group", durationMs: now() - startedAt, escalated: false, terminal };
        }
        return { stopped: false, reason: "no-owned-group", durationMs: now() - startedAt, escalated: false, terminal };
      }
      if (terminal && !groupAlive(pgid, kill)) {
        return { stopped: true, reason: "already-terminal", durationMs: now() - startedAt, escalated: false, terminal };
      }

      // 1. Graceful, to the OWNED GROUP.
      //
      // A DELIVERY FAILURE IS NOT AN OUTCOME. `ESRCH` means the group is already gone, and `EPERM`
      // is what Darwin returns for a group signal when ANY member could not be signalled — which
      // happens intermittently once the group leader has exited and been reaped, exactly the
      // orphaned-descendant case this exists for. Treating either as fatal made the caller abandon
      // the stop and report a failure while the workload was still running (and, in the fence,
      // release its database lock underneath it). So delivery errors are RECORDED, escalation still
      // runs, and the verification below is the sole arbiter of whether the workload is gone.
      const signalErrors = [];
      try { signalGroup(pgid, "SIGTERM", kill); }
      catch (error) {
        if (error?.code !== "ESRCH" && error?.code !== "EPERM") throw error;
        signalErrors.push(`SIGTERM:${error.code}`);
      }

      // 2. Bounded grace on the TRACKED child. The timer is CLEARED on the winning path. While the
      //    stop is unsettled it deliberately remains referenced: a pending Promise alone does not
      //    keep Node alive, and exiting here would abandon group verification mid-containment.
      let graceTimer = null;
      const graced = await Promise.race([
        completion.then(() => true),
        new Promise((resolve) => { graceTimer = setTimer(() => resolve(false), graceMs); }),
      ]).finally(() => { if (graceTimer) clearTimer(graceTimer); });

      // 3. …then escalation, still limited to the owned group. This is what a surviving grandchild
      //    needs: the wrapper exiting is not the workload stopping.
      let escalated = false;
      if (escalate && (!graced || groupAlive(pgid, kill))) {
        escalated = true;
        try { signalGroup(pgid, "SIGKILL", kill); }
        catch (error) {
          if (error?.code !== "ESRCH" && error?.code !== "EPERM") throw error;
          signalErrors.push(`SIGKILL:${error.code}`);
        }
      }

      // 4. VERIFIED completion. An unverifiable cleanup is an explicit failure, never a reported
      //    success — the caller must not start a replacement on the strength of a hope.
      const deadline = now() + verifyMs;
      while (groupAlive(pgid, kill) && now() < deadline) {
        // Contractual liveness: this referenced poll is the only handle that may remain after the
        // tracked wrapper exits while a descendant/group still needs verification.
        await new Promise((resolve) => { setTimer(resolve, pollMs); });
      }
      const stopped = !groupAlive(pgid, kill);
      const result = { stopped, reason: stopped ? "verified-gone" : "group-survived", durationMs: now() - startedAt, escalated, signalErrors, terminal };
      emitReceipt("workload-stop", { label, pid: child.pid ?? null, pgid, stopped, reason: result.reason, escalated, signalErrors: signalErrors.join(",") || null, durationMs: result.durationMs, exitCode: terminal?.code ?? null, exitSignal: terminal?.signal ?? null });
      return result;
    })().then((result) => {
      if (!result.stopped) stopping = null;
      return result;
    }, (error) => {
      stopping = null;
      throw error;
    });
    return stopping;
  }

  emitReceipt("workload-spawned", { label, pid: child.pid ?? null, pgid, ownsGroup: true });
  return { pid: child.pid ?? null, pgid, child, completion, terminal: () => terminal, stop };
}
