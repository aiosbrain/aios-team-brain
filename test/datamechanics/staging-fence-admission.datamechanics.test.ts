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

  /**
   * NO INJECTED `statement_timeout` (M4). It used to be 250 ms, and the refusal these cases
   * observed was therefore the TIMEOUT cancelling a blocking `pg_advisory_lock_shared` — which
   * proves the safety exclusion but says nothing about how a real deployment behaves, because
   * production supplies no such timeout. There, admission simply waited for the whole import.
   * With a non-blocking acquisition the contender is refused by name and by its own decision, and
   * removing the timeout is what makes that the only thing this can be measuring.
   */
  const contender = () => new pg.Client({ connectionString: DATABASE_URL });
  const REFUSAL = /staging maintenance holds the exclusive data-use lock/;
  /** A ceiling, not the mechanism: if it ever blocks again, this fails as a timeout rather than hanging. */
  const PROMPTLY_MS = 5_000;

  it("never spawns the startup payload while an importer owns the exclusive lock", async () => {
    const spawnImpl = vi.fn();
    const startedAt = Date.now();
    await expect(supervise([process.execPath, "-e", "process.exit(0)"], {
      env: ENV, createClient: contender, spawnImpl,
    })).rejects.toThrow(REFUSAL);
    expect(Date.now() - startedAt, "admission waited instead of refusing").toBeLessThan(PROMPTLY_MS);
    expect(spawnImpl).not.toHaveBeenCalled();
  }, 20_000);

  it("never emits schema SQL while an importer owns the exclusive lock", async () => {
    const schemaSql = "CREATE TABLE staging_ops.h3_loader_probe(id integer)";
    const startedAt = Date.now();
    await expect(loadSchema({
      cwd: "/unused", databaseUrl: DATABASE_URL, env: ENV, createClient: contender,
      readFile: () => schemaSql, exists: () => false, readDir: () => [], logger: { log: () => {} },
    })).rejects.toThrow(/staging maintenance holds the exclusive data-use lock/);
    expect(Date.now() - startedAt, "the loader waited instead of refusing").toBeLessThan(PROMPTLY_MS);
    const proof = await owner.query("SELECT to_regclass('staging_ops.h3_loader_probe') AS relation");
    expect(proof.rows[0].relation).toBeNull();
  }, 20_000);

  it("still ACQUIRES the shared lock once maintenance releases it", async () => {
    // The positive control the two refusals need: without it, a fence that refused unconditionally
    // would pass both of them and this suite would certify nothing.
    //
    // The journal here is `importing`, so the fence still refuses — at CLASSIFICATION, which is the
    // NEXT step and a different refusal. That difference is the evidence: reaching the journal
    // verdict is only possible after the shared lock was granted. Released and re-acquired inside
    // this case so the suite's other ordering is untouched.
    await releaseDataUseLock(owner, "exclusive");
    try {
      const spawnImpl = vi.fn();
      const refusal = await supervise([process.execPath, "-e", "process.exit(0)"], {
        env: ENV, createClient: contender, spawnImpl,
      }).then(() => null, (error: Error) => error);
      expect(refusal, "the fence did not refuse an importing journal").not.toBeNull();
      expect(refusal!.message, "admission was refused by the LOCK even with no exclusive owner").not.toMatch(REFUSAL);
      expect(refusal!.message).toMatch(/refresh state is importing/);
      expect(spawnImpl).not.toHaveBeenCalled();
    } finally {
      await acquireDataUseLock(owner, "exclusive", true);
    }
  }, 20_000);
});
