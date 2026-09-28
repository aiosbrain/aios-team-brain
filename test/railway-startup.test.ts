import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("Railway startup owns provisioning, pre-deploy owns schema", () => {
  it("passes explicit predeployed mode and sources persisted secrets before starting", () => {
    const dir = mkdtempSync(join(tmpdir(), "startup-"));
    const log = join(dir, "calls");
    try {
      writeFileSync(
        join(dir, "node"),
        '#!/bin/sh\nprintf "%s\\n" "$*" >> "$CALLS"\n',
        { mode: 0o755 },
      );
      writeFileSync(
        join(dir, "npm"),
        '#!/bin/sh\nprintf "%s:%s:%s\\n" "$*" "$AUTH_SECRET" "$SECRETS_KEY" >> "$CALLS"\n',
        { mode: 0o755 },
      );
      const secrets = join(dir, "secrets");
      writeFileSync(
        secrets,
        "AUTH_SECRET='synthetic-auth'\nSECRETS_KEY='synthetic-key'\n",
      );
      const result = spawnSync("sh", ["scripts/railway-start.sh"], {
        env: {
          ...process.env,
          PATH: dir + ":" + process.env.PATH,
          CALLS: log,
          DEV_SECRETS_FILE: secrets,
          AUTH_SECRET: "",
          SECRETS_KEY: "",
        },
        encoding: "utf8",
      });
      expect(result.status).toBe(0);
      expect(readFileSync(log, "utf8").trim().split("\n")).toEqual([
        "docker/bootstrap.mjs --schema=predeployed",
        "start:synthetic-auth:synthetic-key",
      ]);
      writeFileSync(log, "");
      const configured = spawnSync("sh", ["scripts/railway-start.sh"], {
        env: {
          ...process.env,
          PATH: dir + ":" + process.env.PATH,
          CALLS: log,
          DEV_SECRETS_FILE: secrets,
          AUTH_SECRET: "configured-auth",
          SECRETS_KEY: "configured-key",
        },
        encoding: "utf8",
      });
      expect(configured.status).toBe(0);
      expect(readFileSync(log, "utf8")).toContain(
        "start:configured-auth:configured-key",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("does not start the server when bootstrap fails", () => {
    const dir = mkdtempSync(join(tmpdir(), "startup-"));
    const log = join(dir, "calls");
    try {
      writeFileSync(join(dir, "node"), "#!/bin/sh\nexit 17\n", { mode: 0o755 });
      writeFileSync(join(dir, "npm"), '#!/bin/sh\necho started > "$CALLS"\n', {
        mode: 0o755,
      });
      const result = spawnSync("sh", ["scripts/railway-start.sh"], {
        env: { ...process.env, PATH: dir + ":" + process.env.PATH, CALLS: log },
        encoding: "utf8",
      });
      expect(result.status).toBe(17);
      expect(() => readFileSync(log)).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
