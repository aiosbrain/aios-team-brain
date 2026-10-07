import { randomUUID } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
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
  holdTable,
  parkThenCompete,
  raceHarnessFatal,
  sessionEvidence,
  untilBarrierGone,
  untilSessions,
} from "./identity-race-harness";
import { assertRunNotFatal, createRunLatch, runLatch, truncationHookRuns } from "./run-fatal-latch";

/**
 * THE RACE HARNESS, tested as itself (AIO-1167), against real PostgreSQL.
 *
 * The identity suites rest their concurrency claims on `./identity-race-harness`. A harness that
 * leaks a barrier, mistakes another session for its own, or lets a failed schedule's transaction
 * live into the next test's `TRUNCATE` makes those claims — and every later test — unsound. So:
 *
 *   1. a barrier whose lock acquisition FAILS — after it connected and began — leaves no session
 *      and no lock; and a released barrier is gone, however often it is released;
 *   2. a FOREIGN session of the same database is never the harness's: waiting behind the same
 *      barrier, or behind the parked operation itself, it is not counted as evidence; and when
 *      cleanup has to cancel a raced operation, only that operation's own backend is signalled —
 *      the foreign sessions keep their locks and their waits, and complete once released;
 *   3. a schedule that FAILS after an operation has started a real transaction is reported only
 *      after that operation's backend is idle; and a cleanup that cannot be proven stops the RUN
 *      through the latch the tier's global `beforeEach` reads BEFORE it truncates — a hook that
 *      runs before this file's own hooks, which is asserted here rather than assumed.
 *
 * Everything is established from PostgreSQL evidence about exact, known backends. The "foreign"
 * sessions are plain clients this file opens and never registers with the harness.
 */

// ── Hook-order evidence: taken by this file's own `beforeEach`, checked in (3) ─────────────────
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

