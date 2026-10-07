import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { getPool } from "@/lib/db/pg/pool";
import { currentRunSafety, type RunSafety } from "./run-fatal-latch";

/**
 * TEST-ONLY harness for deterministic identity races against real PostgreSQL.
 *
 * A schedule is built from locks, never from a clock. One operation is PARKED on a lock a
 * connection of the harness's own holds (a barrier); the other is then shown — from `pg_locks` — to
 * be waiting on the team's identity authority behind it; then the barrier is released.
 *
 * OWNERSHIP IS REGISTERED, NOT INFERRED. "This backend is blocked behind my barrier" does not make
 * it mine: any other session of the same database can be waiting there too. So every raced
 * operation runs inside a scope, and the application pool is instrumented (here, in the test
 * process only) to record the backend PID of every connection checked out inside that scope, and
 * when it is returned. Lock-wait evidence is read only for those registered backends, and the only
 * backends this harness will ever cancel or terminate are the ones a raced operation of its own
 * holds checked out at that moment. The barriers and the monitor are connections this module opens
 * itself, each under an `application_name` of its own.
 *
 * A SIGNAL IS AIMED AT A CHECKOUT, NOT AT A PID. "Held at that moment" is read in this process;
 * the signal is executed later, in PostgreSQL. Were the operation to return its connection in
 * between, the pool could hand that same backend to a stranger, and the signal would land on the
 * stranger's work. So each checkout is a LEASE, and before anything asynchronous happens the
 * leases about to be signalled are reserved: a release the operation asks for from then on is
 * recorded and NOT carried out. Once the signal has been executed the connection is retired —
 * given to the pool to destroy, never to keep. A lease whose signal cannot be shown to have been
 * executed is never handed back at all, and cleanup is then `unproven`.
 *
 * CLEANUP IS PROVEN, NOT ASSUMED. Before a barrier connects, its scope is recorded as IN FLIGHT in
 * the run-safety state (`run-fatal-latch`); if that cannot be recorded, nothing connects. After the
 * barrier is released — on every path, a failed schedule or a failed acquisition included — two
 * things must be SEEN in `pg_stat_activity`, within a bound, before the outcome is reported: the
 * barrier's own tagged session is gone (that `rollback` and `end()` returned is not evidence of
 * it), and every raced operation has settled, returned its connections and left its backends idle
 * or gone. Only then is the scope's marker removed — that marker, and nothing else. If the raced
 * operations needed a cancel or a terminate, the test fails. If any of it cannot be proven — a
 * survivor, or evidence that cannot be read — the RUN is stopped: the fatal reason is recorded,
 * the marker stays, and the tier's setup file — at module scope and again before every `TRUNCATE`,
 * ahead of any test file's own hooks — refuses to go on for the rest of that run. A scope whose
 * test timed out or was interrupted before it got this far leaves its marker, with the same effect.
 *
 * No wait here establishes a schedule by elapsed time. Evidence is re-read from PostgreSQL until it
 * is what is expected, the operation in question can no longer produce it, or a bound expires; the
 * pause between two reads is only the interval of that re-reading.
 *
 * A BOUND IS A DEADLINE, NOT A COUNT OF READS. Evidence counts only if it was read before the
 * wait's deadline: a read that outlasts the deadline fails the wait there and then, and whatever
 * that read comes back with later — the very evidence that was expected, included — is observed
 * and dropped. Nothing a read returns after its wait has failed can make that wait succeed.
 *
 * AND EVERY BOUND HERE IS THAT KIND OF DEADLINE — not only the evidence waits. The raced operations
 * settling, a connection being closed, PostgreSQL acknowledging a signal: each is asked of the clock
 * when it settles, whichever way it settles, and one that settles at or after its deadline has not
 * met it, however late the timer that was to say so (`outcomeBy`). The clock is MONOTONIC
 * (`REAL_CLOCK`): the wall clock can be set, and a deadline read from it would move with it.
 *
 * WHAT WAS NOT ACKNOWLEDGED IN TIME IS NOT PROVEN LATER. A connection whose closing was not
 * acknowledged, and a signal whose execution was not, each leave their cleanup `unproven` for good:
 * the marker stays and the run is stopped, whatever PostgreSQL shows afterwards and whatever the
 * late answer turns out to be. Closing is still attempted to the end; it just proves nothing.
 *
 * A TEST'S OWN SESSIONS ARE SCOPES TOO. A plain client a test opens to hold a lock or to wait on one
 * is never registered as a raced operation and never signalled — but it can outlive its test just
 * as a barrier can. So it is opened through `openTestSession`: its marker is recorded before it
 * connects, and comes off only once its closing was acknowledged and that exact backend was seen gone.
 */

export interface RaceBounds {
  /** How long one lock-evidence wait may go on before the schedule is declared failed. */
  pollMs: number;
  /** How long each cleanup step may wait: operations settling, and their backends going idle. */
  cleanupMs: number;
}

const DEFAULT_BOUNDS: RaceBounds = { pollMs: 10_000, cleanupMs: 5_000 };
/** How long a harness-owned connection may take to connect, or one of its statements to run. */
const OWNED_CONNECTION_BOUND_MS = 10_000;
/** The interval between two reads of the same evidence. Never what a schedule is built on. */
const EVIDENCE_INTERVAL_MS = 25;
/**
 * The timeout of every test that races — far above Vitest's default (5 s), which is shorter than a
 * single evidence wait.
 *
 * What one schedule can spend, each part separately bounded:
 *
 *   - the barrier's acquisition: connecting, its four statements (who it is, BEGIN, the lock
 *     timeout, the lock) and the monitor's two reads of it (that exact backend, then its tag), up
 *     to `OWNED_CONNECTION_BOUND_MS` apiece;
 *   - its evidence waits, of which there are SEVERAL — `parkThenCompete` makes three, five with
 *     `whileQueued`; `parkWhile` makes two around a bounded run — each up to `pollMs`;
 *   - the barrier's disappearance, which is FOUR bounded steps, not one: `disposeOwned` rolls back
 *     and then ends the connection (up to `OWNED_CONNECTION_BOUND_MS` each), and absence is then
 *     waited for twice — no session under the tag, and not that exact backend — up to `cleanupMs`
 *     each;
 *   - up to three cleanup rounds (settle, cancel, terminate) of up to two `cleanupMs` each, and
 *     between them the two signals' acknowledgements, up to `OWNED_CONNECTION_BOUND_MS` each.
 *
 * At the defaults (`pollMs` 10 s, `cleanupMs` 5 s, `OWNED_CONNECTION_BOUND_MS` 10 s) that is up to
 * 70 s to acquire, 30 s of evidence waits (50 s with `whileQueued`), 30 s for the barrier to be seen
 * gone and 50 s of cleanup rounds: 180 s, or 200 s — and 110 s (130 s) even when acquisition is
 * instant. A wait that succeeds returns as soon as PostgreSQL shows the evidence, and a schedule
 * stops at its first wait that fails, so in practice one wait runs long. But nothing makes the
 * others short: a schedule in which every part takes nearly its whole bound adds up to more than
 * this timeout.
 *
 * That case is not made to fit by this number; it fails closed. A test Vitest gives up on leaves
 * its scope's in-flight marker on file until `finish` has proven cleanup, and until then the
 * tier's setup file refuses to truncate or load another file.
 */
export const RACE_TEST_TIMEOUT_MS = 90_000;

/** Every connection this module opens is named, so its fate can be read from `pg_stat_activity`. */
const APPLICATION = "identity-race-harness";

export class RaceHarnessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RaceHarnessError";
  }
}

/** How cleanup after a barrier's release was established — or that it was not. */
export type CleanupOutcome = "quiet" | "cancelled" | "terminated" | "unproven";

export interface CleanupReport {
  /** `quiet`: everything finished by itself. `cancelled` / `terminated`: only after that signal to
   * the raced operations' own backends. `unproven`: the barrier's session was not seen gone, or the
   * raced operations not seen settled, even then — the run has been stopped. */
  outcome: CleanupOutcome;
  /** The barrier's own tagged session was SEEN to be absent from `pg_stat_activity`. */
  barrierGone: boolean;
  /** The backends that were signalled: always, and only, ones a raced operation held at that moment
   * — and that the pool was kept from handing to anyone else until the signal had been executed. */
  signalled: number[];
  /** Each raced operation: every backend it ever held, and whether it had settled. */
  operations: { label: string; backends: number[]; settled: boolean }[];
}

/**
 * A schedule that failed — reported only AFTER its barrier was released and cleanup of everything
 * it had started was attempted. `cleanup` says how that went.
 */
export class RaceScheduleError extends RaceHarnessError {
  readonly cleanup: CleanupReport;
  /** The schedule's own failure, when there was one; undefined when only cleanup needed help. */
  readonly failure: unknown;

  constructor(message: string, cleanup: CleanupReport, failure?: unknown) {
    super(message);
    this.name = "RaceScheduleError";
    this.cleanup = cleanup;
    this.failure = failure;
  }
}

/** Non-null once the run has been stopped because cleanup could not be proven. */
export function raceHarnessFatal(): string | null {
  return currentRunSafety().fatal();
}

/**
 * The clock a bounded wait runs on: where its deadline is read from, and what ends a read, a pause
 * or a step that would outlast it. Every wait runs on the real one; another is a SEAM for the
 * harness's own tests, which stage a deadline passing instead of waiting for one.
 */
export interface EvidenceClock {
  /** Milliseconds on a clock that only goes forward. Only differences between two readings mean anything. */
  now: () => number;
  /** Call `fire` once `ms` have passed. Returns how to call that off. */
  after: (ms: number, fire: () => void) => () => void;
}

/**
 * THE REAL CLOCK IS MONOTONIC. A deadline is a length of time, so it is read from a clock that only
 * goes forward, at the rate time passes (`performance.now()`) — never from the wall clock. A wall
 * clock is SET: by NTP, by a machine waking from sleep, by hand. A deadline read from it is extended
 * when it is set back and cut short when it is set forward, and neither is time having passed. The
 * timers are the event loop's, which are monotonic too.
 *
 * `performance.now` is looked up on every call, not captured once: the harness's own tests stage a
 * monotonic reading there while they move the wall clock the other way.
 */
const REAL_CLOCK: EvidenceClock = {
  now: () => globalThis.performance.now(),
  after: (ms, fire) => {
    const timer = setTimeout(fire, ms);
    return () => clearTimeout(timer);
  },
};

