import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireCoordinatorLock, acquireDataUseLock, releaseCoordinatorLock, releaseDataUseLock,
} from "../../scripts/staging-ops/journal.mjs";
import { restorePairedPostgres } from "../../scripts/staging-ops/pg-paired.mjs";

const DATABASE_URL = process.env.DATABASE_URL!;
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function waitFor(predicate: () => boolean, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

describe("AC-06 — importer cancellation keeps real database fencing until owned restore work settles", () => {
  it("terminates a slow restore before the lock-owning session can be released or replaced", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "staging-importer-signal-pg-"));
    roots.push(root);
    const pidFile = path.join(root, "restore-pid");
    const pgRestore = path.join(root, "pg_restore");
    writeFileSync(pgRestore, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
writeFileSync(process.env.STAGING_SIGNAL_PID_FILE, String(process.pid));
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
`, { mode: 0o700 });
    chmodSync(pgRestore, 0o700);

    const owner = new pg.Client({ connectionString: DATABASE_URL });
    const contender = new pg.Client({ connectionString: DATABASE_URL });
    await owner.connect();
    await contender.connect();
    const oldPidFile = process.env.STAGING_SIGNAL_PID_FILE;
    process.env.STAGING_SIGNAL_PID_FILE = pidFile;
    try {
      expect(await acquireCoordinatorLock(owner)).toBe(true);
      expect(await acquireDataUseLock(owner, "exclusive")).toBe(true);
      const controller = new AbortController();
      const restoring = restorePairedPostgres({
        client: owner, databaseUrl: DATABASE_URL, directory: root, pgRestore,
        operationTimeoutMs: 20_000, terminateGraceMs: 100, verifiedStagingTarget: true,
        signal: controller.signal,
      });
      expect(await waitFor(() => existsSync(pidFile)), "the slow restore process never started").toBe(true);
      const childPid = Number(readFileSync(pidFile, "utf8"));
      expect(alive(childPid)).toBe(true);

      // A replacement worker cannot enter while the owned process is active.
      expect(await acquireCoordinatorLock(contender)).toBe(false);
      expect(await acquireDataUseLock(contender, "exclusive")).toBe(false);

      controller.abort(new Error("SIGTERM"));
      await expect(restoring).rejects.toThrow(/operation aborted; subprocess termination confirmed/);
      expect(alive(childPid), "restore cancellation returned before the child was gone").toBe(false);
      await expect(owner.query("select 1 as owner_session_alive")).resolves.toMatchObject({ rows: [{ owner_session_alive: 1 }] });
      expect(await acquireCoordinatorLock(contender), "the coordinator lock was released during cancellation").toBe(false);
      expect(await acquireDataUseLock(contender, "exclusive"), "the data lock was released during cancellation").toBe(false);

      await releaseDataUseLock(owner, "exclusive");
      await releaseCoordinatorLock(owner);
      expect(await acquireCoordinatorLock(contender), "a replacement cannot enter after confirmed containment and release").toBe(true);
      expect(await acquireDataUseLock(contender, "exclusive")).toBe(true);
      await releaseDataUseLock(contender, "exclusive");
      await releaseCoordinatorLock(contender);
    } finally {
      if (oldPidFile === undefined) delete process.env.STAGING_SIGNAL_PID_FILE;
      else process.env.STAGING_SIGNAL_PID_FILE = oldPidFile;
      await owner.end().catch(() => {});
      await contender.end().catch(() => {});
    }
  }, 30_000);
});
