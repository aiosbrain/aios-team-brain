import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Type-only and erased at runtime: it makes `vitest` resolvable for the `ProvidedContext`
// augmentation below without this module ever loading Vitest's runtime.
import type {} from "vitest";

/**
 * THE RUN-SAFETY STATE of the data-mechanics tier (test-only; Node built-ins only, so the tier's
 * global setup can import it without loading — or pre-empting a mock of — any application module).
 *
 * WHY IT EXISTS. The tier's isolation is a `TRUNCATE` before every test. A test that raced real
 * database sessions and did not PROVE them gone or idle may have left locks and open transactions
 * behind; truncating then either blocks or "cleans up" around work still in flight. Nothing may
 * truncate, and nothing may run, as if cleanup had succeeded.
 *
 * WHAT IT RECORDS, as files in one directory per run:
 *   - `fatal.json` — the run has been stopped. Sticky: the first reason stands; nothing clears it.
 *   - `scope-<id>.json` — an IN-FLIGHT MARKER: a harness scope has acquired, or is about to acquire,
 *     database sessions. It is written BEFORE the first connection and removed only by that scope,
 *     and only once the scope has proven its sessions gone and its operations settled. So it also
 *     outlives a test that timed out or was interrupted before it could clean up.
 * The tier refuses to truncate or run while there is a fatal reason OR any marker.
 *
 * FAIL CLOSED. State that cannot be read is not clean: a missing run directory, an unparsable
 * `fatal.json`, an unreadable directory — each one blocks. A marker that cannot be WRITTEN throws,
 * so the caller never starts the database work the marker was to cover.
 *
 * ONE RUN, ONE DIRECTORY. The run id is minted once per Vitest invocation, in the main process,
 * before any worker exists (`global-setup.ts`), and every worker inherits it. The directory is
 * keyed by that id and the database — never by a process id, which a later run can be handed
 * again. Workers only ever write and remove their OWN files inside their OWN run's directory; no
 * worker deletes a directory, and no run reads, clears or inherits another run's files.
 */

/** Set by `global-setup.ts` in the Vitest main process; inherited by every worker of that run. */
export const RUN_ID_ENV = "AIOS_DATAMECHANICS_RUN_ID";
/** The same id, as Vitest's own main-to-worker channel carries it (`project.provide` / `inject`). */
export const RUN_ID_PROVIDED = "aiosDatamechanicsRunId";

declare module "vitest" {
  export interface ProvidedContext {
    aiosDatamechanicsRunId: string;
  }
}

const ROOT = join(tmpdir(), "aios-datamechanics-run-safety");
const OWNER_FILE = "owner.json";
const FATAL_FILE = "fatal.json";
const SCOPE_FILE = /^scope-([A-Za-z0-9._-]+)\.json$/;

export class RunSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunSafetyError";
  }
}

const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));
const isMissing = (error: unknown) => (error as { code?: unknown } | null)?.code === "ENOENT";

/** The directory of one run against one database. Pure: the same inputs give the same directory. */
export function runDirectoryFor(runId: string, databaseUrl: string, root: string = ROOT): string {
  if (!/^[A-Za-z0-9._-]{8,}$/.test(runId)) throw new RunSafetyError(`unusable data-mechanics run id: ${JSON.stringify(runId)}`);
  const database = createHash("sha256").update(databaseUrl).digest("hex").slice(0, 12);
  return join(root, database, runId);
}

export interface RunSafety {
  readonly directory: string;
  /** Why the run may not truncate or go on — a fatal reason, in-flight scopes, or state that
   * cannot be read — or null when it is provably clean. */
  blocked(): string | null;
  /** The reason the run was stopped, or null. Unreadable fatal state reads as stopped. */
  fatal(): string | null;
  /** Stop the run. Sticky: if it is already stopped, the FIRST reason stands and is returned. */
  setFatal(reason: string): string;
  /** Record an in-flight scope BEFORE its database work. Throws if the marker cannot be written. */
  arm(scope: string, detail: string): void;
  /** Remove THIS scope's marker — after its cleanup was proven. Touches nothing else. */
  disarm(scope: string): void;
  /** The scopes with a marker on file. Throws if the directory cannot be read. */
  armed(): string[];
}

/**
 * The run-safety state kept in `directory`. Every instance over the same directory — in any worker
 * — sees the same state. The directory must already exist (the main process creates it): a
 * directory that is not there is state that cannot be read, and blocks.
 */