const explain = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** `start()`, with a synchronous throw — or a result that is no promise — made the promise it stands for. */
function attempt<T>(start: () => Promise<T>): Promise<T> {
  try {
    const started = start();
    return new Promise<T>((resolve) => { resolve(started); });
  } catch (error) {
    return Promise.reject(error);
  }
}

/**
 * SEAMS for the harness's own tests, on the waits that prove a barrier's session gone: another
 * clock, and something to stand in front of every read of that evidence — it is given the real
 * read, and what it returns is what the wait awaits. Together they stage evidence of absence that
 * arrives only after the cleanup budget has run out.
 */
export interface EvidenceSeam {
  clock?: EvidenceClock;
  read?: <T>(read: () => Promise<T>) => Promise<T>;
}

/** How `work` settled — and whether the clock had already reached the deadline when it did. */
interface Outcome<T> {
  result: { ok: true; value: T } | { ok: false; error: unknown };
  /** It settled AT OR AFTER the deadline: ahead of the timer that was to say so, but not in time. */
  late: boolean;
}

/**
 * THE ONE PRIMITIVE EVERY BOUND IS BUILT ON. What became of `work` by `deadline` (a reading of
 * `clock`): how it settled, or `null` if the timer for the deadline fired while it was still pending.
 *
 * THE TIMER IS NOT THE CLOCK. A timer that is due can be run after a result that arrived later than
 * it was due — a busy event loop does exactly that — so "the result came before the timer fired" says
 * nothing about when it came. The clock is therefore asked when `work` settles, on BOTH paths: a
 * resolution and a rejection at or after the deadline are each reported `late`, and no caller here
 * treats a late outcome as one that met its bound.
 *
 * This promise settles ONCE, and never rejects. Both of `work`'s outcomes are observed whenever they
 * come; one that comes after the timer finds it settled and changes nothing — never an unhandled
 * rejection, never a result anyone acts on, never a second verdict.
 */
function outcomeBy<T>(clock: EvidenceClock, work: Promise<T>, deadline: number): Promise<Outcome<T> | null> {
  return new Promise((resolve) => {
    let over = false;
    let callOff = (): void => undefined;
    const end = (outcome: Outcome<T> | null): void => {
      if (over) return;
      over = true;
      callOff();
      resolve(outcome);
    };
    callOff = clock.after(Math.max(0, deadline - clock.now()), () => end(null));
    work.then(
      (value) => end({ result: { ok: true, value }, late: clock.now() >= deadline }),
      (error: unknown) => end({ result: { ok: false, error }, late: clock.now() >= deadline }),
    );
  });
}

/**
 * What `work` RESOLVED to, if it did so before `ms` had passed on `clock`; otherwise `null` — it
 * rejected, it was still pending, or it resolved only at or after the deadline. For a step that
 * proves something only by being acknowledged: closing a connection, executing a signal.
 */
async function fulfilledWithin<T>(clock: EvidenceClock, work: Promise<T>, ms: number): Promise<{ value: T } | null> {
  const outcome = await outcomeBy(clock, work, clock.now() + ms);
  return outcome && !outcome.late && outcome.result.ok ? { value: outcome.result.value } : null;
}

/**
 * Re-read `read` until `accept` holds. Stops early — with an error — as soon as `abort` gives a
 * reason the evidence can no longer appear, and otherwise at the wait's DEADLINE, `timeoutMs` after
 * it began.
 *
 * The deadline bounds everything the wait does, not just how often it reads:
 *
 *   - a read is started only while there is budget left, and is given what is left of it. One still
 *     pending at the deadline fails the wait then; no other read is started, and whatever that one
 *     later resolves or rejects with is dropped (`outcomeBy`);
 *   - a read that does come back is checked against the deadline BEFORE it is accepted. The timer
 *     that bounds a read and the clock are not the same thing — a late result can be delivered ahead
 *     of a timer that is already due — so evidence that is what was expected, but was read at or
 *     after the deadline, fails the wait like any other;
 *   - a read that FAILS is the wait's failure, as its own error, when it fails in time; one that
 *     fails only at or after the deadline is late like any other, and the wait ends as expired;
 *   - the pause between two reads never runs past the deadline either.
 *
 * `clock` is a seam for the harness's own tests (`EvidenceClock`).
 */
export async function untilEvidence<T>(opts: {
  read: () => Promise<T>;
  accept: (value: T) => boolean;
  expected: string;
  show: (value: T) => string;
  timeoutMs: number;
  abort?: () => string | null;
  clock?: EvidenceClock;
}): Promise<T> {
  const clock = opts.clock ?? REAL_CLOCK;
  const deadline = clock.now() + opts.timeoutMs;
  const expired = (how: string) => new RaceHarnessError(`no evidence within ${opts.timeoutMs} ms of ${opts.expected}; ${how}`);
  // The last read that came back IN TIME — the detail of a wait that then runs out.
  let seen: { value: T } | null = null;
  for (;;) {
    if (deadline - clock.now() <= 0) throw expired(seen ? `last saw ${opts.show(seen.value)}` : "nothing was read");
    const read = await outcomeBy(clock, opts.read(), deadline);
    const lastSaw = seen ? `; last saw ${opts.show(seen.value)}` : "";
    if (!read) throw expired(`a read was still pending at the deadline${lastSaw}`);
    // `late` was asked of the clock itself, as the read settled: that it beat its timer says nothing.
    const { result, late } = read;
    if (!result.ok) {
      if (!late) throw result.error;
      throw expired(`a read failed only at or after the deadline (${explain(result.error)})${lastSaw}`);
    }
    const { value } = result;
    const accepted = opts.accept(value);
    if (accepted && !late) return value;
    if (!accepted) {
      const aborted = opts.abort?.() ?? null;
      if (aborted) throw new RaceHarnessError(`${aborted} — expected ${opts.expected}; saw ${opts.show(value)}`);
    }
    if (late) {
      throw expired(accepted ? `what was expected was read only at or after the deadline: ${opts.show(value)}` : `last saw ${opts.show(value)}`);
    }
    seen = { value };
    const interval = Math.min(EVIDENCE_INTERVAL_MS, deadline - clock.now());
    await new Promise<void>((resolve) => { clock.after(interval, resolve); });
  }
}

/**
 * `true` only if `work` SETTLED — resolved or rejected — before `ms` had passed on `clock`. One that
 * settles at or after that deadline is `false`, also when the timer for it has not been run yet; and
 * once this has said `false`, nothing `work` does later says anything else (`outcomeBy`).
 *
 * Exported, with its `clock`, as a SEAM for the harness's own tests.
 */
export async function withinBound(work: Promise<unknown>, ms: number, clock: EvidenceClock = REAL_CLOCK): Promise<boolean> {
  const outcome = await outcomeBy(clock, work, clock.now() + ms);
  return outcome !== null && !outcome.late;
}

/**
 * What closing a harness-owned connection was SEEN to do. `closed`: every step of it was
 * acknowledged, each within its bound. `uncertain`: a step was still pending at its deadline, failed,
 * or was acknowledged only at or after it — or the closing was somebody else's code that did not say.
 *
 * `uncertain` is not "probably closed". A session whose closing was not acknowledged is not proven
 * gone by anything read afterwards (`holdLock`, `openTestSession`).
 */
export type Disposal = "closed" | "uncertain";

/** A replacement for closing an owned connection — a SEAM for the harness's own tests. */
export type DisposeSeam = (client: Client, rollback: boolean) => Promise<Disposal | void>;

/**
 * Close a harness-owned client for good: roll back if asked, end it, never wait unboundedly — and
 * SAY what was seen of it. Never throws.
 *
 * Best-effort to the end: whatever became of the rollback, the connection is still ended (ending it
 * ends its session, and the server rolls back whatever it still held). But only a closing whose every
 * step was acknowledged in time is reported `closed`.
 */
async function disposeOwned(client: Client, rollback: boolean, clock: EvidenceClock = REAL_CLOCK): Promise<Disposal> {
  const rolledBack = !rollback
    || (await fulfilledWithin(clock, attempt(() => client.query("rollback")), OWNED_CONNECTION_BOUND_MS)) !== null;
  const ended = (await fulfilledWithin(clock, attempt(() => client.end()), OWNED_CONNECTION_BOUND_MS)) !== null;
  return rolledBack && ended ? "closed" : "uncertain";
}

/**
 * Close an owned client — by `replacement`, if a test gave one — and say what was seen of it. Never
 * throws.
 *
 * A replacement is bounded here, as the one step it is, and is believed only if it SAYS `closed`,
 * in time. One that is still pending at the deadline, that rejects, that answers late, or that
 * resolves with anything else — nothing at all, included — is `uncertain`.
 */
async function closeOwned(client: Client, rollback: boolean, clock: EvidenceClock, replacement?: DisposeSeam): Promise<Disposal> {
  if (!replacement) return disposeOwned(client, rollback, clock);
  const said = await fulfilledWithin(clock, attempt(() => replacement(client, rollback)), OWNED_CONNECTION_BOUND_MS);
  return said?.value === "closed" ? "closed" : "uncertain";
}

function ownedClient(role: string, applicationName = `${APPLICATION}/${role}`): Client {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    application_name: applicationName,
    connectionTimeoutMillis: OWNED_CONNECTION_BOUND_MS,
    statement_timeout: OWNED_CONNECTION_BOUND_MS,
  });
  client.on("error", () => undefined);
  return client;
}

// ── The monitor: the harness's own connection for evidence and for signalling ──────────────────

let monitor: Promise<Client> | undefined;

function monitorClient(): Promise<Client> {
  monitor ??= (async () => {
    const client = ownedClient("monitor");
    try {
      await client.connect();
      return client;
    } catch (error) {
      monitor = undefined;
      // It never connected, and it is the failed connection that is reported: what closing it was
      // seen to do decides nothing here.
      await disposeOwned(client, false);
      throw error;
    }
  })();
  return monitor;
}

/**
 * One query on the monitor, as it comes: bounded by nothing of its own. That is right INSIDE an
 * evidence wait, which bounds each of its reads by what is left of its one deadline — a second timer
 * around the same read would only compete with it. A read made anywhere else goes through `answered`.
 */
async function observe<T>(text: string, params: unknown[] = []): Promise<T[]> {
  return (await (await monitorClient()).query(text, params)).rows as T[];
}

/**
 * A read asked of the monitor DIRECTLY — not inside an evidence wait, so with no deadline around it
 * yet. It is answered within the bound of one owned-connection statement, or it has failed: an
 * answer still pending then, or arriving at or after it, is not one, and is dropped when it comes.
 * A read that fails in time fails with its own error.
 */
