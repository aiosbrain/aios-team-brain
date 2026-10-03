import { BUILD_RECORD_FILE, DevLoginSetupFailure } from "./dev-login-dev-setup";
import { runRecordedBuild } from "./dev-login-build-record";

// Entry for `npm run test:http:dev-login:build` (CI's HTTP job and a clean task-owned checkout).
// TEST-ONLY. It takes NO arguments: the command is always the ordinary `npm run build`, and nothing
// on the command line can claim a build succeeded or point the record at another artifact.
if (process.argv.length > 2) {
  console.error("SETUP_FAILURE[build-failed]: the dev-login build recorder takes no arguments.");
  process.exit(2);
}

try {
  const record = runRecordedBuild(process.cwd());
  console.log(
    `DEV_LOGIN_BUILD_RECORD_OK ${JSON.stringify({
      file: BUILD_RECORD_FILE,
      command: record.command,
      exitCode: record.exitCode,
      startedAt: record.startedAt,
      finishedAt: record.finishedAt,
      buildId: record.buildId,
      routeEntry: record.routeEntry,
      artifactFingerprint: record.artifactFingerprint,
      serverJs: record.serverJs,
      sources: record.sourcesAfter,
      generated: { before: record.generatedBefore, after: record.generatedAfter },
    })}`
  );
} catch (err) {
  if (!(err instanceof DevLoginSetupFailure)) throw err;
  console.error(err.message);
  process.exit(1);
}
