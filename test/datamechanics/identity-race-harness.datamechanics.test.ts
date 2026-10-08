import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client, PoolClient } from "pg";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getPool } from "@/lib/db/pg/pool";
import { listMemberIdentities } from "@/lib/identity/list";
import { setMemberIdentity } from "@/lib/identity/member-identities";
import { db, seedTeam, type Seed } from "./helpers";
import {
  RACE_TEST_TIMEOUT_MS,
  RaceHarnessError,
  RaceScheduleError,
  type AcquisitionWitness,
  type Barrier,
  type Disposal,
  type EvidenceClock,
  type PendingSignal,
  type RetireOptions,
  type SessionEvidence,
  type SignalAcknowledgement,
  type TestSession,
  authorityLockName,
  backendIdentity,
  barrierSessions,
  closeRaceHarness,
  holdIdentityKey,
  holdLock,
  holdNamedLock,
  holdTable,
  openTestSession,
  parkThenCompete,
  raceHarnessFatal,
  retireSessions,
  sessionEvidence,
  sessionsNamed,
  settleStarted,
  untilBarrierGone,
  untilEvidence,
  untilSessions,
  withinBound,
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
 *      the foreign sessions keep their locks and their waits, and complete once released; and a
 *      backend a signal is aimed at stays the raced operation's until the signal has been executed
 *      — the pool cannot lend it to anyone else in between, even once the operation has let it go;
 *      and a release the pool THREW out of — an ordinary one included — is not a return: cleanup
 *      is `unproven`, the marker stays and the run is stopped;
 *   3. a schedule that FAILS after an operation has started a real transaction is reported only
 *      after that operation's backend is idle; a cleanup that cannot be proven stops the run;
 *   4. the run-safety state: an in-flight scope blocks truncation and the next file; a scope's own
 *      cleanup clears only its own marker; unreadable state is not clean; a marker that cannot be
 *      written prevents the database work; a fresh run inherits nothing from another run's files;
 *      and the tier's setup file checks all of it at module scope and again before it truncates —
 *      ahead of this file's own hooks, which is asserted here rather than assumed;
 *   5. an evidence wait ENDS AT ITS DEADLINE: evidence read at or after it is not accepted, however
 *      much it is what was expected; a read still pending then fails the wait without another being
 *      started; and what that read comes back with later changes nothing — so a barrier whose
 *      absence could only be read after its cleanup budget stays `unproven`, its run stopped and its
 *      marker on file. The deadline is staged on a clock moved by hand, never waited for. And the
 *      REAL clock is monotonic: moving the wall clock neither extends a deadline nor cuts it short;
 *   6. EVERY bounded step ends at its deadline the same way — not only evidence waits: an operation
 *      that settles at or after its round's deadline, ahead of a timer that is overdue, has not met
 *      it, whichever way it settled, and nothing it does later reopens that round;
 *   7. what was NOT ACKNOWLEDGED IN TIME is not proven later: a barrier whose closing is still
 *      pending at its deadline, fails, answers late or does not say, and a signal PostgreSQL did not
 *      acknowledge in time, each leave cleanup `unproven` for good — the marker on file, the run
 *      stopped, the signalled connection never handed back — whatever is read or answered afterwards;
 *      and a signal is acknowledged by PostgreSQL's own answer to the real send, for exactly the
 *      backends it was aimed at, and by nothing else that resolves in its place;
 *   8. this file's OWN foreign sessions are scopes of the real run: a marker before each connects,
 *      removed only once its closing was acknowledged and that exact backend seen gone;
 *   9. a pool connection a STAGED test checks out itself is on the real run's sentinel from before
 *      it is asked who it is: one whose answer is still pending, or was refused, leaves its test no
 *      backend to look for — so the sentinel is then not cleared at all, until that connection has
 *      said who it is, the monitor has seen that backend, and it was then SEEN gone within its bound;
 *  10. a REAL session a staged test closes itself — a barrier whose release it staged, a lock holder
 *      whose closing it stood in front of — is closed by one bounded, acknowledged step and then
 *      seen gone as its exact backend before the real run's sentinel comes off. A closing that
 *      rejects, is still pending at its deadline, does not say `closed` or says so late, and a
 *      backend not seen gone, each leave that sentinel on file and stop the real run — sticky;
 *  11. such a session is on that sentinel from BEFORE its acquisition: reserved first, and put on
 *      the books by the acquisition itself as far as it gets — also one that fails and hands its
 *      test nothing. Attempted and never identified, it is not cleared around: the sentinel stays
 *      and the run is stopped. One that never attempted a connection opened nothing, and a cleanup
 *      with nothing to see gone is not refused for being empty. And what else a cleanup is to see
 *      absent is bounded like every other step: pending at its deadline, late or rejected, it is
 *      not seen — the cleanup ends there, the sentinel on file and the run stopped.
 *
 * Everything is established from PostgreSQL evidence about exact, known backends. The "foreign"
 * sessions are plain clients this file opens and never registers with the harness as raced
 * operations. Wherever a test stages an unsafe outcome it does so in a run-safety state of ITS OWN,
 * and removes what it staged before it ends: the real run is never stopped by testing what stops it.
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

// ── Foreign sessions: this file's own clients, NOT registered with the harness as raced ────────
// They are never read for lock-wait evidence and never signalled. They ARE scopes of the real run
// (`openTestSession`): each has its in-flight marker on file before it connects, and keeps it until
// it has been closed and that exact backend SEEN gone — which the `afterEach` below does, and which
// stops the run if it cannot be done. Asserted in (8).
type Foreign = TestSession;
const foreignSessions: Foreign[] = [];

async function foreign(name: string): Promise<Foreign> {
  // A name of its own each time: the scope's marker is this session's, and no other's.
  const session = await openTestSession(`${name}-${randomUUID().slice(0, 8)}`);
  foreignSessions.push(session);
  return session;
}

/** The scopes the real run has on file for the foreign sessions this test opened — as `armed()` lists them. */
const foreignScopes = (): string[] => foreignSessions.map((session) => session.scope).sort();

interface InFlight<T> { promise: Promise<T>; state: () => "pending" | "resolved" | "rejected" }

/** A query left in flight, with what became of it readable at any moment. */
function inFlight<T>(work: Promise<T>): InFlight<T> {
  let state: "pending" | "resolved" | "rejected" = "pending";
  work.then(() => { state = "resolved"; }, () => { state = "rejected"; });
  return { promise: work, state: () => state };
}

/** A gate a test opens by hand: nothing but `open()` lets what waits on `opened` go on. */
function gate(): { opened: Promise<void>; open: () => void } {
  let open: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => { open = resolve; });
  return { opened, open };
}

interface Controlled<T> { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void }

/** A promise a test settles by hand, either way, and only by hand: an operation, an acknowledgement. */
function controlled<T>(): Controlled<T> {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((settle, fail) => { resolve = settle; reject = fail; });
  return { promise, resolve, reject };
}

/**
 * Every unhandled rejection from here until `stop()`. A late outcome the harness had dropped without
 * observing it would be one — so "nothing came of it" is asserted of this list too.
 */
function watchUnhandled(): { seen: unknown[]; stop: () => void } {
  const seen: unknown[] = [];
  const note = (reason: unknown): void => { seen.push(reason); };
  process.on("unhandledRejection", note);
  return { seen, stop: () => { process.removeListener("unhandledRejection", note); } };
}

// ── A clock, and reads, that a test moves by hand ──────────────────────────────────────────────

/** Counts things as they happen, and lets a test wait for the Nth of them — an event, never a time. */
function tally(): { note: () => void; count: () => number; reached: (target: number) => Promise<void> } {
  let count = 0;
  let waiting: { target: number; resolve: () => void }[] = [];
  return {
    note: () => {
      count += 1;
      const ready = waiting.filter((waiter) => waiter.target <= count);
      waiting = waiting.filter((waiter) => waiter.target > count);
      for (const waiter of ready) waiter.resolve();
    },
    count: () => count,
    reached: (target) => (count >= target
      ? Promise.resolve()
      : new Promise<void>((resolve) => { waiting = [...waiting, { target, resolve }]; })),
  };
}

interface HandClock {
  clock: EvidenceClock;
  /** Move the time and fire NOTHING: the clock now reads later than any timer has been run for —
   * what a busy event loop does when a result is delivered ahead of a timer that is already due. */
  drift: (ms: number) => void;
  /** Move the time and fire every timer then due, in the order they were set. */
  tick: (ms: number) => void;
  /** The delay of every timer ever set, in order. */
  delays: () => number[];
  /** How many timers are still set: neither fired nor called off. */
  outstanding: () => number;
  /** Resolves once `count` timers have been set in all. */
  set: (count: number) => Promise<void>;
}

/** A clock a test moves by hand: time passes only when the test says so, and no timer fires by itself. */
function handClock(): HandClock {
  let now = 1_000_000;
  let timers: { at: number; fire: () => void }[] = [];
  let delays: number[] = [];
  const set = tally();
  return {
    clock: {
      now: () => now,
      after: (ms, fire) => {
        const timer = { at: now + ms, fire };
        timers = [...timers, timer];
        delays = [...delays, ms];
        set.note();
        return () => { timers = timers.filter((other) => other !== timer); };
      },
    },
    drift: (ms) => { now += ms; },
    tick: (ms) => {
      now += ms;
      const due = timers.filter((timer) => timer.at <= now);
      timers = timers.filter((timer) => timer.at > now);
      for (const timer of due) timer.fire();
    },
    delays: () => [...delays],
    outstanding: () => timers.length,
    set: set.reached,
  };
}

interface HeldReads<T> {
  read: () => Promise<T>;
  /** How many reads have been asked for. */
  count: () => number;
  /** Resolves once `count` reads have been asked for in all. */
  asked: (count: number) => Promise<void>;
  answer: (index: number, value: T) => void;
  fail: (index: number, error: unknown) => void;
}

/** Reads a test answers by hand: each one is counted, and stays pending until the test settles it. */
function heldReads<T>(): HeldReads<T> {
  let calls: { resolve: (value: T) => void; reject: (error: unknown) => void }[] = [];
  const asked = tally();
  return {
    read: () => new Promise<T>((resolve, reject) => {
      calls = [...calls, { resolve, reject }];
      asked.note();
    }),
    count: asked.count,
    asked: asked.reached,
    answer: (index, value) => calls[index].resolve(value),
    fail: (index, error) => calls[index].reject(error),
  };
}

/**
 * One turn of the event loop: every promise reaction queued so far, and all they queue in turn, has
 * run. An ORDERING, not a wait — no time has to pass for it. It is what lets a test say "nothing came
 * of that" of a promise it has just settled, and see a wait that failed to end as `pending` at once
 * rather than by timing out on it.
 */
const turn = () => new Promise<void>((resolve) => { setImmediate(resolve); });

/** One backend, exactly — its pid and when it started — as the session itself reports it. */
interface BackendIdentity { pid: number; started: string }
const WHO_AM_I = `select pg_backend_pid() as pid,
  (select extract(epoch from backend_start)::text from pg_stat_activity where pid = pg_backend_pid()) as started`;
const whoIs = async (client: PoolClient): Promise<BackendIdentity> =>
  (await client.query<BackendIdentity>(WHO_AM_I)).rows[0];

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

/** What a sentinel knows of one pool checkout its test made: who it SAID it is, and whether that backend was then SEEN. */
interface StagedCheckout { identity: BackendIdentity | null; proven: boolean }

interface Sentinel {
  /** The name of its marker in the real run's safety state. */
  scope: string;
  /**
   * Who a pool connection this test checked out is — recorded as CHECKED OUT first, synchronously,
   * before it is asked. It has said who it is only once the session itself answered with a backend
   * (its pid and when it started) AND the monitor saw exactly that backend; until then, and for good
   * if the answer never comes, is rejected or is no identity, it is on the books as unidentified.
   * Asked again, it starts over: only the latest question's answer counts, and it is to be seen again.
   */
  identify: (client: PoolClient) => Promise<BackendIdentity>;
  /**
   * Wait, within the default evidence bound, until every checkout's own backend is as `accept`
   * says — and note each one that was. Rejects at once, having waited for nothing, if any checkout
   * has not said who it is: there is no backend to read evidence about.
   */
  seen: (expected: string, accept: (sessions: SessionEvidence[]) => boolean) => Promise<void>;
  /**
   * RESERVE a real session this test is ABOUT TO stage under a state of its own — a barrier, a
   * lock holder — and hand the acquisition what it is to tell (`AcquisitionWitness`). The
   * reservation is made here, synchronously, BEFORE the acquisition is asked for; the acquisition
   * then puts the session on the books by itself, as far as it gets:
   *
   *   - never attempted — refused before its marker, or its marker could not be written: it opened
   *     nothing, and a reservation that opened nothing is not a session;
   *   - attempted: a session may exist, and until it is identified nothing names a backend to look
   *     for. It is never cleared around;
   *   - identified: on the books by its exact backend, as the monitor saw it — also when the
   *     acquisition then fails, and hands this test nothing to go by.
   *
   * One reservation is one acquisition's.
   */
  acquiring: () => AcquisitionWitness;
  /**
   * A REAL session this test stages past the harness's own cleanup, and that it did not acquire
   * under a reservation, goes on the books by its exact backend, as the monitor reads it now. On
   * the books FIRST, synchronously, as one that has not been identified: if the monitor does not
   * then see it, it stays that, and is never cleared around.
   */
  session: (pid: number) => Promise<BackendIdentity>;
  /**
   * THE ONE WAY a test that staged real sessions ends (`retireSessions`): `close` really closes
   * them — one bounded step, believed only if it says `closed` in time — every session on the books
   * is then SEEN gone as its exact backend, and `absent`, if given, is seen too, within a deadline
   * of its own. Anything less leaves the marker on file, STOPS the run and rejects. The first
   * conclusion stands: asked again, it answers the same and closes nothing again.
   *
   * The marker comes off here only if nothing else is owed. While a pool checkout of this test's
   * has not said who it is, or has not since been `seen`, it stays — for `clear()`, once it has.
   * A test that acquired nothing has nothing to see gone, and is not refused for that.
   */
  retire: (close: () => Promise<Disposal | void>, absent?: () => Promise<unknown>) => Promise<void>;
  /** Remove the marker — or THROW and leave it, while any checkout has not said who it is or has
   * not since been `seen`, or any real session on the books was not retired. */
  clear: () => void;
}

/**
 * The closing step of a retirement whose session the HARNESS closed itself — a barrier it released,
 * an acquisition it failed and cleaned up. Nothing is left for the test to close, and saying so
 * proves nothing: the exact backend on the sentinel's books must still be SEEN gone.
 */
const closedByTheHarness = async (): Promise<Disposal> => "closed";

/** Really end the connections a staged seam kept open: `closed` only if every one of them said so. */
const endAll = async (clients: Client[]): Promise<Disposal> => {
  await Promise.all(clients.map((client) => client.end()));
  return "closed";
};

/**
 * A SENTINEL on the REAL run's safety state, for a test that stages real sessions the harness will
 * — by design — not clean up, under a private state the real run does not read. While the sentinel
 * is on file the real run refuses to truncate, so a test that times out or is interrupted with such
 * a session still alive cannot be truncated around. `clear()` removes that one marker and nothing
 * else; a test calls it only after it has SEEN its staged sessions gone.
 *
 * A POOL CONNECTION such a test checks out itself is on the sentinel's books from BEFORE it is
 * asked who it is (`identify`), and what decides is those books — never what the test happens to
 * know. A test learns its backend only from that answer; one still pending, rejected, or not an
 * identity leaves it nothing to look for, and "nothing to look for" is not "nothing there". So
 * while any checkout has not said who it is, `seen` rejects and `clear()` throws: the marker stays
 * and the real run stops. The only way off the books is a POSITIVE IDENTITY — from the session
 * itself, and that backend seen present by the monitor — and then the BOUNDED evidence wait about
 * exactly that backend (`seen`). Asking again is allowed; nothing else stands in for an answer.
 *
 * A REAL SESSION such a test stages is on the same books, by its exact backend — put there by its
 * own acquisition, under a reservation made BEFORE that acquisition began (`acquiring`), or by
 * this test, from a pid it was told (`session`). It comes off them only by `retire`: its closing
 * acknowledged within its bound, and that backend then SEEN gone. A closing merely asked for —
 * awaited without a bound, its rejection swallowed — is not that, and neither is no session being
 * left under a name: a name is not a backend, and one the session never took matches nothing.
 *
 * `ask` is a SEAM for this file's own test of that (9): what a checkout is asked, in place of `whoIs`.
 * `seams` are for its tests of `retire` (10, 11): a run-safety state in place of the real run's,
 * the clock its bounded steps run on, and shorter budgets for seeing a backend gone and for what
 * else was to be seen absent.
 */
function stagedOnRealRun(
  what: string,
  ask: (client: PoolClient) => Promise<BackendIdentity> = whoIs,
  seams: Pick<RetireOptions, "safety" | "clock" | "cleanupMs" | "absentMs"> = {},
): Sentinel {
  const run = seams.safety ?? currentRunSafety();
  const scope = `sentinel-${randomUUID().slice(0, 8)}`;
  run.arm(scope, what);
  const checkouts = new Map<PoolClient, StagedCheckout>();
  const unidentified = (): number => [...checkouts.values()].filter((checkout) => !checkout.identity).length;
  const unseen = (): number => [...checkouts.values()].filter((checkout) => checkout.identity && !checkout.proven).length;
  // Every real session this test staged, or reserved: whether a connection was ever attempted for
  // it, who the monitor said it is, and whether it was then retired.
  const sessions: { attempted: boolean; backend: BackendIdentity | null; proven: boolean }[] = [];
  let retired: Promise<void> | undefined;
  const clear = (): void => {
    // A reservation nothing was ever attempted under opened no session: there is nothing of it to
    // have closed. One that WAS attempted is a session until it is retired, identified or not.
    const open = sessions.filter((session) => session.attempted && !session.proven).length;
    if (open > 0) {
      throw new Error(
        `the real run's ${scope} (${what}) is NOT cleared: ${open} real session(s) this test staged were not closed and `
        + "SEEN gone by their exact backend. Sessions that may still be there must not be truncated around.",
      );
    }
    if (unidentified() > 0 || unseen() > 0) {
      throw new Error(
        `the real run's ${scope} (${what}) is NOT cleared: of this test's own pool checkouts, ${unidentified()} did not say who `
        + `they are and ${unseen()} said so but were not then SEEN as its cleanup requires. Sessions that may still be there must not be truncated around.`,
      );
    }
    run.disarm(scope);
  };
  return {
    scope,
    acquiring: () => {
      // RESERVED FIRST, synchronously — before the acquisition this is handed to is even asked for.
      const entry: (typeof sessions)[number] = { attempted: false, backend: null, proven: false };
      sessions.push(entry);
      return {
        attempted: () => { entry.attempted = true; },
        identified: (backend) => {
          if (entry.backend && (entry.backend.pid !== backend.pid || entry.backend.started !== backend.started)) {
            throw new Error(
              `a reservation under ${scope} (${what}) is ONE acquisition's: it already names backend ${entry.backend.pid} `
              + `(started ${entry.backend.started}), and was given ${backend.pid} (started ${backend.started})`,
            );
          }
          entry.attempted = true;
          entry.backend = { pid: backend.pid, started: backend.started };
        },
      };
    },
    session: (pid) => {
      const entry: (typeof sessions)[number] = { attempted: true, backend: null, proven: false };
      sessions.push(entry);
      return (async () => {
        entry.backend = await backendIdentity(pid);
        return entry.backend;
      })();
    },
    retire: (close, absent) => (retired ??= (async () => {
      // Every session a connection was attempted for — one that never said who it is included: it
      // is handed on as the unknown it is, and nothing is cleared around it.
      const staged = sessions.filter((session) => session.attempted);
      await retireSessions(`${scope} (${what})`, staged.map((session) => session.backend), close, { ...seams, absent });
      for (const session of staged) session.proven = true;
      // A pool checkout still owed keeps the marker for `clear()`: that is not a failed retirement.
      if (unidentified() > 0 || unseen() > 0) return;
      try {
        clear();
      } catch (error) {
        // Its sessions are gone, but something else came onto the books meanwhile: the marker
        // stays, and that stops the run like any other cleanup that could not be proven.
        run.setFatal(error instanceof Error ? error.message : String(error));
        throw error;
      }
    })()),
    identify: (client) => {
      // ON THE BOOKS FIRST — before the question is put, let alone answered — as one that has not
      // said who it is and has not been seen. Asked again, it is that again, under an entry of its
      // own: what an earlier question comes to, or an earlier wait saw, says nothing about this one.
      const checkout: StagedCheckout = { identity: null, proven: false };
      checkouts.set(client, checkout);
      return (async () => {
        const said: Partial<BackendIdentity> | undefined = await ask(client);
        if (!said || typeof said.pid !== "number" || !Number.isInteger(said.pid) || typeof said.started !== "string" || !said.started) {
          throw new Error(`a pool checkout under ${scope} (${what}) could not be identified: it answered ${JSON.stringify(said)}`);
        }
        const identity: BackendIdentity = { pid: said.pid, started: said.started };
        // THE POSITIVE CONTROL: the monitor — the connection that will later look for it — sees
        // exactly that backend now. One it never saw present is never taken to be gone.
        const present = await sessionEvidence([identity.pid]);
        if (present.length !== 1 || present[0].pid !== identity.pid) {
          throw new Error(
            `a pool checkout under ${scope} (${what}): the monitor must see exactly its backend ${identity.pid} `
            + `(started ${identity.started}), and sees ${JSON.stringify(present)}`,
          );
        }
        checkout.identity = identity;
        return identity;
      })();
    },
    seen: async (expected, accept) => {
      if (unidentified() > 0) {
        throw new Error(
          `${unidentified()} pool checkout(s) under ${scope} (${what}) did not say who they are: `
          + `nothing names a backend to read evidence about — expected ${expected}`,
        );
      }
      for (const checkout of [...checkouts.values()]) {
        const { identity } = checkout;
        if (!identity) continue;
        await untilSessions([identity.pid], expected, accept);
        checkout.proven = true;
      }
    },
    clear,
  };
}

