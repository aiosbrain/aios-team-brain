import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { supervisionSupported } from "../scripts/staging-ops/owned-workload.mjs";

/**
 * REPEATED SIGTERM/SIGINT MUST NOT DEFEAT HEALTHY-LOCK CONTAINMENT.
 *
 * The defect: the fence installed its signal handlers with `process.once`. Delivery removes a `once`
 * handler BEFORE invoking it, and the handler returns immediately after starting the asynchronous
 * `shutdown`. So during the deliberate retry loop — where a healthy lock session and an unverified
 * stop mean the fence stays alive ON PURPOSE — a SECOND delivery of the same signal found no
 * listener and took Node's default action: terminate. The payload owns a SEPARATE process group
 * (`spawnOwnedWorkload` detaches it), so signalling the fence's group cannot reach it, and a live
 * payload could go on serving from the copied dataset after the lock-owning supervisor had died.
 * AC-06 requires that shared connection for the child's ENTIRE lifetime.
 *
 * This is reachable through implemented callers, not just an external killer: `owned-workload`
 * resets `stopping` after a failed verification, so a later POST stop, a deploy's stop-first attempt
 * or a controller shutdown starts a NEW outer stop and sends TERM again. Alternating TERM then INT
 * consumes two different listeners and does not reproduce it; two TERM or two INT do.
 *
 * WHY A REAL SUBPROCESS: `process.emit(signal)` drives the JavaScript listener and can never
 * observe the restored default OS action, which is the entire mechanism. These deliver real signals
 * to a real process running the real `supervise`.
 *
 * WHAT IS SIMULATED AND WHAT IS NOT: containment is held pending by injecting a `kill` that
 * suppresses delivery to the owned group while leaving signal-0 liveness real. That models an
 * uncontained live workload — the state the retry loop exists for — and makes no claim that a real
 * SIGKILL is ignorable. Everything about handler lifetime, lock retention and release ordering is
 * the real implementation.
 */

const DRIVER = fileURLToPath(new URL("./fixtures/repeat-signal-supervisor.mjs", import.meta.url));
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

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const groupAlive = (pgid: number) => { try { process.kill(-pgid, 0); return true; } catch { return false; } };

async function waitFor(predicate: () => boolean, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (predicate()) return true; await new Promise((r) => setTimeout(r, 25)); }
  return false;
}

const cleanup: (() => void)[] = [];
afterEach(() => { for (const undo of cleanup.splice(0)) { try { undo(); } catch { /* already gone */ } } });

interface Driver {
  readonly process: ChildProcess;
  readonly stdout: () => string;
  /** Everything needed to NAME a startup failure, rather than reporting only its symptom. */
  readonly diagnosis: () => string;
  readonly exited: () => boolean;
  readonly payloadPgid: () => number | null;
  readonly released: () => boolean;
  readonly containmentPending: () => number;
}

function startDriver(port: number, releaseFile: string): Driver {
  let stdout = "";
  let stderr = "";
  let exited: { code: number | null; signal: string | null } | null = null;
  const child = spawn(process.execPath, [DRIVER, String(port), releaseFile], { stdio: ["ignore", "pipe", "pipe"] });
  child.stdout!.setEncoding("utf8");
  child.stdout!.on("data", (chunk: string) => { stdout += chunk; });
  // KEPT, not discarded. A driver that dies on import (a syntax error anywhere in the real module
  // graph it loads) or refuses the fence writes its reason here; `resume()` threw that away and left
  // "the driver never spawned its payload" as the only evidence, which names no cause.
  child.stderr!.setEncoding("utf8");
  child.stderr!.on("data", (chunk: string) => { stderr += chunk; });
  child.on("exit", (code, signal) => { exited = { code, signal: signal ?? null }; });
  cleanup.push(() => { try { process.kill(child.pid!, "SIGKILL"); } catch { /* gone */ } });
  const lines = () => stdout.split("\n");
  return {
    process: child,
    stdout: () => stdout,
    diagnosis: () => [
      exited ? `driver exited early (code=${exited.code} signal=${exited.signal})` : "driver still running",
      `stderr: ${stderr.trim().slice(-1500) || "(empty)"}`,
      `stdout: ${stdout.trim().slice(-800) || "(empty)"}`,
    ].join("\n"),
    exited: () => exited != null,
    payloadPgid: () => {
      const line = lines().find((l) => l.includes('"event":"payload"'));
      return line ? (JSON.parse(line).pgid as number) : null;
    },
    released: () => stdout.includes('"event":"released"'),
    // The fence's OWN statement that it failed to contain the workload and is retrying, rather than
    // a marker this test invented.
    containmentPending: () => lines().filter((l) => l.includes("staging-ops-receipt fence-containment-pending")).length,
  };
}

