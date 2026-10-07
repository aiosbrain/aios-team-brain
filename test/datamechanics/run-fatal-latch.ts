import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { isMainThread } from "node:worker_threads";

/**
 * THE RUN-FATAL LATCH of the data-mechanics tier (test-only; Node built-ins only, so the tier's
 * global setup can import it without loading — or pre-empting a mock of — any application module).
 *
 * WHY IT EXISTS. A test that leaves a database session it cannot prove idle may have left locks
 * behind. The tier's isolation is a `TRUNCATE` before every test; run against such a session it
 * either blocks or, worse, "cleans up" around work still in flight. Nothing may truncate, and
 * nothing may run, as if cleanup had succeeded.
 *
 * WHY A FILE. Vitest runs each test file in a worker of its own, and the hooks of a setup file run
 * BEFORE the hooks of the test file. So a latch that is only a variable in one test file is read
 * too late (after the global `beforeEach` has already truncated) and is forgotten by the next
 * file. This latch is a small file keyed by the run — the Vitest main process — and the database,
 * read by the tier's global `beforeEach` as its first act (`assertRunNotFatal`), in every worker.
 * Once set it stays set for the rest of that run: the first reason wins, and nothing clears it.
 */

export interface RunLatch {
  /** The reason the run was stopped, or null. */
  read(): string | null;
  /** Stop the run. Sticky: if it is already stopped, the FIRST reason stands and is returned. */
  set(reason: string): string;
}

/** A latch backed by one file. Every instance over the same file — in any process — sees the same latch. */
export function createRunLatch(file: string): RunLatch {
  // The in-process copy stands even if the file cannot be written: this worker, at least, stops.
  let held: string | null = null;
  const read = (): string | null => {
    if (held) return held;
    try {
      const stored = JSON.parse(readFileSync(file, "utf8")) as { reason?: unknown };
      if (typeof stored.reason === "string" && stored.reason) held = stored.reason;
    } catch {
      // No latch file (or an unreadable one): not stopped, as far as this process can tell.
    }
    return held;
  };
  return {
    read,
    set(reason: string): string {
      const standing = read();
      if (standing) return standing;
      held = reason;
      try {
        mkdirSync(dirname(file), { recursive: true });
        // `wx`: never overwrite — if another worker latched first, its reason is the one on file.
        writeFileSync(file, JSON.stringify({ reason, at: new Date().toISOString() }), { flag: "wx" });
      } catch {
        // Already latched by another worker, or the file system refused. `held` still stops this one.
      }
      return held;
    },
  };
}

/**
 * The Vitest MAIN process — the one thing every worker of a run shares. A forked worker is its
 * child (`ppid`); a worker thread lives inside it (`pid`).
 */
const runProcess = isMainThread ? process.ppid : process.pid;
const database = createHash("sha256").update(process.env.DATABASE_URL ?? "").digest("hex").slice(0, 12);

/** The latch of THIS run against THIS database. */
export const runLatch: RunLatch = createRunLatch(
  join(tmpdir(), `aios-datamechanics-run-fatal-${database}-${runProcess}.json`),
);

/** Throw if the run has been stopped. The tier's global `beforeEach` calls this before it truncates. */
export function assertRunNotFatal(latch: RunLatch = runLatch): void {
  const reason = latch.read();
  if (reason) {
    throw new Error(`data-mechanics run STOPPED — refusing to truncate or run another test: ${reason}`);
  }
}

// ── Hook-order evidence ────────────────────────────────────────────────────────────────────────
// The guarantee above rests on the global hook running before a test file's own hooks. That is
// asserted, not assumed: the global hook counts its runs here (on `globalThis`, so the count does
// not depend on how modules are instantiated), and a test file compares it with its own count.

const HOOK_RUNS = Symbol.for("aios.datamechanics.truncation-hook-runs");
const counters = globalThis as unknown as Record<symbol, number | undefined>;

/** Called by the global truncation hook, after the fatal check has passed and before it truncates. */
export function noteTruncationHook(): void {
  counters[HOOK_RUNS] = (counters[HOOK_RUNS] ?? 0) + 1;
}

/** How many times the global truncation hook has got past its fatal check in this worker. */
export function truncationHookRuns(): number {
  return counters[HOOK_RUNS] ?? 0;
}
