import { randomUUID } from "node:crypto";
import {
  RUN_ID_ENV,
  RUN_ID_PROVIDED,
  initializeRunDirectory,
  removeRunDirectoryIfClean,
  runDirectoryFor,
} from "./run-fatal-latch";

/**
 * Vitest GLOBAL setup for every tier that truncates through `test/datamechanics/setup.ts`.
 *
 * It runs once per Vitest invocation, in the main process, BEFORE any worker is created. That is
 * the only place a run can be given an identity all of its workers share:
 *
 *   - a FRESH run id is minted here, always — never taken from the environment this process was
 *     started with, so a run cannot inherit an earlier run's id or its state;
 *   - it is handed to the workers twice: in the environment they inherit, and through Vitest's own
 *     `provide` channel (the setup file checks that the two agree);
 *   - the run's own safety directory is created (see `run-fatal-latch`).
 *
 * At the end, the main process removes that directory — its own, and only if it is provably clean.
 * A run that was stopped, or that still has an in-flight marker, leaves its state where it is; the
 * next invocation gets a new id and a new directory, and reads none of it.
 */
export default function setup(project: { provide: (key: typeof RUN_ID_PROVIDED, value: string) => void }): () => void {
  const runId = randomUUID();
  process.env[RUN_ID_ENV] = runId;
  project.provide(RUN_ID_PROVIDED, runId);
  const directory = runDirectoryFor(runId, process.env.DATABASE_URL ?? "");
  initializeRunDirectory(directory, { runId, startedAt: new Date().toISOString(), mainProcess: process.pid });
  return () => {
    removeRunDirectoryIfClean(directory);
  };
}
