import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { listMemberIdentities } from "@/lib/identity/list";
import { setMemberIdentity } from "@/lib/identity/member-identities";
import { db, seedTeam, type Seed } from "./helpers";
import {
  RACE_TEST_TIMEOUT_MS,
  RaceScheduleError,
  authorityLockName,
  barrierSessions,
  closeRaceHarness,
  holdIdentityKey,
  holdLock,
  holdNamedLock,
  holdTable,
  parkThenCompete,
  raceHarnessFatal,
  sessionEvidence,
  untilBarrierGone,
  untilSessions,
} from "./identity-race-harness";
import {
  RUN_ID_ENV,
  RunSafetyError,
  assertRunSafe,
  createRunSafety,
  currentRunSafety,
  initializeRunDirectory,
  removeRunDirectoryIfClean,
  runDirectoryFor,
  setupModuleChecks,
  truncationHookRuns,
  type RunSafety,
} from "./run-fatal-latch";

/**
 * THE RACE HARNESS AND THE RUN-SAFETY STATE, tested as themselves (AIO-1167), against real
 * PostgreSQL.
 *
 * The identity suites rest their concurrency claims on `./identity-race-harness`. A harness that
 * leaks a barrier, mistakes another session for its own, or lets a failed schedule's transaction
 * live into the next test's `TRUNCATE` makes those claims — and every later test — unsound. So:
 *
 *   1. a barrier's cleanup is PROVEN from `pg_stat_activity`: after a normal release and after a
 *      failed acquisition its tagged session is seen gone before its in-flight marker is cleared;
 *      a barrier that survives its release is `unproven` and stops the run;
 *   2. a FOREIGN session of the same database is never the harness's: waiting behind the same
 *      barrier, or behind the parked operation itself, it is not counted as evidence; and when
 *      cleanup has to cancel a raced operation, only that operation's own backend is signalled —
 *      the foreign sessions keep their locks and their waits, and complete once released;
 *   3. a schedule that FAILS after an operation has started a real transaction is reported only
 *      after that operation's backend is idle; a cleanup that cannot be proven stops the run;
 *   4. the run-safety state: an in-flight scope blocks truncation and the next file; a scope's own
 *      cleanup clears only its own marker; unreadable state is not clean; a marker that cannot be
 *      written prevents the database work; a fresh run inherits nothing from another run's files;
 *      and the tier's setup file checks all of it at module scope and again before it truncates —
 *      ahead of this file's own hooks, which is asserted here rather than assumed.
 *
 * Everything is established from PostgreSQL evidence about exact, known backends. The "foreign"
 * sessions are plain clients this file opens and never registers with the harness. Wherever a
 * test stages an unsafe outcome it does so in a run-safety state of ITS OWN, and removes what it
 * staged before it ends: the real run is never stopped by testing what stops it.
 */

// ── Order evidence: taken at module load and by this file's own `beforeEach`, checked in (4) ───
const setupModuleChecksAtLoad = setupModuleChecks();
const truncationHooksAtLoad = truncationHookRuns();
let fileHooks = 0;
const hookOrder: { truncationHooks: number; fileHooks: number }[] = [];

beforeEach(() => {
  fileHooks += 1;
  hookOrder.push({ truncationHooks: truncationHookRuns() - truncationHooksAtLoad, fileHooks });
});

// ── Foreign sessions: this file's own clients, NOT registered with the harness ─────────────────
interface Foreign { client: Client; pid: number }
const foreignClients: Client[] = [];

async function foreign(name: string): Promise<Foreign> {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    application_name: `identity-race-foreign/${name}`,
    connectionTimeoutMillis: 10_000,
  });
  client.on("error", () => undefined);
  foreignClients.push(client);
  await client.connect();
  const pid = (await client.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0].pid;
  return { client, pid };
}

interface InFlight<T> { promise: Promise<T>; state: () => "pending" | "resolved" | "rejected" }

/** A query left in flight, with what became of it readable at any moment. */
function inFlight<T>(work: Promise<T>): InFlight<T> {
  let state: "pending" | "resolved" | "rejected" = "pending";
  work.then(() => { state = "resolved"; }, () => { state = "rejected"; });
  return { promise: work, state: () => state };
}

/** Exactly `count` of the named backends exist, and every one of them is waiting for a `locktype` lock. */
const waitsOn = (locktype: string, count: number) => (sessions: { waitingOn: string | null }[]) =>
  sessions.length === count && sessions.every((session) => session.waitingOn === locktype);

// ── Run-safety states of this file's own ───────────────────────────────────────────────────────
const privateRoots: string[] = [];

