import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

/** Exercise the real shell payload with only external executables replaced. The actual fence's
 * admission/lock/process behavior is covered by staging-startup-fence and owned-workload tests. */
function startupFixture(dir: string) {
  const log = join(dir, "calls");
  const source = readFileSync("scripts/railway-start.sh", "utf8");
  const prefix = "exec /usr/bin/tini -s -- node scripts/staging-ops/startup-fence.mjs -- sh -ec";
  expect(source).toContain(prefix);
  const script = join(dir, "railway-start.sh");
  writeFileSync(script, source.replace("/usr/bin/tini", join(dir, "tini")));
  writeFileSync(join(dir, "tini"), `#!/bin/sh
[ "$1" = "-s" ] && [ "$2" = "--" ] || exit 90
printf 'tini\\n' >> "$CALLS"
shift 2
exec "$@"
`, { mode: 0o755 });
  writeFileSync(join(dir, "node"), `#!/bin/sh
if [ "$1" = "scripts/staging-ops/startup-fence.mjs" ]; then
  [ "$2" = "--" ] || exit 91
  printf 'fence\\n' >> "$CALLS"
  [ "$FENCE_REFUSAL" = "0" ] || exit 23
  shift 2
  exec "$@"
fi
[ "$1" = "docker/bootstrap.mjs" ] && [ "$2" = "--schema=predeployed" ] || exit 92
printf '%s\\n' "$*" >> "$CALLS"
exit "$BOOTSTRAP_FAILURE"
`, { mode: 0o755 });
  writeFileSync(join(dir, "npm"), '#!/bin/sh\nprintf "%s:%s:%s\\n" "$*" "$AUTH_SECRET" "$SECRETS_KEY" >> "$CALLS"\n', { mode: 0o755 });
  return {
    log,
    run: (extra: NodeJS.ProcessEnv = {}) => spawnSync("sh", [script], {
      env: { PATH: dir + ":" + process.env.PATH, CALLS: log, FENCE_REFUSAL: "0", BOOTSTRAP_FAILURE: "0", ...extra },
      encoding: "utf8",
    }),
  };
}

describe("Railway startup owns provisioning, pre-deploy owns schema", () => {
  it("runs predeployed bootstrap and persisted-secret loading inside the reaper/fence chain", () => {
    const dir = mkdtempSync(join(tmpdir(), "startup-"));
    try {
      const fixture = startupFixture(dir);
      const secrets = join(dir, "secrets");
      writeFileSync(secrets, "AUTH_SECRET='synthetic-auth'\nSECRETS_KEY='synthetic-key'\n");
      const result = fixture.run({ DEV_SECRETS_FILE: secrets, AUTH_SECRET: "", SECRETS_KEY: "" });
      expect(result.status).toBe(0);
      expect(readFileSync(fixture.log, "utf8").trim().split("\n")).toEqual([
        "tini", "fence", "docker/bootstrap.mjs --schema=predeployed", "start:synthetic-auth:synthetic-key",
      ]);
      writeFileSync(fixture.log, "");
      const configured = fixture.run({ DEV_SECRETS_FILE: secrets, AUTH_SECRET: "configured-auth", SECRETS_KEY: "configured-key" });
      expect(configured.status).toBe(0);
      expect(readFileSync(fixture.log, "utf8")).toContain("start:configured-auth:configured-key");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not start the server when bootstrap fails", () => {
    const dir = mkdtempSync(join(tmpdir(), "startup-"));
    try {
      const fixture = startupFixture(dir);
      const result = fixture.run({ BOOTSTRAP_FAILURE: "17" });
      expect(result.status).toBe(17);
      expect(readFileSync(fixture.log, "utf8").trim().split("\n")).toEqual([
        "tini", "fence", "docker/bootstrap.mjs --schema=predeployed",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not bootstrap, load secrets, or start the server when the fence refuses", () => {
    const dir = mkdtempSync(join(tmpdir(), "startup-"));
    try {
      const fixture = startupFixture(dir);
      const secrets = join(dir, "secrets");
      writeFileSync(secrets, 'printf "secrets loaded\\n" >> "$CALLS"\n');
      const result = fixture.run({ FENCE_REFUSAL: "1", DEV_SECRETS_FILE: secrets });
      expect(result.status).toBe(23);
      expect(readFileSync(fixture.log, "utf8").trim().split("\n")).toEqual(["tini", "fence"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
