import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { loadSchema } from "../../scripts/pg-load-schema.mjs";
import { installStagingOps, acquireDataUseLock, releaseDataUseLock } from "../../scripts/staging-ops/journal.mjs";
import { supervise } from "../../scripts/staging-ops/startup-fence.mjs";

const DATABASE_URL = process.env.DATABASE_URL!;
const ENV = {
  DATABASE_URL,
  STAGING_OPS_ENVIRONMENT_ID: "staging-fence-test",
  RAILWAY_ENVIRONMENT_ID: "staging-fence-test",
  // Deliberately missing STAGING_DATA_MODE: durable activated state must still enter the fence.
} as NodeJS.ProcessEnv;

describe("H3 — actual startup/loader admission contends on the common data fence", () => {
  const owner = new pg.Client({ connectionString: DATABASE_URL });

  beforeAll(async () => {
    await owner.connect();
    await installStagingOps(owner);
    await owner.query(`UPDATE staging_ops.refresh_journal SET
      state='importing', run_id='activated-import', last_ready_run_id='prior-ready',
      last_ready_object_id='prior-object', last_ready_digest=$1, last_ready_commit=$2,
      last_ready_mode='copy-ready' WHERE singleton=true`, ["a".repeat(64), "b".repeat(40)]);
    await acquireDataUseLock(owner, "exclusive", true);
  });

  afterAll(async () => {
    await releaseDataUseLock(owner, "exclusive").catch(() => {});
    await owner.end();
  });

  const contender = () => new pg.Client({ connectionString: DATABASE_URL, statement_timeout: 250 });

  it("never spawns the startup payload while an importer owns the exclusive lock", async () => {
    const spawnImpl = vi.fn();
    await expect(supervise([process.execPath, "-e", "process.exit(0)"], {
      env: ENV, createClient: contender, spawnImpl,
    })).rejects.toThrow(/statement timeout|canceling statement/i);
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it("never emits schema SQL while an importer owns the exclusive lock", async () => {
    const schemaSql = "CREATE TABLE staging_ops.h3_loader_probe(id integer)";
    await expect(loadSchema({
      cwd: "/unused", databaseUrl: DATABASE_URL, env: ENV, createClient: contender,
      readFile: () => schemaSql, exists: () => false, readDir: () => [], logger: { log: () => {} },
    })).rejects.toThrow(/statement timeout|canceling statement/i);
    const proof = await owner.query("SELECT to_regclass('staging_ops.h3_loader_probe') AS relation");
    expect(proof.rows[0].relation).toBeNull();
  });
});