/** Re-read until no session of this database is left under one exact `application_name`. */
const untilNoSessionsNamed = (applicationName: string) =>
  expect.poll(() => sessionsNamed(applicationName), { timeout: 10_000 }).toEqual([]);

/**
 * Take one connection out of the application pool for good, by hand — what the harness, by design,
 * never does for a STRANDED lease: a connection a signal may still be on its way to is not handed
 * back at all, so a test that stages one must retire it itself, once it has seen what became of its
 * backend. The pool has no public way to give up a connection it was never given back; `_remove` is
 * what its own `release(error)` ends in.
 */
function discardFromPool(client: PoolClient): void {
  const internals = getPool() as unknown as { _remove?: (client: unknown) => void };
  if (typeof internals._remove !== "function") {
    throw new Error("pg-pool no longer has `_remove`: a stranded connection staged by this file cannot be retired from the pool");
  }
  internals._remove(client);
}

/**
 * Where the application pool has one connection, from its own inventory: `known` — it still counts
 * it among its connections; `idle` — it holds it ready to lend. A connection it was properly given
 * back is known and idle, or (given back with an error) not known at all. The pool has no public
 * reading of ONE connection — its counters move with every other connection's idle timeout — so
 * this reads the two lists those counters are the lengths of.
 */
function poolInventoryOf(client: PoolClient): { known: boolean; idle: boolean } {
  const internals = getPool() as unknown as { _clients?: unknown[]; _idle?: { client: unknown }[] };
  if (!Array.isArray(internals._clients) || !Array.isArray(internals._idle)) {
    throw new Error("pg-pool no longer has `_clients` / `_idle`: where it has a connection cannot be read");
  }
  return { known: internals._clients.includes(client), idle: internals._idle.some((item) => item.client === client) };
}

afterEach(async () => {
  // Every foreign session is closed and PROVEN gone — its closing acknowledged, its exact backend
  // seen absent — and only then is its marker removed from the real run. All at once: ending one of
  // them is what lets another, still waiting behind its lock, go. (Ending a client whose query is
  // still waiting drops its connection; the server abandons it once nothing blocks it.)
  const closing = await Promise.allSettled(foreignSessions.splice(0).map((session) => session.close()));
  for (const root of privateRoots.splice(0)) rmSync(root, { recursive: true, force: true });
  // One that could not be proven gone has already stopped the run and kept its marker: the next
  // truncation is refused. Say so here too, against the test that left it.
  const unproven = closing.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (unproven) throw unproven.reason;
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
    // The survivor is a REAL session the harness will, by design, not clean up — and its marker is
    // in the private state, which the real run does not read. So the real run carries a sentinel
    // of its own for as long as that session may exist (see `stagedOnRealRun`).
    const staged = stagedOnRealRun("a barrier staged to survive its release");
    try {
      // Acquired INSIDE the `try`: the seam below keeps the session open even when acquisition
      // itself fails, so that failure too must reach the `finally` that closes it and sees it gone.
      // The barrier exists only from here on — nothing below can release one that was not handed out.
      // RESERVED on the sentinel before it is asked for: the acquisition itself puts its backend
      // on the real run's books, whether or not it then hands a barrier out.
      const barrier = await holdNamedLock(`harness-survivor:${randomUUID()}`, {
        tag, safety, cleanupMs: 300, dispose: async (client) => { survivors.push(client); },
        acquisition: staged.acquiring(),
      });
      expect(safety.armed()).toEqual([tag]);
      expect(currentRunSafety().armed(), "the real run: the sentinel, and only the sentinel").toEqual([staged.scope]);

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
      expect(currentRunSafety().armed()).toEqual([staged.scope]);
    } finally {
      // The suite is left safe: the survivor is really closed — one bounded step, acknowledged — and
      // then SEEN gone as the exact backend its acquisition put on the sentinel's books, and under
      // its tag. Only then does the real run's sentinel come off; anything less leaves it on file,
      // STOPS the real run, and this throws. The same on a failed acquisition: whatever session it
      // opened was kept by the seam and is in `survivors` — and if it never attempted a connection,
      // it opened none, and none is there to be seen.
      await staged.retire(() => endAll(survivors), () => untilBarrierGone(tag));
    }
    // The sentinel took nothing else with it: the staged state is still stopped, its scope still on
    // file, and the real run is clean.
    expect(safety.armed()).toEqual([tag]);
    expect(safety.fatal()).toMatch(/could not be proven gone/);
    expect(currentRunSafety().blocked()).toBeNull();
  }, RACE_TEST_TIMEOUT_MS);

  it("a barrier that could not be FOUND by its tag is never handed out: a tag too long for the session name is refused before anything connects, and a session named otherwise is closed and seen gone by its exact backend", async () => {
    const { safety } = privateRun();
    const gate = `harness-misnamed:${randomUUID()}`;

    // TOO LONG: `identity-race-harness/barrier/` + 34 characters is 64 bytes; PostgreSQL keeps 63.
    // A truncated name would never match — and "no session under this tag" would read as "gone".
    for (const tag of ["t".repeat(34), "t".repeat(200), "not a tag", "é".repeat(8)]) {
      const refusal = await holdNamedLock(gate, { tag, safety }).then(() => null, (error: unknown) => error);
      expect(refusal, tag).toBeInstanceOf(Error);
      expect((refusal as Error).message, tag).toMatch(/unusable barrier tag/);
    }
    // Refused before the marker, and before any connection: nothing was recorded.
    expect(safety.armed()).toEqual([]);
    // The longest tag that DOES fit is carried whole, found by the monitor, and seen gone again.
    // Its marker is in the private state too, so it is on a sentinel of the real run from before it
    // is asked for, and comes off it only by its release — acknowledged — and its exact backend
    // SEEN gone.
    const longest = "t".repeat(33);
    const fitting = stagedOnRealRun("a barrier under the longest tag that fits");
    let fits: Barrier | undefined;
    try {
      fits = await holdNamedLock(gate, { tag: longest, safety, acquisition: fitting.acquiring() });
      expect(await barrierSessions(longest)).toEqual([{ pid: fits.pid, state: "idle in transaction" }]);
    } finally {
      await fitting.retire(async () => {
        await fits?.release();
        return "closed";
      }, () => untilBarrierGone(longest));
    }
    expect(await barrierSessions(longest)).toEqual([]);
    expect(safety.armed()).toEqual([]);

    // NAMED OTHERWISE — what an `application_name` in the connection string does to every session.
    // The session exists, under a name the tag will never match.
    const tag = `misnamed-${randomUUID().slice(0, 8)}`;
    const otherName = `identity-race-foreign/misnamed-${randomUUID().slice(0, 8)}`;
    const staged = stagedOnRealRun("a barrier session staged under another application_name");
    let failure: unknown;
    try {
      failure = await holdNamedLock(gate, { tag, safety, applicationName: otherName, acquisition: staged.acquiring() })
        .then(() => null, (error: unknown) => error);
      // No barrier was handed out — and its session is on the sentinel's books all the same, by the
      // exact backend the failed acquisition had identified: the sentinel cannot simply be taken off.
      expect(() => staged.clear()).toThrow(/is NOT cleared: 1 real session\(s\) this test staged were not closed and SEEN gone/);
    } finally {
      // Whatever the harness did, the real run's sentinel comes off only when the exact backend
      // that acquisition put on its books is SEEN gone — a name it never took would match nothing
      // — and no session is left under EITHER name.
      await staged.retire(closedByTheHarness, async () => {
        await untilNoSessionsNamed(otherName);
        await untilBarrierGone(tag);
      });
    }
    // It was refused as a failed acquisition — by the session's own report of its name, before it
    // began or took the lock…
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/its session reports application_name "identity-race-foreign\/misnamed-[a-f0-9]+", not "identity-race-harness\/barrier\/misnamed-[a-f0-9]+"/);
    // …and its cleanup was PROVEN, by its exact backend rather than by a name that matches nothing:
    // the marker is cleared and the run is not stopped.
    expect(await sessionsNamed(otherName)).toEqual([]);
    expect(safety.armed()).toEqual([]);
    expect(safety.fatal()).toBeNull();
    // The lock itself was never taken: it is free for a barrier that IS found by its tag — one more
    // real session under the private state, and so on a sentinel of its own in the same way.
    const freed = stagedOnRealRun("a barrier that takes the lock the misnamed one never took");
    let free: Barrier | undefined;
    try {
      free = await holdNamedLock(gate, { safety, lockTimeoutMs: 250, acquisition: freed.acquiring() });
    } finally {
      await freed.retire(async () => {
        await free?.release();
        return "closed";
      });
    }
    expect(safety.blocked()).toBeNull();
    expect(currentRunSafety().blocked()).toBeNull();
  }, RACE_TEST_TIMEOUT_MS);
});

