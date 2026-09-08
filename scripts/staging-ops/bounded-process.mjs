import { spawn } from "node:child_process";

const redact = (value) => String(value ?? "").replace(/postgres(?:ql)?:\/\/[^\s]+/gi, "[redacted database URL]").slice(0, 500);

/**
 * Run one owned subprocess group to confirmed group absence. Timeout/abort sends SIGTERM,
 * escalates to SIGKILL, awaits `close`, and verifies no descendant remains. If absence cannot be
 * established, hard-stop the owner instead of unwinding its database locks around surviving work.
 */
export async function runBoundedProcess(command, args, {
  timeoutMs, terminateGraceMs = 2_000, maxBuffer = 16 * 1024 * 1024,
  env = process.env, cwd, signal, spawnImpl = spawn, platform = process.platform,
  hardStop = (_error) => process.kill(process.pid, "SIGKILL"),
  kill = process.kill,
  holdUncontained = () => new Promise(() => { setInterval(() => {}, 60_000); }),
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
    if (ownedGroupAlive()) {
      try { signalOwned("SIGKILL"); }
      catch (error) { termination = `${termination}; final SIGKILL failed: ${redact(error?.message)}`; }
    }
    const verificationDeadline = Date.now() + terminateGraceMs;
    while (ownedGroupAlive() && Date.now() < verificationDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (ownedGroupAlive()) {
      if (escalationTimer) clearTimeout(escalationTimer);
      const error = Object.assign(new Error(`${command} ${termination}; owned subprocess group termination could not be confirmed; hard-stopping its owner`), {
        code: "STAGING_OPERATION_TIMEOUT", terminationConfirmed: false,
      });
      // Returning this error would unwind the importer, end the lock-owning PG session, and let a
      // surviving restore continue unfenced. The process/container boundary is the safety endpoint:
      // invoke it synchronously and, if a test double or broken platform returns, keep a referenced
      // handle forever so ordinary cleanup can never report/release around uncontained work.
      try { Promise.resolve(hardStop(error)).catch(() => {}); } catch { /* holding ownership is safer than unwinding */ }
      await holdUncontained();
    }
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
