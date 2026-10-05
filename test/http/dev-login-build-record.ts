import { spawnSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  BUILD_RECORD_COMMAND,
  BUILD_RECORD_FILE,
  DevLoginSetupFailure,
  GENERATED_FILES,
  LOOPBACK,
  assertNoNextEnvFiles,
  assertTaskRoot,
  buildChildEnv,
  describeChanged,
  describeChildEnv,
  fingerprintFiles,
  inventoryRuntimeSources,
  inventoryServerJs,
  readProductionArtifact,
  validateSyntheticDatabaseUrl,
  type BuildRecord,
} from "./dev-login-dev-setup";

/**
 * Non-serving loopback stand-ins for a build that was given no database. Port 9 (discard) is not a
 * Postgres and nothing here claims a ready one: a build that really needs a database fails on this
 * value instead of reaching for an ambient URL.
 */
const BUILD_ONLY_PORT = 9;
export const BUILD_ONLY_DATABASE_URL = `postgres://aio1210_build:aio1210_build@${LOOPBACK}:${BUILD_ONLY_PORT}/aio1210_build_only_test`;
/** Fixed, non-secret signing stand-in: the build mints nothing, and no served child ever uses it. */
export const BUILD_ONLY_AUTH_SECRET = Buffer.alloc(32, 9).toString("hex");

export interface RecordedBuildEnv {
  /** The exact environment handed to the build command. */
  env: Record<string, string>;
  /** Where DATABASE_URL came from — the NAME of the source, never its value. */
  database: "DATABASE_TEST_URL" | "build-only-default";
}

/**
 * The build command's ENTIRE environment, constructed here so that a direct `npm run
 * test:http:dev-login:build`, CI and a coordinator all build under the same one. It is the carrier's
 * child policy (`buildChildEnv`: the finite OS allowlist, the shared empty-base scrub, the blanked
 * graph/LLM/mail/Sentry endpoints and credentials, schedulers and Next telemetry off) with build
 * values: NODE_ENV=production, AIOS_DEV_LOGIN=0, no obsolete escape, the postgres backend, synthetic
 * AUTH_SECRET/SECRETS_KEY and a local APP_URL. Nothing else of the caller's reaches the build — not
 * NODE_OPTIONS, a NEXT_PUBLIC_* value, a PG* variable, a provider credential or an unknown key.
 *
 * The only database it will pass is a DATABASE_TEST_URL that passes the wire carrier's own guard
 * (owned loopback, `_test`, plain). DATABASE_URL is never read. With no DATABASE_TEST_URL the build
 * gets the non-serving stand-in above; a present but unsafe one is refused, not replaced.
 */
export function recordedBuildEnv(ambient: NodeJS.ProcessEnv = process.env): RecordedBuildEnv {
  const provided = ambient.DATABASE_TEST_URL;
  const databaseUrl = provided ? validateSyntheticDatabaseUrl(provided).url : BUILD_ONLY_DATABASE_URL;
  const env = buildChildEnv(
    { nodeEnv: "production", devLoginOptIn: "0", databaseUrl, authSecret: BUILD_ONLY_AUTH_SECRET, port: BUILD_ONLY_PORT },
    ambient
  );
  return { env, database: provided ? "DATABASE_TEST_URL" : "build-only-default" };
}

/**
 * TEST-ONLY build RECORDER for the AIO-1210 dev-login wire carrier — the one place a build record is
 * written. Kept out of `dev-login-dev-setup.ts` on purpose: the carrier (its config, global setup
 * and test file) only ever READS a record and never runs a build.
 *
 * It runs the ordinary build command itself, once, so the record states what THIS process observed:
 *   1. refuse, before the build, a checkout holding any of the eight Next-loaded env files — the
 *      build must not be able to pick up an opt-in, a mode or a credential from one;
 *   2. inventory the runtime sources, then run the command with stdio unchanged and the SANITIZED
 *      environment above — the same command, but not the caller's ambient environment, whose Sentry
 *      upload settings, provider keys or preload hooks would otherwise take part in the build;
 *   3. only if it exited 0 AND that inventory is identical afterwards (no file edited, added or
 *      removed), bind it to the BUILD_ID, route artifact and server JS inventory the build left.
 * There is no flag or argument that asserts success, and no path that attributes an artifact this
 * process did not just watch being built. Any earlier record is removed before the build starts.
 *
 * What the sanitized environment does NOT do: undo anything that already ran in this recorder
 * process. Whoever started it is trusted; a hook preloaded into the recorder itself is outside what
 * scrubbing the build child can address.
 */
export function runRecordedBuild(
  cwd: string = process.cwd(),
  command: readonly string[] = BUILD_RECORD_COMMAND
): BuildRecord {
  assertTaskRoot(cwd);
  assertNoNextEnvFiles(cwd);
  const build = recordedBuildEnv();
  const recordPath = join(cwd, BUILD_RECORD_FILE);
  rmSync(recordPath, { force: true });

  const sourcesBefore = inventoryRuntimeSources(cwd);
  const generatedBefore = fingerprintFiles(cwd, GENERATED_FILES);
  // Mode and presence only: values outside the printable set are reported as <set> / <blank>.
  console.log(`DEV_LOGIN_BUILD_ENV ${JSON.stringify({ database: build.database, env: describeChildEnv(build.env) })}`);
  const startedAt = new Date().toISOString();
  const [file, ...args] = command;
  const result = spawnSync(file, args, { cwd, env: build.env, stdio: "inherit" });
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
  const sourcesAfter = inventoryRuntimeSources(cwd);
  const changed = describeChanged(sourcesBefore, sourcesAfter);
  if (changed) {
    throw new DevLoginSetupFailure(
      "build-source-changed",
      `runtime source(s) changed, appeared or disappeared while ${ran} ran: ${changed}. No build record was written.`
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