describe.runIf(POSIX)("repeated shutdown signals do not break healthy-lock containment", () => {
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    it(`survives repeated ${signal} while containment is pending, and releases only after it completes`, async () => {
      const directory = mkdtempSync(path.join(tmpdir(), "aios-repeat-signal-"));
      cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
      const releaseFile = path.join(directory, "release");
      const port = await freePort();

      // An UNRELATED process, in its own group, that nothing in this test owns. If a remedy ever
      // widened its blast radius beyond the owned group, this is what would notice.
      const sentinel = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", detached: true });
      cleanup.push(() => { try { process.kill(-sentinel.pid!, "SIGKILL"); } catch { /* gone */ } });

      const driver = startDriver(port, releaseFile);
      // A driver that died on startup answers the predicate immediately, so a broken module graph or
      // a refused fence reports its own reason in seconds instead of timing out with none.
      await waitFor(() => driver.payloadPgid() != null || driver.exited());
      expect(driver.payloadPgid() != null, `the driver never spawned its payload\n${driver.diagnosis()}`).toBe(true);
      const payloadPgid = driver.payloadPgid()!;
      cleanup.push(() => { try { process.kill(-payloadPgid, "SIGKILL"); } catch { /* gone */ } });
      expect(await waitFor(() => groupAlive(payloadPgid)), "the owned payload group never came up").toBe(true);

      // FIRST signal: handled, containment fails (delivery is suppressed), fence retries by design.
      process.kill(driver.process.pid!, signal);
      expect(await waitFor(() => driver.containmentPending() >= 1), "the fence never reported pending containment").toBe(true);
      expect(driver.released(), "the fence released its lock before containment completed").toBe(false);

      // SECOND and THIRD deliveries of the SAME signal, while cleanup is still pending. This is the
      // regression: with `process.once` the listener was already gone and these terminated the
      // supervisor by default action, leaving the payload's separate group alive and unfenced.
      process.kill(driver.process.pid!, signal);
      await new Promise((r) => setTimeout(r, 300));
      process.kill(driver.process.pid!, signal);
      await new Promise((r) => setTimeout(r, 500));

      expect(alive(driver.process.pid!), `a repeated ${signal} killed the lock-owning supervisor`).toBe(true);
      expect(groupAlive(payloadPgid), "the owned payload died, so this run proves nothing about containment").toBe(true);
      expect(driver.released(), "the shared lock was given up while a live owned payload survived").toBe(false);
      // It is not merely alive-and-stuck: it is still actively retrying the same idempotent stop.
      expect(driver.containmentPending()).toBeGreaterThan(1);

      // Now let containment succeed. The ORDERING claim: release happens only after the group is
      // verified gone, and the fence then exits on its own.
      writeFileSync(releaseFile, "go", "utf8");
      expect(await waitFor(() => driver.released()), "the fence never released after containment completed").toBe(true);
      expect(groupAlive(payloadPgid), "the fence released while the owned group was still alive").toBe(false);
      expect(await waitFor(() => !alive(driver.process.pid!)), "the supervisor never exited").toBe(true);

      // …and nothing outside the owned group was touched.
      expect(alive(sentinel.pid!), "an unrelated process was killed").toBe(true);
    }, 60_000);
  }
});