afterEach(async () => {
  // Ending a client whose query is still waiting drops its connection; the server then abandons it.
  for (const client of foreignClients.splice(0)) await client.end().catch(() => undefined);
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

describe("race harness (1): a barrier that fails to acquire, or is released, leaves nothing behind (real Postgres)", () => {
  it("a lock statement that FAILS after connect + BEGIN: the error is rethrown, and the barrier's session is gone — no transaction, no lock", async () => {
    const tag = `failing-${randomUUID().slice(0, 8)}`;

    const failure = await holdLock("lock table identity_race_no_such_table in access exclusive mode", [], { tag })
      .then(() => null, (error: unknown) => error);

    // The failing statement is the lock itself — issued only after the connection began its
    // transaction — and it is PostgreSQL's own error that comes back, not a harness one.
    expect(failure).toBeInstanceOf(Error);
    expect((failure as { code?: string }).code).toBe("42P01");
    // The session that connected and began is gone, and with it everything it could have held.
    await untilBarrierGone(tag);
    expect(await barrierSessions(tag)).toEqual([]);
  }, RACE_TEST_TIMEOUT_MS);

  it("a lock that is NOT FREE: the second barrier is refused by PostgreSQL's lock timeout, leaves no session and no queued request, and the first barrier is untouched", async () => {
    const held = `held-${randomUUID().slice(0, 8)}`;
    const refused = `refused-${randomUUID().slice(0, 8)}`;
    const first = await holdTable("member_identities", { tag: held });
    try {
      const failure = await holdTable("member_identities", { tag: refused, lockTimeoutMs: 250 })
        .then(() => null, (error: unknown) => error);

      expect(failure).toBeInstanceOf(Error);
      expect((failure as { code?: string }).code, "PostgreSQL's lock_not_available").toBe("55P03");
      await untilBarrierGone(refused);
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
    await untilBarrierGone(held);
    expect(await barrierSessions(held)).toEqual([]);
  }, RACE_TEST_TIMEOUT_MS);
});

describe("race harness (2): a foreign session of the same database is never the harness's (real Postgres)", () => {
  it("foreign waiters behind the SAME barrier and behind the PARKED operation are not evidence, are not signalled, and complete once released", async () => {
    const { seed, alice, bob, target } = await aliceHolds();
    const barrier = await holdTable("member_identity_mapping_state");
    // FOREIGN #1 waits behind the harness's own barrier — exactly where the parked operation will.
    // "Blocked behind my barrier" is true of it, and it is not the harness's.
    const behindBarrier = await foreign("behind-barrier");
    const read = inFlight(behindBarrier.client.query("select count(*)::int as n from member_identity_mapping_state"));
    await untilSessions([behindBarrier.pid], "the foreign read waiting on the table barrier", waitsOn("relation", 1));

    const behindParked = await foreign("behind-parked");
    let queued: InFlight<unknown> | undefined;
    let raced: { parked: number; competing: number } | undefined;
    const { first: listing, second: remapped } = await parkThenCompete({
      seed,
      barrier,
      parksOn: "relation",
      first: () => listMemberIdentities(db(), seed.teamId),
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
    expect((listing.get(alice)?.providers ?? []).map((identity) => [identity.externalId, identity.revision])).toEqual([[target, 1]]);
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
    expect(raceHarnessFatal()).toBeNull();
  }, RACE_TEST_TIMEOUT_MS);

  it("when cleanup must CANCEL a raced operation, only that operation's own backend is signalled: a foreign lock holder and foreign waiters in the same database keep their locks and their waits", async () => {
    const { seed } = await aliceHolds();
    const barrier = await holdTable("member_identities");
    // A FOREIGN session holds the table the raced operation needs NEXT — not a harness barrier, and
    // not released by the harness: once its own barrier is gone, the raced operation runs into it.
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
    // ever waiting. Cleanup then releases the barrier; the parked listing — a real transaction,
    // holding the team authority — runs on into the foreign holder's lock and cannot finish.
    const failure = await parkThenCompete({
      seed,
      barrier,
      parksOn: "relation",
      first: () => listMemberIdentities(db(), seed.teamId),
      second: async () => "finished without waiting",
      bounds: { cleanupMs: 500 },
    }).then(() => null, (error: unknown) => error);

    expect(failure).toBeInstanceOf(RaceScheduleError);
    const { cleanup, message } = failure as RaceScheduleError;
    expect(message).toContain("the competing operation finished without waiting");
    // CLEANUP CAME FIRST, and took a cancel — of the raced operation's own backend, and no other.
    expect(cleanup.outcome).toBe("cancelled");
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
    // Cleanup was proven, so the run goes on.
    expect(raceHarnessFatal()).toBeNull();
  }, RACE_TEST_TIMEOUT_MS);
});

describe("race harness (3): a failed schedule is cleaned up before it is reported, and an unproven cleanup stops the run before any later TRUNCATE (real Postgres)", () => {
  it("a schedule that fails after an operation began a real transaction: the failure is reported only once that operation has finished and its backend is idle", async () => {
    const { seed, alice, target } = await aliceHolds();

    const failure = await parkThenCompete({
      seed,
      barrier: await holdTable("member_identity_mapping_state"),
      parksOn: "relation",
      // A real transaction: inside the team's identity boundary, parked on the barrier.
      first: () => listMemberIdentities(db(), seed.teamId),
      second: async () => "finished without waiting",
    }).then(() => null, (error: unknown) => error);

    expect(failure).toBeInstanceOf(RaceScheduleError);
    const { cleanup, message } = failure as RaceScheduleError;
    expect(message).toContain("the competing operation finished without waiting");
    // Nothing needed signalling: with its barrier gone the parked operation finished by itself.
    expect(cleanup.outcome).toBe("quiet");
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
    // The barrier is gone too, and the data the operation only read is as it was.
    expect((await listMemberIdentities(db(), seed.teamId)).get(alice)?.providers.map((identity) => identity.externalId)).toEqual([target]);
    expect(raceHarnessFatal()).toBeNull();
  }, RACE_TEST_TIMEOUT_MS);

  it("an UNPROVEN cleanup sets the fatal latch — sticky, shared by every reader of the same latch — and the truncation guard then refuses", async () => {
    // A latch of this test's own, so the REAL run is not stopped by testing what stops it.
    const file = join(tmpdir(), `aios-datamechanics-latch-self-test-${randomUUID()}.json`);
    const latch = createRunLatch(file);
    try {
      expect(latch.read()).toBeNull();
      expect(() => assertRunNotFatal(latch)).not.toThrow();

      // An operation that never settles and never checks out a connection: nothing the harness
      // could signal, and nothing it can prove. (It holds no database resource at all.)
      const teamId = randomUUID();
      const failure = await parkThenCompete({
        seed: { teamId },
        barrier: await holdIdentityKey(teamId, "slack", "latch-self-test"),
        parksOn: "advisory",
        first: () => new Promise<never>(() => undefined),
        second: async () => "never started",
        bounds: { pollMs: 200, cleanupMs: 200 },
        latch,
      }).then(() => null, (error: unknown) => error);

      expect(failure).toBeInstanceOf(RaceScheduleError);
      const { cleanup } = failure as RaceScheduleError;
      expect(cleanup.outcome).toBe("unproven");
      expect(cleanup.signalled, "with no backend of its own to signal, the harness signals nobody").toEqual([]);
      expect(cleanup.operations).toEqual([{ label: "the parked operation", backends: [], settled: false }]);

      // THE LATCH IS SET, and the guard the global `beforeEach` runs first now refuses.
      const reason = latch.read();
      expect(reason).toMatch(/could not be proven settled, idle or disposed/);
      expect(() => assertRunNotFatal(latch)).toThrow(/run STOPPED — refusing to truncate or run another test/);
      // STICKY: a later reason does not replace the first…
      expect(latch.set("a later, different reason")).toBe(reason);
      expect(latch.read()).toBe(reason);
      // …and SHARED: another reader of the same latch — as the next test file's worker is — sees it.
      const elsewhere = createRunLatch(file);
      expect(elsewhere.read()).toBe(reason);
      expect(() => assertRunNotFatal(elsewhere)).toThrow(/run STOPPED/);
      // A different run's latch is a different latch.
      expect(createRunLatch(`${file}.other-run`).read()).toBeNull();
      // The real run was not stopped by this test.
      expect(runLatch.read()).toBeNull();
      expect(raceHarnessFatal()).toBeNull();
    } finally {
      rmSync(file, { force: true });
    }
  }, RACE_TEST_TIMEOUT_MS);

  it("the truncation guard is EARLIER than cleanup: the global hook checks the latch before it connects or truncates, and it runs before this file's own hooks", () => {
    // SOURCE ORDER inside the tier's global `beforeEach`: the fatal check, then everything else.
    const setup = readFileSync(join(import.meta.dirname, "setup.ts"), "utf8");
    const hook = setup.slice(setup.indexOf("beforeEach(async () => {"));
    const guard = hook.indexOf("assertRunNotFatal();");
    expect(guard, "the global hook must check the run-fatal latch").toBeGreaterThan(-1);
    for (const later of ["noteTruncationHook();", "await ensureConnected();", "TRUNCATE"]) {
      expect(hook.indexOf(later), `${later} must exist in the global hook`).toBeGreaterThan(-1);
      expect(guard, `the latch check must precede ${later}`).toBeLessThan(hook.indexOf(later));
    }
    // One `beforeEach` in the setup file: there is no earlier hook that truncates.
    expect(setup.match(/\bbeforeEach\(/g)).toHaveLength(1);
    expect(setup.match(/TRUNCATE/g)).toHaveLength(1);

    // HOOK ORDER, observed: every time this file's own `beforeEach` has run, the global hook had
    // ALREADY run for that same test (it counts itself just after its latch check). Had the file's
    // hook come first, the global count would be one behind. So a latch checked only in a test
    // file's `beforeEach` is checked after the truncation; the one in the global hook is not.
    expect(hookOrder.length).toBeGreaterThanOrEqual(1);
    for (const observed of hookOrder) {
      expect(observed.truncationHooks, "global truncation hook runs before this file's hooks").toBe(observed.fileHooks);
    }
  });
});
