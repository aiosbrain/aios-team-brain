import { spawnSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  BUILD_RECORD_COMMAND,
  BUILD_RECORD_FILE,
  DevLoginSetupFailure,
  GENERATED_FILES,
  RUNTIME_SOURCE_FILES,
  assertNoNextEnvFiles,
  assertTaskRoot,
  changedKeys,
  fingerprintFiles,
  inventoryServerJs,
  readProductionArtifact,
  type BuildRecord,
} from "./dev-login-dev-setup";

/**
 * TEST-ONLY build RECORDER for the AIO-1210 dev-login wire carrier — the one place a build record is
 * written. Kept out of `dev-login-dev-setup.ts` on purpose: the carrier (its config, global setup
 * and test file) only ever READS a record and never runs a build.
 *
 * It runs the ordinary build command itself, so the record states what THIS process observed:
 *   1. refuse, before the build, a checkout holding any of the eight Next-loaded env files — the
 *      build must not be able to pick up an opt-in, a mode or a credential from one;
 *   2. fingerprint the tracked runtime sources, then run the command with the caller's environment
 *      and stdio unchanged (nothing is added, removed or overridden: it is the same build);
 *   3. only if it exited 0 AND those sources are byte-identical afterwards, bind them to the
 *      BUILD_ID, route artifact and server JS inventory the build left behind.
 * There is no flag or argument that asserts success, and no path that attributes an artifact this
 * process did not just watch being built. Any earlier record is removed before the build starts.
 */
export function runRecordedBuild(
  cwd: string = process.cwd(),
  command: readonly string[] = BUILD_RECORD_COMMAND
): BuildRecord {
  assertTaskRoot(cwd);
  assertNoNextEnvFiles(cwd);
  const recordPath = join(cwd, BUILD_RECORD_FILE);
  rmSync(recordPath, { force: true });

  const sourcesBefore = fingerprintFiles(cwd, RUNTIME_SOURCE_FILES);
  const generatedBefore = fingerprintFiles(cwd, GENERATED_FILES);
  const startedAt = new Date().toISOString();
  const [file, ...args] = command;
  const result = spawnSync(file, args, { cwd, stdio: "inherit" });
  const finishedAt = new Date().toISOString();

  const ran = `\`${command.join(" ")}\``;
  if (result.error) {
    throw new DevLoginSetupFailure("build-failed", `${ran} could not be run: ${result.error.message}. No build record was written.`);
  }
  if (result.status !== 0) {
    throw new DevLoginSetupFailure(
      "build-failed",
      `${ran} exited with status ${String(result.status)} (signal ${String(result.signal)}). No build record was written.`
    );
  }
  const sourcesAfter = fingerprintFiles(cwd, RUNTIME_SOURCE_FILES);
  const changed = changedKeys(sourcesBefore, sourcesAfter);
  if (changed.length > 0) {
    throw new DevLoginSetupFailure(
      "build-source-changed",
      `tracked runtime source(s) changed while ${ran} ran: ${changed.join(", ")}. No build record was written.`
    );
  }

  const artifact = readProductionArtifact(cwd);
  const serverJs = inventoryServerJs(cwd);
  const record: BuildRecord = {
    schema: 1,
    command: [...command],
    exitCode: result.status,
    startedAt,
    finishedAt,
    sourcesBefore,
    sourcesAfter,
    generatedBefore,
    generatedAfter: fingerprintFiles(cwd, GENERATED_FILES),
    buildId: artifact.buildId,
    routeEntry: artifact.routeEntry,
    artifactFingerprint: artifact.fingerprint,
    serverJs: { files: serverJs.files, bytes: serverJs.bytes, nonRegular: serverJs.nonRegular, hash: serverJs.hash },
  };
  writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);
  return record;
}