/** A run directory nobody else reads: its own root, its own run id. */
function privateRun(root?: string, databaseUrl = "postgres://harness-self-test"): { root: string; runId: string; directory: string; safety: RunSafety } {
  const ownRoot = root ?? join(tmpdir(), `aios-datamechanics-self-test-${randomUUID()}`);
  if (!root) privateRoots.push(ownRoot);
  const runId = randomUUID();
  const directory = runDirectoryFor(runId, databaseUrl, ownRoot);
  initializeRunDirectory(directory, { runId });
  return { root: ownRoot, runId, directory, safety: createRunSafety(directory) };
}

afterEach(async () => {
  // Ending a client whose query is still waiting drops its connection; the server then abandons it.
  for (const client of foreignClients.splice(0)) await client.end().catch(() => undefined);
  for (const root of privateRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

afterAll(async () => {
  await closeRaceHarness();
});

/** Alice holds one Slack id at revision 1, linked by the real writer; Bob may be remapped to. */
async function aliceHolds(): Promise<{ seed: Seed; alice: string; bob: string; target: string }> {
  const seed = await seedTeam();
  const person = async (name: string) => {
    const { data, error } = await db().from("members").insert({
      team_id: seed.teamId, email: `${name}-${randomUUID().slice(0, 8)}@roster.example`, display_name: name,
      actor_handle: `${name}-${randomUUID().slice(0, 8)}`, role: "member", tier: "team", status: "active", is_connector: false,
    }).select("id").single();
    if (error || !data) throw new Error(`member fixture failed: ${error?.message}`);
    return (data as { id: string }).id;
  };
  const alice = await person("alice");
  const bob = await person("bob");
  const target = `harness-${randomUUID().slice(0, 8)}`;
  await setMemberIdentity(db(), seed.teamId, alice, { provider: "slack", externalId: target });
  return { seed, alice, bob, target };
}

/** A real writer call that links a NEW Slack id to a member: a real transaction, inside the team's identity boundary. */
const linkFresh = (seed: Seed, memberId: string, externalId: string) =>
  setMemberIdentity(db(), seed.teamId, memberId, { provider: "slack", externalId });

const slackIds = async (seed: Seed, memberId: string) =>
  ((await listMemberIdentities(db(), seed.teamId)).get(memberId)?.providers ?? []).map((identity) => identity.externalId).sort();

describe("race harness (1): a barrier's cleanup is proven — after a failed acquisition, after a release, and not at all if it survives (real Postgres)", () => {
  it("a lock statement that FAILS after connect + BEGIN: the error is rethrown only once the barrier's session is SEEN gone, and its in-flight marker is then cleared", async () => {
    const run = currentRunSafety();
    const tag = `failing-${randomUUID().slice(0, 8)}`;

    const failure = await holdLock("lock table identity_race_no_such_table in access exclusive mode", [], { tag })
      .then(() => null, (error: unknown) => error);

    // The failing statement is the lock itself — issued only after the connection began its
    // transaction — and it is PostgreSQL's own error that comes back, not a harness one.
    expect(failure).toBeInstanceOf(Error);
    expect((failure as { code?: string }).code).toBe("42P01");
    // The session that connected and began is gone, and with it everything it could have held…
    expect(await barrierSessions(tag)).toEqual([]);
    // …which is what cleared the marker it was armed with before it connected.
    expect(run.armed()).not.toContain(tag);
    expect(run.blocked()).toBeNull();
  }, RACE_TEST_TIMEOUT_MS);

  it("a lock that is NOT FREE: the second barrier is refused by PostgreSQL's lock timeout and leaves no session and no marker; the first stays in flight until its own release is proven", async () => {
    const run = currentRunSafety();
    const held = `held-${randomUUID().slice(0, 8)}`;
    const refused = `refused-${randomUUID().slice(0, 8)}`;
    const first = await holdTable("member_identities", { tag: held });
    try {
      // IN FLIGHT: while a barrier holds a session, its scope is on file — and a truncation now
      // would be refused.
      expect(run.armed()).toEqual([held]);
      expect(() => assertRunSafe(run)).toThrow(/still in flight/);

      const failure = await holdTable("member_identities", { tag: refused, lockTimeoutMs: 250 })
        .then(() => null, (error: unknown) => error);

      expect(failure).toBeInstanceOf(Error);
      expect((failure as { code?: string }).code, "PostgreSQL's lock_not_available").toBe("55P03");
      expect(await barrierSessions(refused)).toEqual([]);
      expect(run.armed(), "the refused barrier's marker is cleared; the held one's is not").toEqual([held]);
      // The barrier that IS held: one session, in its transaction, holding its lock, waiting for nothing.
      expect(await barrierSessions(held)).toEqual([{ pid: first.pid, state: "idle in transaction" }]);
      const [holder] = await sessionEvidence([first.pid]);
      expect(holder).toMatchObject({ pid: first.pid, waitingOn: null });
      expect(holder.locksHeld).toBeGreaterThanOrEqual(1);
    } finally {
      // Released twice at once, and once more: every call resolves, and the session is gone.
      await Promise.all([first.release(), first.release()]);
      await first.release();
    }
    expect(await barrierSessions(held)).toEqual([]);
    expect(run.armed()).toEqual([]);
    expect(run.blocked()).toBeNull();
  }, RACE_TEST_TIMEOUT_MS);

  it("a barrier that SURVIVES its release is `unproven`: that closing returned proves nothing — the tagged session is still there, so the run is stopped and the marker stays", async () => {
    // Staged in a run-safety state of this test's own, with a seam that makes "closing" do nothing.
    const { safety } = privateRun();
    const tag = `survivor-${randomUUID().slice(0, 8)}`;
    const survivors: Client[] = [];
    const barrier = await holdNamedLock(`harness-survivor:${randomUUID()}`, {
      tag, safety, cleanupMs: 300, dispose: async (client) => { survivors.push(client); },
    });
    try {
      expect(safety.armed()).toEqual([tag]);

      const failure = await barrier.release().then(() => null, (error: unknown) => error);

      // "Closing" completed without an error — and the harness did not take that for cleanup.
      expect(survivors).toHaveLength(1);
      expect(failure).toBeInstanceOf(RaceScheduleError);
      expect((failure as RaceScheduleError).cleanup).toEqual({ outcome: "unproven", barrierGone: false, signalled: [], operations: [] });
      // The evidence it went by: the exact tagged session, still in its transaction.
      expect(await barrierSessions(tag)).toEqual([{ pid: barrier.pid, state: "idle in transaction" }]);
      // THE RUN IS STOPPED: a fatal reason, the marker still on file, and the guard refusing.
      expect(safety.fatal()).toMatch(/barrier survivor-[a-f0-9]+ was released, and its session could not be proven gone/);
      expect(safety.armed()).toEqual([tag]);
      expect(() => assertRunSafe(safety)).toThrow(/run STOPPED/);
      // Releasing again changes nothing: the same refusal, the same state.
      expect(await barrier.release().then(() => null, (error: unknown) => error)).toBe(failure);
      expect(safety.armed()).toEqual([tag]);
      // The real run was not stopped by this test: its state is not this one.
      expect(raceHarnessFatal()).toBeNull();
      expect(currentRunSafety().armed()).not.toContain(tag);
    } finally {
      // The suite is left safe: the survivor is really closed, and seen gone.
      for (const client of survivors) await client.end().catch(() => undefined);
      await untilBarrierGone(tag);
    }
  }, RACE_TEST_TIMEOUT_MS);
});

describe("race harness (1, in a schedule): a surviving barrier makes the whole schedule's cleanup `unproven` (real Postgres)", () => {
  it("the raced operation is settled — by cancelling ITS backend only — and its backend is idle, but the barrier's session is still there: the report says `unproven`, the run is stopped, the marker stays", async () => {
    const { seed, alice } = await aliceHolds();
    const fresh = `harness-${randomUUID().slice(0, 8)}`;
    const { safety } = privateRun();
    const tag = `survivor-${randomUUID().slice(0, 8)}`;
    const survivors: Client[] = [];
    // The barrier holds the new id's own key, which the writer takes after the team authority.
    const barrier = await holdIdentityKey(seed.teamId, "slack", fresh, {
      tag, safety, cleanupMs: 300, dispose: async (client) => { survivors.push(client); },
    });
    try {
      const failure = await parkThenCompete({
        seed,
        barrier,
        parksOn: "advisory",
        first: () => linkFresh(seed, alice, fresh).then(() => "linked", (error: unknown) => (error as { code?: string }).code ?? "failed"),
        second: async () => "finished without waiting",
        bounds: { cleanupMs: 300 },
      }).then(() => null, (error: unknown) => error);

      expect(failure).toBeInstanceOf(RaceScheduleError);
      const { cleanup, message } = failure as RaceScheduleError;
      // The raced writer could not finish — its barrier never went away — so its own backend was
      // cancelled, and it is settled and idle. That half of cleanup IS proven…
      const parked = cleanup.operations.find((operation) => operation.label === "the parked operation")!;
      expect(parked.settled).toBe(true);
      expect(cleanup.signalled).toHaveLength(1);
      expect(parked.backends).toContain(cleanup.signalled[0]);
      expect(cleanup.signalled).not.toContain(barrier.pid);
      for (const session of await sessionEvidence(parked.backends)) {
        expect(session).toEqual({ pid: session.pid, state: "idle", waitingOn: null, locksHeld: 0 });
      }
      // …and the other half is not: the barrier's tagged session was never seen gone.
      expect(cleanup.barrierGone).toBe(false);
      expect(cleanup.outcome).toBe("unproven");
      expect(message).toContain("the barrier's own session was not seen gone after its release");
      expect(await barrierSessions(tag)).toEqual([{ pid: barrier.pid, state: "idle in transaction" }]);
      // So the run (this test's own) is stopped, and the scope stays on file.
      expect(safety.fatal()).toMatch(/the barrier's own session was not seen gone/);
      expect(safety.armed()).toEqual([tag]);
      expect(() => assertRunSafe(safety)).toThrow(/run STOPPED/);
      expect(raceHarnessFatal()).toBeNull();
    } finally {
      for (const client of survivors) await client.end().catch(() => undefined);
      await untilBarrierGone(tag);
    }
    // With the survivor really gone, the cancelled writer has left nothing behind.
    expect(await slackIds(seed, alice)).not.toContain(fresh);
  }, RACE_TEST_TIMEOUT_MS);
});

describe("race harness (2): a foreign session of the same database is never the harness's (real Postgres)", () => {
  it("foreign waiters behind the SAME barrier and behind the PARKED operation are not evidence, are not signalled, and complete once released", async () => {
    const { seed, alice, bob, target } = await aliceHolds();
    const fresh = `harness-${randomUUID().slice(0, 8)}`;
    const barrier = await holdTable("member_identity_mapping_state");
    // FOREIGN #1 waits behind the harness's own barrier — exactly where the parked operation will.
    // "Blocked behind my barrier" is true of it, and it is not the harness's.
    const behindBarrier = await foreign("behind-barrier");
    const read = inFlight(behindBarrier.client.query("select count(*)::int as n from member_identity_mapping_state"));
    await untilSessions([behindBarrier.pid], "the foreign read waiting on the table barrier", waitsOn("relation", 1));

    const behindParked = await foreign("behind-parked");
    let queued: InFlight<unknown> | undefined;
    let raced: { parked: number; competing: number } | undefined;
    const { first: linked, second: remapped } = await parkThenCompete({
      seed,
      barrier,
      parksOn: "relation",
      // Two real writer calls: the first parks at its locked read of the mapping state, holding the
      // team authority; the second waits for that authority.
      first: () => linkFresh(seed, alice, fresh),
      second: () => setMemberIdentity(db(), seed.teamId, bob, { provider: "slack", externalId: target }, { force: true, expectedRevision: 1 }),
      // With both raced operations proven waiting, FOREIGN #2 queues on the team identity authority
      // itself — behind the parked operation, on the very lock the competing operation waits for.
      // The harness then proves its two waits again: each still exactly one, exactly as before.
      whileQueued: async (waiting) => {
        raced = waiting;
        await behindParked.client.query("begin");
        queued = inFlight(behindParked.client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [authorityLockName(seed.teamId)]));
        await untilSessions([behindParked.pid], "the foreign session waiting on the team authority", waitsOn("advisory", 1));
        // Still waiting where it was: the foreign read behind the barrier.
        expect(read.state()).toBe("pending");
      },
    });

    // The schedule passed with both foreign waiters present, and it is the schedule's own result.
    expect(linked).toMatchObject({ memberId: alice, created: true, mappingRevision: 1 });
    expect(remapped).toMatchObject({ memberId: bob, updated: true, mappingRevision: 2 });
    // Neither foreign backend was one of the two the harness registered and reasoned about.
    expect([raced!.parked, raced!.competing]).not.toContain(behindBarrier.pid);
    expect([raced!.parked, raced!.competing]).not.toContain(behindParked.pid);
    // Both foreign operations COMPLETE — never cancelled, never terminated.
    expect((await read.promise).rows).toEqual([{ n: expect.any(Number) }]);
    await queued!.promise;
    expect(queued!.state()).toBe("resolved");
    expect(read.state()).toBe("resolved");
    await behindParked.client.query("rollback");
    // The scope's cleanup was proven, so its marker is gone and the run goes on.
    expect(currentRunSafety().armed()).toEqual([]);
    expect(raceHarnessFatal()).toBeNull();
  }, RACE_TEST_TIMEOUT_MS);

  it("when cleanup must CANCEL a raced operation, only that operation's own backend is signalled: a foreign lock holder and foreign waiters in the same database keep their locks and their waits", async () => {
    const { seed, alice } = await aliceHolds();
    const fresh = `harness-${randomUUID().slice(0, 8)}`;
    const barrier = await holdTable("member_identities");
    // A FOREIGN session holds the table the raced writer needs NEXT — not a harness barrier, and
    // not released by the harness: once its own barrier is gone, the raced writer runs into it.
    const holder = await foreign("lock-holder");
    await holder.client.query("begin");
    await holder.client.query("lock table member_identity_mapping_state in access exclusive mode");
    // Foreign waiters: one behind that foreign holder, one behind the harness's barrier.
    const behindHolder = await foreign("behind-holder");
    const stuck = inFlight(behindHolder.client.query("select count(*)::int as n from member_identity_mapping_state"));
    const behindBarrier = await foreign("behind-barrier");
    const passing = inFlight(behindBarrier.client.query("select count(*)::int as n from member_identities"));
    await untilSessions([behindHolder.pid, behindBarrier.pid], "both foreign reads waiting on their table locks", waitsOn("relation", 2));

    // The schedule FAILS, deterministically and at once: the "competing" operation finishes without
    // ever waiting. Cleanup then releases the barrier; the parked writer — a real transaction,
    // holding the team authority — runs on into the foreign holder's lock and cannot finish.
    const failure = await parkThenCompete({
      seed,
      barrier,
      parksOn: "relation",
      first: () => linkFresh(seed, alice, fresh).then(() => "linked", (error: unknown) => (error as { code?: string }).code ?? "failed"),
      second: async () => "finished without waiting",
      bounds: { cleanupMs: 500 },
    }).then(() => null, (error: unknown) => error);

    expect(failure).toBeInstanceOf(RaceScheduleError);
    const { cleanup, message } = failure as RaceScheduleError;
    expect(message).toContain("the competing operation finished without waiting");
    // CLEANUP CAME FIRST, and took a cancel — of the raced operation's own backend, and no other.
    expect(cleanup.outcome).toBe("cancelled");
    expect(cleanup.barrierGone).toBe(true);
    const parked = cleanup.operations.find((operation) => operation.label === "the parked operation")!;
    expect(parked.settled).toBe(true);
    expect(cleanup.signalled).toHaveLength(1);
    expect(parked.backends).toContain(cleanup.signalled[0]);
    for (const outsider of [holder.pid, behindHolder.pid, behindBarrier.pid, barrier.pid]) {
      expect(cleanup.signalled, "a foreign backend must never be signalled").not.toContain(outsider);
    }
    // By the time the failure is reported, the raced operation's backends are idle: no statement,
    // no transaction, no lock, no wait.
    for (const session of await sessionEvidence(parked.backends)) {
      expect(session).toEqual({ pid: session.pid, state: "idle", waitingOn: null, locksHeld: 0 });
    }
    // THE FOREIGN SESSIONS ARE AS THEY WERE. The holder still holds its lock in its transaction…
    const [holding] = await sessionEvidence([holder.pid]);
    expect(holding).toMatchObject({ state: "idle in transaction", waitingOn: null });
    expect(holding.locksHeld).toBeGreaterThanOrEqual(1);
    // …the waiter behind it is STILL WAITING — it was in the same database, waiting on a lock, at
    // the moment the harness cancelled, and it was not cancelled…
    const stillWaiting = await sessionEvidence([behindHolder.pid]);
    expect(stillWaiting).toHaveLength(1);
    expect(stillWaiting[0]).toMatchObject({ pid: behindHolder.pid, state: "active", waitingOn: "relation" });
    expect(stuck.state()).toBe("pending");
    // …and the one behind the harness's barrier simply completed when the barrier was released.
    expect((await passing.promise).rows).toEqual([{ n: expect.any(Number) }]);

    // Released by ITS owner, the foreign waiter completes.
    await holder.client.query("rollback");
    expect((await stuck.promise).rows).toEqual([{ n: expect.any(Number) }]);
    expect(stuck.state()).toBe("resolved");
    // The cancelled writer wrote nothing; cleanup was proven, so the marker is gone and the run goes on.
    expect(await slackIds(seed, alice)).not.toContain(fresh);
    expect(currentRunSafety().armed()).toEqual([]);
    expect(raceHarnessFatal()).toBeNull();
  }, RACE_TEST_TIMEOUT_MS);
});

describe("race harness (3): a failed schedule is cleaned up before it is reported, and an unproven cleanup stops the run (real Postgres)", () => {
  it("a schedule that fails after an operation began a real transaction: the failure is reported only once that operation has finished, its backend is idle and the barrier is gone", async () => {
    const { seed, alice, target } = await aliceHolds();
    const fresh = `harness-${randomUUID().slice(0, 8)}`;
    const barrier = await holdTable("member_identity_mapping_state");

    const failure = await parkThenCompete({
      seed,
      barrier,
      parksOn: "relation",
      // A real transaction: inside the team's identity boundary, parked on the barrier.
      first: () => linkFresh(seed, alice, fresh),
      second: async () => "finished without waiting",
    }).then(() => null, (error: unknown) => error);

    expect(failure).toBeInstanceOf(RaceScheduleError);
    const { cleanup, message } = failure as RaceScheduleError;
    expect(message).toContain("the competing operation finished without waiting");
    // Nothing needed signalling: with its barrier gone the parked operation finished by itself.
    expect(cleanup.outcome).toBe("quiet");
    expect(cleanup.barrierGone).toBe(true);
    expect(cleanup.signalled).toEqual([]);
    const parked = cleanup.operations.find((operation) => operation.label === "the parked operation")!;
    expect(parked.settled).toBe(true);
    // It really had checked out a backend and begun — and that backend is idle NOW, as the failure
    // is being reported: no statement, no transaction, no lock.
    expect(parked.backends.length).toBeGreaterThanOrEqual(1);
    const sessions = await sessionEvidence(parked.backends);
    expect(sessions.length).toBe(parked.backends.length);
    for (const session of sessions) {
      expect(session).toEqual({ pid: session.pid, state: "idle", waitingOn: null, locksHeld: 0 });
    }
    // The barrier's tagged session is gone, the scope's marker with it; and the parked writer,
    // released, committed what it was doing.
    expect(await barrierSessions(barrier.tag)).toEqual([]);
    expect(currentRunSafety().armed()).toEqual([]);
    expect(await slackIds(seed, alice)).toEqual([fresh, target].sort());
    expect(raceHarnessFatal()).toBeNull();
  }, RACE_TEST_TIMEOUT_MS);

  it("an UNPROVEN cleanup stops the run — sticky, shared by every reader of the same state — and leaves the scope's marker on file", async () => {
    // A run-safety state of this test's own, so the REAL run is not stopped by testing what stops it.
    const { directory, safety } = privateRun();
    expect(safety.blocked()).toBeNull();
    expect(() => assertRunSafe(safety)).not.toThrow();

    // An operation that never settles and never checks out a connection: nothing the harness
    // could signal, and nothing it can prove. (It holds no database resource at all.)
    const teamId = randomUUID();
    const barrier = await holdIdentityKey(teamId, "slack", "unproven-self-test", { safety });
    const failure = await parkThenCompete({
      seed: { teamId },
      barrier,
      parksOn: "advisory",
      first: () => new Promise<never>(() => undefined),
      second: async () => "never started",
      bounds: { pollMs: 200, cleanupMs: 200 },
    }).then(() => null, (error: unknown) => error);

    expect(failure).toBeInstanceOf(RaceScheduleError);
    const { cleanup } = failure as RaceScheduleError;
    expect(cleanup.outcome).toBe("unproven");
    expect(cleanup.barrierGone, "the barrier itself WAS seen gone — it is the operation that is unproven").toBe(true);
    expect(cleanup.signalled, "with no backend of its own to signal, the harness signals nobody").toEqual([]);
    expect(cleanup.operations).toEqual([{ label: "the parked operation", backends: [], settled: false }]);
    expect(await barrierSessions(barrier.tag)).toEqual([]);

    // THE RUN IS STOPPED, and the scope is still on file: the guard the setup file runs refuses.
    const reason = safety.fatal();
    expect(reason).toMatch(/could not be proven settled, idle or disposed/);
    expect(safety.armed()).toEqual([barrier.tag]);
    expect(() => assertRunSafe(safety)).toThrow(/run STOPPED — refusing to truncate or run another test/);
    // STICKY: a later reason does not replace the first…
    expect(safety.setFatal("a later, different reason")).toBe(reason);
    expect(safety.fatal()).toBe(reason);
    // …a later release of that barrier does not clear what the schedule concluded…
    await barrier.release();
    expect(safety.armed()).toEqual([barrier.tag]);
    // …and SHARED: another reader of the same state — as the next test file's worker is — sees it.
    const elsewhere = createRunSafety(directory);
    expect(elsewhere.fatal()).toBe(reason);
    expect(() => assertRunSafe(elsewhere)).toThrow(/run STOPPED/);
    // The real run was not stopped by this test.
    expect(raceHarnessFatal()).toBeNull();
    expect(currentRunSafety().blocked()).toBeNull();
  }, RACE_TEST_TIMEOUT_MS);
});

describe("race harness (4): the run-safety state — in-flight scopes, sticky fatal, fail closed, one run one directory (real Postgres)", () => {
  it("an IN-FLIGHT scope blocks truncation and the next file — also when its test never came back to clean up — and its own proven cleanup clears ONLY its own marker", async () => {
    const { directory, safety } = privateRun();
    // Another scope, and a fatal reason, already on file: neither is this barrier's to clear.
    safety.arm("another-scope", "someone else's sessions");
    const tag = `scope-${randomUUID().slice(0, 8)}`;
    const barrier = await holdNamedLock(`harness-scope:${randomUUID()}`, { tag, safety });
    let released = false;
    try {
      // The barrier holds a session and the harness has not been back — exactly the state a test
      // that timed out, or was interrupted, leaves behind. The marker was written BEFORE it
      // connected, so it is there whatever became of the test.
      expect(safety.armed()).toEqual(["another-scope", tag].sort());
      expect(() => assertRunSafe(safety)).toThrow(/2 harness scope\(s\) still in flight/);
      // The next file's worker reads the same directory, and is refused too.
      expect(() => assertRunSafe(createRunSafety(directory))).toThrow(/still in flight/);

      const stopped = safety.setFatal("the run was stopped for another reason");
      await barrier.release();
      released = true;

      // ITS OWN marker is gone — its session was seen gone. The other scope and the fatal reason
      // are exactly as they were.
      expect(await barrierSessions(tag)).toEqual([]);
      expect(safety.armed()).toEqual(["another-scope"]);
      expect(safety.fatal()).toBe(stopped);
      expect(() => assertRunSafe(safety)).toThrow(/the run was stopped for another reason/);
      // Any other reader of the directory sees the same: the other scope still on file, the run still stopped.
      expect(createRunSafety(directory).armed()).toEqual(["another-scope"]);
      expect(createRunSafety(directory).blocked()).toBe(stopped);
    } finally {
      if (!released) await barrier.release().catch(() => undefined);
    }
  }, RACE_TEST_TIMEOUT_MS);

  it("FAIL CLOSED: state that cannot be read is not clean, and a marker that cannot be written prevents the database work", async () => {
    const { root, directory, safety } = privateRun();
    expect(safety.blocked()).toBeNull();

    // CORRUPT fatal state: a fatal file that does not say why is still a fatal file.
    writeFileSync(join(directory, "fatal.json"), "{ not json");
    expect(createRunSafety(directory).fatal()).toMatch(/unreadable \(corrupt fatal\.json\)/);
    expect(() => assertRunSafe(createRunSafety(directory))).toThrow(/run STOPPED/);
    rmSync(join(directory, "fatal.json"));
    expect(createRunSafety(directory).blocked()).toBeNull();
    // A CORRUPT marker is still a marker.
    writeFileSync(join(directory, "scope-garbled.json"), "\u0000\u0001 not json");
    expect(createRunSafety(directory).armed()).toEqual(["garbled"]);
    expect(() => assertRunSafe(createRunSafety(directory))).toThrow(/still in flight/);

    // A run directory that is NOT THERE (never initialized, or removed) is unreadable, not clean…
    const missing = createRunSafety(join(root, "no-such-database", randomUUID()));
    expect(missing.blocked()).toMatch(/could not be read/);
    expect(() => assertRunSafe(missing)).toThrow(/run STOPPED/);
    // …and so is one that is not a directory at all.
    const notADirectory = join(root, "a-file");
    writeFileSync(notADirectory, "x");
    expect(createRunSafety(notADirectory).blocked()).not.toBeNull();

    // A MARKER THAT CANNOT BE WRITTEN: the barrier refuses before it connects. No session under its
    // tag ever exists, and nothing is left to clean up.
    const tag = `unrecorded-${randomUUID().slice(0, 8)}`;
    const failure = await holdNamedLock(`harness-unrecorded:${randomUUID()}`, { tag, safety: missing })
      .then(() => null, (error: unknown) => error);
    expect(failure).toBeInstanceOf(RunSafetyError);
    expect((failure as Error).message).toMatch(/could not be recorded — no database work may start/);
    expect(await barrierSessions(tag)).toEqual([]);
    // An unusable run id is refused rather than guessed at.
    expect(() => runDirectoryFor("", "postgres://x")).toThrow(RunSafetyError);
    expect(() => runDirectoryFor("../escape", "postgres://x")).toThrow(RunSafetyError);
  }, RACE_TEST_TIMEOUT_MS);

  it("ONE RUN, ONE DIRECTORY: a fresh run inherits nothing from another run's files — not its fatal reason, not its markers — and never removes them", () => {
    const database = "postgres://same-database";
    // An EARLIER run against the same database, left stopped and with a scope in flight.
    const earlier = privateRun(undefined, database);
    earlier.safety.arm("left-in-flight", "an interrupted test");
    earlier.safety.setFatal("the earlier run was stopped");
    expect(earlier.safety.blocked()).toBe("the earlier run was stopped");

    // A FRESH run: a new id, the same root, the same database.
    const fresh = privateRun(earlier.root, database);
    expect(fresh.runId).not.toBe(earlier.runId);
    expect(fresh.directory).not.toBe(earlier.directory);
    expect(fresh.safety.blocked(), "a fresh run is clean whatever another run left").toBeNull();
    expect(() => assertRunSafe(fresh.safety)).not.toThrow();
    // The same run id against ANOTHER database is another directory too.
    expect(runDirectoryFor(fresh.runId, "postgres://other-database", earlier.root)).not.toBe(fresh.directory);

    // Everything the fresh run does stays in its own directory…
    fresh.safety.arm("its-own-scope", "its own sessions");
    fresh.safety.disarm("its-own-scope");
    fresh.safety.disarm("left-in-flight");
    expect(fresh.safety.blocked()).toBeNull();
    // …the earlier run's files are exactly as it left them…
    expect(createRunSafety(earlier.directory).armed()).toEqual(["left-in-flight"]);
    expect(createRunSafety(earlier.directory).fatal()).toBe("the earlier run was stopped");
    // …and the end-of-run removal takes a run's OWN directory, and only when it is clean.
    expect(removeRunDirectoryIfClean(fresh.directory)).toBe(true);
    expect(existsSync(fresh.directory)).toBe(false);
    expect(removeRunDirectoryIfClean(earlier.directory)).toBe(false);
    expect(existsSync(join(earlier.directory, "fatal.json"))).toBe(true);
    expect(existsSync(join(earlier.directory, "scope-left-in-flight.json"))).toBe(true);
  });

  it("THIS run has an id of its own, minted before any worker, and its state was checked before this file was loaded and is checked again before every truncation", () => {
    // THE RUN ID: set by the global setup in the main process, inherited here, and naming a
    // directory that the main process created — keyed by the run and the database, not by a pid.
    const runId = process.env[RUN_ID_ENV];
    expect(runId, "the global setup must have minted this run's id").toMatch(/^[0-9a-f-]{36}$/);
    const run = currentRunSafety();
    expect(run.directory).toBe(runDirectoryFor(runId!, process.env.DATABASE_URL ?? ""));
    expect(run.directory.endsWith(runId!), "the directory is named by the run id").toBe(true);
    expect(JSON.parse(readFileSync(join(run.directory, "owner.json"), "utf8"))).toMatchObject({ runId });
    expect(run.blocked()).toBeNull();

    // MODULE SCOPE: the setup file's check had already passed when this test module was loaded —
    // so a stopped run fails a file before any of it, or any `beforeAll`, can run.
    expect(setupModuleChecksAtLoad).toBeGreaterThanOrEqual(1);
    const setup = readFileSync(join(import.meta.dirname, "setup.ts"), "utf8");
    const moduleCheck = setup.indexOf("\nassertRunSafe();");
    expect(moduleCheck, "the setup file must check the run-safety state at module scope").toBeGreaterThan(-1);
    for (const later of ["new Client(", "beforeEach(async () => {", "afterAll("]) {
      expect(setup.indexOf(later), `${later} must exist in the setup file`).toBeGreaterThan(-1);
      expect(moduleCheck, `the module-scope check must precede ${later}`).toBeLessThan(setup.indexOf(later));
    }

    // AGAIN BEFORE EVERY TRUNCATE: inside the global `beforeEach`, the check, then everything else.
    const hook = setup.slice(setup.indexOf("beforeEach(async () => {"));
    const guard = hook.indexOf("assertRunSafe();");
    expect(guard, "the global hook must check the run-safety state").toBeGreaterThan(-1);
    for (const later of ["noteTruncationHook();", "await ensureConnected();", "TRUNCATE"]) {
      expect(hook.indexOf(later), `${later} must exist in the global hook`).toBeGreaterThan(-1);
      expect(guard, `the check must precede ${later}`).toBeLessThan(hook.indexOf(later));
    }
    // One `beforeEach` in the setup file, one TRUNCATE: there is no earlier hook that truncates.
    expect(setup.match(/\bbeforeEach\(/g)).toHaveLength(1);
    expect(setup.match(/TRUNCATE/g)).toHaveLength(1);

    // HOOK ORDER, observed: every time this file's own `beforeEach` has run, the global hook had
    // ALREADY run for that same test (it counts itself just after its check). Had the file's hook
    // come first, the global count would be one behind. So a check made only in a test file's
    // `beforeEach` comes after the truncation; the one in the global hook does not.
    expect(hookOrder.length).toBeGreaterThanOrEqual(1);
    for (const observed of hookOrder) {
      expect(observed.truncationHooks, "global truncation hook runs before this file's hooks").toBe(observed.fileHooks);
    }
  });
});