describe("race harness (1, in a schedule): a surviving barrier makes the whole schedule's cleanup `unproven` (real Postgres)", () => {
  it("the raced operation is settled — by cancelling ITS backend only — and its backend is idle, but the barrier's session is still there: the report says `unproven`, the run is stopped, the marker stays", async () => {
    const { seed, alice } = await aliceHolds();
    const fresh = `harness-${randomUUID().slice(0, 8)}`;
    const { safety } = privateRun();
    const tag = `survivor-${randomUUID().slice(0, 8)}`;
    const survivors: Client[] = [];
    // Two REAL sessions are staged here that only a private state knows about: the surviving
    // barrier, and a writer parked holding the team authority. The real run carries a sentinel for
    // both, which comes off only when the barrier is seen gone AND the writer — if one was ever
    // started — was seen idle.
    const staged = stagedOnRealRun("a surviving barrier and a parked writer");
    let writerStarted = false;
    let writerSeenIdle = false;
    try {
      // Acquired INSIDE the `try`, for the reason given in the test above: the seam keeps the
      // session open even when acquisition fails. The barrier holds the new id's own key, which the
      // writer takes after the team authority.
      const barrier = await holdIdentityKey(seed.teamId, "slack", fresh, {
        tag, safety, cleanupMs: 300, dispose: async (client) => { survivors.push(client); },
        acquisition: staged.acquiring(),
      });
      const failure = await parkThenCompete({
        seed,
        barrier,
        parksOn: "advisory",
        first: () => {
          writerStarted = true;
          return linkFresh(seed, alice, fresh).then(() => "linked", (error: unknown) => (error as { code?: string }).code ?? "failed");
        },
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
      expect(parked.backends.length).toBeGreaterThanOrEqual(1);
      for (const session of await sessionEvidence(parked.backends)) {
        expect(session).toEqual({ pid: session.pid, state: "idle", waitingOn: null, locksHeld: 0 });
      }
      writerSeenIdle = true;
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
      expect(currentRunSafety().armed(), "the real run: the sentinel, and only the sentinel").toEqual([staged.scope]);
    } finally {
      // The survivor is really closed — one bounded, acknowledged step — and SEEN gone as the exact
      // backend its acquisition put on the sentinel's books, on a failed acquisition too, where the
      // seam kept whatever session was opened. That retirement is what takes the sentinel off, and
      // it is asked for only if, as well, no writer is unaccounted for: none was ever started (the
      // barrier was not acquired, or the schedule never reached it), or the one that was started
      // was seen idle above. Otherwise the survivor is still ended, for what that is worth, and the
      // sentinel stays: the real run stops.
      if (!writerStarted || writerSeenIdle) {
        await staged.retire(() => endAll(survivors), () => untilBarrierGone(tag));
      } else {
        await endAll(survivors).catch(() => undefined);
      }
    }
    // The sentinel took nothing else with it: the staged state is still stopped, its scope still on
    // file, and the real run is clean.
    expect(safety.armed()).toEqual([tag]);
    expect(safety.fatal()).toMatch(/the barrier's own session was not seen gone/);
    expect(currentRunSafety().blocked()).toBeNull();
    // With the survivor really gone, the cancelled writer has left nothing behind.
    expect(await slackIds(seed, alice)).not.toContain(fresh);
  }, RACE_TEST_TIMEOUT_MS);
});

describe("race harness (2): a foreign session of the same database is never the harness's (real Postgres)", () => {
  it("foreign waiters behind the SAME barrier and behind the PARKED operation are not evidence, are not signalled, and complete once released", async () => {
    const { seed, alice, bob, target } = await aliceHolds();
    const fresh = `harness-${randomUUID().slice(0, 8)}`;
    const barrier = await holdTable("member_identity_mapping_state");
    // From here the test holds an ACCESS EXCLUSIVE barrier of the real run. Everything that can
    // fail before the schedule takes it over — connecting the foreign clients, waiting for their
    // evidence — is inside a `try` whose `finally` releases it: one failing step must not leave a
    // table locked and its scope in flight for every test after it. (Once the schedule has run, it
    // has already released and proven the barrier; this release is then a no-op.)
    try {
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
        // Two real writer calls: the first parks at its locked read of the mapping state, holding
        // the team authority; the second waits for that authority.
        first: () => linkFresh(seed, alice, fresh),
        second: () => setMemberIdentity(db(), seed.teamId, bob, { provider: "slack", externalId: target }, { force: true, expectedRevision: 1 }),
        // With both raced operations proven waiting, FOREIGN #2 queues on the team identity
        // authority itself — behind the parked operation, on the very lock the competing operation
        // waits for. The harness then proves its two waits again: each still exactly one, as before.
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
      // The scope's cleanup was proven, so its marker is gone and the run goes on. What is still on
      // file is this test's own two foreign sessions, open until the `afterEach` proves them gone.
      expect(currentRunSafety().armed()).not.toContain(barrier.tag);
      expect(foreignScopes()).toEqual([behindBarrier.scope, behindParked.scope].sort());
      expect(currentRunSafety().armed()).toEqual(foreignScopes());
      expect(raceHarnessFatal()).toBeNull();
    } finally {
      // If the release cannot be proven it has already stopped the run; do not mask what failed.
      await barrier.release().catch(() => undefined);
    }
  }, RACE_TEST_TIMEOUT_MS);

  it("when cleanup must CANCEL a raced operation, only that operation's own backend is signalled: a foreign lock holder and foreign waiters in the same database keep their locks and their waits", async () => {
    const { seed, alice } = await aliceHolds();
    const fresh = `harness-${randomUUID().slice(0, 8)}`;
    const barrier = await holdTable("member_identities");
    // As above: whatever fails between acquiring the barrier and the schedule releasing it, the
    // `finally` releases it.
    try {
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

      // The schedule FAILS, deterministically and at once: the "competing" operation finishes
      // without ever waiting. Cleanup then releases the barrier; the parked writer — a real
      // transaction, holding the team authority — runs on into the foreign holder's lock and
      // cannot finish.
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
      // The cancelled writer wrote nothing; cleanup was proven, so the marker is gone and the run goes
      // on. What is still on file is this test's own three foreign sessions, open until the
      // `afterEach` proves them gone.
      expect(await slackIds(seed, alice)).not.toContain(fresh);
      expect(currentRunSafety().armed()).not.toContain(barrier.tag);
      expect(foreignScopes()).toEqual([holder.scope, behindHolder.scope, behindBarrier.scope].sort());
      expect(currentRunSafety().armed()).toEqual(foreignScopes());
      expect(raceHarnessFatal()).toBeNull();
    } finally {
      await barrier.release().catch(() => undefined);
    }
  }, RACE_TEST_TIMEOUT_MS);
});

describe("race harness (2, leases): a backend a signal is aimed at is not lent to anyone else until the signal has been executed (real Postgres)", () => {
  /**
   * THE WINDOW. Cleanup reads which backends a raced operation holds, in this process, and then has
   * PostgreSQL signal them. If the operation returns its connection in between, the pool can lend
   * that very backend to an unrelated borrower — and the signal lands on the borrower's work.
   *
   * Each test holds that window open with an explicit gate (`beforeSignal`: after the target is
   * captured and reserved, before PostgreSQL is asked to execute the signal), and inside it:
   * fills the pool, lets the raced operation finish and release, and queues an unrelated borrower
   * that only the raced operation's connection could serve. The borrower must still be waiting
   * after a real round trip to PostgreSQL; the pool must not have been given the connection at
   * all. Then the gate is left, the signal is executed, and the borrower is served — by another
   * backend — while every unrelated connection is exactly as it was.
   *
   * Nothing here is timed: the raced operation, the borrower and the signal each move only when a
   * gate is opened or evidence from PostgreSQL has been read.
   */
  it.each(["cancel", "terminate"] as const)("%s: the raced operation releases after its backend was captured and before the signal is executed — the pool is not given that backend, a queued borrower is not served by it, and unrelated work is untouched", async (gated) => {
    const pool = getPool();
    const max = (pool as unknown as { options: { max: number } }).options.max;
    const { safety } = privateRun();
    const tag = `lease-${randomUUID().slice(0, 8)}`;
    const lockName = `harness-lease:${randomUUID()}`;
    // What the raced operation releases with: nothing (cancel), or an error of its own (terminate).
    const releasedWith = gated === "terminate" ? new Error("the raced operation's own release error") : undefined;
    const proceed = gate();
    const released = gate();
    const lent = new Set<PoolClient>();
    const lend = (client: PoolClient): PoolClient => { lent.add(client); return client; };
    const hogs: { client: PoolClient; identity: BackendIdentity }[] = [];
    const signals: string[] = [];
    // Every time the POOL is given the raced operation's connection back, and with what.
    const handedBack: unknown[] = [];
    let owner: BackendIdentity | undefined;
    let repeatedRelease: unknown = "not attempted";
    let borrower: InFlight<PoolClient> | undefined;
    let borrowed: PoolClient | undefined;
    let barrier: Barrier | undefined;
    // What the gate itself found wrong, if anything: the harness reports a failed gate as `unproven`.
    const gateFailures: unknown[] = [];
    const onRelease = (error: unknown, client: unknown): void => {
      if (owner && (client as { processID?: unknown }).processID === owner.pid) handedBack.push(error);
    };
    // Real sessions are staged here under a run-safety state the real run does not read: a barrier,
    // and a raced operation's backend left in a transaction. The real run carries a sentinel until
    // both are SEEN gone or idle.
    const staged = stagedOnRealRun("a raced operation held between the capture of its backend and the signal");
    try {
      pool.on("release", onRelease);
      barrier = await holdNamedLock(lockName, { tag, safety, acquisition: staged.acquiring() });
      const failure = await parkThenCompete({
        seed: { teamId: randomUUID() },
        barrier,
        parksOn: "advisory",
        // The raced operation: one pool connection, in a transaction, parked on the barrier's lock.
        // Past it, it waits for this test's gate and for nothing in the database — so it is still
        // holding its connection when cleanup comes to signal it.
        first: async () => {
          const client = await pool.connect();
          try {
            owner = await staged.identify(client);
            await client.query("begin");
            await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [lockName]);
            await proceed.opened;
            await client.query("rollback");
          } finally {
            client.release(releasedWith);
            // A SECOND release of the same checkout is refused as the pool refuses one.
            try {
              client.release();
              repeatedRelease = "accepted";
            } catch (error) {
              repeatedRelease = error;
            }
            released.open();
          }
          return "released";
        },
        // The schedule itself fails at once, so cleanup runs with the first operation still held.
        second: async () => "finished without waiting",
        bounds: { cleanupMs: 300 },
        beforeSignal: async (pending) => {
          try {
            signals.push(pending.signal);
            // THE TARGET IS CAPTURED: the raced operation's own backend, and nothing else…
            expect(pending.backends).toEqual([owner!.pid]);
            // …past its lock and waiting only on this test: no statement for a cancel to find.
            await untilSessions([owner!.pid], "the raced operation idle in its transaction",
              (sessions) => sessions.length === 1 && sessions[0].state === "idle in transaction" && sessions[0].waitingOn === null);
            if (pending.signal !== gated) return;

            // A CONSTRAINED POOL: every other connection it has, or may open, is taken by this
            // test. From here a borrower can be served only by a connection that is given back.
            while (pool.idleCount > 0 || pool.totalCount < max) {
              const client = lend(await pool.connect());
              hogs.push({ client, identity: await whoIs(client) });
            }
            expect(hogs.map((hog) => hog.identity)).not.toContainEqual(owner);

            // THE RACED OPERATION FINISHES AND RELEASES — after the capture, before the signal.
            proceed.open();
            await released.opened;
            await untilSessions([owner!.pid], "the raced operation's backend idle, its transaction over",
              (sessions) => sessions.length === 1 && sessions[0].state === "idle");

            // AN UNRELATED BORROWER queues for a connection. Nothing of the harness's knows it.
            borrower = inFlight(pool.connect());
            // A real round trip to PostgreSQL later — long after a pool that had been given the
            // connection would have lent it — the backend is still there, idle, the pool has not
            // been given it, and the borrower is still waiting.
            expect(await sessionEvidence([owner!.pid])).toEqual([{ pid: owner!.pid, state: "idle", waitingOn: null, locksHeld: 0 }]);
            expect(handedBack, "the pool must not be given a backend a signal is aimed at").toEqual([]);
            expect(borrower.state()).toBe("pending");
            expect({ total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount }).toEqual({ total: max, idle: 0, waiting: 1 });
          } catch (error) {
            gateFailures.push(error);
            throw error;
          }
        },
      }).then(() => null, (error: unknown) => error);

      // Whatever the gate found wrong is the failure to report — not what cleanup made of it.
      if (gateFailures.length > 0) throw gateFailures[0];
      expect(signals).toEqual(gated === "cancel" ? ["cancel"] : ["cancel", "terminate"]);
      expect(failure).toBeInstanceOf(RaceScheduleError);
      const { cleanup, message } = failure as RaceScheduleError;
      expect(message).toContain("the competing operation finished without waiting");
      // CLEANUP WAS PROVEN, and took that signal — of the raced operation's own backend, and no other.
      expect(cleanup.outcome).toBe(gated === "cancel" ? "cancelled" : "terminated");
      expect(cleanup.barrierGone).toBe(true);
      expect(cleanup.signalled).toEqual([owner!.pid]);
      expect(cleanup.operations).toEqual([
        { label: "the parked operation", backends: [owner!.pid], settled: true },
        { label: "the competing operation", backends: [], settled: true },
      ]);
      // THE RELEASE THE OPERATION ASKED FOR WAS CARRIED OUT, ONCE, after the signal: with the
      // operation's own error where it gave one, and otherwise with the harness's — a signalled
      // connection is retired, never pooled. Its second release was refused as the pool refuses one.
      expect(handedBack).toHaveLength(1);
      if (releasedWith) expect(handedBack[0]).toBe(releasedWith);
      else expect((handedBack[0] as Error).message).toMatch(/was signalled by the identity race harness: its connection is retired, not pooled/);
      expect(repeatedRelease).toBeInstanceOf(Error);
      expect((repeatedRelease as Error).message).toBe("Release called on client which has already been released to the pool.");
      await untilSessions([owner!.pid], "the signalled backend gone", (sessions) => sessions.length === 0);

      // ONLY NOW IS THE BORROWER SERVED — by a backend that is not the one the signal was aimed at…
      borrowed = lend(await borrower!.promise);
      expect(await whoIs(borrowed)).not.toEqual(owner);
      // …and UNRELATED WORK COMPLETES, UNAFFECTED: the borrower's, and on every connection this
      // test held through the signal — each still the very backend it was, neither cancelled nor
      // terminated.
      expect((await borrowed.query("select count(*)::int as n from member_identities")).rows).toEqual([{ n: expect.any(Number) }]);
      for (const hog of hogs) expect(await whoIs(hog.client)).toEqual(hog.identity);
      expect(cleanup.signalled).not.toContain((await whoIs(borrowed)).pid);
      // The scope's cleanup was proven, so its marker is gone; neither state was stopped.
      expect(safety.armed()).toEqual([]);
      expect(safety.fatal()).toBeNull();
      expect(raceHarnessFatal()).toBeNull();
      expect(currentRunSafety().armed(), "the real run: the sentinel, and only the sentinel").toEqual([staged.scope]);
    } finally {
      // ON EVERY EXIT: the raced operation may finish; every connection this test took goes back —
      // which is also what serves a borrower still waiting, whose connection then goes back too;
      // and the barrier is released (a no-op once the schedule has proven it gone).
      pool.removeListener("release", onRelease);
      proceed.open();
      for (const client of [...lent]) {
        lent.delete(client);
        client.release();
      }
      if (borrower && !borrowed) await borrower.promise.then((client) => client.release(), () => undefined);
      // The barrier is retired: its release is the one bounded closing, which must be acknowledged,
      // and its session is then SEEN gone as the exact backend its acquisition put on the
      // sentinel's books, and under its tag. The sentinel itself comes off only once the raced
      // operation's backend is SEEN idle or gone as well — the backend its connection SAID it is:
      // one that was checked out and never said leaves nothing to see. If any of that cannot be
      // seen, this throws, the sentinel stays, and the real run stops.
      await staged.retire(async () => {
        await barrier?.release();
        return "closed";
      }, () => untilBarrierGone(tag));
      await staged.seen("the raced operation's backend idle or gone",
        (sessions) => sessions.every((session) => session.state === "idle"));
      staged.clear();
    }
  }, RACE_TEST_TIMEOUT_MS);
});

describe("race harness (2, leases — a hand-over that threw): a release the pool did not complete is not a return — cleanup is `unproven`, the marker stays and the run is stopped (real Postgres)", () => {
  /**
   * A raced operation finishes by itself and releases its connection in the ordinary way: nothing
   * was ever aimed at its backend. But the pool's `release` THROWS — a `release` listener of the
   * application's, which the pool runs before it has either kept the connection or destroyed it.
   * The operation is settled and holds nothing it knows of; and where its connection is, nothing
   * says. That must not read as "returned": the scope's marker must stay and the run must stop.
   *
   * The listener throws once, for that operation's connection only, and is removed on every exit.
   * Nothing is timed: the operation moves when the barrier's lock is released to it, and what
   * became of its backend is read from PostgreSQL.
   */
  it("an ordinary, UNSIGNALLED release that throws out of the pool: the operation is settled and its backend idle, but the connection was not taken back — `unproven`, nobody signalled, the marker and the fatal reason kept, the guard refusing", async () => {
    const pool = getPool();
    const { directory, safety } = privateRun();
    const tag = `handover-${randomUUID().slice(0, 8)}`;
    const lockName = `harness-handover:${randomUUID()}`;
    const stagedFailure = new Error("staged: a pool `release` listener that throws");
    // The raced operation's backend, and its checked-out client: filled in by the operation itself.
    const owners: BackendIdentity[] = [];
    const held: PoolClient[] = [];
    // What each of the operation's two release calls came to: what it threw, or "returned".
    const releases: unknown[] = [];
    const signals: PendingSignal[] = [];
    // ONE SHOT: the first time the pool announces the release of the raced operation's connection.
    let thrown = 0;
    const throwOnce = (_error: unknown, client: unknown): void => {
      if (thrown > 0 || !owners.some((owner) => (client as { processID?: unknown }).processID === owner.pid)) return;
      thrown += 1;
      throw stagedFailure;
    };
    expect(safety.blocked()).toBeNull();
    // Real sessions are staged here under a run-safety state the real run does not read: a barrier,
    // and a connection the pool is made to lose track of. The real run carries a sentinel until
    // both are SEEN gone.
    const staged = stagedOnRealRun("a raced operation whose ordinary release is staged to throw out of the pool");
    let barrier: Barrier | undefined;
    try {
      pool.on("release", throwOnce);
      barrier = await holdNamedLock(lockName, { tag, safety, acquisition: staged.acquiring() });
      const failure = await parkThenCompete({
        seed: { teamId: randomUUID() },
        barrier,
        parksOn: "advisory",
        // The raced operation: one pool connection, in a transaction, parked on the barrier's lock.
        // Once cleanup has released the barrier it gets the lock, ends its transaction and releases
        // — by itself, before any round of cleanup has reason to signal it.
        first: async () => {
          const client = await pool.connect();
          held.push(client);
          owners.push(await staged.identify(client));
          await client.query("begin");
          await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [lockName]);
          await client.query("rollback");
          // AN ORDINARY RELEASE, twice: the first is the one the pool throws out of.
          for (let call = 0; call < 2; call += 1) {
            try {
              client.release();
              releases.push("returned");
            } catch (error) {
              releases.push(error);
            }
          }
          return "released";
        },
        // The schedule itself fails at once, so cleanup runs with the first operation still parked.
        second: async () => "finished without waiting",
        // Every signal cleanup asks for, should it ask for one.
        cleanup: { signal: (pending, send) => { signals.push(pending); return send(); } },
      }).then(() => null, (error: unknown) => error);

      expect(owners).toHaveLength(1);
      const [owner] = owners;
      // THE RELEASE: the listener threw, once, and the operation was told — as without the harness.
      // Its second release of that checkout was refused as the pool refuses one: no second hand-over.
      expect(thrown).toBe(1);
      expect(releases).toHaveLength(2);
      expect(releases[0]).toBe(stagedFailure);
      expect(releases[1]).toBeInstanceOf(Error);
      expect((releases[1] as Error).message).toBe("Release called on client which has already been released to the pool.");

      // WHERE THE CONNECTION IS. Its backend is there, idle, its transaction over and its lock
      // gone; the client still answers, as that very backend; and the pool still counts the
      // connection as one of its own but does NOT hold it ready to lend. It was neither kept nor
      // destroyed: it was not returned.
      expect(await sessionEvidence([owner.pid])).toEqual([{ pid: owner.pid, state: "idle", waitingOn: null, locksHeld: 0 }]);
      expect(await whoIs(held[0])).toEqual(owner);
      expect(poolInventoryOf(held[0])).toEqual({ known: true, idle: false });

      // CLEANUP IS UNPROVEN — though the barrier was seen gone and both operations had settled. And
      // nobody was signalled: a connection nothing can place is not one to aim at.
      expect(failure).toBeInstanceOf(RaceScheduleError);
      const { cleanup, message } = failure as RaceScheduleError;
      expect(message).toContain("the competing operation finished without waiting");
      expect(cleanup).toEqual({
        outcome: "unproven",
        barrierGone: true,
        signalled: [],
        operations: [
          { label: "the parked operation", backends: [owner.pid], settled: true },
          { label: "the competing operation", backends: [], settled: true },
        ],
      });
      expect(signals).toEqual([]);
      expect(await barrierSessions(tag)).toEqual([]);

      // THE RUN IS STOPPED: a fatal reason, the marker still on file, and the guard refusing.
      const reason = safety.fatal();
      expect(reason).toMatch(/could not be proven settled, idle or disposed/);
      expect(safety.armed()).toEqual([tag]);
      expect(() => assertRunSafe(safety)).toThrow(/run STOPPED — refusing to truncate or run another test/);
      // STICKY: no later conclusion, release or reason clears it…
      barrier.conclude(true, "");
      await barrier.release();
      expect(safety.armed()).toEqual([tag]);
      expect(safety.fatal()).toBe(reason);
      expect(safety.setFatal("a later, different reason")).toBe(reason);
      expect(() => assertRunSafe(safety)).toThrow(/run STOPPED — refusing to truncate or run another test/);
      // …and SHARED: another reader of the same state — as the next test file's worker is — is refused too.
      const elsewhere = createRunSafety(directory);
      expect(elsewhere.armed()).toEqual([tag]);
      expect(elsewhere.fatal()).toBe(reason);
      expect(() => assertRunSafe(elsewhere)).toThrow(/run STOPPED/);
      // The real run was not stopped by this test: its state is not this one.
      expect(raceHarnessFatal()).toBeNull();
      expect(currentRunSafety().armed(), "the real run: the sentinel, and only the sentinel").toEqual([staged.scope]);
    } finally {
      // ON EVERY EXIT: the listener is taken off first, so no later release — this test's or
      // another's — can meet it; the barrier is released (a no-op once the schedule has seen it
      // gone); and the connection the pool lost track of is retired from it by hand, so that no
      // later test inherits a pool one connection short. The barrier is retired — its release the
      // one bounded, acknowledged closing, its session then SEEN gone as the exact backend its
      // acquisition put on the sentinel's books — and the sentinel comes off only when that
      // connection's backend is SEEN gone too — the backend it SAID it is: one that was checked out
      // and never said leaves nothing to see. If any of that cannot be seen, this throws, the
      // sentinel stays, and the real run stops.
      pool.removeListener("release", throwOnce);
      await staged.retire(async () => {
        await barrier?.release();
        return "closed";
      }, () => untilBarrierGone(tag));
      for (const client of held) discardFromPool(client);
      await staged.seen("the raced operation's backend gone", (sessions) => sessions.length === 0);
      staged.clear();
    }
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
    const tag = `unsettled-${randomUUID().slice(0, 8)}`;
    // The barrier IS a real session, and its marker is in the private state, which the real run
    // does not read. So it is on a sentinel of the real run from before it is asked for, and comes
    // off it only by its release — acknowledged — and its exact backend SEEN gone.
    const staged = stagedOnRealRun("a barrier whose schedule is staged never to settle");
    let barrier: Barrier | undefined;
    try {
      barrier = await holdIdentityKey(teamId, "slack", "unproven-self-test", { tag, safety, acquisition: staged.acquiring() });
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
      expect(await barrierSessions(tag)).toEqual([]);

      // THE RUN IS STOPPED, and the scope is still on file: the guard the setup file runs refuses.
      const reason = safety.fatal();
      expect(reason).toMatch(/could not be proven settled, idle or disposed/);
      expect(safety.armed()).toEqual([tag]);
      expect(() => assertRunSafe(safety)).toThrow(/run STOPPED — refusing to truncate or run another test/);
      // STICKY: a later reason does not replace the first…
      expect(safety.setFatal("a later, different reason")).toBe(reason);
      expect(safety.fatal()).toBe(reason);
      // …a later release of that barrier does not clear what the schedule concluded…
      await barrier.release();
      expect(safety.armed()).toEqual([tag]);
      // …and SHARED: another reader of the same state — as the next test file's worker is — sees it.
      const elsewhere = createRunSafety(directory);
      expect(elsewhere.fatal()).toBe(reason);
      expect(() => assertRunSafe(elsewhere)).toThrow(/run STOPPED/);
      // The real run was not stopped by this test: its state is not this one.
      expect(raceHarnessFatal()).toBeNull();
      expect(currentRunSafety().armed(), "the real run: the sentinel, and only the sentinel").toEqual([staged.scope]);
    } finally {
      await staged.retire(async () => {
        await barrier?.release();
        return "closed";
      }, () => untilBarrierGone(tag));
    }
    expect(currentRunSafety().blocked()).toBeNull();
  }, RACE_TEST_TIMEOUT_MS);
});

describe("race harness (4): the run-safety state — in-flight scopes, sticky fatal, fail closed, one run one directory (real Postgres)", () => {
  it("an IN-FLIGHT scope blocks truncation and the next file — also when its test never came back to clean up — and its own proven cleanup clears ONLY its own marker", async () => {
    const { directory, safety } = privateRun();
    // Another scope, and a fatal reason, already on file: neither is this barrier's to clear.
    safety.arm("another-scope", "someone else's sessions");
    const tag = `scope-${randomUUID().slice(0, 8)}`;
    // The barrier is a REAL session whose marker is in the private state: on a sentinel of the real
    // run from before it is asked for, and off it only by its release — acknowledged — and its
    // exact backend SEEN gone.
    const staged = stagedOnRealRun("a barrier left in flight under a state of this test's own");
    let barrier: Barrier | undefined;
    try {
      barrier = await holdNamedLock(`harness-scope:${randomUUID()}`, { tag, safety, acquisition: staged.acquiring() });
      // The barrier holds a session and the harness has not been back — exactly the state a test
      // that timed out, or was interrupted, leaves behind. The marker was written BEFORE it
      // connected, so it is there whatever became of the test.
      expect(safety.armed()).toEqual(["another-scope", tag].sort());
      expect(() => assertRunSafe(safety)).toThrow(/2 harness scope\(s\) still in flight/);
      // The next file's worker reads the same directory, and is refused too.
      expect(() => assertRunSafe(createRunSafety(directory))).toThrow(/still in flight/);

      const stopped = safety.setFatal("the run was stopped for another reason");
      await barrier.release();

      // ITS OWN marker is gone — its session was seen gone. The other scope and the fatal reason
      // are exactly as they were.
      expect(await barrierSessions(tag)).toEqual([]);
      expect(safety.armed()).toEqual(["another-scope"]);
      expect(safety.fatal()).toBe(stopped);
      expect(() => assertRunSafe(safety)).toThrow(/the run was stopped for another reason/);
      // Any other reader of the directory sees the same: the other scope still on file, the run still stopped.
      expect(createRunSafety(directory).armed()).toEqual(["another-scope"]);
      expect(createRunSafety(directory).blocked()).toBe(stopped);
      // The real run was not stopped by this test: it carries the sentinel, and nothing else.
      expect(raceHarnessFatal()).toBeNull();
      expect(currentRunSafety().armed()).toEqual([staged.scope]);
    } finally {
      await staged.retire(async () => {
        await barrier?.release();
        return "closed";
      }, () => untilBarrierGone(tag));
    }
    expect(currentRunSafety().blocked()).toBeNull();
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

/** The budget every wait below is given: the harness's own default for one cleanup step. */
const BUDGET_MS = 5_000;
/** The harness's interval between two reads of the same evidence. */
const REREAD_MS = 25;

describe("race harness (5): an evidence wait ends at its deadline — late evidence is not evidence (a clock and reads moved by hand)", () => {
  /**
   * The wait every cleanup proof is: "no session left". Its reads are answered by the test, and its
   * clock moved by the test, so each case puts the read on exactly the side of the deadline it
   * names. Nothing here sleeps, and nothing here touches the database.
   */
  type Sessions = { pid: number }[];
  const untilNoSession = (hand: HandClock, reads: HeldReads<Sessions>): InFlight<Sessions> => inFlight(untilEvidence({
    read: reads.read,
    accept: (sessions) => sessions.length === 0,
    expected: "no session left",
    show: (sessions) => JSON.stringify(sessions),
    timeoutMs: BUDGET_MS,
    clock: hand.clock,
  }));
  const rejection = (wait: InFlight<Sessions>) => wait.promise.then(() => null, (error: unknown) => error);

  it("evidence read BEFORE the deadline — by one millisecond — is accepted: one read, bounded by the whole budget, and that bound is called off", async () => {
    const hand = handClock();
    const reads = heldReads<Sessions>();
    const wait = untilNoSession(hand, reads);
    // Begun at once: one read, and one timer — the bound on that read, which is the whole budget.
    expect(reads.count()).toBe(1);
    expect(hand.delays()).toEqual([BUDGET_MS]);

    hand.tick(BUDGET_MS - 1);
    await turn();
    expect(wait.state(), "nothing has ended the wait: its budget is not spent").toBe("pending");
    reads.answer(0, []);

    expect(await wait.promise).toEqual([]);
    expect(reads.count()).toBe(1);
    expect(hand.outstanding(), "the read's bound was called off, not left to fire").toBe(0);
  });

  it("the within-budget path: evidence that is not yet what is expected is re-read after the interval, each read bounded by what is LEFT of the one budget", async () => {
    const hand = handClock();
    const reads = heldReads<Sessions>();
    const wait = untilNoSession(hand, reads);

    hand.tick(100);
    reads.answer(0, [{ pid: 7 }]);
    // The pause before the next read is the second timer; until it is over, nothing is read.
    await hand.set(2);
    expect(reads.count()).toBe(1);
    hand.tick(REREAD_MS);
    await reads.asked(2);
    // The second read is given what is left of the SAME budget — not a budget of its own.
    expect(hand.delays()).toEqual([BUDGET_MS, REREAD_MS, BUDGET_MS - 100 - REREAD_MS]);

    hand.tick(BUDGET_MS - 100 - REREAD_MS - 1);
    reads.answer(1, []);
    expect(await wait.promise).toEqual([]);
    expect(reads.count()).toBe(2);
    expect(hand.outstanding()).toBe(0);
  });

  it.each([
    { when: "AT", past: 0 },
    { when: "one millisecond AFTER", past: 1 },
  ])("evidence that IS what was expected, read $when the deadline, fails the wait — also when it is delivered ahead of the timer that bounds its read", async ({ past }) => {
    const hand = handClock();
    const reads = heldReads<Sessions>();
    const wait = untilNoSession(hand, reads);

    // THE DEADLINE PASSES ON THE CLOCK, and the timer bounding the read has not been run: the read's
    // result is delivered first. Only asking the clock again can tell that it is late.
    hand.drift(BUDGET_MS + past);
    expect(hand.outstanding()).toBe(1);
    reads.answer(0, []);

    const failure = await rejection(wait);
    expect(failure, "acceptable evidence, read too late, must not be accepted").toBeInstanceOf(RaceHarnessError);
    expect((failure as Error).message).toBe(
      `no evidence within ${BUDGET_MS} ms of no session left; what was expected was read only at or after the deadline: []`,
    );
    expect(reads.count()).toBe(1);
    expect(hand.delays(), "nothing was started after it: no pause, no other read").toEqual([BUDGET_MS]);
    expect(hand.outstanding()).toBe(0);
  });

  it.each([
    { later: "resolves with the very evidence that was expected", settle: (reads: HeldReads<Sessions>) => reads.answer(0, []) },
    { later: "rejects", settle: (reads: HeldReads<Sessions>) => reads.fail(0, new Error("canceling statement due to statement timeout")) },
  ])("a read still PENDING at the deadline fails the wait there — one read, and no other started — and when it later $later, nothing comes of it", async ({ settle }) => {
    const hand = handClock();
    const reads = heldReads<Sessions>();
    const unhandled: unknown[] = [];
    const noteUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    process.on("unhandledRejection", noteUnhandled);
    try {
      const wait = untilNoSession(hand, reads);
      hand.tick(BUDGET_MS - 1);
      await turn();
      expect(wait.state()).toBe("pending");

      // THE DEADLINE: the bound on the read fires, and the read has still not come back.
      hand.tick(1);
      await turn();
      expect(wait.state(), "a read that outlasts the deadline must not keep the wait open").toBe("rejected");
      const failure = await rejection(wait);
      expect(failure).toBeInstanceOf(RaceHarnessError);
      expect((failure as Error).message).toBe(`no evidence within ${BUDGET_MS} ms of no session left; a read was still pending at the deadline`);
      expect(reads.count(), "exactly one read: none is started once the budget is spent").toBe(1);
      expect(hand.delays()).toEqual([BUDGET_MS]);

      // THE READ COMES BACK NOW — observed, and dropped: not an unhandled rejection, not a second
      // outcome for the wait, and not the start of anything else.
      settle(reads);
      await turn();
      expect(unhandled).toEqual([]);
      expect(wait.state()).toBe("rejected");
      expect(await rejection(wait)).toBe(failure);
      expect(reads.count()).toBe(1);
      expect(hand.delays()).toEqual([BUDGET_MS]);
    } finally {
      process.removeListener("unhandledRejection", noteUnhandled);
    }
  });

  it.each([
    { when: "AT", past: 0 },
    { when: "one millisecond AFTER", past: 1 },
  ])("a read that FAILS $when the deadline, delivered ahead of the timer that bounds it, ends the wait as EXPIRED — late like any other outcome, not a failure that came in time", async ({ past }) => {
    const hand = handClock();
    const reads = heldReads<Sessions>();
    const wait = untilNoSession(hand, reads);

    // THE DEADLINE PASSES ON THE CLOCK with the read's timer not yet run, and the read then REJECTS.
    hand.drift(BUDGET_MS + past);
    expect(hand.outstanding()).toBe(1);
    reads.fail(0, new Error("canceling statement due to statement timeout"));

    const failure = await rejection(wait);
    expect(failure, "the wait ended at its deadline: that is what is reported").toBeInstanceOf(RaceHarnessError);
    expect((failure as Error).message).toBe(
      `no evidence within ${BUDGET_MS} ms of no session left; a read failed only at or after the deadline (canceling statement due to statement timeout)`,
    );
    expect(reads.count()).toBe(1);
    expect(hand.delays(), "nothing was started after it: no pause, no other read").toEqual([BUDGET_MS]);
    expect(hand.outstanding()).toBe(0);
  });

  it("the control: a read that fails one millisecond BEFORE the deadline fails the wait there, with its own error", async () => {
    const hand = handClock();
    const reads = heldReads<Sessions>();
    const wait = untilNoSession(hand, reads);
    const refused = new Error("canceling statement due to statement timeout");

    hand.drift(BUDGET_MS - 1);
    reads.fail(0, refused);

    expect(await rejection(wait)).toBe(refused);
    expect(reads.count()).toBe(1);
    expect(hand.delays()).toEqual([BUDGET_MS]);
    expect(hand.outstanding()).toBe(0);
  });

  it("the pause between two reads is bounded by the same deadline: evidence that is not what is expected, read just before it, is not re-read after it", async () => {
    const hand = handClock();
    const reads = heldReads<Sessions>();
    const wait = untilNoSession(hand, reads);

    hand.tick(BUDGET_MS - 10);
    reads.answer(0, [{ pid: 7 }]);
    await hand.set(2);
    // Ten milliseconds are left, so the pause is ten — not the interval, which would outlast them.
    expect(hand.delays()).toEqual([BUDGET_MS, 10]);
    hand.tick(10);
    await turn();

    expect(wait.state()).toBe("rejected");
    const failure = await rejection(wait);
    expect(failure).toBeInstanceOf(RaceHarnessError);
    expect((failure as Error).message).toBe(`no evidence within ${BUDGET_MS} ms of no session left; last saw [{"pid":7}]`);
    expect(reads.count(), "no read is started at the deadline").toBe(1);
    expect(hand.delays()).toEqual([BUDGET_MS, 10]);
  });
});

describe("race harness (5, the real clock): a deadline is read from a MONOTONIC clock — setting the wall clock neither extends it nor cuts it short", () => {
  /**
   * An EVIDENCE wait and a CLEANUP bound, each given NO clock: they run on the harness's real one.
   * What is staged is what that clock is read from. The monotonic reading (`performance.now`) is
   * set by the test to exactly the side of the deadline each case names, and the WALL clock (`Date`)
   * is set a week the other way — the way that would rescue, or condemn, a deadline read from it.
   * The timers that bound them are the real ones, and are never reached: nothing here waits for one.
   */
  type Sessions = { pid: number }[];
  const WEEK_MS = 7 * 24 * 60 * 60 * 1_000;

  it.each([
    {
      wall: "BACK a week", moved: -WEEK_MS, monotonic: "has reached the deadline", elapsed: BUDGET_MS, inTime: false,
      verdict: "the evidence is late and the step has not met its bound: a wall clock set back does not EXTEND a deadline",
    },
    {
      wall: "FORWARD a week", moved: WEEK_MS, monotonic: "is one millisecond short of the deadline", elapsed: BUDGET_MS - 1, inTime: true,
      verdict: "the evidence is accepted and the step has met its bound: a wall clock set forward does not CUT A DEADLINE SHORT",
    },
  ])("the wall clock is set $wall while the monotonic clock $monotonic — $verdict", async ({ moved, elapsed, inTime }) => {
    const reads = heldReads<Sessions>();
    const work = controlled<string>();
    const startedAt = Date.now();
    const origin = performance.now();
    const monotonic = vi.spyOn(performance, "now").mockReturnValue(origin);
    try {
      // Both begin at the same monotonic reading, each with the same budget.
      const wait = inFlight(untilEvidence({
        read: reads.read,
        accept: (sessions) => sessions.length === 0,
        expected: "no session left",
        show: (sessions) => JSON.stringify(sessions),
        timeoutMs: BUDGET_MS,
      }));
      const bounded = inFlight(withinBound(work.promise, BUDGET_MS));
      expect(reads.count()).toBe(1);
      expect(monotonic, "the real clock is read from the monotonic source").toHaveBeenCalled();

      // THE WALL CLOCK IS SET, by a week — and the monotonic clock moves by exactly `elapsed`.
      vi.setSystemTime(startedAt + moved);
      expect(Date.now(), "the wall clock really was set").toBe(startedAt + moved);
      monotonic.mockReturnValue(origin + elapsed);
      reads.answer(0, []);
      work.resolve("done");

      // THE EVIDENCE WAIT…
      const outcome = await wait.promise.then((value) => ({ value }), (error: unknown) => ({ error }));
      if (inTime) {
        expect(outcome).toEqual({ value: [] });
      } else {
        const failure = "error" in outcome ? outcome.error : null;
        expect(failure, "acceptable evidence, read at the monotonic deadline, must not be accepted").toBeInstanceOf(RaceHarnessError);
        expect((failure as Error).message).toBe(
          `no evidence within ${BUDGET_MS} ms of no session left; what was expected was read only at or after the deadline: []`,
        );
      }
      expect(reads.count(), "one read: the wait ended there, either way").toBe(1);
      // …AND THE CLEANUP BOUND, by the same clock.
      expect(await bounded.promise).toBe(inTime);
    } finally {
      vi.useRealTimers();
      monotonic.mockRestore();
    }
  });
});

describe("race harness (6): every bounded step ends at its deadline — settling at or after it, ahead of an overdue timer, is not settling in time (a clock and operations moved by hand)", () => {
  /**
   * The bound every cleanup step is — the raced operations settling in a round, a connection being
   * closed, a signal being acknowledged — taken by itself, and then as the rounds of cleanup. The
   * work is a promise the test settles, either way; the clock is moved by the test and its timers
   * are WITHHELD (`drift`), so each case puts the settlement on exactly the side of the deadline it
   * names with the timer that should have said so still not run. Nothing sleeps; no database.
   */
  const settlements = [
    { how: "RESOLVES", settle: (work: Controlled<string>) => work.resolve("done") },
    { how: "REJECTS", settle: (work: Controlled<string>) => work.reject(new Error("the operation failed")) },
  ];
  const moments = [
    { when: "one millisecond BEFORE", elapsed: BUDGET_MS - 1, inTime: true },
    { when: "exactly AT", elapsed: BUDGET_MS, inTime: false },
    { when: "one millisecond AFTER", elapsed: BUDGET_MS + 1, inTime: false },
  ];
  const everyCase = settlements.flatMap((settlement) => moments.map((moment) => ({ ...settlement, ...moment })));
  const operation = { label: "the operation", backends: [] as number[] };
  /** Cleanup of one operation that never touches the database, each round given `BUDGET_MS`, on a hand clock. */
  const cleanupOf = (hand: HandClock, work: Controlled<string>) => inFlight(settleStarted(
    [{ label: operation.label, run: () => work.promise }],
    { bounds: { cleanupMs: BUDGET_MS }, cleanup: { clock: hand.clock } },
  ));

  it.each(everyCase)("work that $how $when its deadline, the timer for it withheld — met its bound: $inTime", async ({ settle, elapsed, inTime }) => {
    const hand = handClock();
    const work = controlled<string>();
    const unhandled = watchUnhandled();
    try {
      const bounded = inFlight(withinBound(work.promise, BUDGET_MS, hand.clock));
      expect(hand.delays()).toEqual([BUDGET_MS]);

      // THE CLOCK MOVES AND NO TIMER IS RUN: only asking the clock can tell when the work settled.
      hand.drift(elapsed);
      expect(hand.outstanding()).toBe(1);
      await turn();
      expect(bounded.state(), "nothing has ended it: no timer fired, and the work has not settled").toBe("pending");
      settle(work);

      expect(await bounded.promise).toBe(inTime);
      expect(hand.outstanding(), "its timer was called off, not left to fire").toBe(0);
      expect(hand.delays()).toEqual([BUDGET_MS]);
      await turn();
      expect(unhandled.seen, "a rejection is observed, in time or not").toEqual([]);
    } finally {
      unhandled.stop();
    }
  });

  it.each(settlements)("work still PENDING when the timer for its deadline fires has not met its bound — and when it later $how, nothing comes of it", async ({ settle }) => {
    const hand = handClock();
    const work = controlled<string>();
    const unhandled = watchUnhandled();
    try {
      const bounded = inFlight(withinBound(work.promise, BUDGET_MS, hand.clock));
      hand.tick(BUDGET_MS - 1);
      await turn();
      expect(bounded.state()).toBe("pending");

      hand.tick(1);
      expect(await bounded.promise).toBe(false);

      // THE WORK SETTLES NOW — observed, and dropped: no second verdict, no unhandled rejection.
      settle(work);
      await turn();
      expect(unhandled.seen).toEqual([]);
      expect(bounded.state()).toBe("resolved");
      expect(await bounded.promise).toBe(false);
      expect(hand.delays()).toEqual([BUDGET_MS]);
      expect(hand.outstanding()).toBe(0);
    } finally {
      unhandled.stop();
    }
  });

  it.each(settlements)("CLEANUP: an operation that $how one millisecond before the first round's deadline makes that round `quiet`", async ({ settle }) => {
    const hand = handClock();
    const work = controlled<string>();
    const unhandled = watchUnhandled();
    try {
      const cleanup = cleanupOf(hand, work);
      await hand.set(1);
      expect(hand.delays(), "the first round: the operations settling, within one cleanup budget").toEqual([BUDGET_MS]);

      hand.drift(BUDGET_MS - 1);
      settle(work);

      expect(await cleanup.promise).toEqual({ outcome: "quiet", signalled: [], operations: [{ ...operation, settled: true }] });
      expect(hand.delays(), "no other round was needed").toEqual([BUDGET_MS]);
      expect(hand.outstanding()).toBe(0);
      await turn();
      expect(unhandled.seen).toEqual([]);
    } finally {
      unhandled.stop();
    }
  });

  it.each(everyCase.filter((each) => !each.inTime))("CLEANUP: an operation that $how $when the first round's deadline, ahead of the overdue timer, does NOT make that round quiet — it is found settled by the NEXT round, whose outcome it is", async ({ settle, elapsed }) => {
    const hand = handClock();
    const work = controlled<string>();
    const unhandled = watchUnhandled();
    try {
      const cleanup = cleanupOf(hand, work);
      await hand.set(1);

      // THE ROUND'S DEADLINE PASSES ON THE CLOCK, its timer is not run, and the operation settles.
      hand.drift(elapsed);
      expect(hand.outstanding()).toBe(1);
      settle(work);

      const report = await cleanup.promise;
      expect(report.outcome, "a late settlement must not qualify for the round whose deadline it missed").not.toBe("quiet");
      // With no connection of its own there was nothing to signal: the cancel round simply found it settled.
      expect(report).toEqual({ outcome: "cancelled", signalled: [], operations: [{ ...operation, settled: true }] });
      // The next round was a new one, with a budget of its own — which it did not need.
      expect(hand.delays()).toEqual([BUDGET_MS, BUDGET_MS]);
      expect(hand.outstanding()).toBe(0);
      await turn();
      expect(unhandled.seen).toEqual([]);
    } finally {
      unhandled.stop();
    }
  });

  it.each(settlements)("CLEANUP: an operation still pending through all three rounds is `unproven` — and when it then $how, no round is reopened and the report does not change", async ({ settle }) => {
    const hand = handClock();
    const work = controlled<string>();
    const unhandled = watchUnhandled();
    try {
      const cleanup = cleanupOf(hand, work);
      // SETTLE, CANCEL, TERMINATE: each round's deadline passes with the operation still pending.
      for (const round of [1, 2, 3]) {
        await hand.set(round);
        await turn();
        expect(cleanup.state(), `round ${round} is still waiting`).toBe("pending");
        hand.tick(BUDGET_MS);
      }

      const report = await cleanup.promise;
      expect(report).toEqual({ outcome: "unproven", signalled: [], operations: [{ ...operation, settled: false }] });
      expect(hand.delays()).toEqual([BUDGET_MS, BUDGET_MS, BUDGET_MS]);

      // THE OPERATION SETTLES NOW — after the last round. Observed, and dropped.
      settle(work);
      await turn();
      expect(unhandled.seen).toEqual([]);
      expect(await cleanup.promise).toBe(report);
      expect(report.outcome).toBe("unproven");
      expect(hand.delays(), "no round was started for it").toEqual([BUDGET_MS, BUDGET_MS, BUDGET_MS]);
      expect(hand.outstanding()).toBe(0);
    } finally {
      unhandled.stop();
    }
  });
});

describe("race harness (5, in a barrier): proof of a barrier's absence that arrives after its cleanup budget is not proof (real Postgres)", () => {
  it("the one read of its absence is still pending when the budget runs out: the barrier is `unproven`, the run is stopped and the marker stays — and so they stay when that read is then let through and shows the session gone", async () => {
    // Staged in a run-safety state of this test's own: the real run is not stopped by testing what stops it.
    const { directory, safety } = privateRun();
    const tag = `late-${randomUUID().slice(0, 8)}`;
    const hand = handClock();
    const held = gate();
    const asked = tally();
    let lateReads: Promise<unknown>[] = [];
    // In front of every read of the barrier's absence: counted when the harness asks for it, and
    // MADE — the real read, of the real `pg_stat_activity` — only once this test opens its gate.
    const read = <T>(real: () => Promise<T>): Promise<T> => {
      const late = held.opened.then(real);
      lateReads = [...lateReads, late.then((value: unknown) => value, (error: unknown) => error)];
      asked.note();
      return late;
    };
    // The barrier is a REAL session, and its marker is in the private state, which the real run
    // does not read. So the real run carries a sentinel of its own until that session is SEEN gone.
    const staged = stagedOnRealRun("a barrier whose absence is read only after its cleanup budget has run out");
    let barrier: Barrier | undefined;
    let releaseStaged = false;
    try {
      // Acquired on the real clock and the real reads: nothing is staged until the barrier is held.
      barrier = await holdNamedLock(`harness-late:${randomUUID()}`, { tag, safety, acquisition: staged.acquiring() });
      expect(safety.armed()).toEqual([tag]);
      expect(await barrierSessions(tag)).toEqual([{ pid: barrier.pid, state: "idle in transaction" }]);
      expect(currentRunSafety().armed(), "the real run: the sentinel, and only the sentinel").toEqual([staged.scope]);

      // ITS RELEASE BEGINS. The connection is really closed; then the proof of its absence is asked
      // for — on a clock this test moves, from a read this test holds back.
      releaseStaged = true;
      const vanishing = inFlight(barrier.vanish(BUDGET_MS, { clock: hand.clock, read }));
      // Until the read is asked for — or, were it never to be, until `vanish` has ended without it.
      await Promise.race([asked.reached(1), vanishing.promise.then(() => undefined, () => undefined)]);
      expect(asked.count(), "the proof of absence was asked for").toBe(1);
      expect(hand.delays(), "that read is bounded by the cleanup budget").toEqual([BUDGET_MS]);
      await turn();
      expect(vanishing.state()).toBe("pending");

      // THE CLEANUP BUDGET RUNS OUT with that one read still pending.
      hand.tick(BUDGET_MS);
      await turn();
      expect(vanishing.state(), "a proof still being read at the deadline must not keep cleanup waiting").toBe("resolved");
      expect(await vanishing.promise, "not seen gone within the budget").toBe(false);
      expect(asked.count(), "exactly one read: none is started once the budget is spent").toBe(1);

      // So the release is refused, as `unproven`, and THE RUN IS STOPPED: a fatal reason, the
      // marker still on file, and the guard the setup file runs — at module scope and before every
      // TRUNCATE — refusing.
      const failure = await barrier.release().then(() => null, (error: unknown) => error);
      expect(failure).toBeInstanceOf(RaceScheduleError);
      expect((failure as RaceScheduleError).cleanup).toEqual({ outcome: "unproven", barrierGone: false, signalled: [], operations: [] });
      const reason = safety.fatal();
      expect(reason).toMatch(/barrier late-[a-f0-9]+ was released, and its session could not be proven gone/);
      expect(safety.armed()).toEqual([tag]);
      expect(() => assertRunSafe(safety)).toThrow(/run STOPPED — refusing to truncate or run another test/);

      // The session really is gone by now — seen by this test's own reading, on the real clock —
      // so what the held read will return is exactly the evidence the harness was waiting for.
      await untilBarrierGone(tag);

      // THE LATE READ IS LET THROUGH, and returns it: no session under the tag.
      held.open();
      expect(await lateReads[0]).toEqual([]);
      await turn();

      // NOTHING CAME OF IT. The wait did not go on: no other read, no pause, no other bound…
      expect(asked.count()).toBe(1);
      expect(lateReads).toHaveLength(1);
      expect(hand.delays()).toEqual([BUDGET_MS]);
      // …the barrier is as unproven as it was, to the schedules and to its own release…
      expect(await barrier.vanish(BUDGET_MS)).toBe(false);
      expect(await barrier.release().then(() => null, (error: unknown) => error)).toBe(failure);
      // …no later conclusion clears what was concluded…
      barrier.conclude(true, "");
      expect(safety.armed()).toEqual([tag]);
      expect(safety.fatal()).toBe(reason);
      expect(safety.setFatal("a later, different reason")).toBe(reason);
      // …and the guard still refuses — here, and for any other reader of the same state, as the
      // next test file's worker is.
      expect(() => assertRunSafe(safety)).toThrow(/run STOPPED — refusing to truncate or run another test/);
      const elsewhere = createRunSafety(directory);
      expect(elsewhere.armed()).toEqual([tag]);
      expect(elsewhere.fatal()).toBe(reason);
      expect(() => assertRunSafe(elsewhere)).toThrow(/run STOPPED/);
      // The real run was not stopped by this test: its state is not this one.
      expect(raceHarnessFatal()).toBeNull();
      expect(currentRunSafety().armed()).toEqual([staged.scope]);
    } finally {
      // ON EVERY EXIT nothing stays held back, and the real run's sentinel comes off only once the
      // barrier's session is SEEN gone — as the exact backend its acquisition put on the sentinel's
      // books, and under its tag, by this test's own reading on the real clock. `vanish` closes the
      // connection before it asks for any evidence, so a release that was staged has closed it
      // whatever became of the staged proof, and is NOT awaited here: on the hand clock it might
      // never end. A barrier this test never got to release is released now, for real — as the one
      // bounded closing of this retirement, which must be acknowledged. If the session cannot be
      // seen gone, this throws, the sentinel stays, and the real run stops.
      held.open();
      await staged.retire(async () => {
        if (barrier && !releaseStaged) await barrier.release();
        return "closed";
      }, () => untilBarrierGone(tag));
    }
    // The sentinel took nothing else with it: the staged state is still stopped, its scope still on
    // file, and the real run is clean.
    expect(safety.armed()).toEqual([tag]);
    expect(safety.fatal()).toMatch(/could not be proven gone/);
    expect(currentRunSafety().blocked()).toBeNull();
  }, RACE_TEST_TIMEOUT_MS);
});

/** The harness's bound on one statement of a connection of its own — and so on closing one, and on a signal's acknowledgement. */
const OWNED_BOUND_MS = 10_000;

interface StagedClosing {
  hand: HandClock;
  /** What the staged closing answers with — when, and if, the test says so. */
  verdict: Controlled<Disposal | void>;
  /** Counts the times the harness asked for the connection to be closed. */
  asked: ReturnType<typeof tally>;
  /** Every client the harness asked to have closed, in order. */
  handed: Client[];
  /** The seam itself: what the harness is given in place of closing the connection. */
  dispose: (client: Client) => Promise<Disposal | void>;
  /** From here on a closing is the test's to answer. Until then it is a real one, honestly reported. */
  stage: () => void;
  staging: () => boolean;
}

/**
 * Something to stand in front of the closing of ONE harness-owned connection, on a clock moved by
 * hand. Until `stage()` it really closes the connection and says so — so an acquisition that fails
 * before the test has staged anything is cleaned up for real, and does not hang on a clock nobody
 * moves. After it, the closing does nothing and answers only what, and when, the test makes it.
 */
function stagedClosing(): StagedClosing {
  const hand = handClock();
  const verdict = controlled<Disposal | void>();
  const asked = tally();
  const handed: Client[] = [];
  let staging = false;
  return {
    hand,
    verdict,
    asked,
    handed,
    dispose: (client) => {
      handed.push(client);
      asked.note();
      return staging ? verdict.promise : client.end().then((): Disposal => "closed");
    },
    stage: () => { staging = true; },
    staging: () => staging,
  };
}

describe("race harness (7): a closing that was not acknowledged in time is not proven later — the barrier stays `unproven`, its marker on file and the run stopped, though its session IS gone (real Postgres)", () => {
  /**
   * The barrier is a real session, and in every case this test really closes it and SEES it gone
   * before the staged closing answers at all: the database evidence of its absence is there, and
   * reads of it succeed. What is missing is only the acknowledgement of the closing, in time — and
   * that alone must keep the barrier `unproven`, then and for good.
   */
  const unacknowledged: {
    what: string;
    then: string;
    stage: (staged: StagedClosing) => void;
    later: (staged: StagedClosing) => void;
  }[] = [
    {
      what: "is still PENDING at its deadline",
      then: "is acknowledged `closed` only afterwards",
      stage: ({ hand }) => hand.tick(OWNED_BOUND_MS),
      later: ({ verdict }) => verdict.resolve("closed"),
    },
    {
      what: "is acknowledged `closed` exactly AT its deadline, ahead of the overdue timer",
      then: "that timer is finally run",
      stage: ({ hand, verdict }) => { hand.drift(OWNED_BOUND_MS); verdict.resolve("closed"); },
      later: ({ hand }) => hand.tick(OWNED_BOUND_MS),
    },
    {
      what: "REJECTS, in time",
      then: "its deadline passes",
      stage: ({ verdict }) => verdict.reject(new Error("Connection terminated unexpectedly")),
      later: ({ hand }) => hand.tick(OWNED_BOUND_MS),
    },
    {
      what: "is OPAQUE — it resolves in time, and does not say `closed`",
      then: "its deadline passes",
      stage: ({ verdict }) => verdict.resolve(undefined),
      later: ({ hand }) => hand.tick(OWNED_BOUND_MS),
    },
  ];

  it.each(unacknowledged)("a closing that $what: `unproven`, the marker kept and the run stopped while reads of the session's absence succeed — and so it stays when $then", async ({ stage, later }) => {
    // Staged in a run-safety state of this test's own: the real run is not stopped by testing what stops it.
    const { directory, safety } = privateRun();
    const tag = `closing-${randomUUID().slice(0, 8)}`;
    const closing = stagedClosing();
    const { hand, asked, handed } = closing;
    const unhandled = watchUnhandled();
    // The barrier is a REAL session whose marker is in the private state, which the real run does
    // not read: the real run carries a sentinel of its own until that session is SEEN gone.
    const staged = stagedOnRealRun("a barrier whose closing is staged not to be acknowledged in time");
    let barrier: Barrier | undefined;
    try {
      // RESERVED on the real run's sentinel before it is asked for: its own acquisition puts its exact
      // backend on those books — before anything is staged in front of its closing, and whether or
      // not a barrier is then handed out.
      barrier = await holdNamedLock(`harness-closing:${randomUUID()}`, {
        tag, safety, clock: hand.clock, dispose: closing.dispose, acquisition: staged.acquiring(),
      });
      expect(() => staged.clear(), "acquired is not retired: the sentinel cannot simply be taken off")
        .toThrow(/is NOT cleared: 1 real session\(s\) this test staged were not closed and SEEN gone/);
      expect(safety.armed()).toEqual([tag]);
      expect(await barrierSessions(tag)).toEqual([{ pid: barrier.pid, state: "idle in transaction" }]);
      expect(asked.count(), "nothing has been closed yet").toBe(0);

      // ITS RELEASE BEGINS: the harness asks for the connection to be closed, and bounds that —
      // as the one step it is — on the clock this test moves.
      closing.stage();
      const releasing = inFlight(barrier.release());
      await Promise.race([asked.reached(1), releasing.promise.then(() => undefined, () => undefined)]);
      expect(asked.count(), "the closing was asked for").toBe(1);
      expect(hand.delays(), "and it is bounded").toEqual([OWNED_BOUND_MS]);
      await turn();
      expect(releasing.state()).toBe("pending");

      // THE SESSION REALLY GOES — closed by this test, behind the harness's back, and SEEN gone by
      // its tag and by its backend. Everything the database could say of its absence, it now says.
      await handed[0].end();
      await untilBarrierGone(tag);
      await untilSessions([barrier.pid], "the barrier's backend gone", (sessions) => sessions.length === 0);

      // …BUT THE CLOSING IS NOT ACKNOWLEDGED IN TIME.
      stage(closing);
      const failure = await releasing.promise.then(() => null, (error: unknown) => error);
      expect(failure).toBeInstanceOf(RaceScheduleError);
      expect((failure as RaceScheduleError).cleanup).toEqual({ outcome: "unproven", barrierGone: false, signalled: [], operations: [] });
      // THE RUN IS STOPPED: a fatal reason, the marker still on file, and the guard refusing…
      const reason = safety.fatal();
      expect(reason).toMatch(/barrier closing-[a-f0-9]+ was released, and its session could not be proven gone/);
      expect(safety.armed()).toEqual([tag]);
      expect(() => assertRunSafe(safety)).toThrow(/run STOPPED — refusing to truncate or run another test/);
      // …WHILE READS OF ITS ABSENCE SUCCEED: no session under the tag, and not that backend.
      expect(await barrierSessions(tag)).toEqual([]);
      expect(await sessionEvidence([barrier.pid])).toEqual([]);

      // WHATEVER COMES LATER — the acknowledgement itself, or the timer that was overdue.
      later(closing);
      await turn();

      // NOTHING CAME OF IT. Not an unhandled rejection; the closing was not asked for again, and no
      // other bound was started…
      expect(unhandled.seen).toEqual([]);
      expect(asked.count()).toBe(1);
      expect(hand.delays()).toEqual([OWNED_BOUND_MS]);
      // …the barrier is as unproven as it was, to the schedules and to its own release…
      expect(await barrier.vanish(BUDGET_MS)).toBe(false);
      expect(await barrier.release().then(() => null, (error: unknown) => error)).toBe(failure);
      // …no later conclusion clears what was concluded…
      barrier.conclude(true, "");
      expect(safety.armed()).toEqual([tag]);
      expect(safety.fatal()).toBe(reason);
      expect(safety.setFatal("a later, different reason")).toBe(reason);
      // …and the guard still refuses — here, and for any other reader of the same state — with the
      // session's absence still there to be read.
      expect(await barrierSessions(tag)).toEqual([]);
      expect(() => assertRunSafe(safety)).toThrow(/run STOPPED — refusing to truncate or run another test/);
      const elsewhere = createRunSafety(directory);
      expect(elsewhere.armed()).toEqual([tag]);
      expect(elsewhere.fatal()).toBe(reason);
      expect(() => assertRunSafe(elsewhere)).toThrow(/run STOPPED/);
      // The real run was not stopped by this test: its state is not this one.
      expect(raceHarnessFatal()).toBeNull();
      expect(currentRunSafety().armed()).toEqual([staged.scope]);
    } finally {
      // ON EVERY EXIT nothing stays held back, and the barrier's session is REALLY closed: a barrier
      // this test never got to release is released for real, and every connection the harness asked
      // to have closed is ended. That closing is one bounded step and must be acknowledged; the
      // session must then be SEEN gone — as the exact backend on the sentinel's books, and under its
      // tag — and only then does the real run's sentinel come off. A closing that rejects, is still
      // pending at its bound or answers late, or a session not seen gone, leaves the sentinel on
      // file, STOPS the real run, and this throws.
      unhandled.stop();
      closing.verdict.resolve(undefined);
      await staged.retire(async () => {
        if (barrier && !closing.staging()) await barrier.release();
        for (const client of handed) await client.end();
        return "closed";
      }, () => untilBarrierGone(tag));
    }
    // The sentinel took nothing else with it: the staged state is still stopped, its scope still on
    // file, and the real run is clean.
    expect(safety.armed()).toEqual([tag]);
    expect(safety.fatal()).toMatch(/could not be proven gone/);
    expect(currentRunSafety().blocked()).toBeNull();
  }, RACE_TEST_TIMEOUT_MS);

  it("the control: a closing acknowledged `closed` one millisecond BEFORE its deadline, its session then seen gone, IS proven — the marker comes off and the run goes on", async () => {
    const { safety } = privateRun();
    const tag = `closed-${randomUUID().slice(0, 8)}`;
    const closing = stagedClosing();
    const { hand, asked, handed } = closing;
    const staged = stagedOnRealRun("a barrier whose closing is staged to be acknowledged just in time");
    let barrier: Barrier | undefined;
    try {
      barrier = await holdNamedLock(`harness-closed:${randomUUID()}`, {
        tag, safety, clock: hand.clock, dispose: closing.dispose, acquisition: staged.acquiring(),
      });
      expect(safety.armed()).toEqual([tag]);

      closing.stage();
      const releasing = inFlight(barrier.release());
      await Promise.race([asked.reached(1), releasing.promise.then(() => undefined, () => undefined)]);
      expect(asked.count()).toBe(1);
      expect(hand.delays()).toEqual([OWNED_BOUND_MS]);

      // The same seam, the same clock, the same real closing behind the harness's back — and the
      // acknowledgement one millisecond inside the bound, its timer still not run.
      await handed[0].end();
      hand.drift(OWNED_BOUND_MS - 1);
      expect(hand.outstanding()).toBe(1);
      closing.verdict.resolve("closed");

      // The release resolves: the closing was acknowledged, and the session's absence — read by
      // the harness, on the real clock — was then seen.
      await releasing.promise;
      expect(hand.outstanding(), "the bound on the closing was called off").toBe(0);
      expect(await barrierSessions(tag)).toEqual([]);
      expect(safety.armed()).toEqual([]);
      expect(safety.fatal()).toBeNull();
      expect(() => assertRunSafe(safety)).not.toThrow();
      expect(currentRunSafety().armed()).toEqual([staged.scope]);
    } finally {
      // As above: one bounded, acknowledged closing, that exact backend then SEEN gone, or the
      // sentinel stays and the real run stops.
      closing.verdict.resolve(undefined);
      await staged.retire(async () => {
        if (barrier && !closing.staging()) await barrier.release();
        for (const client of handed) await client.end();
        return "closed";
      }, () => untilBarrierGone(tag));
    }
    expect(currentRunSafety().blocked()).toBeNull();
  }, RACE_TEST_TIMEOUT_MS);
});

describe("race harness (7, signals): a signal PostgreSQL did not acknowledge in time strands its lease and leaves cleanup `unproven` for good (real Postgres)", () => {
  /**
   * A raced operation holds one pool connection, in a transaction, when cleanup comes to cancel it.
   * The CANCEL's acknowledgement is this test's to give (`CleanupSeam.signal`) and it does not give
   * it: its deadline passes on a clock moved by hand. Meanwhile the operation finishes and releases
   * its connection — which must not reach the pool. Cleanup goes on: the TERMINATE is the real one,
   * really executed and acknowledged in time. None of that may hand the connection back or make the
   * outcome anything but `unproven`; and nor may the cancel's acknowledgement, when it finally comes.
   *
   * The schedule's own waits and the evidence waits run on the real clock, answered by PostgreSQL.
   * Only the steps of cleanup that are not evidence waits are on the hand clock — and there are
   * exactly five of them, in a fixed order, so each is waited for as an event, never as a time.
   */
  it.each([
    { later: "RESOLVES", settle: (ack: Controlled<unknown>) => ack.resolve([{ pg_cancel_backend: true }]) },
    { later: "REJECTS", settle: (ack: Controlled<unknown>) => ack.reject(new Error("Connection terminated unexpectedly")) },
  ])("the cancel's acknowledgement is still PENDING at its deadline: the lease is stranded — never handed to the pool, not on the operation's release and not after a terminate that IS acknowledged — and cleanup is `unproven`; when it later $later, nothing changes", async ({ settle }) => {
    const pool = getPool();
    const { directory, safety } = privateRun();
    const tag = `ack-${randomUUID().slice(0, 8)}`;
    const lockName = `harness-ack:${randomUUID()}`;
    const CLEANUP_MS = 300;
    const hand = handClock();
    const ack = controlled<unknown>();
    const asked = tally();
    const signals: PendingSignal[] = [];
    const proceed = gate();
    const released = gate();
    // The raced operation's backend, and its checked-out client: filled in by the operation itself.
    const owners: BackendIdentity[] = [];
    const held: PoolClient[] = [];
    // Every time the POOL is given the raced operation's connection back, and with what.
    const handedBack: unknown[] = [];
    const onRelease = (error: unknown, client: unknown): void => {
      if (owners.some((owner) => (client as { processID?: unknown }).processID === owner.pid)) handedBack.push(error);
    };
    // In front of every signal. The CANCEL is not sent at all, and what is waited for as its
    // acknowledgement is this test's promise; the TERMINATE is the real one, as it comes.
    const signal = (pending: PendingSignal, send: () => Promise<unknown>): Promise<unknown> => {
      signals.push(pending);
      asked.note();
      return pending.signal === "cancel" ? ack.promise : send();
    };
    const unhandled = watchUnhandled();
    // Real sessions are staged here under a run-safety state the real run does not read: a barrier,
    // and a raced operation's backend left in a transaction. The real run carries a sentinel until
    // both are SEEN gone or idle.
    const staged = stagedOnRealRun("a raced operation whose cancel is staged not to be acknowledged in time");
    let barrier: Barrier | undefined;
    try {
      pool.on("release", onRelease);
      barrier = await holdNamedLock(lockName, { tag, safety, acquisition: staged.acquiring() });
      const scheduled = inFlight(parkThenCompete({
        seed: { teamId: randomUUID() },
        barrier,
        parksOn: "advisory",
        // The raced operation: one pool connection, in a transaction, parked on the barrier's lock.
        // Past it, it waits for this test's gate and for nothing in the database — so it is still
        // holding its connection when cleanup comes to signal it.
        first: async () => {
          const client = await pool.connect();
          held.push(client);
          try {
            owners.push(await staged.identify(client));
            await client.query("begin");
            await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [lockName]);
            await proceed.opened;
            await client.query("rollback");
          } finally {
            client.release();
            released.open();
          }
          return "released";
        },
        // The schedule itself fails at once, so cleanup runs with the first operation still held.
        second: async () => "finished without waiting",
        bounds: { cleanupMs: CLEANUP_MS },
        cleanup: { clock: hand.clock, signal },
      }));
      const over = scheduled.promise.then(() => undefined, () => undefined);

      // ROUND ONE: the operation has not settled when its budget runs out.
      await Promise.race([hand.set(1), over]);
      expect(hand.delays(), "the first round: the operations settling").toEqual([CLEANUP_MS]);
      expect(scheduled.state()).toBe("pending");
      hand.tick(CLEANUP_MS);

      // THE CANCEL: aimed at the raced operation's own backend, and its acknowledgement bounded.
      await Promise.race([asked.reached(1), over]);
      expect(signals).toEqual([{ signal: "cancel", backends: [owners[0].pid] }]);
      await Promise.race([hand.set(2), over]);
      expect(hand.delays(), "the acknowledgement of the cancel is bounded").toEqual([CLEANUP_MS, OWNED_BOUND_MS]);
      await untilSessions([owners[0].pid], "the raced operation idle in its transaction",
        (sessions) => sessions.length === 1 && sessions[0].state === "idle in transaction" && sessions[0].waitingOn === null);

      // WITH THE ACKNOWLEDGEMENT OUTSTANDING, THE OPERATION FINISHES AND RELEASES. Its transaction
      // is over, its backend idle — and the pool has not been given the connection.
      proceed.open();
      await released.opened;
      await untilSessions([owners[0].pid], "the raced operation's backend idle, its transaction over",
        (sessions) => sessions.length === 1 && sessions[0].state === "idle");
      expect(handedBack, "the pool must not be given a backend a signal is aimed at").toEqual([]);
      expect(scheduled.state()).toBe("pending");

      // THE ACKNOWLEDGEMENT'S DEADLINE PASSES. Cleanup goes on by itself from here: the next round
      // finds the operation settled; a terminate — the real one — is executed and acknowledged; the
      // last round ends. Each of those is inside its own bound, so no timer has to be run for it.
      hand.tick(OWNED_BOUND_MS);
      const failure = await scheduled.promise.then(() => null, (error: unknown) => error);

      expect(failure).toBeInstanceOf(RaceScheduleError);
      const { cleanup, message } = failure as RaceScheduleError;
      expect(message).toContain("the competing operation finished without waiting");
      // UNPROVEN — with the barrier seen gone, the operation settled, and both signals asked for.
      expect(cleanup.outcome).toBe("unproven");
      expect(cleanup.barrierGone).toBe(true);
      expect(cleanup.signalled).toEqual([owners[0].pid]);
      expect(cleanup.operations).toEqual([
        { label: "the parked operation", backends: [owners[0].pid], settled: true },
        { label: "the competing operation", backends: [], settled: true },
      ]);
      // The rounds went on as they do: the terminate was aimed at that same backend — still the
      // operation's own, because its connection was never let back into the pool.
      expect(signals).toEqual([
        { signal: "cancel", backends: [owners[0].pid] },
        { signal: "terminate", backends: [owners[0].pid] },
      ]);
      // Five bounded steps, in order: settle, the cancel's acknowledgement, settle, the terminate's
      // acknowledgement, settle. The last three were met, and their timers called off.
      expect(hand.delays()).toEqual([CLEANUP_MS, OWNED_BOUND_MS, CLEANUP_MS, OWNED_BOUND_MS, CLEANUP_MS]);
      expect(hand.outstanding()).toBe(0);
      // THE STRANDED CONNECTION WAS NEVER HANDED BACK: not when its operation released it, and not
      // when a later signal at the same backend was executed and acknowledged.
      expect(handedBack).toEqual([]);
      // THE RUN IS STOPPED: a fatal reason, the marker still on file, and the guard refusing.
      const reason = safety.fatal();
      expect(reason).toMatch(/could not be proven settled, idle or disposed/);
      expect(safety.armed()).toEqual([tag]);
      expect(() => assertRunSafe(safety)).toThrow(/run STOPPED — refusing to truncate or run another test/);
      // The terminate was real: that backend is gone.
      await untilSessions([owners[0].pid], "the terminated backend gone", (sessions) => sessions.length === 0);

      // THE CANCEL'S ACKNOWLEDGEMENT COMES NOW — long after its deadline.
      settle(ack);
      await turn();

      // NOTHING CAME OF IT. Not an unhandled rejection; the connection is still not the pool's; no
      // signal was sent for it and no bound started…
      expect(unhandled.seen).toEqual([]);
      expect(handedBack).toEqual([]);
      expect(signals).toHaveLength(2);
      expect(hand.delays()).toEqual([CLEANUP_MS, OWNED_BOUND_MS, CLEANUP_MS, OWNED_BOUND_MS, CLEANUP_MS]);
      // …the verdict is what it was, and no later conclusion clears it…
      barrier.conclude(true, "");
      await barrier.release();
      expect(safety.armed()).toEqual([tag]);
      expect(safety.fatal()).toBe(reason);
      expect(safety.setFatal("a later, different reason")).toBe(reason);
      // …and the guard still refuses — here, and for any other reader of the same state.
      expect(() => assertRunSafe(safety)).toThrow(/run STOPPED — refusing to truncate or run another test/);
      const elsewhere = createRunSafety(directory);
      expect(elsewhere.armed()).toEqual([tag]);
      expect(elsewhere.fatal()).toBe(reason);
      expect(() => assertRunSafe(elsewhere)).toThrow(/run STOPPED/);
      // The real run was not stopped by this test: its state is not this one.
      expect(raceHarnessFatal()).toBeNull();
      expect(currentRunSafety().armed(), "the real run: the sentinel, and only the sentinel").toEqual([staged.scope]);
    } finally {
      // ON EVERY EXIT: nothing stays held back and the raced operation may finish; the barrier is
      // retired — its release (a no-op once the schedule has seen it gone) the one bounded closing,
      // which must be acknowledged, and its session then SEEN gone as the exact backend its
      // acquisition put on the sentinel's books. The sentinel comes off only when, as well, the
      // raced operation's backend is SEEN idle or gone — the backend its connection SAID it is: one
      // that was checked out and never said leaves nothing to see — and only then is the connection
      // the harness stranded retired from the pool by hand, so that no later test inherits a pool
      // one connection short. If any of that cannot be seen, this throws, the sentinel stays, and
      // the real run stops.
      unhandled.stop();
      proceed.open();
      ack.resolve(undefined);
      await staged.retire(async () => {
        await barrier?.release();
        return "closed";
      }, () => untilBarrierGone(tag));
      await staged.seen("the raced operation's backend idle or gone",
        (sessions) => sessions.every((session) => session.state === "idle"));
      pool.removeListener("release", onRelease);
      for (const client of held) discardFromPool(client);
      staged.clear();
    }
  }, RACE_TEST_TIMEOUT_MS);
});

describe("race harness (7, signals — whose acknowledgement): only PostgreSQL's own answer to the real send acknowledges a signal — anything else resolved in its place strands the lease and leaves cleanup `unproven` (real Postgres)", () => {
  /** Shaped exactly like an acknowledgement of the cancel of that backend — and made here, not by the real send. */
  const lookalike = (pid: number): SignalAcknowledgement => ({ signal: "cancel", backends: [{ pid, sent: true }] });
  /** What the cancel's statement answers when PostgreSQL has signalled that backend. */
  const signalledRows = (pid: number): unknown => [{ pid, sent: true }];

  interface StagedAnswer {
    staged: string;
    /** The seam makes the real send — whose statement's answer is then this test's to give. */
    sends: boolean;
    /** What the seam resolves with, when the test says so; `null`: it hands over the real send itself. */
    says: ((pid: number) => unknown) | null;
    /** What the real send's statement answers with, long after the verdict. (Where no send was made
     * nothing awaits that answer, so it is never a rejection there: nobody would observe one.) */
    later: (answered: Controlled<unknown>, pid: number) => void;
  }

  /**
   * The raced operation of the test above, held in the same place when cleanup comes to cancel it.
   * Here BOTH of the cancel's promises are this test's: what the seam in front of the signal
   * resolves with (`CleanupSeam.signal`: `said`), and what the statement of the real send answers
   * (`CleanupSeam.execute`: `answered` — the statement itself is not run, so that send stays pending
   * for exactly as long as this test leaves it). The TERMINATE is the real one, through both.
   *
   * The seam resolves — IN TIME: the clock is not moved — with something that is not PostgreSQL's
   * acknowledgement, while the real send was never made or has not answered. Believed, that would
   * condemn the lease and give the connection to the pool to destroy, with a cancel still to be
   * executed at its PID. It must strand it instead. (Where the seam hands over the real send itself
   * there is nothing to believe: it is simply still pending at its deadline.)
   */
  it.each<StagedAnswer>([
    {
      staged: "resolves with NOTHING AT ALL, the real send never made",
      sends: false,
      says: () => undefined,
      later: (answered, pid) => answered.resolve(signalledRows(pid)),
    },
    {
      staged: "resolves with something SHAPED like an acknowledgement of that very backend, the real send never made",
      sends: false,
      says: lookalike,
      later: (answered, pid) => answered.resolve(signalledRows(pid)),
    },
    {
      staged: "resolves with NOTHING AT ALL while the real send is still PENDING — which later RESOLVES with PostgreSQL's answer",
      sends: true,
      says: () => undefined,
      later: (answered, pid) => answered.resolve(signalledRows(pid)),
    },
    {
      staged: "resolves with something SHAPED like an acknowledgement of that very backend while the real send is still PENDING — which later REJECTS",
      sends: true,
      says: lookalike,
      later: (answered) => answered.reject(new Error("Connection terminated unexpectedly")),
    },
    {
      staged: "hands over the real send itself, still PENDING at its deadline — which later RESOLVES with PostgreSQL's answer",
      sends: true,
      says: null,
      later: (answered, pid) => answered.resolve(signalledRows(pid)),
    },
  ])("the seam in front of the cancel $staged: the lease is stranded — never handed to the pool, not on the operation's release and not after a terminate that IS acknowledged — cleanup is `unproven`, the marker and the fatal reason are kept, and nothing answered afterwards changes that", async ({ sends, says, later }) => {
    const pool = getPool();
    const { directory, safety } = privateRun();
    const tag = `own-ack-${randomUUID().slice(0, 8)}`;
    const lockName = `harness-own-ack:${randomUUID()}`;
    const CLEANUP_MS = 300;
    const hand = handClock();
    const said = controlled<unknown>();
    const answered = controlled<unknown>();
    const asked = tally();
    const signals: PendingSignal[] = [];
    // Every statement a real send was made of: one for each signal whose seam made that send.
    const statements: PendingSignal[] = [];
    const proceed = gate();
    const released = gate();
    // The raced operation's backend, and its checked-out client: filled in by the operation itself.
    const owners: BackendIdentity[] = [];
    const held: PoolClient[] = [];
    // Every time the POOL is given the raced operation's connection back, and with what.
    const handedBack: unknown[] = [];
    const onRelease = (error: unknown, client: unknown): void => {
      if (owners.some((owner) => (client as { processID?: unknown }).processID === owner.pid)) handedBack.push(error);
    };
    // In front of every signal. The TERMINATE is the real send, as it comes. The CANCEL's seam
    // makes the real send or does not, lets go of it, and answers with this test's promise — or
    // hands the real send over as its answer.
    const signal = (pending: PendingSignal, send: () => Promise<unknown>): Promise<unknown> => {
      signals.push(pending);
      asked.note();
      if (pending.signal !== "cancel" || !says) return send();
      if (sends) void send();
      return said.promise;
    };
    // In front of the statement of every real send. The CANCEL's is not run: its answer is this
    // test's promise, so that send is pending until the test says otherwise.
    const execute = (pending: PendingSignal, statement: () => Promise<unknown>): Promise<unknown> => {
      statements.push(pending);
      return pending.signal === "cancel" ? answered.promise : statement();
    };
    const unhandled = watchUnhandled();
    const staged = stagedOnRealRun("a raced operation whose cancel is staged to be acknowledged by something other than PostgreSQL");
    let barrier: Barrier | undefined;
    try {
      pool.on("release", onRelease);
      barrier = await holdNamedLock(lockName, { tag, safety, acquisition: staged.acquiring() });
      const scheduled = inFlight(parkThenCompete({
        seed: { teamId: randomUUID() },
        barrier,
        parksOn: "advisory",
        // The raced operation: one pool connection, in a transaction, parked on the barrier's lock.
        // Past it, it waits for this test's gate and for nothing in the database — so it is still
        // holding its connection when cleanup comes to signal it.
        first: async () => {
          const client = await pool.connect();
          held.push(client);
          try {
            owners.push(await staged.identify(client));
            await client.query("begin");
            await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [lockName]);
            await proceed.opened;
            await client.query("rollback");
          } finally {
            client.release();
            released.open();
          }
          return "released";
        },
        // The schedule itself fails at once, so cleanup runs with the first operation still held.
        second: async () => "finished without waiting",
        bounds: { cleanupMs: CLEANUP_MS },
        cleanup: { clock: hand.clock, signal, execute },
      }));
      const over = scheduled.promise.then(() => undefined, () => undefined);

      // ROUND ONE: the operation has not settled when its budget runs out.
      await Promise.race([hand.set(1), over]);
      expect(hand.delays(), "the first round: the operations settling").toEqual([CLEANUP_MS]);
      expect(scheduled.state()).toBe("pending");
      hand.tick(CLEANUP_MS);

      // THE CANCEL: aimed at the raced operation's own backend, its acknowledgement bounded — and
      // its real send made, of a statement for that same backend, only where the seam made it.
      await Promise.race([asked.reached(1), over]);
      const cancel = { signal: "cancel", backends: [owners[0].pid] };
      const terminate = { signal: "terminate", backends: [owners[0].pid] };
      expect(signals).toEqual([cancel]);
      expect(statements).toEqual(sends ? [cancel] : []);
      await Promise.race([hand.set(2), over]);
      expect(hand.delays(), "the acknowledgement of the cancel is bounded").toEqual([CLEANUP_MS, OWNED_BOUND_MS]);
      await untilSessions([owners[0].pid], "the raced operation idle in its transaction",
        (sessions) => sessions.length === 1 && sessions[0].state === "idle in transaction" && sessions[0].waitingOn === null);

      // WITH NOTHING YET ANSWERED, THE OPERATION FINISHES AND RELEASES. Its transaction is over,
      // its backend idle — and the pool has not been given the connection.
      proceed.open();
      await released.opened;
      await untilSessions([owners[0].pid], "the raced operation's backend idle, its transaction over",
        (sessions) => sessions.length === 1 && sessions[0].state === "idle");
      expect(handedBack, "the pool must not be given a backend a signal is aimed at").toEqual([]);
      expect(scheduled.state()).toBe("pending");

      // THE SEAM ANSWERS — well inside the bound: no time has passed on the clock — with what is
      // not PostgreSQL's acknowledgement. (Or, where it handed over the real send, the deadline
      // passes on that.) Cleanup goes on by itself from here: the next round finds the operation
      // settled; a terminate — the real one — is executed and acknowledged; the last round ends.
      if (says) said.resolve(says(owners[0].pid));
      else hand.tick(OWNED_BOUND_MS);
      const failure = await scheduled.promise.then(() => null, (error: unknown) => error);

      expect(failure).toBeInstanceOf(RaceScheduleError);
      const { cleanup, message } = failure as RaceScheduleError;
      expect(message).toContain("the competing operation finished without waiting");
      // UNPROVEN — with the barrier seen gone, the operation settled, and both signals asked for.
      expect(cleanup.outcome).toBe("unproven");
      expect(cleanup.barrierGone).toBe(true);
      expect(cleanup.signalled).toEqual([owners[0].pid]);
      expect(cleanup.operations).toEqual([
        { label: "the parked operation", backends: [owners[0].pid], settled: true },
        { label: "the competing operation", backends: [], settled: true },
      ]);
      // The terminate was aimed at that same backend — still the operation's own, because its
      // connection was never let back into the pool — and its real send was made.
      expect(signals).toEqual([cancel, terminate]);
      expect(statements).toEqual(sends ? [cancel, terminate] : [terminate]);
      // The same five bounded steps, and no timer left set: the cancel's was called off when its
      // seam answered, or fired at its deadline.
      expect(hand.delays()).toEqual([CLEANUP_MS, OWNED_BOUND_MS, CLEANUP_MS, OWNED_BOUND_MS, CLEANUP_MS]);
      expect(hand.outstanding()).toBe(0);
      // THE STRANDED CONNECTION WAS NEVER HANDED BACK: not when its operation released it, not when
      // the seam answered, and not when a later signal at the same backend was really acknowledged.
      expect(handedBack).toEqual([]);
      // THE RUN IS STOPPED: a fatal reason, the marker still on file, and the guard refusing.
      const reason = safety.fatal();
      expect(reason).toMatch(/could not be proven settled, idle or disposed/);
      expect(safety.armed()).toEqual([tag]);
      expect(() => assertRunSafe(safety)).toThrow(/run STOPPED — refusing to truncate or run another test/);
      // The terminate was real: that backend is gone.
      await untilSessions([owners[0].pid], "the terminated backend gone", (sessions) => sessions.length === 0);

      // THE REAL SEND OF THE CANCEL IS ANSWERED NOW — long after the verdict.
      later(answered, owners[0].pid);
      await turn();

      // NOTHING CAME OF IT. Not an unhandled rejection — though the seam had let go of that send;
      // the connection is still not the pool's; no signal was sent for it and no bound started…
      expect(unhandled.seen).toEqual([]);
      expect(handedBack).toEqual([]);
      expect(signals).toHaveLength(2);
      expect(hand.delays()).toEqual([CLEANUP_MS, OWNED_BOUND_MS, CLEANUP_MS, OWNED_BOUND_MS, CLEANUP_MS]);
      // …the verdict is what it was, and no later conclusion clears it…
      barrier.conclude(true, "");
      await barrier.release();
      expect(safety.armed()).toEqual([tag]);
      expect(safety.fatal()).toBe(reason);
      // …and the guard still refuses — here, and for any other reader of the same state.
      expect(() => assertRunSafe(safety)).toThrow(/run STOPPED — refusing to truncate or run another test/);
      const elsewhere = createRunSafety(directory);
      expect(elsewhere.armed()).toEqual([tag]);
      expect(elsewhere.fatal()).toBe(reason);
      // The real run was not stopped by this test: its state is not this one.
      expect(raceHarnessFatal()).toBeNull();
      expect(currentRunSafety().armed(), "the real run: the sentinel, and only the sentinel").toEqual([staged.scope]);
    } finally {
      // ON EVERY EXIT, as in the test above: nothing stays held back and the raced operation may
      // finish; the barrier is retired — one bounded, acknowledged closing, its exact backend then
      // SEEN gone; the sentinel comes off only when, as well, the raced operation's backend is SEEN
      // idle or gone — and only then is the connection the harness stranded retired from the pool
      // by hand. If any of that cannot be seen, this throws, the sentinel stays, and the real run
      // stops.
      unhandled.stop();
      proceed.open();
      said.resolve(undefined);
      answered.resolve(undefined);
      await staged.retire(async () => {
        await barrier?.release();
        return "closed";
      }, () => untilBarrierGone(tag));
      await staged.seen("the raced operation's backend idle or gone",
        (sessions) => sessions.every((session) => session.state === "idle"));
      pool.removeListener("release", onRelease);
      for (const client of held) discardFromPool(client);
      staged.clear();
    }
  }, RACE_TEST_TIMEOUT_MS);
});

describe("race harness (8): a test's own foreign session is a scope of the run — its marker comes before its connection, and comes off only once it is closed and SEEN gone (real Postgres)", () => {
  it("THE CONTROL, on the REAL run: a foreign lock holder has its marker on file from before it connects — so a truncation is refused while it lives — and closed, acknowledged and seen gone, the marker comes off and its lock is free", async () => {
    const run = currentRunSafety();
    expect(run.armed(), "nothing is in flight before it is opened").toEqual([]);

    // Opened exactly as every other test in this file opens one.
    const holder = await foreign("lock-holder");
    // ITS MARKER IS ON THE REAL RUN — its own, named for this one session — and the guard the setup
    // file runs before every TRUNCATE refuses while it is there.
    expect(holder.scope).toMatch(/^session-lock-holder-[a-f0-9]{8}$/);
    expect(run.armed()).toEqual([holder.scope]);
    expect(() => assertRunSafe()).toThrow(/1 harness scope\(s\) still in flight/);

    // THE LOCK HOLDER: in a transaction of its own, holding a table every truncation needs.
    await holder.client.query("begin");
    await holder.client.query("lock table member_identity_mapping_state in access exclusive mode");
    const [holding] = await sessionEvidence([holder.pid]);
    expect(holding).toMatchObject({ pid: holder.pid, state: "idle in transaction", waitingOn: null });
    expect(holding.locksHeld).toBeGreaterThanOrEqual(1);
    expect(run.armed(), "still in flight: holding a lock changes nothing about that").toEqual([holder.scope]);

    // CLOSED — twice at once, and once more: every call resolves, and the session is gone.
    await Promise.all([holder.close(), holder.close()]);
    await holder.close();

    // SEEN GONE, by its exact backend — and only so is the marker off and the run clean again.
    expect(await sessionEvidence([holder.pid])).toEqual([]);
    expect(run.armed()).toEqual([]);
    expect(run.blocked()).toBeNull();
    expect(() => assertRunSafe()).not.toThrow();
    // Its lock went with it: a barrier takes that table at once.
    const free = await holdTable("member_identity_mapping_state", { lockTimeoutMs: 250 });
    await free.release();
    expect(run.blocked()).toBeNull();
    expect(raceHarnessFatal()).toBeNull();
  }, RACE_TEST_TIMEOUT_MS);

  it("THE MARKER COMES FIRST: one that cannot be written prevents the session, and a name that could not be carried whole is refused before either", async () => {
    const { root, safety } = privateRun();

    // `identity-race-foreign/` + 42 characters is 64 bytes; PostgreSQL keeps 63.
    for (const name of ["n".repeat(42), "n".repeat(200), "not a name", "é".repeat(8)]) {
      const refusal = await openTestSession(name, { safety }).then(() => null, (error: unknown) => error);
      expect(refusal, name).toBeInstanceOf(RaceHarnessError);
      expect((refusal as Error).message, name).toMatch(/unusable test session name/);
    }
    expect(safety.armed(), "refused before the marker, and before any connection").toEqual([]);

    // A MARKER THAT CANNOT BE WRITTEN: the session is refused before it connects. None under its
    // name ever exists, and nothing is left to clean up.
    const missing = createRunSafety(join(root, "no-such-database", randomUUID()));
    const name = `unrecorded-${randomUUID().slice(0, 8)}`;
    const failure = await openTestSession(name, { safety: missing }).then(() => null, (error: unknown) => error);
    expect(failure).toBeInstanceOf(RunSafetyError);
    expect((failure as Error).message).toMatch(/could not be recorded — no database work may start/);
    expect(await sessionsNamed(`identity-race-foreign/${name}`)).toEqual([]);
  }, RACE_TEST_TIMEOUT_MS);

  it("A LOCK HOLDER WHOSE CLOSING IS NOT ACKNOWLEDGED IN TIME: the run is stopped and its marker kept — rightly, it still holds its lock and a reader still waits behind it — and when it is then really closed, seen gone and acknowledged, the failed conclusion stands", async () => {
    // Staged in a run-safety state of this test's own: the real run is not stopped by testing what stops it.
    const { directory, safety } = privateRun();
    const name = `lock-holder-${randomUUID().slice(0, 8)}`;
    const sessionName = `identity-race-foreign/${name}`;
    const hand = handClock();
    // What ending the holder's connection answers with, once this test has stood in front of it.
    const ending = controlled<void>();
    const asked = tally();
    const unhandled = watchUnhandled();
    // The lock holder is a REAL session whose marker is in the private state, which the real run
    // does not read: the real run carries a sentinel of its own until that session is SEEN gone.
    const staged = stagedOnRealRun("a test-owned lock holder whose closing is staged not to be acknowledged in time");
    let holder: TestSession | undefined;
    // The connection's own `end`, kept from before this test stood in front of it.
    let reallyEnd: (() => Promise<void>) | undefined;
    try {
      // Opened on the clock this test moves — and on nothing else staged: until the gate below, its
      // closing would be the real one, acknowledged in real time. RESERVED on the real run's
      // sentinel before it is asked for: its own acquisition puts its exact backend on those books,
      // before anything is staged in front of its closing.
      holder = await openTestSession(name, { safety, clock: hand.clock, acquisition: staged.acquiring() });
      expect(() => staged.clear(), "opened is not retired: the sentinel cannot simply be taken off")
        .toThrow(/is NOT cleared: 1 real session\(s\) this test staged were not closed and SEEN gone/);
      // ITS MARKER IS ON FILE, in the state it was opened under, and that state's guard refuses.
      expect(safety.armed()).toEqual([holder.scope]);
      expect(() => assertRunSafe(safety)).toThrow(/1 harness scope\(s\) still in flight/);
      expect(await sessionsNamed(sessionName)).toEqual([{ pid: holder.pid, state: "idle" }]);

      // THE SCHEDULE: it holds a table lock in a transaction of its own, and a reader — another
      // foreign session, a scope of the real run — is proven waiting behind it, on that lock.
      await holder.client.query("begin");
      await holder.client.query("lock table member_identity_mapping_state in access exclusive mode");
      const waiter = await foreign("behind-holder");
      const stuck = inFlight(waiter.client.query("select count(*)::int as n from member_identity_mapping_state"));
      await untilSessions([waiter.pid], "the foreign read waiting on the holder's table lock", waitsOn("relation", 1));
      const [holding] = await sessionEvidence([holder.pid]);
      expect(holding).toMatchObject({ pid: holder.pid, state: "idle in transaction", waitingOn: null });
      expect(holding.locksHeld).toBeGreaterThanOrEqual(1);
      expect(currentRunSafety().armed(), "the real run: the sentinel and the waiter").toEqual([staged.scope, waiter.scope].sort());

      // THE FAILURE GATE. No seam of the harness's: the client is this test's, so it is the client's
      // own `end` that is made to do nothing and not to answer — which is what the harness's real
      // closing, the one every foreign session of this file is closed by, then runs into.
      const connection = holder.client as unknown as { end: () => Promise<void> };
      const end = connection.end;
      reallyEnd = () => end.call(connection);
      connection.end = () => {
        asked.note();
        return ending.promise;
      };
      const closed = inFlight(holder.close());
      await Promise.race([asked.reached(1), closed.promise.then(() => undefined, () => undefined)]);
      expect(asked.count(), "the closing was asked for").toBe(1);
      expect(hand.delays(), "and it is bounded").toEqual([OWNED_BOUND_MS]);
      await turn();
      expect(closed.state()).toBe("pending");

      // ITS DEADLINE PASSES. The close is refused, and THE RUN IS STOPPED: a fatal reason, the
      // marker still on file, and the guard that runs before every TRUNCATE refusing.
      hand.tick(OWNED_BOUND_MS);
      const failure = await closed.promise.then(() => null, (error: unknown) => error);
      expect(failure).toBeInstanceOf(RaceHarnessError);
      expect((failure as Error).message).toMatch(
        /a test's own session identity-race-foreign\/lock-holder-[a-f0-9]+ was closed, and it could not be proven gone/,
      );
      const reason = safety.fatal();
      expect(reason).toBe((failure as Error).message);
      expect(safety.armed()).toEqual([holder.scope]);
      expect(() => assertRunSafe(safety)).toThrow(/run STOPPED — refusing to truncate or run another test/);
      // AND RIGHTLY SO. The session is exactly where it was: in its transaction, holding its lock,
      // with the reader still waiting behind it — as a truncation would.
      const [still] = await sessionEvidence([holder.pid]);
      expect(still).toMatchObject({ pid: holder.pid, state: "idle in transaction", waitingOn: null });
      expect(still.locksHeld).toBeGreaterThanOrEqual(1);
      expect(await sessionEvidence([waiter.pid])).toMatchObject([{ pid: waiter.pid, state: "active", waitingOn: "relation" }]);
      expect(stuck.state()).toBe("pending");

      // THE CLEANUP GATE, opened LATE: the connection really is closed now, its backend SEEN gone,
      // the reader behind it completes — and the ending the harness asked for is, at last, acknowledged.
      await reallyEnd();
      await untilSessions([holder.pid], "the lock holder's backend gone", (sessions) => sessions.length === 0);
      expect((await stuck.promise).rows).toEqual([{ n: expect.any(Number) }]);
      ending.resolve();
      await turn();

      // NOTHING CAME OF IT. Not an unhandled rejection; the closing was not asked for again and no
      // other bound started; reads of the session's absence succeed…
      expect(unhandled.seen).toEqual([]);
      expect(asked.count()).toBe(1);
      expect(hand.delays()).toEqual([OWNED_BOUND_MS]);
      expect(await sessionEvidence([holder.pid])).toEqual([]);
      expect(await sessionsNamed(sessionName)).toEqual([]);
      // …and the failed conclusion stands: the same refusal, the marker, the reason, the guard —
      // here, and for any other reader of the same state, as the next test file's worker is.
      expect(await holder.close().then(() => null, (error: unknown) => error)).toBe(failure);
      expect(safety.armed()).toEqual([holder.scope]);
      expect(safety.fatal()).toBe(reason);
      expect(safety.setFatal("a later, different reason")).toBe(reason);
      expect(() => assertRunSafe(safety)).toThrow(/run STOPPED — refusing to truncate or run another test/);
      const elsewhere = createRunSafety(directory);
      expect(elsewhere.armed()).toEqual([holder.scope]);
      expect(elsewhere.fatal()).toBe(reason);
      expect(() => assertRunSafe(elsewhere)).toThrow(/run STOPPED/);
      // The real run was not stopped by this test: its state is not this one.
      expect(raceHarnessFatal()).toBeNull();
      expect(currentRunSafety().armed()).toEqual([staged.scope, waiter.scope].sort());
    } finally {
      // ON EVERY EXIT nothing stays held back, and the holder's connection is really closed — by its
      // own `end`, whether or not this test ever stood in front of it. That closing is one bounded
      // step and must be acknowledged; the real run's sentinel comes off only once the holder's exact
      // backend is then SEEN gone and no session is left under its name. A closing that rejects, is
      // still pending at its bound or answers late, or a session not seen gone, leaves the sentinel
      // on file, STOPS the real run, and this throws.
      unhandled.stop();
      ending.resolve();
      await staged.retire(async () => {
        if (reallyEnd) await reallyEnd();
        else if (holder) await holder.client.end();
        return "closed";
      }, () => untilNoSessionsNamed(sessionName));
    }
    // The sentinel took nothing else with it: the staged state is still stopped, its scope still on file.
    expect(safety.armed()).toEqual([`session-${name}`]);
    expect(safety.fatal()).toMatch(/could not be proven gone/);
    expect(raceHarnessFatal()).toBeNull();
  }, RACE_TEST_TIMEOUT_MS);
});

describe("race harness (9): a staged test's own pool checkout is on the real run's sentinel BEFORE it is asked who it is — one that never said is not cleared around, until it is identified and its backend SEEN gone (real Postgres)", () => {
  /**
   * The staged tests above put a real session on a pool connection of their own, and learn its
   * backend only by asking it (`whoIs`). If that answer never comes — still pending, or rejected —
   * the test has no backend to look for; and a cleanup that waits only on the backends its test
   * knows of then waits on nothing and clears the real run's sentinel, with that session alive.
   *
   * The first answer is this test's own promise, settled by hand — left pending, then rejected —
   * and nothing is timed. It is staged on the REAL run, because whether the real run's sentinel
   * comes off is what is tested. It does, at the end, by the one way there is: the connection
   * really says who it is, the monitor sees that backend, the connection is retired from the pool,
   * and the backend is then SEEN gone.
   */
  it("`whoIs` is still PENDING, and then REJECTS, for an acquired client: its test knows no backend — and the sentinel is NOT cleared, the marker stays and the guard refuses; identified at last, it is still not cleared until that backend is SEEN gone", async () => {
    const pool = getPool();
    const run = currentRunSafety();
    const stagedFailure = new Error("staged: the acquired client does not say who it is");
    // What the checkout is asked the FIRST time, in place of `whoIs`: this test's promise. Asked
    // again, it is really asked.
    const answer = controlled<BackendIdentity>();
    const asked = tally();
    const ask = (client: PoolClient): Promise<BackendIdentity> => {
      asked.note();
      return asked.count() === 1 ? answer.promise : whoIs(client);
    };
    const gone = (sessions: SessionEvidence[]): boolean => sessions.length === 0;
    expect(run.armed(), "nothing is in flight before it is staged").toEqual([]);
    const staged = stagedOnRealRun("a pool checkout staged not to say who it is", ask);
    // What a cleanup that goes by the sentinel's books comes to: the wait on its checkouts, and the clearing.
    const refusals = async (): Promise<{ seen: unknown; clear: unknown }> => {
      const seen = await staged.seen("the checkout's backend gone", gone).then(() => null, (error: unknown) => error);
      try {
        staged.clear();
        return { seen, clear: null };
      } catch (error) {
        return { seen, clear: error };
      }
    };
    let client: PoolClient | undefined;
    let retired = false;
    try {
      // THE RACED OPERATION'S FIRST TWO STEPS, as the staged tests above write them: a pool
      // connection, and who it is — all its test will ever know of its backend.
      const owners: BackendIdentity[] = [];
      client = await pool.connect();
      const identified = inFlight(staged.identify(client).then((identity) => { owners.push(identity); }));
      expect(asked.count(), "it was asked, once").toBe(1);
      await turn();
      expect(identified.state()).toBe("pending");

      // THE ANSWER IS STILL PENDING. The test knows no backend: a cleanup that goes by what it
      // knows has nothing to wait for. The sentinel does — and is not cleared.
      expect(owners).toEqual([]);
      const pending = await refusals();
      expect(pending.seen).toBeInstanceOf(Error);
      expect((pending.seen as Error).message).toMatch(/1 pool checkout\(s\) under sentinel-[a-f0-9]{8} .* did not say who they are/);
      expect(pending.clear).toBeInstanceOf(Error);
      expect((pending.clear as Error).message).toMatch(/is NOT cleared: of this test's own pool checkouts, 1 did not say who they are and 0 said so/);
      expect(run.armed(), "the real run: the sentinel is still on file").toEqual([staged.scope]);
      expect(() => assertRunSafe()).toThrow(/1 harness scope\(s\) still in flight/);

      // THE ANSWER IS A REJECTION. The operation is told, as it would be; its test still knows no
      // backend — and nothing has changed: no wait, no clearing, the marker on file, the guard refusing.
      answer.reject(stagedFailure);
      expect(await identified.promise.then(() => null, (error: unknown) => error)).toBe(stagedFailure);
      expect(owners).toEqual([]);
      const rejected = await refusals();
      expect(rejected.seen).toBeInstanceOf(Error);
      expect((rejected.seen as Error).message).toMatch(/1 pool checkout\(s\) under sentinel-[a-f0-9]{8} .* did not say who they are/);
      expect(rejected.clear).toBeInstanceOf(Error);
      expect((rejected.clear as Error).message).toMatch(/is NOT cleared: of this test's own pool checkouts, 1 did not say who they are and 0 said so/);
      expect(asked.count(), "refusing asked it nothing more").toBe(1);
      expect(run.armed()).toEqual([staged.scope]);
      expect(() => assertRunSafe()).toThrow(/1 harness scope\(s\) still in flight/);

      // AND RIGHTLY SO. THE POSITIVE IDENTITY, at last: really asked, the session says who it is,
      // and the monitor sees exactly that backend. It was there all along, checked out and alive.
      const owner = await staged.identify(client);
      expect(asked.count()).toBe(2);
      expect(await sessionEvidence([owner.pid])).toEqual([{ pid: owner.pid, state: "idle", waitingOn: null, locksHeld: 0 }]);
      expect(poolInventoryOf(client)).toEqual({ known: true, idle: false });
      // KNOWING WHO IT IS IS NOT HAVING SEEN IT GONE: the sentinel is still not cleared.
      expect(() => staged.clear()).toThrow(/is NOT cleared: of this test's own pool checkouts, 0 did not say who they are and 1 said so but were not then SEEN/);
      expect(run.armed()).toEqual([staged.scope]);
      expect(() => assertRunSafe()).toThrow(/1 harness scope\(s\) still in flight/);

      // THE BOUNDED ABSENCE: retired from the pool by hand, that backend is SEEN gone within the
      // evidence bound — and only now may the sentinel come off (it does, below).
      discardFromPool(client);
      retired = true;
      await staged.seen("the checkout's backend gone", gone);
      expect(await sessionEvidence([owner.pid])).toEqual([]);
      expect(run.armed(), "seen gone, and not yet cleared").toEqual([staged.scope]);
      expect(raceHarnessFatal()).toBeNull();
    } finally {
      // ON EVERY EXIT the connection this test checked out is really asked who it is and retired
      // from the pool by hand, so that no later test inherits it; and the real run's sentinel comes
      // off only once that backend — named by the session, seen by the monitor — is SEEN gone. If
      // it cannot be identified, or cannot be seen gone, this throws, the sentinel stays, and the
      // real run stops.
      if (client && !retired) {
        await staged.identify(client);
        discardFromPool(client);
      }
      await staged.seen("the checkout's backend gone", gone);
      staged.clear();
    }
    // Cleared, by its own proof: the real run is clean and was never stopped.
    expect(run.armed()).toEqual([]);
    expect(run.blocked()).toBeNull();
    expect(() => assertRunSafe()).not.toThrow();
    expect(raceHarnessFatal()).toBeNull();
  }, RACE_TEST_TIMEOUT_MS);
});

describe("race harness (10): a staged test's own cleanup of a REAL session is one bounded, acknowledged closing and that exact backend SEEN gone — anything less leaves the sentinel on file and stops the run, for good (real Postgres)", () => {
  /**
   * The staged tests above take a real session out of the harness's hands, so what closes it at the
   * end is their own cleanup — the sentinel's `retire`. Here that cleanup is the thing under test.
   *
   * The session is a REAL one: a foreign session of this file, a scope of the real run, which the
   * `afterEach` closes and proves gone whatever happens here. The sentinel stands on a run-safety
   * state of this test's own, in place of the real run's, so that stopping it does not stop the
   * real run; and the closing it is given is this test's to answer, on a clock moved by hand.
   */
  const unproven: {
    what: string;
    then: string;
    stage: (staged: StagedClosing) => void;
    later: (staged: StagedClosing) => void;
  }[] = [
    {
      what: "REJECTS, in time",
      then: "its deadline passes",
      stage: ({ verdict }) => verdict.reject(new Error("Connection terminated unexpectedly")),
      later: ({ hand }) => hand.tick(OWNED_BOUND_MS),
    },
    {
      what: "is still PENDING at its deadline",
      then: "is acknowledged `closed` only afterwards",
      stage: ({ hand }) => hand.tick(OWNED_BOUND_MS),
      later: ({ verdict }) => verdict.resolve("closed"),
    },
    {
      what: "is OPAQUE — it resolves in time, and does not say `closed`",
      then: "its deadline passes",
      stage: ({ verdict }) => verdict.resolve(undefined),
      later: ({ hand }) => hand.tick(OWNED_BOUND_MS),
    },
    {
      what: "is acknowledged `closed` exactly AT its deadline, ahead of the overdue timer",
      then: "that timer is finally run",
      stage: ({ hand, verdict }) => { hand.drift(OWNED_BOUND_MS); verdict.resolve("closed"); },
      later: ({ hand }) => hand.tick(OWNED_BOUND_MS),
    },
  ];

  it.each(unproven)("a closing that $what: the cleanup rejects, the marker stays and the run is stopped — rightly, the session is still there — and so it stays when $then", async ({ stage, later }) => {
    const { directory, safety } = privateRun();
    const closing = stagedClosing();
    const { hand, asked } = closing;
    const unhandled = watchUnhandled();
    const session = await foreign("staged-cleanup");
    const staged = stagedOnRealRun("a real session whose cleanup closing is staged", whoIs, { safety, clock: hand.clock });
    try {
      expect(safety.armed()).toEqual([staged.scope]);
      // ON THE BOOKS by its exact backend, as the monitor reads it.
      expect((await staged.session(session.pid)).pid).toBe(session.pid);
      // Known is not retired: the marker cannot simply be taken off.
      expect(() => staged.clear()).toThrow(/is NOT cleared: 1 real session\(s\) this test staged were not closed and SEEN gone/);

      // THE CLEANUP BEGINS: it asks for the closing, and bounds that — as the one step it is.
      closing.stage();
      const retiring = inFlight(staged.retire(() => closing.dispose(session.client)));
      await Promise.race([asked.reached(1), retiring.promise.then(() => undefined, () => undefined)]);
      expect(asked.count(), "the closing was asked for").toBe(1);
      expect(hand.delays(), "and it is bounded").toEqual([OWNED_BOUND_MS]);
      await turn();
      expect(retiring.state()).toBe("pending");

      // …BUT THE CLOSING IS NOT ACKNOWLEDGED IN TIME. The cleanup is refused, and THE RUN IS
      // STOPPED: a fatal reason, the marker still on file, and the guard refusing.
      stage(closing);
      const failure = await retiring.promise.then(() => null, (error: unknown) => error);
      expect(failure).toBeInstanceOf(RaceHarnessError);
      expect((failure as Error).message).toMatch(
        /sentinel-[a-f0-9]{8} \(a real session whose cleanup closing is staged\) was closed, but its closing was not acknowledged in time, and could not be proven gone/,
      );
      const reason = safety.fatal();
      expect(reason).toBe((failure as Error).message);
      expect(safety.armed()).toEqual([staged.scope]);
      expect(() => assertRunSafe(safety)).toThrow(/run STOPPED — refusing to truncate or run another test/);
      // AND RIGHTLY SO: the session is exactly where it was.
      expect(await sessionEvidence([session.pid])).toMatchObject([{ pid: session.pid, state: "idle" }]);

      // WHATEVER COMES LATER — the acknowledgement itself, or the timer that was overdue.
      later(closing);
      await turn();

      // NOTHING CAME OF IT. Not an unhandled rejection; the closing was not asked for again, and no
      // other bound was started…
      expect(unhandled.seen).toEqual([]);
      expect(asked.count()).toBe(1);
      expect(hand.delays()).toEqual([OWNED_BOUND_MS]);
      // …the first conclusion stands, asked again or cleared by hand…
      expect(await staged.retire(() => closing.dispose(session.client)).then(() => null, (error: unknown) => error)).toBe(failure);
      expect(asked.count()).toBe(1);
      expect(() => staged.clear()).toThrow(/is NOT cleared/);
      // …and the run stays stopped — here, and for any other reader of the same state.
      expect(safety.armed()).toEqual([staged.scope]);
      expect(safety.fatal()).toBe(reason);
      expect(safety.setFatal("a later, different reason")).toBe(reason);
      const elsewhere = createRunSafety(directory);
      expect(elsewhere.armed()).toEqual([staged.scope]);
      expect(elsewhere.fatal()).toBe(reason);
      expect(() => assertRunSafe(elsewhere)).toThrow(/run STOPPED/);
      // The real run was not stopped by this test: its state is not this one.
      expect(raceHarnessFatal()).toBeNull();
      expect(currentRunSafety().armed()).toEqual([session.scope]);
    } finally {
      unhandled.stop();
      closing.verdict.resolve(undefined);
    }
  }, RACE_TEST_TIMEOUT_MS);

  it("a closing acknowledged `closed` in time whose backend is NOT then seen gone: the marker stays and the run is stopped — the acknowledgement alone proves nothing", async () => {
    const { safety } = privateRun();
    const session = await foreign("survives-cleanup");
    // A short budget for seeing it gone: the session is never closed here, so the wait runs out.
    const staged = stagedOnRealRun("a real session whose closing says `closed` and closes nothing", whoIs, { safety, cleanupMs: 250 });
    const backend = await staged.session(session.pid);

    const failure = await staged.retire(async () => "closed").then(() => null, (error: unknown) => error);

    expect(failure).toBeInstanceOf(RaceHarnessError);
    expect((failure as Error).message).toContain(`was closed, but its backend ${backend.pid} (started ${backend.started}) was not seen gone`);
    expect(safety.fatal()).toBe((failure as Error).message);
    expect(safety.armed()).toEqual([staged.scope]);
    expect(() => assertRunSafe(safety)).toThrow(/run STOPPED — refusing to truncate or run another test/);
    expect(() => staged.clear()).toThrow(/is NOT cleared/);
    expect(await sessionEvidence([session.pid])).toMatchObject([{ pid: session.pid, state: "idle" }]);
    expect(raceHarnessFatal()).toBeNull();
  }, RACE_TEST_TIMEOUT_MS);

  it("a session the monitor could NOT identify is not cleared around: its closing acknowledged, there is still no backend to see gone — the marker stays and the run is stopped", async () => {
    const { safety } = privateRun();
    const session = await foreign("unidentified-cleanup");
    const staged = stagedOnRealRun("a real session the monitor never saw", whoIs, { safety });
    // No backend has this pid: the monitor sees no row, and says so.
    const unknown = await staged.session(2_147_483_647).then(() => null, (error: unknown) => error);
    expect(unknown).toBeInstanceOf(RaceHarnessError);
    expect((unknown as Error).message).toMatch(/backend 2147483647 could not be identified: the monitor sees \[\]/);
    expect(() => staged.clear()).toThrow(/is NOT cleared: 1 real session\(s\)/);

    // Its closing is a real one, really acknowledged — and it is not enough.
    const failure = await staged.retire(() => session.client.end().then((): Disposal => "closed")).then(() => null, (error: unknown) => error);

    expect(failure).toBeInstanceOf(RaceHarnessError);
    expect((failure as Error).message).toMatch(/was closed, but one of its sessions never said who it is, and could not be proven gone/);
    expect(safety.fatal()).toBe((failure as Error).message);
    expect(safety.armed()).toEqual([staged.scope]);
    expect(() => assertRunSafe(safety)).toThrow(/run STOPPED — refusing to truncate or run another test/);
    expect(raceHarnessFatal()).toBeNull();
  }, RACE_TEST_TIMEOUT_MS);

  it("the control: a closing acknowledged `closed` one millisecond BEFORE its deadline, its exact backend then seen gone, IS proven — the marker comes off and the run goes on", async () => {
    const { safety } = privateRun();
    const closing = stagedClosing();
    const { hand, asked } = closing;
    const session = await foreign("retired-cleanup");
    const staged = stagedOnRealRun("a real session whose cleanup closing is acknowledged just in time", whoIs, { safety, clock: hand.clock });
    try {
      await staged.session(session.pid);
      const gone = controlled<void>();

      closing.stage();
      const retiring = inFlight(staged.retire(() => closing.dispose(session.client), () => gone.promise));
      await Promise.race([asked.reached(1), retiring.promise.then(() => undefined, () => undefined)]);
      expect(asked.count()).toBe(1);
      expect(hand.delays()).toEqual([OWNED_BOUND_MS]);

      // The same seam, the same clock, a real closing behind it — and the acknowledgement one
      // millisecond inside the bound, its timer still not run.
      await session.client.end();
      hand.drift(OWNED_BOUND_MS - 1);
      expect(hand.outstanding()).toBe(1);
      closing.verdict.resolve("closed");

      // The backend is seen gone on the real clock; what else was to be seen absent is still owed,
      // and until it is the marker stays.
      await untilSessions([session.pid], "the session's backend gone", (sessions) => sessions.length === 0);
      await turn();
      expect(retiring.state()).toBe("pending");
      expect(safety.armed()).toEqual([staged.scope]);
      gone.resolve();

      await retiring.promise;
      expect(hand.outstanding(), "the bound on the closing was called off").toBe(0);
      expect(await sessionEvidence([session.pid])).toEqual([]);
      expect(safety.armed()).toEqual([]);
      expect(safety.fatal()).toBeNull();
      expect(() => assertRunSafe(safety)).not.toThrow();
      // Asked again it is the same conclusion, and nothing is closed again.
      await staged.retire(() => closing.dispose(session.client));
      expect(asked.count()).toBe(1);
    } finally {
      closing.verdict.resolve(undefined);
    }
    expect(raceHarnessFatal()).toBeNull();
  }, RACE_TEST_TIMEOUT_MS);
});

describe("race harness (11): a staged session is on the sentinel from BEFORE its acquisition — attempted and never identified it is not cleared around, having opened nothing it is not refused, and what else is to be seen absent has a deadline (real Postgres)", () => {
  /**
   * The staged tests above used to put a real session on the sentinel's books only AFTER its
   * acquisition had handed it to them. An acquisition that fails hands nothing out, and a test that
   * dies inside one never gets that far: a session could be open with the books empty, and books
   * that are empty clear. So the reservation is made first, and the acquisition itself says how far
   * it got (`AcquisitionWitness`). Here that is the thing under test — with the sentinel on a
   * run-safety state of this test's own, so that stopping it does not stop the real run.
   */
  it("the acquisition itself puts its exact backend on the books — told it was attempted after its own marker, and who it is once the monitor has seen it — so a cleanup that closes nothing is refused BY THAT BACKEND", async () => {
    const { safety } = privateRun();
    const staged = stagedOnRealRun("a session reserved before it is acquired", whoIs, { safety, cleanupMs: 250 });
    // RESERVED, synchronously, before the acquisition is even asked for.
    const reserved = staged.acquiring();
    const name = `reserved-${randomUUID().slice(0, 8)}`;
    const told: string[] = [];
    const identified: BackendIdentity[] = [];
    let markerOnFileWhenAttempted: boolean | undefined;
    const witness: AcquisitionWitness = {
      attempted: () => {
        // The session's own marker is already on file when a connection is first attempted.
        markerOnFileWhenAttempted = currentRunSafety().armed().includes(`session-${name}`);
        told.push("attempted");
        reserved.attempted();
      },
      identified: (backend) => {
        told.push("identified");
        identified.push(backend);
        reserved.identified(backend);
      },
    };

    // A REAL session, and a scope of the real run: the `afterEach` closes it and proves it gone.
    const session = await openTestSession(name, { acquisition: witness });
    foreignSessions.push(session);

    expect(told).toEqual(["attempted", "identified"]);
    expect(markerOnFileWhenAttempted).toBe(true);
    expect(identified).toEqual([{ pid: session.pid, started: expect.any(String) }]);
    // ON THE BOOKS, though this test never said so: the marker cannot simply be taken off.
    expect(() => staged.clear()).toThrow(/is NOT cleared: 1 real session\(s\) this test staged were not closed and SEEN gone/);

    // A cleanup that says `closed` and closes nothing is refused by the very backend that was put there.
    const failure = await staged.retire(async () => "closed").then(() => null, (error: unknown) => error);

    expect(failure).toBeInstanceOf(RaceHarnessError);
    expect((failure as Error).message).toContain(
      `was closed, but its backend ${session.pid} (started ${identified[0].started}) was not seen gone`,
    );
    expect(safety.fatal()).toBe((failure as Error).message);
    expect(safety.armed()).toEqual([staged.scope]);
    expect(() => assertRunSafe(safety)).toThrow(/run STOPPED — refusing to truncate or run another test/);
    expect(() => staged.clear()).toThrow(/is NOT cleared/);
    expect(await sessionEvidence([session.pid])).toMatchObject([{ pid: session.pid, state: "idle" }]);
    expect(raceHarnessFatal()).toBeNull();
  }, RACE_TEST_TIMEOUT_MS);

  it("an acquisition that was ATTEMPTED and never said who it is: its closing acknowledged, there is still no backend to see gone — the cleanup rejects, the marker stays and the run is stopped; identified only afterwards, that conclusion stands", async () => {
    const { directory, safety } = privateRun();
    const staged = stagedOnRealRun("an acquisition that never identified its session", whoIs, { safety });
    const witness = staged.acquiring();
    let closings = 0;
    const close = async (): Promise<Disposal> => {
      closings += 1;
      return "closed";
    };

    // A connection was attempted — and that is the last the acquisition says. A session may exist.
    witness.attempted();
    expect(() => staged.clear()).toThrow(/is NOT cleared: 1 real session\(s\) this test staged were not closed and SEEN gone/);

    const failure = await staged.retire(close).then(() => null, (error: unknown) => error);

    // Its closing was asked for, and acknowledged — and "nothing to look for" is not "nothing there".
    expect(closings).toBe(1);
    expect(failure).toBeInstanceOf(RaceHarnessError);
    expect((failure as Error).message).toMatch(/was closed, but one of its sessions never said who it is, and could not be proven gone/);
    const reason = safety.fatal();
    expect(reason).toBe((failure as Error).message);
    expect(safety.armed()).toEqual([staged.scope]);
    expect(() => assertRunSafe(safety)).toThrow(/run STOPPED — refusing to truncate or run another test/);

    // IDENTIFIED TOO LATE. Nothing is retired again, nothing is cleared, and nothing unsets the stop
    // — here, or for any other reader of the same state.
    witness.identified({ pid: 2_147_483_647, started: "0" });
    expect(await staged.retire(close).then(() => null, (error: unknown) => error)).toBe(failure);
    expect(closings).toBe(1);
    expect(() => staged.clear()).toThrow(/is NOT cleared/);
    expect(safety.armed()).toEqual([staged.scope]);
    expect(safety.fatal()).toBe(reason);
    expect(safety.setFatal("a later, different reason")).toBe(reason);
    const elsewhere = createRunSafety(directory);
    expect(elsewhere.armed()).toEqual([staged.scope]);
    expect(elsewhere.fatal()).toBe(reason);
    expect(() => assertRunSafe(elsewhere)).toThrow(/run STOPPED/);
    expect(raceHarnessFatal()).toBeNull();
  }, RACE_TEST_TIMEOUT_MS);

  it("reservations whose acquisitions never ATTEMPTED a connection opened nothing: with nothing to see gone the cleanup is proven — the marker comes off and the run goes on, not refused for being empty", async () => {
    const { root, safety } = privateRun();
    const staged = stagedOnRealRun("acquisitions refused before they connect", whoIs, { safety });
    expect(safety.armed()).toEqual([staged.scope]);
    const lock = `harness-refused:${randomUUID()}`;

    // REFUSED BEFORE ITS MARKER: a tag that could not be carried whole.
    const unusable = await holdNamedLock(lock, { tag: "t".repeat(200), safety, acquisition: staged.acquiring() })
      .then(() => null, (error: unknown) => error);
    expect((unusable as Error).message).toMatch(/unusable barrier tag/);
    // REFUSED AT ITS MARKER: one that cannot be written prevents the connection — a barrier's…
    const missing = createRunSafety(join(root, "no-such-database", randomUUID()));
    const tag = `unrecorded-${randomUUID().slice(0, 8)}`;
    const unrecorded = await holdNamedLock(lock, { tag, safety: missing, acquisition: staged.acquiring() })
      .then(() => null, (error: unknown) => error);
    expect(unrecorded).toBeInstanceOf(RunSafetyError);
    expect(await barrierSessions(tag)).toEqual([]);
    // …and a test's own session's.
    const name = `unrecorded-${randomUUID().slice(0, 8)}`;
    const unopened = await openTestSession(name, { safety: missing, acquisition: staged.acquiring() })
      .then(() => null, (error: unknown) => error);
    expect(unopened).toBeInstanceOf(RunSafetyError);
    expect(await sessionsNamed(`identity-race-foreign/${name}`)).toEqual([]);
    expect(safety.armed(), "nothing but the sentinel was ever recorded").toEqual([staged.scope]);

    // THREE RESERVATIONS, NO SESSION. The closing is still one acknowledged step; there is then no
    // backend to see gone, and that is not a reason to refuse: nothing was opened.
    let closings = 0;
    await staged.retire(async () => {
      closings += 1;
      return "closed";
    });

    expect(closings).toBe(1);
    expect(safety.armed()).toEqual([]);
    expect(safety.fatal()).toBeNull();
    expect(() => assertRunSafe(safety)).not.toThrow();
    // The harness's own retirement says the same of a caller that acquired nothing.
    await retireSessions("a cleanup with nothing acquired", [], async () => "closed", { safety });
    expect(safety.blocked()).toBeNull();
    expect(raceHarnessFatal()).toBeNull();
  }, RACE_TEST_TIMEOUT_MS);

  /** The budget staged for what else is to be seen absent: not the closing's, so the two are told apart. */
  const ABSENT_MS = 4_000;
  const unseen: {
    what: string;
    then: string;
    stage: (staged: { hand: HandClock; absent: Controlled<void> }) => void;
    later: (staged: { hand: HandClock; absent: Controlled<void> }) => void;
  }[] = [
    {
      what: "is still PENDING at its deadline",
      then: "it resolves only afterwards",
      stage: ({ hand }) => hand.tick(ABSENT_MS),
      later: ({ absent }) => absent.resolve(),
    },
    {
      what: "resolves exactly AT its deadline, ahead of the overdue timer",
      then: "that timer is finally run",
      stage: ({ hand, absent }) => { hand.drift(ABSENT_MS); absent.resolve(); },
      later: ({ hand }) => hand.tick(ABSENT_MS),
    },
    {
      what: "REJECTS, in time",
      then: "its deadline passes",
      stage: ({ absent }) => absent.reject(new RaceHarnessError("no evidence within 10000 ms of no session left")),
      later: ({ hand }) => hand.tick(ABSENT_MS),
    },
  ];

  it.each(unseen)("what else was to be seen absent $what: the cleanup ends THERE, rejected — its session closed, acknowledged and seen gone all the same — the marker stays and the run is stopped, and so they stay when $then", async ({ stage, later }) => {
    const { directory, safety } = privateRun();
    const hand = handClock();
    const absent = controlled<void>();
    const asked = tally();
    const unhandled = watchUnhandled();
    const session = await foreign("absent-deadline");
    const staged = stagedOnRealRun("a real session whose further absence is not seen in time", whoIs, {
      safety, clock: hand.clock, absentMs: ABSENT_MS,
    });
    try {
      await staged.session(session.pid);

      // THE CLEANUP: a real closing, really acknowledged; that exact backend really seen gone; and
      // then what else was to be seen absent — this test's to answer, on a clock it moves.
      const retiring = inFlight(staged.retire(
        () => session.client.end().then((): Disposal => "closed"),
        () => {
          asked.note();
          return absent.promise;
        },
      ));
      await Promise.race([asked.reached(1), retiring.promise.then(() => undefined, () => undefined)]);
      expect(asked.count(), "the further absence was asked for").toBe(1);
      expect(await sessionEvidence([session.pid]), "after the session was closed and seen gone").toEqual([]);
      expect(hand.delays(), "the closing is bounded, and so is that wait — by a deadline of its own").toEqual([OWNED_BOUND_MS, ABSENT_MS]);
      await turn();
      expect(retiring.state()).toBe("pending");
      expect(safety.armed()).toEqual([staged.scope]);

      // …AND IT IS NOT SEEN IN TIME. The cleanup does not wait on: it is refused, and THE RUN IS
      // STOPPED — a fatal reason, the marker still on file, and the guard refusing.
      stage({ hand, absent });
      const failure = await retiring.promise.then(() => null, (error: unknown) => error);
      expect(failure).toBeInstanceOf(RaceHarnessError);
      expect((failure as Error).message).toMatch(
        /sentinel-[a-f0-9]{8} \(a real session whose further absence is not seen in time\) was closed, but what was to be seen absent after it was not seen in time, and could not be proven gone/,
      );
      const reason = safety.fatal();
      expect(reason).toBe((failure as Error).message);
      expect(safety.armed()).toEqual([staged.scope]);
      expect(() => assertRunSafe(safety)).toThrow(/run STOPPED — refusing to truncate or run another test/);

      // WHATEVER COMES LATER — the wait's own answer, or the timer that was overdue.
      later({ hand, absent });
      await turn();

      // NOTHING CAME OF IT. Not an unhandled rejection; it was not asked for again, and no other
      // bound was started…
      expect(unhandled.seen).toEqual([]);
      expect(asked.count()).toBe(1);
      expect(hand.delays()).toEqual([OWNED_BOUND_MS, ABSENT_MS]);
      // …the first conclusion stands, asked again or cleared by hand…
      expect(await staged.retire(async () => "closed").then(() => null, (error: unknown) => error)).toBe(failure);
      expect(() => staged.clear()).toThrow(/is NOT cleared/);
      // …and the run stays stopped — here, and for any other reader of the same state.
      expect(safety.armed()).toEqual([staged.scope]);
      expect(safety.fatal()).toBe(reason);
      expect(safety.setFatal("a later, different reason")).toBe(reason);
      const elsewhere = createRunSafety(directory);
      expect(elsewhere.armed()).toEqual([staged.scope]);
      expect(elsewhere.fatal()).toBe(reason);
      expect(() => assertRunSafe(elsewhere)).toThrow(/run STOPPED/);
      // The real run was not stopped by this test: its state is not this one.
      expect(raceHarnessFatal()).toBeNull();
      expect(currentRunSafety().armed()).toEqual([session.scope]);
    } finally {
      unhandled.stop();
      absent.resolve();
    }
  }, RACE_TEST_TIMEOUT_MS);
});