export function createRunSafety(directory: string): RunSafety {
  // The in-process copy stands even if `fatal.json` cannot be written: this worker, at least, stops.
  let heldFatal: string | null = null;
  const scopeFile = (scope: string): string => {
    if (!/^[A-Za-z0-9._-]+$/.test(scope)) throw new RunSafetyError(`unusable scope id: ${JSON.stringify(scope)}`);
    return join(directory, `scope-${scope}.json`);
  };

  const fatal = (): string | null => {
    if (heldFatal) return heldFatal;
    let text: string;
    try {
      text = readFileSync(join(directory, FATAL_FILE), "utf8");
    } catch (error) {
      if (isMissing(error)) return null;
      return `the run's fatal state could not be read (${describe(error)})`;
    }
    try {
      const stored = JSON.parse(text) as { reason?: unknown };
      if (typeof stored.reason === "string" && stored.reason) {
        heldFatal = stored.reason;
        return heldFatal;
      }
    } catch {
      // Falls through: a fatal file that does not say why is still a fatal file.
    }
    return "the run's fatal state is on file but unreadable (corrupt fatal.json)";
  };

  const armed = (): string[] => {
    const scopes: string[] = [];
    for (const name of readdirSync(directory)) {
      const scope = SCOPE_FILE.exec(name)?.[1];
      if (scope) scopes.push(scope);
    }
    return scopes.sort();
  };

  return {
    directory,
    fatal,
    armed,
    blocked(): string | null {
      const stopped = fatal();
      if (stopped) return stopped;
      let inFlight: string[];
      try {
        if (!statSync(directory).isDirectory()) return `the run-safety state at ${directory} is not a directory`;
        inFlight = armed();
      } catch (error) {
        return `the run-safety state at ${directory} could not be read (${describe(error)})`;
      }
      if (inFlight.length > 0) {
        return `${inFlight.length} harness scope(s) still in flight — their database sessions were never proven gone: ${inFlight.join(", ")}`;
      }
      return null;
    },
    setFatal(reason: string): string {
      const standing = fatal();
      if (standing) return standing;
      heldFatal = reason;
      try {
        // `wx`: never overwrite — if another worker stopped the run first, its reason is on file.
        writeFileSync(join(directory, FATAL_FILE), JSON.stringify({ reason, at: new Date().toISOString() }), { flag: "wx" });
      } catch {
        // Already stopped by another worker, or the file system refused. `heldFatal` stops this one,
        // and the scope that could not be proven keeps its marker, which stops the others.
      }
      return heldFatal;
    },
    arm(scope: string, detail: string): void {
      try {
        writeFileSync(scopeFile(scope), JSON.stringify({ scope, detail, at: new Date().toISOString() }), { flag: "wx" });
      } catch (error) {
        throw new RunSafetyError(`in-flight marker for scope ${scope} could not be recorded — no database work may start (${describe(error)})`);
      }
    },
    disarm(scope: string): void {
      // If this fails the marker stays, and the run stays blocked: the safe direction.
      rmSync(scopeFile(scope), { force: true });
    },
  };
}

/** Create one run's directory and its owner record. Called once, by the main process. */
export function initializeRunDirectory(directory: string, owner: Record<string, unknown>): void {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, OWNER_FILE), JSON.stringify(owner), { flag: "wx" });
}

/** Remove one run's directory — ONLY if it is provably clean. Called once, by the main process, at the end. */
export function removeRunDirectoryIfClean(directory: string): boolean {
  if (createRunSafety(directory).blocked() !== null) return false;
  rmSync(directory, { recursive: true, force: true });
  return true;
}

let current: RunSafety | undefined;

/**
 * Take the run id Vitest's own channel delivered to this worker. The environment normally carries
 * it already; the two must then agree — a worker that is told two different runs is in neither.
 */
export function adoptRunId(provided: string | undefined): void {
  const inherited = process.env[RUN_ID_ENV];
  if (!provided) return;
  if (inherited && inherited !== provided) {
    throw new RunSafetyError(`this worker was given two data-mechanics run ids (${inherited} from its environment, ${provided} from Vitest)`);
  }
  process.env[RUN_ID_ENV] = provided;
}

/**
 * The state of THIS run against THIS database. Throws — it does not guess — when the run id was
 * never initialized: a tier that cannot tell which run it is in cannot tell whether it is safe.
 */
export function currentRunSafety(): RunSafety {
  if (current) return current;
  const runId = process.env[RUN_ID_ENV];
  if (!runId) {
    throw new RunSafetyError(
      `${RUN_ID_ENV} is not set: this tier's run-safety state is initialized by test/datamechanics/global-setup.ts, `
      + "which the Vitest config must list in `globalSetup`",
    );
  }
  current = createRunSafety(runDirectoryFor(runId, process.env.DATABASE_URL ?? ""));
  return current;
}

/**
 * Throw unless the run is provably clean. The tier's setup file calls this at module scope — before
 * a test module is imported or any `beforeAll` runs — and again before every `TRUNCATE`.
 */
export function assertRunSafe(safety: RunSafety = currentRunSafety()): void {
  const reason = safety.blocked();
  if (reason) {
    throw new RunSafetyError(`data-mechanics run STOPPED — refusing to truncate or run another test: ${reason}`);
  }
}

// ── Hook-order evidence ────────────────────────────────────────────────────────────────────────
// The guarantee above rests on the global hook running before a test file's own hooks. That is
// asserted, not assumed: the global hook counts its runs here (on `globalThis`, so the count does
// not depend on how modules are instantiated), and a test file compares it with its own count.

const HOOK_RUNS = Symbol.for("aios.datamechanics.truncation-hook-runs");
const MODULE_CHECKS = Symbol.for("aios.datamechanics.setup-module-checks");
const counters = globalThis as unknown as Record<symbol, number | undefined>;

/** Called by the setup file at module scope, once its run-safety check has passed. */
export function noteSetupModuleCheck(): void {
  counters[MODULE_CHECKS] = (counters[MODULE_CHECKS] ?? 0) + 1;
}

/** How many times the setup file's module-scope check has passed in this worker. */
export function setupModuleChecks(): number {
  return counters[MODULE_CHECKS] ?? 0;
}

/** Called by the global truncation hook, after its run-safety check has passed and before it truncates. */
export function noteTruncationHook(): void {
  counters[HOOK_RUNS] = (counters[HOOK_RUNS] ?? 0) + 1;
}

/** How many times the global truncation hook has got past its run-safety check in this worker. */
export function truncationHookRuns(): number {
  return counters[HOOK_RUNS] ?? 0;
}
