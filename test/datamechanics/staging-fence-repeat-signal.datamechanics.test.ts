import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { acquireDataUseLock, installStagingOps, releaseDataUseLock } from "../../scripts/staging-ops/journal.mjs";
import { supervisionSupported } from "../../scripts/staging-ops/owned-workload.mjs";

/**
 * THE REAL-POSTGRES COUNTERPART to `test/staging-fence-repeat-signal.test.ts`.
 *
 * The unit tier proves the handler LIFETIME: repeated SIGTERM/SIGINT no longer take Node's default
 * action while containment is pending. What it cannot prove is the thing AC-06 actually promises —
 * that the SHARED DATA-USE LOCK is still held, by a real session, for the payload's entire
 * lifetime. Its fence session is a fake whose `end()` prints a line, so "released" there is
 * bookkeeping, not a lock.
 *
 * Here the fence takes the real lock in a real subprocess, and the assertion is made from a THIRD
 * connection: a maintenance-style EXCLUSIVE acquisition must be REFUSED for as long as the owned
 * payload is alive — through repeated signals — and must SUCCEED once the payload is verifiably
 * gone. That last step is the positive control: without it, a fence that failed to acquire anything
 * at all would satisfy every refusal above.
 */

const DATABASE_URL = process.env.DATABASE_URL!;
const DRIVER = fileURLToPath(new URL("../fixtures/repeat-signal-supervisor.mjs", import.meta.url));
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

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

/**
 * A FRESH session per attempt. Advisory locks are session-scoped and re-entrant within a session, so
 * reusing one probe connection would let an earlier successful acquisition mask a later refusal.
 */
async function exclusiveAcquirable(): Promise<boolean> {
  const probe = new pg.Client({ connectionString: DATABASE_URL });
  await probe.connect();
  try {
    const got = await acquireDataUseLock(probe, "exclusive", false);
    if (got) await releaseDataUseLock(probe, "exclusive");
    return got;
  } finally {
    await probe.end();
  }
}

const cleanup: (() => void)[] = [];
afterEach(() => { for (const undo of cleanup.splice(0)) { try { undo(); } catch { /* already gone */ } } });

interface Driver {
  readonly process: ChildProcess;
  readonly diagnosis: () => string;
  readonly exited: () => boolean;
  readonly payloadPgid: () => number | null;
  readonly containmentPending: () => number;
}

function startDriver(port: number, releaseFile: string): Driver {
  let stdout = "";
  let stderr = "";
  let exited: { code: number | null; signal: string | null } | null = null;
  const child = spawn(process.execPath, [DRIVER, String(port), releaseFile, DATABASE_URL], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout!.setEncoding("utf8");
  child.stdout!.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr!.setEncoding("utf8");
  child.stderr!.on("data", (chunk: string) => { stderr += chunk; });
  child.on("exit", (code, signal) => { exited = { code, signal: signal ?? null }; });
  cleanup.push(() => { try { process.kill(child.pid!, "SIGKILL"); } catch { /* gone */ } });
  const lines = () => stdout.split("\n");
  return {
    process: child,
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
    containmentPending: () => lines().filter((l) => l.includes("staging-ops-receipt fence-containment-pending")).length,
  };
}

describe.runIf(POSIX)("AC-06 — the real shared lock is held for the payload's whole lifetime", () => {
  const owner = new pg.Client({ connectionString: DATABASE_URL });

  beforeAll(async () => {
    await owner.connect();
    await installStagingOps(owner);
    // A READY journal with a run identity: `bootAdmissionVerdict` admits `ready`, so the fence gets
    // past classification and actually supervises. Nothing here weakens admission — the fence still
    // makes its own decision against this row.
    await owner.query(
      "UPDATE staging_ops.refresh_journal SET state='ready', run_id='fence-repeat-signal', last_ready_run_id='fence-repeat-signal', last_ready_mode='copy-ready' WHERE singleton=true"
    );
  });

  afterAll(async () => { await owner.end(); });

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    it(`retains the shared lock across repeated ${signal} until the payload is removed`, async () => {
      // No exclusive owner at the start, or every refusal below would be about the wrong thing.
      expect(await exclusiveAcquirable(), "something already held the data-use lock").toBe(true);

      const directory = mkdtempSync(path.join(tmpdir(), "aios-repeat-signal-pg-"));
      cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
      const releaseFile = path.join(directory, "release");
      const port = await freePort();

      const driver = startDriver(port, releaseFile);
      await waitFor(() => driver.payloadPgid() != null || driver.exited());
      expect(driver.payloadPgid() != null, `the driver never spawned its payload\n${driver.diagnosis()}`).toBe(true);
      const payloadPgid = driver.payloadPgid()!;
      cleanup.push(() => { try { process.kill(-payloadPgid, "SIGKILL"); } catch { /* gone */ } });
      expect(await waitFor(() => groupAlive(payloadPgid)), "the owned payload group never came up").toBe(true);

      // BASELINE: with the payload running, maintenance cannot take the data away underneath it.
      expect(await exclusiveAcquirable(), "the fence never held the shared lock at all").toBe(false);

      // First signal: handled, containment fails (delivery to the owned group is suppressed), and
      // the fence deliberately stays alive retrying.
      process.kill(driver.process.pid!, signal);
      expect(await waitFor(() => driver.containmentPending() >= 1), `the fence never reported pending containment\n${driver.diagnosis()}`).toBe(true);
      expect(await exclusiveAcquirable(), "the lock was released while containment was still pending").toBe(false);

      // The regression: two more deliveries of the SAME signal. With `process.once` the listener was
      // gone and these killed the lock-owning supervisor — which would end its session and hand the
      // exclusive lock to maintenance while a live payload kept serving the copied dataset.
      process.kill(driver.process.pid!, signal);
      await new Promise((r) => setTimeout(r, 300));
      process.kill(driver.process.pid!, signal);
      await new Promise((r) => setTimeout(r, 500));

      expect(alive(driver.process.pid!), `a repeated ${signal} killed the lock-owning supervisor`).toBe(true);
      expect(groupAlive(payloadPgid), "the owned payload died, so this run proves nothing about retention").toBe(true);
      expect(await exclusiveAcquirable(), "a repeated signal handed the exclusive lock to maintenance").toBe(false);
      expect(driver.containmentPending()).toBeGreaterThan(1);

      // POSITIVE CONTROL. Let containment succeed: the payload goes, the fence releases, and the
      // exclusive acquisition becomes possible. Without this, a fence that had acquired nothing
      // would have satisfied every refusal above.
      writeFileSync(releaseFile, "go", "utf8");
      expect(await waitFor(() => !alive(driver.process.pid!)), `the supervisor never exited\n${driver.diagnosis()}`).toBe(true);
      expect(groupAlive(payloadPgid), "the fence exited while the owned group was still alive").toBe(false);
      expect(await waitFor(() => exclusiveAcquirable()), "the shared lock outlived the supervisor's session").toBe(true);
    }, 90_000);
  }
});
