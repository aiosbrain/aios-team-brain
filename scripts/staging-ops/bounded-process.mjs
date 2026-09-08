import { spawn } from "node:child_process";

const redact = (value) => String(value ?? "").replace(/postgres(?:ql)?:\/\/[^\s]+/gi, "[redacted database URL]").slice(0, 500);

/**
 * Run one owned subprocess group to confirmed group absence. Timeout/abort sends SIGTERM,
 * escalates to SIGKILL, awaits `close`, and verifies no descendant remains. While a healthy caller
 * still owns its fencing resources, uncertainty keeps this operation pending and retrying against
 * only the owned group; an external container stop remains an operator action.
 */
export async function runBoundedProcess(command, args, {
  timeoutMs, terminateGraceMs = 2_000, maxBuffer = 16 * 1024 * 1024,
  env = process.env, cwd, signal, spawnImpl = spawn, platform = process.platform,
  kill = process.kill,
} = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60 * 60_000) throw new Error("subprocess timeout must be 1..3600000ms");
  if (!Number.isSafeInteger(terminateGraceMs) || terminateGraceMs < 1 || terminateGraceMs > 30_000) throw new Error("subprocess termination grace must be 1..30000ms");
  const child = spawnImpl(command, args, { env, cwd, detached: platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
  const stdout = [];
  const stderr = [];
  let bytes = 0;
  let termination = null;
  let escalationTimer = null;

  const signalOwned = (name) => {
    if (!child.pid) return;
    try { kill(platform === "win32" ? child.pid : -child.pid, name); }
    catch (error) { if (error?.code !== "ESRCH") throw error; }
  };
  const ownedGroupAlive = () => {
    if (platform === "win32" || !child.pid) return false;
    try { kill(-child.pid, 0); return true; }
    catch (error) { return error?.code !== "ESRCH"; }
  };
  const terminate = (reason) => {
    if (termination) return;
    termination = reason;
    try { signalOwned("SIGTERM"); } catch (error) { termination = `${reason}; SIGTERM failed: ${redact(error?.message)}`; }
    escalationTimer = setTimeout(() => {
      try { signalOwned("SIGKILL"); } catch (error) { termination = `${termination}; SIGKILL failed: ${redact(error?.message)}`; }
    }, terminateGraceMs);
    escalationTimer.unref?.();
  };
  const collect = (target) => (chunk) => {
    const value = Buffer.from(chunk);
    bytes += value.length;
    if (bytes > maxBuffer) { terminate("output exceeded the configured maximum"); return; }
    target.push(value);
  };
  child.stdout?.on("data", collect(stdout));
  child.stderr?.on("data", collect(stderr));
  const onAbort = () => terminate("operation aborted");
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) terminate("operation aborted");
  const deadlineTimer = setTimeout(() => terminate(`operation exceeded ${timeoutMs}ms`), timeoutMs);
  deadlineTimer.unref?.();

  const outcome = await new Promise((resolve) => {
    let spawnError = null;
    child.once("error", (error) => {
      spawnError = error;
      // A failed spawn has no process to await. Once a PID exists, only `close` confirms that its
      // stdio and operating-system process are gone.
      if (!child.pid) resolve({ error, code: null, signal: null });
    });
    child.once("close", (code, closeSignal) => resolve({ error: spawnError, code, signal: closeSignal }));
  });
  clearTimeout(deadlineTimer);
  signal?.removeEventListener("abort", onAbort);
  if (termination && platform !== "win32" && child.pid) {
    // `close` confirms only the tracked process and its stdio. A descendant in the detached group
    // can survive that event, so do not let a caller roll back an exported snapshot or release a
    // fence until group absence is observed. The referenced poll also keeps Node alive after the
    // tracked handle disappears.
    if (escalationTimer) {
      clearTimeout(escalationTimer);
      escalationTimer = null;
    }
    let containmentFailure = null;
    while (ownedGroupAlive()) {
      try { signalOwned("SIGKILL"); }
      catch (error) { containmentFailure = redact(error?.message); }
      // This timer must remain referenced: returning would unwind the caller's healthy lock/session
      // while descendants may still be running. Retry only this owned process group until a probe
      // proves ESRCH; do not treat a signalling/probe callback failure as successful containment.
      await new Promise((resolve) => setTimeout(resolve, Math.min(terminateGraceMs, 1_000)));
    }
    if (containmentFailure) termination = `${termination}; SIGKILL retry failed: ${containmentFailure}`;
  }
  if (escalationTimer) clearTimeout(escalationTimer);
  const out = Buffer.concat(stdout).toString("utf8");
  const err = Buffer.concat(stderr).toString("utf8");
  if (termination) {
    throw Object.assign(new Error(`${command} ${termination}; subprocess termination confirmed`), {
      code: "STAGING_OPERATION_TIMEOUT", terminationConfirmed: true, stdout: out, stderr: err,
    });
  }
  if (outcome.error) throw Object.assign(outcome.error, { stdout: out, stderr: err });
  if (outcome.code !== 0) {
    throw Object.assign(new Error(`${command} exited ${outcome.code ?? `on ${outcome.signal}`}`), { code: outcome.code, signal: outcome.signal, stdout: out, stderr: err });
  }
  return { stdout: out, stderr: err };
}