async function answered<T>(what: string, read: Promise<T>): Promise<T> {
  const outcome = await outcomeBy(REAL_CLOCK, read, REAL_CLOCK.now() + OWNED_CONNECTION_BOUND_MS);
  if (!outcome || outcome.late) {
    throw new RaceHarnessError(`the monitor did not answer within ${OWNED_CONNECTION_BOUND_MS} ms: ${what}`);
  }
  if (!outcome.result.ok) throw outcome.result.error;
  return outcome.result.value;
}

/** Close the monitor. Call once, after the file's last test. */
export async function closeRaceHarness(): Promise<void> {
  const open = monitor;
  monitor = undefined;
  if (open) await open.then((client) => disposeOwned(client, false), () => undefined);
}

// ── Evidence about EXACT sessions (the test's own foreign clients, a barrier, a raced backend) ──

export interface SessionEvidence {
  pid: number;
  /** `pg_stat_activity.state`: `idle`, `active`, `idle in transaction`, … */
  state: string | null;
  /** The kind of lock this backend is waiting for, or null if it is waiting for none. */
  waitingOn: string | null;
  /** How many locks of this database it holds granted (relation and advisory). */
  locksHeld: number;
}

const databaseOid = "(select oid from pg_database where datname = current_database())";

/** One reading of exactly these backends, unbounded: for an evidence wait to bound (`observe`). */
async function readSessionEvidence(pids: number[]): Promise<SessionEvidence[]> {
  if (pids.length === 0) return [];
  return observe<SessionEvidence>(
    `select a.pid, a.state,
            (select l.locktype from pg_locks l where l.pid = a.pid and not l.granted limit 1) as "waitingOn",
            (select count(*)::int from pg_locks l
              where l.pid = a.pid and l.granted and l.database = ${databaseOid}
                and l.locktype in ('relation','advisory')) as "locksHeld"
       from pg_stat_activity a
      where a.pid = any($1::int[])
      order by a.pid`, [pids]);
}

/** What PostgreSQL says about exactly these backends. A backend that is gone has no row. */
export async function sessionEvidence(pids: number[]): Promise<SessionEvidence[]> {
  return answered(`the state of backends ${pids.join(",")}`, readSessionEvidence(pids));
}

/** Re-read exactly these backends until `accept` holds, within the default evidence bound. */
export async function untilSessions(
  pids: number[],
  expected: string,
  accept: (sessions: SessionEvidence[]) => boolean,
): Promise<SessionEvidence[]> {
  return untilEvidence({
    read: () => readSessionEvidence(pids),
    accept,
    expected,
    show: (sessions) => JSON.stringify(sessions),
    timeoutMs: DEFAULT_BOUNDS.pollMs,
  });
}

/** PostgreSQL keeps at most this many bytes of an `application_name`; the rest is silently cut. */
const MAX_APPLICATION_NAME_BYTES = 63;

/** The `application_name` a barrier's session is found — and later seen gone — by. */
const barrierSessionName = (tag: string) => `${APPLICATION}/barrier/${tag}`;

/** One reading of the sessions under one exact `application_name`, unbounded: for an evidence wait to bound. */
const readSessionsNamed = (applicationName: string) => observe<{ pid: number; state: string | null }>(
  "select pid, state from pg_stat_activity where datname = current_database() and application_name = $1 order by pid",
  [applicationName]);

/** The live sessions of this database under one exact `application_name`. */
export async function sessionsNamed(applicationName: string): Promise<{ pid: number; state: string | null }[]> {
  return answered(`the sessions named ${applicationName}`, readSessionsNamed(applicationName));
}

/** The live sessions of one named barrier (`holdLock`'s `tag`), found by its exact `application_name`. */
export async function barrierSessions(tag: string): Promise<{ pid: number; state: string | null }[]> {
  return sessionsNamed(barrierSessionName(tag));
}

/** Re-read one named barrier's sessions until none is left, within the default evidence bound. */
export async function untilBarrierGone(tag: string): Promise<void> {
  await untilEvidence({
    read: () => readSessionsNamed(barrierSessionName(tag)),
    accept: (sessions) => sessions.length === 0,
    expected: `no session left for barrier ${tag}`,
    show: (sessions) => JSON.stringify(sessions),
    timeoutMs: DEFAULT_BOUNDS.pollMs,
  });
}

// ── Barriers: explicitly owned connections that hold one lock ──────────────────────────────────

export interface Barrier {
  /** The barrier's own backend: the exact blocker a parked operation must be waiting on. */
  pid: number;
  /** The name of its session (`barrierSessions`) and of its in-flight scope in the run-safety state. */
  tag: string;
  /**
   * Release the lock and PROVE it: close the connection, see the tagged session gone, and only
   * then clear this scope's in-flight marker. If the session cannot be seen gone the run is stopped
   * and this rejects. Idempotent, and safe to call concurrently.
   */
  release: () => Promise<void>;
  /** For the schedules: close the connection once, and say whether its session was PROVEN gone —
   * its closing acknowledged within its bound, and then each proof of absence within `cleanupMs` of
   * its own. `evidence` is a seam for the harness's own tests (`EvidenceSeam`); like `cleanupMs`, it
   * is the first call's that counts — and so is the verdict: it is never taken again. */
  vanish: (cleanupMs: number, evidence?: EvidenceSeam) => Promise<boolean>;
  /** For the schedules: clear this scope's marker (`proven`) or stop the run. The first conclusion stands. */
  conclude: (proven: boolean, reason: string) => void;
}

export interface BarrierOptions {
  /** Names the session and the scope, so a test can prove what became of them. */
  tag?: string;
  /** Shortens how long the barrier's own lock request may wait before PostgreSQL refuses it. */
  lockTimeoutMs?: number;
  /** SEAMS for the harness's own tests: another run-safety state, a shorter cleanup budget, a
   * replacement for closing the connection (to stage a barrier that survives its release, or a
   * closing that is never acknowledged — `DisposeSeam`), the clock that closing is bounded on, and a
   * different `application_name` for its session (to stage one that cannot be found by its tag —
   * what an `application_name` in the connection string does to every session). */
  safety?: RunSafety;
  cleanupMs?: number;
  dispose?: DisposeSeam;
  clock?: EvidenceClock;
  applicationName?: string;
}

const UNPROVEN_BARRIER: CleanupReport = { outcome: "unproven", barrierGone: false, signalled: [], operations: [] };

/** One backend, exactly: its pid AND when it started (epoch seconds, as text — the same in every
 * session's time zone), so a later backend given the same pid is not it. */
interface BackendIdentity { pid: number; started: string }

/**
 * One read of absence evidence, as the wait is to make it: the real read, or the seam's stand-in for it.
 *
 * NAME its result before handing it to `untilEvidence`. Called in place, as that call's `read`, a
 * generic function that returns a function is set aside while the call's own type is inferred — so
 * nothing is learnt from it in time, and `accept` and `show` are given `unknown`.
 */
const seamed =<T>(seam: EvidenceSeam, read: () => Promise<T>) => (): Promise<T> => (seam.read ? seam.read(read) : read());

/** The monitor's own reading of one exact backend: the rows of `pg_stat_activity` that are it. */
const backendRows = (backend: BackendIdentity) => observe<{ pid: number }>(
  "select pid from pg_stat_activity where pid = $1 and extract(epoch from backend_start)::text = $2", [backend.pid, backend.started]);

/**
 * That exact backend was SEEN to be absent within `ms`. Unreadable evidence is not absence.
 *
 * Only meaningful for a backend the monitor has first SEEN PRESENT under this same predicate
 * (`holdLock` records that): "no row matches" proves a backend gone only if a row did match while
 * it was alive. Without that, a predicate that never matched — the two sessions rendering the start
 * time differently, say — would read as "gone" at once.
 */
