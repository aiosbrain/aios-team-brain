import { createHash } from "node:crypto";
import { Client } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * THE LIVE COORDINATOR-LOCK LIFETIME PROOF (`runtime-lifetime-adjudication.md`, requirement 2).
 *
 * The manual-rollback branch was `return rollbackToPrior(...)` inside a `try` whose `finally`
 * releases the coordinator lock. A bare `return promise` settles that try block immediately, so the
 * release ran while the recovery it fences was still going — and a second importer could take the
 * lock mid-recovery and start replacing the same two stores.
 *
 * The unit-tier version of this (`test/staging-resource-lifetime.test.ts`) asserts statement
 * ORDERING against a pg double. That is not the property: a PostgreSQL session advisory lock is
 * held by a real backend, and "the release statement had not been issued yet" is not the same claim
 * as "a second connection cannot get it". This file makes the claim the adjudication actually
 * asked for, against a real Postgres:
 *
 *   1. the real dispatcher enters `rollbackToPrior` and is held there;
 *   2. a SECOND real connection is REFUSED the coordinator lock;
 *   3. the recovery and the dispatcher's cleanup settle;
 *   4. the same second connection now acquires it.
 *
 * Step 4 is the non-vacuity control: without it, a lock that was never taken, or a Postgres that
 * refuses everything, would satisfy step 2 identically.
 *
 * The database, both clients, the journal, the locks and `runImporter` itself are REAL. The bundle
 * cryptography, the object store, the maintenance adapter and the graph driver are controlled —
 * they are the boundaries this property does not run through, and reaching the branch otherwise
 * would need a signed bundle and a live Neo4j.
 */

const deferred = () => {
  let resolve!: (value: unknown) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

/** Held open once the real recovery has entered `rollbackToPrior` and taken its first real steps. */
const recovery = vi.hoisted(() => ({ gate: null as null | { promise: Promise<unknown>; resolve: (v: unknown) => void; reject: (r: unknown) => void }, entered: false }));

const PRIOR_BYTES = vi.hoisted(() => Buffer.from(JSON.stringify({ manifest: { kind: "staging-rollback" } })));

vi.mock("../../scripts/staging-ops/object-store.mjs", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createPrivateStore: () => ({
    read: async () => PRIOR_BYTES, list: async () => [], putImmutable: async () => true,
    verify: async () => true, writePointer: async () => true, delete: async () => true,
  }),
}));
vi.mock("../../scripts/staging-ops/bundle-crypto.mjs", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  openSignedEncryptedBundle: () => ({
    manifest: { kind: "staging-rollback", runId: "prior-run", targetCommit: "b".repeat(40), mode: "copy-ready" },
    payload: Buffer.alloc(0),
  }),
}));
vi.mock("../../scripts/staging-ops/bundle-format.mjs", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  validatePairManifest: () => ({ ok: true, errors: [] }),
}));
vi.mock("../../scripts/staging-ops/build-identity.mjs", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  assertCompatibleBuildIdentity: () => true,
}));
vi.mock("../../scripts/staging-ops/role-policy.mjs", () => ({
  assertRunnerRole: () => true, assertOutboundCredentialIsolation: () => true,
}));
vi.mock("../../scripts/staging-ops/key-material.mjs", () => ({ keyMaterial: () => Buffer.alloc(32, 1) }));
vi.mock("../../scripts/staging-ops/action-preflight.mjs", () => ({ assertActionConfiguration: () => true }));

// THE HOLD. `stopAndVerifyAll` is the first maintenance call inside `rollbackToPrior`, reached only
// after the real session reset and the real `draining` journal write have run on the connection that
// owns the coordinator lock — so when it blocks, the recovery is genuinely mid-flight.
vi.mock("../../scripts/staging-ops/local-maintenance.mjs", () => ({
  LocalMaintenance: class {
    appServiceId = "app-local";
    async stopAndVerifyAll() {
      recovery.entered = true;
      if (recovery.gate) return await recovery.gate.promise;
      return true;
    }
    async tokenIdentity() { return {}; }
    async listActiveDeployments() { return []; }
    async deployApp() { return "dep-1"; }
  },
}));

const { runImporter } = await import("../../scripts/staging-ops/importer.mjs");
const journal = await import("../../scripts/staging-ops/journal.mjs");

const ENV = Object.fromEntries([
  ["STAGING_OPS_ROLE", "importer"], ["STAGING_MAINTENANCE_ADAPTER", "local"],
  ["DATABASE_URL", process.env.DATABASE_TEST_URL ?? ""],
  ["STAGING_COMPARISON_KEY_BASE64", Buffer.alloc(32, 3).toString("base64")],
  ["STAGING_COMPARISON_KEY_ID", "example-key"],
  ["STAGING_NEO4J_SERVICE_NAME", "staging-neo4j"], ["STAGING_NEO4J_DATABASE", "neo4j"],
  ["STAGING_OPS_ENVIRONMENT_ID", "staging-local"], ["RAILWAY_ENVIRONMENT_ID", "staging-local"],
  ["RAILWAY_PROJECT_ID", "local-project"], ["STAGING_APP_SERVICE_ID", "app-local"],
  ["STAGING_GRAPHITI_SERVICE_ID", "graphiti-local"], ["RAILWAY_STAGING_MAINTENANCE_TOKEN", "token"],
  ["STAGING_IMPORTER_SERVICE_ID", "importer-local"], ["STAGING_IMPORTER_IMAGE_DIGEST", `sha256:${"d".repeat(64)}`],
  ["STAGING_DATA_LOCK_TIMEOUT_MS", "1000"],
]) as unknown as NodeJS.ProcessEnv;

