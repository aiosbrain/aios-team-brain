import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireCoordinatorLock, acquireDataUseLock, releaseCoordinatorLock, releaseDataUseLock,
} from "../../scripts/staging-ops/journal.mjs";
import { restorePairedPostgres } from "../../scripts/staging-ops/pg-paired.mjs";
import { createOperationBudget, createSessionWatchdogOwner } from "../../scripts/staging-ops/operation-deadline.mjs";

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

  it("keeps the RECOVERY restore alive under the shutdown that cancelled the install, and still bounds it", async () => {
    // The second half of the same defect, and the half the unit tier can only assert as a flag on an
    // AbortSignal. Recovery runs precisely BECAUSE the operation before it failed, and an external
    // SIGTERM is one of the ways it fails — so a recovery scope derived from that shutdown is
    // aborted from birth, every recovery subprocess is terminated the instant it is spawned, and the
    // rollback that was supposed to put staging back never runs: the journal lands
    // `recovery-required` with staging stopped and both fences held.
    //
    // Measured as WORK PERFORMED, not as "did a process appear". `runBoundedProcess` spawns and
    // only then consults the signal, so an already-aborted scope still hands the child a real
    // `child.pid` for as long as it takes to signal its group. Usually the stub is killed during
    // `node`'s own startup, before its body runs, and never installs the SIGTERM handler that makes
    // the healthy lane survive — but a slow parent can lose that race and let the stub record its
    // PID first. Both outcomes are the SAME guarantee, so the negative control asserts only what
    // does not vary with scheduling: the restore refuses as a cancellation, any process it managed
    // to start is GONE by the time that refusal returns, and NOTHING was mutated. Requiring the PID
    // file to be absent would pin the race instead of the guarantee, and go red on timing alone.
    //
    // The stub ignores SIGTERM and hangs at `pg_restore --list`, which is the FIRST subprocess on
    // the restore path, so neither lane reaches the destructive `cleanPublicApplicationObjects`
    // step and neither can damage the shared test database — asserted below rather than assumed.
    const root = mkdtempSync(path.join(tmpdir(), "staging-recovery-scope-pg-"));
    roots.push(root);
    const refusedPidFile = path.join(root, "refused-pid");
    const recoveryPidFile = path.join(root, "recovery-pid");
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
    try {
      expect(await acquireCoordinatorLock(owner)).toBe(true);
      expect(await acquireDataUseLock(owner, "exclusive")).toBe(true);

      // The shutdown that ended the install, delivered before recovery is even asked for.
      const shutdown = new AbortController();
      const watchdogOwner = createSessionWatchdogOwner(() => {}, { signal: shutdown.signal });
      const install = watchdogOwner.arm(createOperationBudget("install", 60_000));
      shutdown.abort(Object.assign(new Error("importer received SIGTERM"), { code: "STAGING_OPERATION_ABORTED" }));
      expect(install.signal.aborted, "the in-flight install ignored the shutdown").toBe(true);

      // NEGATIVE CONTROL, on the real code path: under the install's own aborted scope the restore
      // is terminated and refuses as a cancellation — the exact behaviour recovery must NOT inherit.
      const publicTables = async () => Number((await owner.query(
        "select count(*)::int as n from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r','p','f')",
      )).rows[0].n);
      const tablesBefore = await publicTables();
      expect(tablesBefore, "the shared test database has no application tables, so non-mutation would be vacuous").toBeGreaterThan(0);
      process.env.STAGING_SIGNAL_PID_FILE = refusedPidFile;
      await expect(restorePairedPostgres({
        client: owner, databaseUrl: DATABASE_URL, directory: root, pgRestore,
        operationTimeoutMs: 20_000, terminateGraceMs: 100, verifiedStagingTarget: true,
        signal: install.signal,
      })).rejects.toThrow(/operation aborted; subprocess termination confirmed/);
      // No executable is left doing work. The stub's very first statement writes this file, and
      // under an already-aborted scope it usually never gets that far — an absent file is therefore
      // allowed. But if it did win the spawn race, the abort is required to have destroyed that
      // process before the refusal returned, exactly as the healthy lane is held to above. Process
      // death is asserted, never relaxed; only the racy question of whether a PID was ever recorded
      // is left open. (A file created but not yet written parses to no usable PID — that is the
      // killed-mid-startup case, and it is not `alive(0)`, which would signal our own group.)
      const refusedPid = existsSync(refusedPidFile)
        ? Number(readFileSync(refusedPidFile, "utf8").trim())
        : Number.NaN;
      if (Number.isInteger(refusedPid) && refusedPid > 0) {
        expect(alive(refusedPid), "an already-aborted scope left its restore executable running").toBe(false);
      }
      // …and nothing downstream of that first subprocess ran either: `cleanPublicApplicationObjects`
      // drops every public table, so an unchanged non-zero inventory is the mutation oracle.
      expect(await publicTables(), "the pre-aborted restore reached the destructive cleanup").toBe(tablesBefore);

      // THE PROPERTY, and the exact contrast with the control above: same call, same stub, same
      // shutdown-derived owner — but the transferred scope is not poisoned, so this one's executable
      // gets far enough to write its PID and is still alive 300ms later.
      const recovery = await watchdogOwner.transferTo(createOperationBudget("recovery", 60_000));
      expect(recovery.signal.aborted, "recovery inherited the already-aborted shutdown signal").toBe(false);
      process.env.STAGING_SIGNAL_PID_FILE = recoveryPidFile;
      const recovering = restorePairedPostgres({
        client: owner, databaseUrl: DATABASE_URL, directory: root, pgRestore,
        // Bounded by the RESTORE's own deadline, so this run ends deterministically rather than
        // hanging: a fresh scope is not an unbounded one, at the real-process level too.
        operationTimeoutMs: 3_000, terminateGraceMs: 100, verifiedStagingTarget: true,
        signal: recovery.signal,
      });
      expect(await waitFor(() => existsSync(recoveryPidFile)), "the recovery restore never started").toBe(true);
      const recoveryChild = Number(readFileSync(recoveryPidFile, "utf8"));
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(alive(recoveryChild), "the recovery restore was terminated on spawn by a shutdown it must not inherit").toBe(true);

      // …and recovery running is not recovery unfenced: both locks are still this session's.
      expect(await acquireCoordinatorLock(contender), "the coordinator lock was released during recovery").toBe(false);
      expect(await acquireDataUseLock(contender, "exclusive"), "the data lock was released during recovery").toBe(false);

      await expect(recovering).rejects.toThrow(/subprocess termination confirmed/);
      expect(alive(recoveryChild), "the recovery restore returned before its child was gone").toBe(false);
      await recovery.disarm();
    } finally {
      if (oldPidFile === undefined) delete process.env.STAGING_SIGNAL_PID_FILE;
      else process.env.STAGING_SIGNAL_PID_FILE = oldPidFile;
      await owner.end().catch(() => {});
      await contender.end().catch(() => {});
    }
  }, 30_000);
});