async function backendAbsent(backend: BackendIdentity, ms: number, seam: EvidenceSeam = {}): Promise<boolean> {
  try {
    const read = seamed(seam, () => backendRows(backend));
    await untilEvidence({
      read,
      accept: (sessions) => sessions.length === 0,
      expected: `backend ${backend.pid} (started ${backend.started}) gone`,
      show: (sessions) => JSON.stringify(sessions),
      timeoutMs: ms,
      clock: seam.clock,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * No session under one exact `application_name` was SEEN within `ms`. Unreadable evidence is not
 * absence — and nor is evidence read too late: a read that shows none only after `ms` is `false`.
 */
async function namedAbsent(applicationName: string, expected: string, ms: number, seam: EvidenceSeam = {}): Promise<boolean> {
  try {
    const read = seamed(seam, () => readSessionsNamed(applicationName));
    await untilEvidence({
      read,
      accept: (sessions) => sessions.length === 0,
      expected,
      show: (sessions) => JSON.stringify(sessions),
      timeoutMs: ms,
      clock: seam.clock,
    });
    return true;
  } catch {
    return false;
  }
}

/** The tagged barrier session was SEEN to be absent within `ms` (`namedAbsent`). */
const barrierAbsent = (tag: string, ms: number, seam: EvidenceSeam = {}): Promise<boolean> =>
  namedAbsent(barrierSessionName(tag), `no session left for barrier ${tag}`, ms, seam);

/**
 * A connection of the harness's own, in a transaction that holds the lock `sql` takes until it is
 * released.
 *
 * BEFORE it connects, its scope is recorded as in flight in the run-safety state; if that cannot
 * be recorded this throws and no connection is made. Connecting, BEGIN, the lock itself and the
 * identity reads are all bounded. If any of them fails, the connection is closed and its session
 * must be SEEN gone before the marker is cleared and the original error rethrown; if it cannot be,
 * the run is stopped. A barrier that was not handed out holds nothing, leaves no session — and that
 * is proven, not inferred from `rollback` / `end()` having returned.
 *
 * ABSENCE NEEDS A POSITIVE CONTROL. "No session under this tag" proves the barrier gone only if the
 * barrier WAS a session under this tag. So, before any lock is taken, the session itself must
 * report the exact `application_name` it will be looked for by (a name set in the connection
 * string overrides the one given here; a name too long is cut); and before the barrier is handed
 * out, the monitor must see exactly one session under the tag, and it must be this backend. Either
 * failing is a failed acquisition. And absence is then seen twice over: no session under the tag,
 * and not this exact backend (its pid and start time) — so a session that could not be found by
 * its name is still not mistaken for one that has gone. That second proof has a positive control
 * of its own: right after the session identifies itself, the monitor must see exactly that backend
 * by the very predicate that will later show it gone. A backend the monitor never saw present —
 * unreadable, or not matching — is `unproven` on every path; its absence is never taken as proof.
 *
 * AND ABSENCE NEEDS AN ACKNOWLEDGED CLOSING. The connection is closed first, within a bound, and
 * what was seen of that is kept (`Disposal`). If the closing was not acknowledged in time — still
 * pending, failed, answered late, or not answered in so many words — the barrier is `unproven` there
 * and then and for good: the marker stays, the run is stopped, and no absence read then or later, and
 * no late answer from the closing, changes that. The first verdict of `vanish` is the only one.
 */
export async function holdLock(sql: string, params: unknown[] = [], opts: BarrierOptions = {}): Promise<Barrier> {
  const tag = opts.tag ?? randomUUID().slice(0, 12);
  // The tag IS the evidence: the session is found, and later seen gone, by its exact
  // `application_name`. PostgreSQL silently truncates a name longer than 63 bytes — a session whose
  // name was cut would never match, and "no such session" would read as "gone". So a tag that
  // cannot be carried whole is refused before anything is recorded or connected.
  const sessionName = barrierSessionName(tag);
  if (!/^[A-Za-z0-9._-]+$/.test(tag) || Buffer.byteLength(sessionName, "utf8") > MAX_APPLICATION_NAME_BYTES) {
    throw new RaceHarnessError(
      `unusable barrier tag ${JSON.stringify(tag)}: it must be [A-Za-z0-9._-]+ and "${sessionName}" must fit PostgreSQL's `
      + `${MAX_APPLICATION_NAME_BYTES}-byte application_name`,
    );
  }
  const safety = opts.safety ?? currentRunSafety();
  const cleanupMs = opts.cleanupMs ?? DEFAULT_BOUNDS.cleanupMs;
  const clock = opts.clock ?? REAL_CLOCK;
  // FIRST: the in-flight marker. If it cannot be written, nothing below runs.
  safety.arm(tag, `barrier ${tag}: ${sql}`);

  const owner = ownedClient(`barrier/${tag}`, opts.applicationName ?? sessionName);
  let connected = false;
  let begun = false;
  let backend: BackendIdentity | null = null;
  // The monitor has SEEN that exact backend present — the positive control its absence rests on.
  let backendSeen = false;
  let vanished: Promise<boolean> | undefined;
  const vanish = (ms: number, evidence: EvidenceSeam = {}): Promise<boolean> => (vanished ??= (async () => {
    // THE CLOSING ITSELF, bounded, and what was seen of it KEPT. A closing that was not acknowledged
    // in time proves nothing, and nothing read afterwards proves it for it: the session may be gone,
    // and may be seen gone — it is `unproven` all the same, now and whenever this is asked again.
    if ((await closeOwned(owner, begun, clock, opts.dispose)) !== "closed") return false;
    // Never connected: there was no session. (The tag is still looked for, for what it is worth.)
    if (!connected) return barrierAbsent(tag, ms, evidence);
    // A session that was opened and never identified, or that the monitor never saw under the
    // identity it would be looked for by, cannot be seen gone: an absent row would prove nothing.
    if (!backend || !backendSeen) return false;
    if (!(await barrierAbsent(tag, ms, evidence))) return false;
    return backendAbsent(backend, ms, evidence);
  })());
  let concluded = false;
  const conclude = (proven: boolean, reason: string): void => {
    if (concluded) return;
    concluded = true;
    if (proven) safety.disarm(tag);
    else safety.setFatal(reason);
  };
  const stop = (what: string, failure?: unknown): RaceScheduleError => {
    const reason = `identity race harness: barrier ${tag} ${what}, and its session could not be proven gone. `
      + "Sessions that may still hold locks must not be truncated around.";
    conclude(false, reason);
    return new RaceScheduleError(reason, UNPROVEN_BARRIER, failure);
  };

  try {
    await owner.connect();
    connected = true;
    // WHO this session is, from the session itself, before it begins or locks anything.
    const self = (await owner.query<{ pid: unknown; started: unknown; name: unknown }>(
      `select pg_backend_pid() as pid,
              (select extract(epoch from backend_start)::text from pg_stat_activity where pid = pg_backend_pid()) as started,
              current_setting('application_name') as name`)).rows[0];
    if (!self || typeof self.pid !== "number" || !Number.isInteger(self.pid) || typeof self.started !== "string" || !self.started) {
      throw new RaceHarnessError("the barrier's backend could not be identified");
    }
    backend = { pid: self.pid, started: self.started };
    const pid = backend.pid;
    // THE POSITIVE CONTROL FOR ITS IDENTITY, before anything can fail on its name: the monitor must
    // see exactly one row that is this backend, by the predicate that will later be asked to show
    // it gone. If it does not — or cannot be read — the session is never treated as absent.
    const present = await answered(`backend ${pid} of barrier ${tag}`, backendRows(backend));
    if (present.length !== 1 || present[0].pid !== pid) {
      throw new RaceHarnessError(
        `barrier ${tag}: the monitor must see exactly its backend ${pid} (started ${backend.started}), and sees ${JSON.stringify(present)}`,
      );
    }
    backendSeen = true;
    if (self.name !== sessionName) {
      throw new RaceHarnessError(
        `barrier ${tag}: its session reports application_name ${JSON.stringify(self.name)}, not ${JSON.stringify(sessionName)} — `
        + "it could not be found again by its tag (is application_name set in the connection string?)",
      );
    }
    await owner.query("begin");
    begun = true;
    // The barrier waits for nobody: if its lock is not free, that is a failed schedule, not a wait.
    await owner.query("select set_config('lock_timeout', $1, true)", [`${opts.lockTimeoutMs ?? OWNED_CONNECTION_BOUND_MS}ms`]);
    await owner.query(sql, params);
    // THE POSITIVE CONTROL, from the monitor — the connection that will later look for it: exactly
    // one session under this tag, and it is this backend. Unreadable evidence fails here too.
    const visible = await barrierSessions(tag);
    if (visible.length !== 1 || visible[0].pid !== pid) {
      throw new RaceHarnessError(
        `barrier ${tag}: the monitor must see exactly its own session (backend ${pid}) under its tag, and sees ${JSON.stringify(visible)}`,
      );
    }
    let released: Promise<void> | undefined;
    const release = (): Promise<void> => (released ??= (async () => {
      if (!(await vanish(cleanupMs))) throw stop("was released");
      conclude(true, "");
    })());
    return { pid, tag, release, vanish, conclude };
  } catch (error) {
    if (!(await vanish(cleanupMs))) {
      throw stop(`failed to acquire (${error instanceof Error ? error.message : String(error)})`, error);
    }
    conclude(true, "");
    throw error;
  }
}

/** ACCESS EXCLUSIVE on one table: every read and write of it waits, nothing else does. */
export const holdTable = (
  table: "member_identities" | "member_identity_mapping_state" | "audit_log",
  opts: BarrierOptions = {},
) => holdLock(`lock table ${table} in access exclusive mode`, [], opts);

/** The name of the writer's own exact-identity advisory lock — taken after the team authority, before its rows. */
export const identityLockName = (teamId: string, provider: string, externalId: string) =>
  `${teamId}:identity:${provider}:${externalId}`;

export const holdIdentityKey = (teamId: string, provider: string, externalId: string, opts: BarrierOptions = {}) =>
  holdLock("select pg_advisory_xact_lock(hashtextextended($1, 0))", [identityLockName(teamId, provider, externalId)], opts);

/** An advisory lock of the test's own naming — a barrier unrelated to any production key. */
export const holdNamedLock = (name: string, opts: BarrierOptions = {}) =>
  holdLock("select pg_advisory_xact_lock(hashtextextended($1, 0))", [name], opts);

/** The name of one team's identity-authority advisory lock — what the mutation boundary takes first. */
export const authorityLockName = (teamId: string) => `${teamId}:identity-authority`;

// ── A test's own sessions: plain clients, never registered, never signalled — and still scopes ──

/** Every session a test opens through `openTestSession` is named under this, so it can be told apart. */
const TEST_SESSION = "identity-race-foreign";

export interface TestSession {
  /** The test's own client. What it runs, and when, is the test's business. */
  client: Client;
  /** Its backend: what the test reads evidence about. */
  pid: number;
  /** The name of its in-flight scope in the run-safety state. */
  scope: string;
  /**
   * Close it and PROVE it: end the connection, see that exact backend gone, and only then clear its
   * in-flight marker. If the closing is not acknowledged in time, or the backend is not seen gone,
   * the run is stopped, the marker stays and this rejects — then and on every later call.
   * Idempotent, and safe to call concurrently.
   */
  close: () => Promise<void>;
}

export interface TestSessionOptions {
  /** SEAMS for the harness's own tests, as a barrier's (`BarrierOptions`): another run-safety state,
   * a shorter budget for seeing the backend gone, and the clock its closing is bounded on. (There is
   * no replacement for the closing here: the client is the test's, and a test that wants its `end`
   * to do something else can make it so.) */
  safety?: RunSafety;
  cleanupMs?: number;
  clock?: EvidenceClock;
}

/**
 * A session of a TEST's own: a plain client, under an `application_name` of its own, that the
 * harness never registers as a raced operation, never reads lock-wait evidence for and never
 * signals. It is what a test uses to hold a lock the harness does not release, or to wait where a
 * raced operation waits.
 *
 * It is a SCOPE all the same, because it can hold a lock past its test exactly as a barrier can —
 * and a `TRUNCATE` would then block on it, or clean up around it. So, as for a barrier (`holdLock`):
 *
 *   - BEFORE it connects, its scope is recorded as in flight; if that cannot be recorded this throws
 *     and no connection is made;
 *   - the session reports who it is — its pid and when it started — and the monitor must SEE exactly
 *     that backend, by the predicate that will later be asked to show it gone, before the session is
 *     handed out. One the monitor never saw present is never treated as absent;
 *   - `close` ends the connection within a bound and keeps what was seen of that (`Disposal`), then
 *     waits, within `cleanupMs`, to see that exact backend gone. Only both together clear the marker.
 *     A closing that was not acknowledged in time, or a backend not seen gone, stops the run and
 *     leaves the marker — for good: the first conclusion stands, whatever is read or answered later;
 *   - a session that could not be opened is closed and proven gone the same way before the original
 *     error is rethrown, and stops the run if it cannot be.
 *
 * Its closing does not roll back first: a test's client may have a statement still waiting on a
 * lock, and a `rollback` would only queue behind it. Ending the connection ends the session.
 */
export async function openTestSession(name: string, opts: TestSessionOptions = {}): Promise<TestSession> {
  const sessionName = `${TEST_SESSION}/${name}`;
  // As for a barrier's tag: the name is what a session that never identified itself is looked for
  // by, and it names the scope's marker. One that cannot be carried whole is refused before anything
  // is recorded or connected.
  if (!/^[A-Za-z0-9._-]+$/.test(name) || Buffer.byteLength(sessionName, "utf8") > MAX_APPLICATION_NAME_BYTES) {
    throw new RaceHarnessError(
      `unusable test session name ${JSON.stringify(name)}: it must be [A-Za-z0-9._-]+ and "${sessionName}" must fit PostgreSQL's `
      + `${MAX_APPLICATION_NAME_BYTES}-byte application_name`,
    );
  }
  const safety = opts.safety ?? currentRunSafety();
  const cleanupMs = opts.cleanupMs ?? DEFAULT_BOUNDS.cleanupMs;
  const clock = opts.clock ?? REAL_CLOCK;
  const scope = `session-${name}`;
  // FIRST: the in-flight marker. If it cannot be written, nothing below runs.
  safety.arm(scope, `a test's own session ${sessionName}`);

  // The test's client, as a test would make it: bounded in connecting, and in nothing it runs — a
  // statement of its own may be MEANT to wait on a lock for as long as the schedule takes.
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    application_name: sessionName,
    connectionTimeoutMillis: OWNED_CONNECTION_BOUND_MS,
  });
  client.on("error", () => undefined);
  let connected = false;
  let backend: BackendIdentity | null = null;
  // The monitor has SEEN that exact backend present — the positive control its absence rests on.
  let backendSeen = false;
  let vanished: Promise<boolean> | undefined;
  const vanish = (): Promise<boolean> => (vanished ??= (async () => {
    // As for a barrier: a closing that was not acknowledged in time proves nothing, and nothing read
    // afterwards proves it for it.
    if ((await disposeOwned(client, false, clock)) !== "closed") return false;
    // Never connected: there was no session. (Its name is still looked for, for what it is worth.)
    if (!connected) return namedAbsent(sessionName, `no session left named ${sessionName}`, cleanupMs);
    if (!backend || !backendSeen) return false;
    return backendAbsent(backend, cleanupMs);
  })());
  let concluded = false;
  const conclude = (proven: boolean, reason: string): void => {
    if (concluded) return;
    concluded = true;
    if (proven) safety.disarm(scope);
    else safety.setFatal(reason);
  };
  const stop = (what: string): RaceHarnessError => {
    const reason = `identity race harness: a test's own session ${sessionName} ${what}, and it could not be proven gone. `
      + "Sessions that may still hold locks must not be truncated around.";
    conclude(false, reason);
    return new RaceHarnessError(reason);
  };

  try {
    await client.connect();
    connected = true;
    // WHO this session is, from the session itself, before the test is given it.
    const self = (await client.query<{ pid: unknown; started: unknown }>(
      `select pg_backend_pid() as pid,
              (select extract(epoch from backend_start)::text from pg_stat_activity where pid = pg_backend_pid()) as started`)).rows[0];
    if (!self || typeof self.pid !== "number" || !Number.isInteger(self.pid) || typeof self.started !== "string" || !self.started) {
      throw new RaceHarnessError(`the backend of test session ${sessionName} could not be identified`);
    }
    backend = { pid: self.pid, started: self.started };
    const pid = backend.pid;
    // THE POSITIVE CONTROL: the monitor sees exactly one row that is this backend, by the predicate
    // that will later be asked to show it gone.
    const present = await answered(`backend ${pid} of test session ${sessionName}`, backendRows(backend));
    if (present.length !== 1 || present[0].pid !== pid) {
      throw new RaceHarnessError(
        `test session ${sessionName}: the monitor must see exactly its backend ${pid} (started ${backend.started}), and sees ${JSON.stringify(present)}`,
      );
    }
    backendSeen = true;
    let closed: Promise<void> | undefined;
    const close = (): Promise<void> => (closed ??= (async () => {
      if (!(await vanish())) throw stop("was closed");
      conclude(true, "");
    })());
    return { client, pid, scope, close };
  } catch (error) {
    if (!(await vanish())) throw stop(`could not be opened (${explain(error)})`);
    conclude(true, "");
    throw error;
  }
}

// ── Registered raced operations ────────────────────────────────────────────────────────────────

/**
 * What becomes of one checkout when the operation that made it asks for its release.
 *
 *   - `returnable`: no signal was ever aimed at its backend. A release goes straight to the pool,
 *     with the operation's own argument — exactly as without this harness.
 *   - `reserved`: a cancel or terminate aimed at its backend may be on its way. A release is
 *     RECORDED and not carried out: the pool must not hand that backend to anyone else while a
 *     signal can still reach its PID.
 *   - `condemned`: the signal aimed at it has been executed by PostgreSQL (or was certainly never
 *     sent). The connection is never pooled again: when a signal is acted on by its backend cannot
 *     be observed, so a backend that was aimed at cannot be shown fit for a stranger's work. A
 *     release RETIRES it — the pool is given the client with an error, and destroys it.
 *   - `stranded`: a signal aimed at it may still be executed, and that cannot be told. It is never
 *     handed back at all: destroyed, its PID could pass to a new backend with that signal still to
 *     come.
 */
type LeaseFate = "returnable" | "reserved" | "condemned" | "stranded";

/** ONE CHECKOUT of one pool connection by a raced operation — not merely the PID it had. */
interface Lease {
  pid: number;
  fate: LeaseFate;
  /** The operation's own release request, made when it could not be carried out as asked: its argument. */
  requested: { error: unknown } | null;
  /** The pool has been ASKED to take the client back — to keep or to destroy. Never twice for one
   * checkout. That it was asked is not that it did: a hand-over that threw is `undisposed`. */
  surrendered: boolean;
  /** Give the client to the pool: the pool's own `release` of this checkout. */
  surrender: (error?: unknown) => unknown;
  /** Listen for the client's `error` event while a signal is aimed at it. A checked-out client is
   * listened to by nobody; one that is idle when its backend is terminated would otherwise raise
   * an uncaught exception in this process. */
  guard: () => void;
  unguard: () => void;
}

interface RacedSessions {
  label: string;
  /**
   * Its OUTSTANDING checkouts, by backend PID: connections the pool has not been given back. That
   * is every connection the operation still holds — and also one it has asked to release while a
   * signal was aimed at it, until that release is carried out.
   */
  leases: Map<number, Lease>;
  /** Every backend it has ever held: what must be seen idle or gone once it has finished. */
  seen: Set<number>;
  /** Checkouts whose backend PID could not be read, or whose release could not be intercepted. Any
   * makes ownership unprovable. */
  unidentified: number;
  /** Checkouts whose hand-over to the pool THREW — the operation's own ordinary release, or the
   * harness's retirement of a signalled one. Where such a connection is cannot be told. Never
   * decremented: any makes cleanup unprovable, for good. */
  undisposed: number;
  /** Its promise has resolved or rejected. */
  settled: boolean;
}

/** What the pool itself says to a second release of one checkout. */
const DOUBLE_RELEASE = "Release called on client which has already been released to the pool.";

/**
 * Carry a release out: the lease leaves its operation's books, and the pool is ASKED to take the
 * client — on every path, an ordinary release as much as a retirement.
 *
 * The lease is struck off BEFORE the pool is called, and has to be: inside its `release` the pool
 * may already lend that very connection on — to this same operation, even — and a lease still on
 * the books then would make the new checkout unidentifiable.
 *
 * BEING ASKED IS NOT HAVING TAKEN IT. The pool's `release` can throw part-way: an application's own
 * `release` listener runs before the pool has either kept the connection or destroyed it, and a
 * queued borrower's callback runs after it has already been lent on. Then nothing says where the
 * connection is — still out, or a stranger's. So a hand-over that throws is COUNTED (`undisposed`),
 * for good: no cleanup of this operation is proven after it, its scope's marker stays and the run
 * is stopped. The lease does not come back onto the books — a backend that may be someone else's
 * is not one to read lock waits for, or to aim a signal at — and the error goes on to whoever
 * asked, as it would without this harness.
 */
function surrenderLease(sessions: RacedSessions, lease: Lease, error: unknown): unknown {
  lease.surrendered = true;
  sessions.leases.delete(lease.pid);
  lease.unguard();
  try {
    return lease.surrender(error);
  } catch (failure) {
    sessions.undisposed += 1;
    throw failure;
  }
}

/**
 * Retire a CONDEMNED checkout whose release has been asked for: the pool is given the client with
 * an error — the operation's own if it gave one, the harness's otherwise — which is how a pool is
 * told to destroy a connection instead of keeping it. Any other lease is left exactly as it is.
 */
function retireLease(sessions: RacedSessions, lease: Lease): void {
  if (lease.surrendered || lease.fate !== "condemned" || !lease.requested) return;
  try {
    surrenderLease(sessions, lease, lease.requested.error
      || new RaceHarnessError(`backend ${lease.pid} was signalled by the identity race harness: its connection is retired, not pooled`));
  } catch {
    // The pool did not take it, and `surrenderLease` has counted that. There is nobody to tell:
    // the operation's own release returned long ago.
  }
}

interface Raced<T> extends RacedSessions {
  result: Promise<T>;
}

const racedScope = new AsyncLocalStorage<RacedSessions>();
let instrumented = false;

type Release = (error?: unknown) => unknown;
type ConnectCallback = (error: unknown, client: unknown, done: unknown) => void;
type Connect = (callback?: ConnectCallback) => unknown;

/**
 * Record, for the raced operation in whose scope a pool connection is checked out, which backend it
 * is — as a LEASE — and take over when it is returned. Installed once, on the application pool of
 * THIS test process; outside a raced scope it does nothing. The scope is read when `connect` is
 * CALLED — a pooled connection can be handed over later from another operation's release.
 *
 * The operation's `release` is the pool's own, wrapped: for a lease nothing was ever aimed at it
 * is the pool's release, with the operation's argument, at once. For a lease that is reserved,
 * condemned or stranded (`LeaseFate`) the request and its argument are recorded, and the pool is
 * given the client when — and if — that is safe (`retireLease`). Either way the pool is given one
 * checkout at most once; a second release of it is answered as the pool answers one.
 */
function instrumentPool(): void {
  if (instrumented) return;
  instrumented = true;
  const pool = getPool();
  // A backend this harness had to terminate surfaces as an idle-client error on the pool.
  pool.on("error", () => undefined);
  const connect = (pool.connect as unknown as Connect).bind(pool);
  const register = (sessions: RacedSessions | undefined, client: unknown): void => {
    if (!sessions || !client) return;
    const held = client as {
      processID?: unknown;
      release?: Release;
      on?: (event: string, listener: () => void) => unknown;
      removeListener?: (event: string, listener: () => void) => unknown;
    };
    const pid = held.processID;
    // The pool installs a fresh `release` on every checkout; this checkout's is the one to wrap.
    const release = held.release;
    // Not this operation's alone, provably: a backend that cannot be named, a release that cannot
    // be taken over (the pool could then be given the connection behind a signal's back), or a PID
    // this operation already has a lease on.
    if (typeof pid !== "number" || !Number.isInteger(pid) || typeof release !== "function" || sessions.leases.has(pid)) {
      sessions.unidentified += 1;
      return;
    }
    const swallow = (): void => undefined;
    let guarded = false;
    const lease: Lease = {
      pid,
      fate: "returnable",
      requested: null,
      surrendered: false,
      surrender: (error) => release.call(client, error),
      guard: () => {
        if (guarded || typeof held.on !== "function") return;
        held.on("error", swallow);
        guarded = true;
      },
      unguard: () => {
        if (guarded && typeof held.removeListener === "function") held.removeListener("error", swallow);
        guarded = false;
      },
    };
    sessions.leases.set(pid, lease);
    sessions.seen.add(pid);
    held.release = (error?: unknown) => {
      // A SECOND release of one checkout: the pool's own refusal, as without this harness — and
      // never a second hand-over, nor a different argument for the first. (Also after a hand-over
      // that threw: the pool counts that checkout as released once, whatever became of it.)
      if (lease.surrendered) return release.call(client, error);
      if (lease.requested) throw new Error(DOUBLE_RELEASE);
      if (lease.fate === "returnable") return surrenderLease(sessions, lease, error);
      // A signal is, or was, aimed at this backend. The request stands, with its argument; it is
      // carried out now only if the signal is known to be over (see `retireLease`).
      lease.requested = { error };
      retireLease(sessions, lease);
      return undefined;
    };
  };
  (pool as unknown as { connect: Connect }).connect = (callback) => {
    const sessions = racedScope.getStore();
    if (typeof callback === "function") {
      return connect((error, client, done) => {
        if (!error) register(sessions, client);
        const release = (client as { release?: Release } | null | undefined)?.release;
        callback(error, client, typeof release === "function" ? release : done);
      });
    }
    return (connect() as Promise<unknown>).then((client) => {
      register(sessions, client);
      return client;
    });
  };
}

/** Start `run` as a registered raced operation: every pool connection it checks out is recorded. */
function race<T>(label: string, run: () => Promise<T>): Raced<T> {
  instrumentPool();
  const sessions: RacedSessions = { label, leases: new Map(), seen: new Set(), unidentified: 0, undisposed: 0, settled: false };
  const result = racedScope.run(sessions, async () => run());
  const settle = () => { sessions.settled = true; };
  result.then(settle, settle);
  return Object.assign(sessions, { result });
}

// ── Lock-wait evidence ─────────────────────────────────────────────────────────────────────────

interface LockWait {
  pid: number;
  locktype: string;
  /** The 64-bit key of an advisory wait, as PostgreSQL stores it; null for any other lock. */
  key: string | null;
  blockers: number[];
}

/**
 * The lock waits this harness can see: ungranted locks whose `pg_locks.database` is THIS database.
 * That is a deliberately partial view. It covers the two kinds every schedule here is built from —
 * `relation` and `advisory` waits — and leaves out both other databases of the cluster and the lock
 * types PostgreSQL records with a NULL database (`transactionid`, `virtualxid`, …). A raced
 * operation waiting on one of those would simply not appear, so the expected wait would never be
 * found and the schedule would fail closed; it cannot make one pass.
 */
async function lockWaits(): Promise<LockWait[]> {
  return observe<LockWait>(
    `select l.pid, l.locktype,
            case when l.locktype = 'advisory' and l.objsubid = 1
                 then ((l.classid::bigint << 32) | l.objid::bigint)::text end as key,
            pg_blocking_pids(l.pid) as blockers
       from pg_locks l
      where not l.granted
        and l.database = ${databaseOid}
      order by l.pid`);
}

/** The advisory key of one team's identity authority, as `pg_locks` shows it. */
export async function authorityKey(teamId: string): Promise<string> {
  const rows = await answered("the team identity authority's advisory key",
    observe<{ key: string }>("select hashtextextended($1,0)::text as key", [authorityLockName(teamId)]));
  return rows[0].key;
}

/** The advisory keys exactly this backend holds GRANTED in this database, as `pg_locks` shows them. */
export async function advisoryKeysHeld(pid: number): Promise<string[]> {
  const rows = await answered(`the advisory keys backend ${pid} holds`, observe<{ key: string }>(
    `select ((l.classid::bigint << 32) | l.objid::bigint)::text as key
       from pg_locks l
      where l.pid = $1 and l.granted and l.locktype = 'advisory' and l.objsubid = 1
        and l.database = ${databaseOid}
      order by 1`, [pid]));
  return rows.map((row) => row.key);
}

interface ExpectedWait {
  locktype: string;
  /** True when the wait must be on the team identity authority's own advisory key. */
  authority: boolean;
  /** The exact backends that block it — no fewer, and none besides. */
  blockedBy: number[];
}

const describeWait = (wait: ExpectedWait) =>
  // `pg_blocking_pids` may repeat a backend that blocks through more than one lock.
  `${wait.locktype}${wait.authority ? " on the team identity authority" : ""} blocked by ${[...new Set(wait.blockedBy)].sort((a, b) => a - b).join(",")}`;

/** Why a registered operation can no longer come to wait, if it cannot. */
const cannotWait = (operation: RacedSessions): string | null => {
  if (operation.unidentified > 0) return `${operation.label}: a session's backend could not be identified`;
  if (operation.settled) return `${operation.label} finished without waiting`;
  return null;
};

/**
 * Wait — on PostgreSQL's own lock table, never on a clock — until the backends `operation` holds
 * show exactly ONE wait, and it is exactly `expected`. Only this operation's registered sessions
 * are read: whatever else waits in the database — behind the same barrier, on the same lock — is
 * neither counted nor required to be absent. Returns the waiting backend.
 */
async function untilWaiting(operation: RacedSessions, expected: ExpectedWait, authority: string, bounds: RaceBounds): Promise<number> {
  const waiting = await untilEvidence({
    read: async () => (await lockWaits()).filter((wait) => operation.leases.has(wait.pid)),
    accept: (waits) => waits.length === 1
      && describeWait({ locktype: waits[0].locktype, authority: waits[0].key === authority, blockedBy: waits[0].blockers }) === describeWait(expected),
    expected: `${operation.label} waiting on exactly: ${describeWait(expected)}`,
    show: (waits) => JSON.stringify(waits.map((wait) => describeWait({ locktype: wait.locktype, authority: wait.key === authority, blockedBy: wait.blockers }))),
    timeoutMs: bounds.pollMs,
    abort: () => cannotWait(operation),
  });
  return waiting[0].pid;
}

// ── Proven cleanup ─────────────────────────────────────────────────────────────────────────────

/** Every one of these backends is idle — no statement, no open transaction — or gone. */
async function sessionsIdle(pids: number[], bounds: RaceBounds): Promise<boolean> {
  if (pids.length === 0) return true;
  try {
    await untilEvidence({
      read: () => observe<{ pid: number; state: string | null }>(
        "select pid, state from pg_stat_activity where pid = any($1::int[]) and state is distinct from 'idle'", [pids]),
      accept: (busy) => busy.length === 0,
      expected: `backends ${pids.join(",")} idle or gone`,
      show: (busy) => JSON.stringify(busy),
      timeoutMs: bounds.cleanupMs,
    });
    return true;
  } catch {
    return false;
  }
}

/** A signal the harness is about to have PostgreSQL execute: which, and at which of its own backends. */
export interface PendingSignal {
  signal: "cancel" | "terminate";
  backends: number[];
}

/**
 * POSTGRESQL'S OWN ANSWER THAT IT EXECUTED ONE SIGNAL: which, and — for each backend it was aimed
 * at, and for no other — what the signalling function returned. `sent: false` is an answer too:
 * there was no such backend left to signal, so nothing was sent and nothing can still arrive.
 *
 * ONLY THE REAL SEND MAKES ONE (`settleRaced`), out of an answer it has checked row by row against
 * the backends that were targeted (`acknowledgementOf`). A value that merely has this shape is not
 * one: an acknowledgement is recognised by being the very object the real send made, never by what
 * it says.
 */
export interface SignalAcknowledgement {
  signal: PendingSignal["signal"];
  backends: { pid: number; sent: boolean }[];
}

/**
 * What a signal's statement answered, as the acknowledgement of THAT signal — or the reason it is
 * not one. It is one only if it is rows, one for each targeted backend and none for any other, each
 * saying which backend it is and, as a boolean, what PostgreSQL's signalling function returned.
 * Nothing at all, rows of another shape, a backend short, a backend too many: each throws.
 */
function acknowledgementOf(pending: PendingSignal, answer: unknown): SignalAcknowledgement {
  const refused = (why: string) =>
    new RaceHarnessError(`the ${pending.signal} of backends ${pending.backends.join(",")} was not acknowledged: ${why}`);
  if (!Array.isArray(answer)) throw refused("its statement did not answer with rows");
  const backends = (answer as unknown[]).map((row) => {
    const { pid, sent } = (typeof row === "object" && row !== null ? row : {}) as { pid?: unknown; sent?: unknown };
    if (typeof pid !== "number" || !Number.isInteger(pid) || typeof sent !== "boolean") {
      throw refused("a row of its answer does not say which backend it is, or whether it was signalled");
    }
    return { pid, sent };
  });
  const answeredFor = backends.map((backend) => backend.pid).sort((a, b) => a - b);
  const aimedAt = [...pending.backends].sort((a, b) => a - b);
  if (answeredFor.length !== aimedAt.length || answeredFor.some((pid, index) => pid !== aimedAt[index])) {
    throw refused(`its answer is for backends ${answeredFor.join(",") || "(none)"}`);
  }
  return { signal: pending.signal, backends };
}

/**
 * SEAMS for the harness's own tests, on the cleanup of the raced operations (`settleRaced`):
 *
 *   - `clock`: what the steps of it that are NOT evidence waits are bounded on — the raced operations
 *     settling in each round, and PostgreSQL acknowledging each signal. (The evidence waits of
 *     cleanup — the backends going idle — keep the real clock: they are answered by PostgreSQL.)
 *   - `beforeSignal`: awaited after the leases a signal is aimed at have been reserved and before
 *     PostgreSQL is asked to execute it — the window in which a release used to be able to hand a
 *     targeted backend to someone else.
 *   - `signal`: stands in front of the signal itself. It is given the signal and the real send, and
 *     what it returns is what the harness waits for — so a test can stage an acknowledgement that
 *     does not come, or comes late. It can WITHHOLD one; it cannot MAKE one. What it returns
 *     acknowledges the signal only if it resolves, in time, with the very `SignalAcknowledgement`
 *     the real send made. Nothing at all, anything opaque, something merely shaped like one — with
 *     the real send never made, or made and still pending — acknowledges nothing.
 *   - `execute`: stands in front of the STATEMENT the real send is — the one that has PostgreSQL
 *     execute the signal, on the monitor. It is given the signal and that statement, and what it
 *     returns is what the real send takes for PostgreSQL's answer, and checks as it checks the real
 *     one — so a test can stage a real send whose answer does not come.
 */
export interface CleanupSeam {
  clock?: EvidenceClock;
  beforeSignal?: (pending: PendingSignal) => Promise<void>;
  signal?: (pending: PendingSignal, send: () => Promise<SignalAcknowledgement>) => Promise<unknown>;
  execute?: (pending: PendingSignal, statement: () => Promise<unknown>) => Promise<unknown>;
}

/**
 * After the barrier is gone: establish that every raced operation has settled, has returned its
 * connections and left its backends idle or gone. If that does not happen by itself within the
 * bound, a cancel — and then, if still needed, a terminate — is sent to the backends the raced
 * operations hold checked out AT THAT MOMENT, and to no other backend, whatever else is waiting in
 * the database. Never throws: the report says which of the four outcomes it was.
 *
 * "At that moment" is made to last until the signal has been executed. The leases to be signalled
 * are RESERVED synchronously — before the first `await`, so no release can slip in between reading
 * them and reserving them — and a reserved connection is not given back to the pool, whatever its
 * operation asks, until PostgreSQL has executed the signal; it is then retired, not pooled
 * (`LeaseFate`). No outcome but `unproven` is reported while any lease is outstanding: `quiet`,
 * `cancelled` and `terminated` all mean every checkout was given back to the pool — returned by its
 * operation, or retired here — and every backend was then SEEN idle or gone. Nor once any
 * hand-over to the pool has THROWN, on either path (`surrenderLease`): that connection is no
 * longer on any operation's books, so no round signals it, and no round can prove anything.
 *
 * EACH ROUND HAS A DEADLINE OF ITS OWN, AND MEETS IT OR DOES NOT. The operations must have settled
 * before the round's `cleanupMs` has passed on the clock (`withinBound`): settling at or after it —
 * ahead of a timer that is overdue, included — does not make that round quiet, and nothing they do
 * later reopens it. The next round is a new one, with a budget of its own; an operation that
 * settled late is simply found settled there, and the outcome is then that round's, never `quiet`.
 *
 * A SIGNAL IS EXECUTED ONLY IF POSTGRESQL SAID SO, IN TIME. Its acknowledgement has a deadline too
 * (`OWNED_CONNECTION_BOUND_MS`: it is one statement on the harness's own connection). If it is
 * still pending then, fails, or comes at or after it, whether — and when — the signal is executed
 * cannot be told: the leases it was aimed at are STRANDED, never handed back to the pool, and the
 * outcome is `unproven` from then on, whatever the remaining rounds find and whatever that
 * acknowledgement later turns out to be. The rounds still run — a terminate is still sent, to
 * backends that are still held out of the pool — but they can no longer prove anything.
 *
 * AND ONLY POSTGRESQL SAYS SO. That SOMETHING resolved in time acknowledges nothing. The
 * acknowledgement is the one the real send made of PostgreSQL's answer — a row for each targeted
 * backend, and for no other (`SignalAcknowledgement`) — and it is recognised as that very object.
 * An answer that is anything else — nothing at all, something opaque, something shaped like an
 * acknowledgement — strands the leases exactly as a missing one does, there and then: the real
 * send may never have been made, or be pending still, with its signal yet to be executed.
 *
 * `seam` is for the harness's own tests (`CleanupSeam`).
 */
async function settleRaced(
  operations: Raced<unknown>[],
  bounds: RaceBounds,
  seam: CleanupSeam = {},
): Promise<Omit<CleanupReport, "barrierGone">> {
  const clock = seam.clock ?? REAL_CLOCK;
  const seen = () => [...new Set(operations.flatMap((operation) => [...operation.seen]))];
  const signalled = new Set<number>();
  // A signal was asked for and not acknowledged in time. STICKY: nothing below unsets it, and with
  // it set no outcome is reported but `unproven`.
  let unacknowledged = false;
  const quiet = async (): Promise<boolean> =>
    (await withinBound(Promise.allSettled(operations.map((operation) => operation.result)), bounds.cleanupMs, clock))
    && operations.every((operation) => operation.unidentified === 0 && operation.undisposed === 0 && operation.leases.size === 0)
    && (await sessionsIdle(seen(), bounds));
  const signal = async (kind: PendingSignal["signal"]): Promise<void> => {
    // RESERVE, SYNCHRONOUSLY: every outstanding lease is still out of the pool, so its backend is
    // still a raced operation's own — and from here to the end of this function it stays out,
    // whatever its operation asks. Nothing is awaited before every target is reserved.
    const targets = operations.flatMap((operation) => [...operation.leases.values()].map((lease) => ({ operation, lease })));
    for (const { lease } of targets) {
      // A stranded lease stays stranded: this signal being executed says nothing of the earlier one.
      if (lease.fate !== "stranded") lease.fate = "reserved";
      lease.guard();
    }
    if (targets.length === 0) return;
    const pids = targets.map(({ lease }) => lease.pid);
    // What the reservation turns into, and — for a lease whose release was asked for meanwhile —
    // the release itself, if it may now be carried out.
    const resolve = (fate: "condemned" | "stranded"): void => {
      for (const { operation, lease } of targets) {
        if (lease.fate !== "reserved") continue;
        lease.fate = fate;
        retireLease(operation, lease);
      }
    };
    try {
      if (seam.beforeSignal) await seam.beforeSignal({ signal: kind, backends: [...pids] });
    } catch (error) {
      // Nothing was sent, so nothing can still arrive: the connections may be given up.
      resolve("condemned");
      throw error;
    }
    for (const pid of pids) signalled.add(pid);
    const pending = (): PendingSignal => ({ signal: kind, backends: [...pids] });
    // THE STATEMENT: PostgreSQL executes the signal, and answers backend by backend.
    const statement = (): Promise<unknown> => observe(
      `select target.pid as pid, ${kind === "cancel" ? "pg_cancel_backend" : "pg_terminate_backend"}(target.pid) as sent
         from unnest($1::int[]) as target(pid)`, [pids]);
    // THE REAL SEND, and the only maker of an acknowledgement of this signal: the statement's
    // answer, checked against these very backends. Made at most once — asked for again, it is the
    // same send — and observed here whoever else does, so one that fails after its seam has let go
    // of it is never an unhandled rejection.
    const real: { send?: Promise<SignalAcknowledgement>; acknowledgement?: SignalAcknowledgement } = {};
    const send = (): Promise<SignalAcknowledgement> => {
      if (!real.send) {
        real.send = attempt(() => (seam.execute ? seam.execute(pending(), statement) : statement()))
          .then((answer) => {
            real.acknowledgement = acknowledgementOf(pending(), answer);
            return real.acknowledgement;
          });
        real.send.catch(() => undefined);
      }
      return real.send;
    };
    const stand = seam.signal;
    // THE ACKNOWLEDGEMENT, bounded: PostgreSQL's answer that it has executed the signal, before the
    // deadline on the clock. `fulfilledWithin` settles once — what the answer turns out to be after
    // that is observed and dropped, and reaches none of the code below.
    const answer = await fulfilledWithin(clock, attempt(() => (stand ? stand(pending(), send) : send())), OWNED_CONNECTION_BOUND_MS);
    // …AND POSTGRESQL'S OWN: what came in time must be the acknowledgement the real send made, that
    // very object. A seam's answer that is not — while the real send was never made, or is pending
    // still — is no more an acknowledgement than no answer at all.
    const acknowledged = answer !== null && real.acknowledgement !== undefined && answer.value === real.acknowledgement;
    if (!acknowledged) {
      // Sent, perhaps, and perhaps still to be executed — the answer failed, is still pending, came
      // too late to say, or was not PostgreSQL's. These connections are never handed back:
      // destroyed, a PID could pass to a new backend with that signal still to come. And no outcome
      // can now be anything but `unproven`, whatever the rounds that follow find.
      unacknowledged = true;
      resolve("stranded");
      return;
    }
    // EXECUTED: PostgreSQL has sent the signal to those very processes, and a signal already sent
    // goes with its process. Nothing can reach a later owner of the PID any more, so the
    // connections can be given to the pool — to destroy: WHEN each backend acts on the signal is
    // not known, so none of them is lent to anyone again.
    resolve("condemned");
  };
  const report = (outcome: CleanupOutcome): Omit<CleanupReport, "barrierGone"> => ({
    // Read when the report is made: an unacknowledged signal overrides whatever a round concluded.
    outcome: unacknowledged ? "unproven" : outcome,
    signalled: [...signalled].sort((a, b) => a - b),
    operations: operations.map((operation) => ({
      label: operation.label, backends: [...operation.seen].sort((a, b) => a - b), settled: operation.settled,
    })),
  });

  try {
    if (await quiet()) return report("quiet");
    await signal("cancel");
    if (await quiet()) return report("cancelled");
    await signal("terminate");
    if (await quiet()) return report("terminated");
  } catch {
    // Evidence could not even be read: nothing is proven.
  }
  return report("unproven");
}

/**
 * SEAM for the harness's own tests: the cleanup of raced operations BY ITSELF — what `finish` does
 * once its barrier is gone — over operations the test starts here and settles by hand. With
 * operations that never check out a connection it touches no database at all: there is no backend
 * to see idle and none to signal, so what is left is exactly the rounds and their deadlines.
 */
export function settleStarted(
  runs: { label: string; run: () => Promise<unknown> }[],
  opts: { bounds?: Partial<RaceBounds>; cleanup?: CleanupSeam } = {},
): Promise<Omit<CleanupReport, "barrierGone">> {
  return settleRaced(runs.map(({ label, run }) => race(label, run)), { ...DEFAULT_BOUNDS, ...opts.bounds }, opts.cleanup);
}

const describeCleanup = (cleanup: CleanupReport, settled: CleanupOutcome): string => {
  const who = cleanup.operations.map((operation) => operation.label).join(" and ") || "nothing started";
  const backends = cleanup.signalled.join(",");
  const barrier = cleanup.barrierGone ? "" : "the barrier's own session was not seen gone after its release; ";
  switch (settled) {
    case "quiet": return `${barrier}${who} settled and left their backends idle`;
    case "cancelled": return `${barrier}${who} did not finish after the barrier was released: their own backends (${backends}) were cancelled, their connections retired, and they are now idle or gone`;
    case "terminated": return `${barrier}${who} did not finish after the barrier was released: their own backends (${backends}) were terminated, their connections retired, and they are now gone`;
    case "unproven": return `${barrier}${who} could not be proven settled, idle or disposed after the barrier was released `
      + `(backends ever held: ${cleanup.operations.flatMap((operation) => operation.backends).join(",") || "none identified"})`;
  }
};

/**
 * Release the barrier and establish cleanup on every path, THEN report: the schedule's own failure
 * first (carrying the cleanup report), else a cleanup that needed help, else the results.
 *
 * Cleanup is proven only when BOTH hold: the barrier's tagged session was seen gone, and the raced
 * operations were seen settled with their backends idle or gone. Then — and only then — this
 * scope's in-flight marker is cleared. Otherwise the run is stopped before anything is reported,
 * and the marker stays.
 */
async function finish<T>(
  barrier: Barrier,
  started: Raced<unknown>[],
  failure: { error: unknown } | null,
  results: () => Promise<T>,
  bounds: RaceBounds,
  cleanupSeam: CleanupSeam = {},
): Promise<T> {
  // A barrier whose closing was not acknowledged, or whose session was not seen gone, is `false`
  // here for good — and the raced operations are cleaned up all the same.
  const barrierGone = await barrier.vanish(bounds.cleanupMs);
  const settled = await settleRaced(started, bounds, cleanupSeam);
  const cleanup: CleanupReport = { ...settled, barrierGone, outcome: barrierGone ? settled.outcome : "unproven" };
  const described = describeCleanup(cleanup, settled.outcome);
  barrier.conclude(
    cleanup.outcome !== "unproven",
    `identity race harness: ${described}. Sessions that may still hold locks must not be truncated around.`,
  );
  if (failure) {
    const message = failure.error instanceof Error ? failure.error.message : String(failure.error);
    throw new RaceScheduleError(`${message} [cleanup: ${described}]`, cleanup, failure.error);
  }
  if (cleanup.outcome !== "quiet") throw new RaceScheduleError(described, cleanup);
  return results();
}

// ── The schedules ──────────────────────────────────────────────────────────────────────────────

/**
 * THE DETERMINISTIC RACE. `first` is started and PARKED: its own registered backend must come to
 * wait on the barrier (a `relation` or `advisory` wait, blocked by the barrier's backend and nothing
 * else). Only then is `second` started, and ITS registered backend must come to wait on this team's
 * identity-authority advisory key, blocked by `first`'s waiting backend and nothing else — while
 * `first` is still parked exactly where it was. Then the barrier is released and both finish.
 *
 * On EVERY path — a failed or timed-out schedule included — the barrier is released and cleanup of
 * whatever was started is established before anything is reported (see `finish`).
 *
 * `whileQueued`, `beforeSignal`, `cleanup` and `bounds` are seams for the harness's own tests: a
 * moment, with both operations proven waiting, at which a test may add sessions of its own (the two
 * waits are then proven again, unchanged); a moment in cleanup, after the leases a cancel or
 * terminate is aimed at have been reserved and before PostgreSQL is asked to execute it; the clock
 * cleanup's own steps are bounded on, and something to stand in front of a signal and of the
 * statement that sends it (`CleanupSeam`); and shorter bounds. The run-safety state is the
 * barrier's (`BarrierOptions.safety`).
 */
export async function parkThenCompete<A, B>(opts: {
  seed: { teamId: string };
  barrier: Barrier;
  parksOn: "relation" | "advisory";
  first: () => Promise<A>;
  second: () => Promise<B>;
  whileQueued?: (waiting: { parked: number; competing: number }) => Promise<void>;
  beforeSignal?: (pending: PendingSignal) => Promise<void>;
  cleanup?: Pick<CleanupSeam, "clock" | "signal" | "execute">;
  bounds?: Partial<RaceBounds>;
}): Promise<{ first: A; second: B }> {
  const bounds = { ...DEFAULT_BOUNDS, ...opts.bounds };
  const started: Raced<unknown>[] = [];
  let first: Raced<A> | undefined;
  let second: Raced<B> | undefined;
  let failure: { error: unknown } | null = null;
  try {
    const authority = await authorityKey(opts.seed.teamId);
    const parkedOnBarrier = { locktype: opts.parksOn, authority: false, blockedBy: [opts.barrier.pid] };
    first = race("the parked operation", opts.first);
    started.push(first);
    const parked = await untilWaiting(first, parkedOnBarrier, authority, bounds);
    const behindParked = { locktype: "advisory", authority: true, blockedBy: [parked] };
    second = race("the competing operation", opts.second);
    started.push(second);
    const competing = await untilWaiting(second, behindParked, authority, bounds);
    await untilWaiting(first, parkedOnBarrier, authority, bounds);
    if (opts.whileQueued) {
      await opts.whileQueued({ parked, competing });
      await untilWaiting(second, behindParked, authority, bounds);
      await untilWaiting(first, parkedOnBarrier, authority, bounds);
    }
  } catch (error) {
    failure = { error };
  }
  return finish(
    opts.barrier, started, failure,
    async () => ({ first: await first!.result, second: await second!.result }),
    bounds,
    { ...opts.cleanup, beforeSignal: opts.beforeSignal },
  );
}

/**
 * PARKED WHILE ANOTHER OPERATION COMPLETES. `first` is started and parked on the barrier exactly as
 * above. Then `during` is run — and it must FINISH while `first` is still parked: it is given the
 * parked backend's pid, it is awaited within the evidence bound, and `first` is then proven to be
 * waiting exactly where it was. Only then is the barrier released.
 *
 * This is the schedule for what must NOT wait: a statement paused after its snapshot was taken
 * while a writer commits, or a read that completes beside a writer holding the team authority.
 */
export async function parkWhile<A, B>(opts: {
  seed: { teamId: string };
  barrier: Barrier;
  parksOn: "relation" | "advisory";
  first: () => Promise<A>;
  during: (parked: number) => Promise<B>;
  bounds?: Partial<RaceBounds>;
}): Promise<{ first: A; during: B }> {
  const bounds = { ...DEFAULT_BOUNDS, ...opts.bounds };
  const started: Raced<unknown>[] = [];
  let first: Raced<A> | undefined;
  let during: Raced<B> | undefined;
  let failure: { error: unknown } | null = null;
  try {
    const authority = await authorityKey(opts.seed.teamId);
    const parkedOnBarrier = { locktype: opts.parksOn, authority: false, blockedBy: [opts.barrier.pid] };
    first = race("the parked operation", opts.first);
    started.push(first);
    const parked = await untilWaiting(first, parkedOnBarrier, authority, bounds);
    const run = opts.during;
    during = race("the operation run while it is parked", () => run(parked));
    started.push(during);
    // Finished BEFORE the bound, by the clock — not merely ahead of the timer for it.
    if (!(await withinBound(during.result, bounds.pollMs))) {
      throw new RaceHarnessError(`the operation run while the other is parked did not finish within ${bounds.pollMs} ms — it is waiting, and it must not`);
    }
    // It has finished (a rejection is the schedule's failure) — and `first` never moved.
    await during.result;
    await untilWaiting(first, parkedOnBarrier, authority, bounds);
  } catch (error) {
    failure = { error };
  }
  return finish(
    opts.barrier, started, failure,
    async () => ({ first: await first!.result, during: await during!.result }),
    bounds,
  );
}

/**
 * Put two fenced calls in flight TOGETHER: the team's identity authority is held from a connection
 * of the harness's own until both are waiting on it — which is before either has observed
 * anything, because a fenced call enters the boundary first. Released, they run one after the
 * other, and the second observes what the first committed.
 *
 * The evidence is exact to the two registered calls: each one's own backend shows a single wait, on
 * THIS team's authority key, blocked by the harness's holder, and by nothing but that holder and
 * the other registered call (the later arrival also queues behind the earlier).
 */
export async function bothQueuedOnAuthority<T>(
  seed: { teamId: string },
  first: () => Promise<T>,
  second: () => Promise<T>,
): Promise<[T, T]> {
  const bounds = DEFAULT_BOUNDS;
  const holder = await holdLock("select pg_advisory_xact_lock(hashtextextended($1,0))", [authorityLockName(seed.teamId)]);
  const queued = JSON.stringify({ locktype: "advisory", onAuthority: true, behindHolder: true, foreignBlockers: 0 });
  const started: Raced<unknown>[] = [];
  let one: Raced<T> | undefined;
  let other: Raced<T> | undefined;
  let failure: { error: unknown } | null = null;
  try {
    const authority = await authorityKey(seed.teamId);
    const calls = [race("the first queued call", first), race("the second queued call", second)];
    [one, other] = calls;
    started.push(...calls);
    await untilEvidence({
      read: async () => {
        const waits = await lockWaits();
        const own = new Set([holder.pid, ...calls.flatMap((call) => [...call.leases.keys()])]);
        return calls.map((call) => waits.filter((wait) => call.leases.has(wait.pid)).map((wait) => JSON.stringify({
          locktype: wait.locktype,
          onAuthority: wait.key === authority,
          behindHolder: wait.blockers.includes(holder.pid),
          foreignBlockers: wait.blockers.filter((pid) => !own.has(pid)).length,
        })));
      },
      accept: (perCall) => perCall.every((waits) => waits.length === 1 && waits[0] === queued),
      expected: "both calls queued on the team identity authority, behind the harness's holder",
      show: (perCall) => JSON.stringify(perCall),
      timeoutMs: bounds.pollMs,
      abort: () => calls.map(cannotWait).find((reason) => reason !== null) ?? null,
    });
  } catch (error) {
    failure = { error };
  }
  return finish(holder, started, failure, async () => [await one!.result, await other!.result] as [T, T], bounds);
}