async function connect() {
  const client = new Client({ connectionString: process.env.DATABASE_TEST_URL });
  await client.connect();
  return client;
}

/** A journal `openPrior` accepts, so the branch reaches the recovery rather than refusing early. */
async function seedJournal(client: Client) {
  await journal.installStagingOps(client);
  await client.query(
    `UPDATE staging_ops.refresh_journal SET state='failed', run_id='failed-run',
       last_ready_run_id='prior-run', last_ready_object_id=$1, last_ready_digest=$2,
       last_ready_commit=$3, last_ready_mode='copy-ready', last_safe_checkpoint=null
     WHERE singleton=true`,
    [`prior-run--${"a".repeat(64)}`, createHash("sha256").update(PRIOR_BYTES).digest("hex"), "b".repeat(40)],
  );
}

const settle = async () => { for (let i = 0; i < 6; i += 1) await new Promise((r) => setImmediate(r)); };

let observer: Client | null = null;
afterEach(async () => {
  // The observer may hold the lock it acquired in step 4; ending the session drops it.
  await observer?.end().catch(() => {});
  observer = null;
  recovery.gate = null;
  recovery.entered = false;
});

describe("the manual rollback branch holds the real coordinator lock for the whole recovery", () => {
  it("refuses a second connection the coordinator lock until recovery AND dispatcher cleanup settle", async () => {
    const setup = await connect();
    try { await seedJournal(setup); } finally { await setup.end(); }

    observer = await connect();
    // Nothing holds it yet: the control that makes every later refusal meaningful.
    expect(await journal.acquireCoordinatorLock(observer), "the lock was already held before the run").toBe(true);
    await journal.releaseCoordinatorLock(observer);

    const gate = deferred();
    recovery.gate = gate;
    const outcome = runImporter(ENV, ["rollback", "failed-run"]).then(() => "resolved", (error: Error) => error);

    // Wait for the REAL recovery to be in flight — signalled by the maintenance stop being reached,
    // which happens after the session reset and the `draining` journal write on the lock-owning
    // connection.
    for (let i = 0; i < 200 && !recovery.entered; i += 1) await new Promise((r) => setTimeout(r, 25));
    expect(recovery.entered, "the dispatcher never entered rollbackToPrior").toBe(true);

    // THE PROPERTY. A real second backend, refused by a real advisory lock, while the recovery it
    // fences is still running.
    expect(await journal.acquireCoordinatorLock(observer), "a second connection took the coordinator lock MID-RECOVERY").toBe(false);
    const journalDuring = await observer.query<{ state: string }>("select state from staging_ops.refresh_journal where singleton=true");
    expect(journalDuring.rows[0].state, "the recovery had not actually started").toBe("draining");

    // Let the recovery fail from here: the branch unwinds through its real catch, the nested finally
    // releases the lock, and the dispatcher's finally closes the connection.
    gate.reject(new Error("harness released the recovery"));
    const settled = await outcome;
    expect(settled, "the recovery failure must reach the caller").toBeInstanceOf(Error);
    await settle();

    // …and only now is it available. Without this the refusal above is satisfied by a lock nothing
    // ever released.
    expect(await journal.acquireCoordinatorLock(observer), "the coordinator lock was never released").toBe(true);
  }, 60_000);

  it("leaves no importer backend behind once the dispatcher has returned", async () => {
    // The other half of the same lifetime: `client.end()` must actually run on the real connection.
    // Counted by application_name-free backend count on this database, before and after.
    const setup = await connect();
    try {
      await seedJournal(setup);
      const count = async () => Number((await setup.query<{ n: string }>(
        "select count(*)::text as n from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid()",
      )).rows[0].n);
      const before = await count();

      recovery.gate = null; // no hold: let it run straight through to its failure
      const settled = await runImporter(ENV, ["rollback", "failed-run"]).then(() => "resolved", (error: Error) => error);
      expect(settled).toBeInstanceOf(Error);

      // Postgres tears a backend down asynchronously, so allow it a bounded moment to settle.
      let after = await count();
      for (let i = 0; i < 40 && after > before; i += 1) {
        await new Promise((r) => setTimeout(r, 50));
        after = await count();
      }
      expect(after, "the importer left a backend connected after returning").toBeLessThanOrEqual(before);
    } finally { await setup.end(); }
  }, 60_000);
});
