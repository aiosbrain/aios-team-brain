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
 *   - up to three cleanup rounds (settle, cancel, terminate) of up to two `cleanupMs` each.
 *
 * At the defaults (`pollMs` 10 s, `cleanupMs` 5 s, `OWNED_CONNECTION_BOUND_MS` 10 s) that is up to
 * 70 s to acquire, 30 s of evidence waits (50 s with `whileQueued`), 30 s for the barrier to be seen
 * gone and 30 s of cleanup rounds: 160 s, or 180 s — and 90 s (110 s) even when acquisition is
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
 * The clock one evidence wait runs on: where its deadline is read from, and what ends a read or a
 * pause that would outlast it. Every wait runs on the real one; another is a SEAM for the harness's
 * own tests, which stage a deadline passing instead of waiting for one.
 */
export interface EvidenceClock {
  now: () => number;
  /** Call `fire` once `ms` have passed. Returns how to call that off. */
  after: (ms: number, fire: () => void) => () => void;
}

const REAL_CLOCK: EvidenceClock = {
  now: () => Date.now(),
  after: (ms, fire) => {
    const timer = setTimeout(fire, ms);
    return () => clearTimeout(timer);
  },
};

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

/**
 * `work`, for at most `ms`: what it resolved to, or `null` if it had not settled by then. A
 * rejection inside the bound is rethrown.
 *
 * BOTH of `work`'s outcomes are observed, whenever they come. One that comes after the bound finds
 * this promise already settled and changes nothing: it is never an unhandled rejection, and never a
 * result anyone acts on.
 */
function settledWithin<T>(clock: EvidenceClock, work: Promise<T>, ms: number): Promise<{ value: T } | null> {
  return new Promise((resolve, reject) => {
    const callOff = clock.after(ms, () => resolve(null));
    work.then(
      (value) => { callOff(); resolve({ value }); },
      (error: unknown) => { callOff(); reject(error); },
    );
  });
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
 *     later resolves or rejects with is dropped (`settledWithin`);
 *   - a read that does come back is checked against the deadline BEFORE it is accepted. The timer
 *     that bounds a read and the clock are not the same thing — a late result can be delivered ahead
 *     of a timer that is already due — so evidence that is what was expected, but was read at or
 *     after the deadline, fails the wait like any other;
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
    const remaining = deadline - clock.now();
    if (remaining <= 0) throw expired(seen ? `last saw ${opts.show(seen.value)}` : "nothing was read");
    const read = await settledWithin(clock, opts.read(), remaining);
    if (!read) throw expired(`a read was still pending at the deadline${seen ? `; last saw ${opts.show(seen.value)}` : ""}`);
    const { value } = read;
    // Asked BEFORE acceptance, and of the clock itself: that the read beat its timer says nothing.
    const late = clock.now() >= deadline;
    const accepted = opts.accept(value);
    if (accepted && !late) return value;
    if (!accepted) {
      const aborted = opts.abort?.() ?? null;
      if (aborted) throw new RaceHarnessError(`${aborted} — expected ${opts.expected}; saw ${opts.show(value)}`);
    }
    if (late) {
      throw expired(accepted ? `what was expected was read only at or after the deadline: ${opts.show(value)}` : `last saw ${opts.show(value)}`);
    }
    seen = read;
    const interval = Math.min(EVIDENCE_INTERVAL_MS, deadline - clock.now());
    await new Promise<void>((resolve) => { clock.after(interval, resolve); });
  }
}

/** `true` if `work` finished inside `ms`. The timer bounds CLEANUP only. */
async function withinBound(work: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), ms); });
  try {
    return await Promise.race([work.then(() => true as const, () => true as const), bound]);
  } finally {
    clearTimeout(timer);
  }
}

/** Close a harness-owned client for good: roll back if asked, end it, and never wait unboundedly. */
async function disposeOwned(client: Client, rollback: boolean): Promise<void> {
  if (rollback) await withinBound(client.query("rollback"), OWNED_CONNECTION_BOUND_MS);
  // Ending the connection ends its session: the server rolls back whatever it still held.
  await withinBound(client.end(), OWNED_CONNECTION_BOUND_MS);
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
      await disposeOwned(client, false);
      throw error;
    }
  })();
  return monitor;
}

async function observe<T>(text: string, params: unknown[] = []): Promise<T[]> {
  return (await (await monitorClient()).query(text, params)).rows as T[];
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

/** What PostgreSQL says about exactly these backends. A backend that is gone has no row. */
export async function sessionEvidence(pids: number[]): Promise<SessionEvidence[]> {
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

/** Re-read exactly these backends until `accept` holds, within the default evidence bound. */
export async function untilSessions(
  pids: number[],
  expected: string,
  accept: (sessions: SessionEvidence[]) => boolean,
): Promise<SessionEvidence[]> {
  return untilEvidence({
    read: () => sessionEvidence(pids),
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

/** The live sessions of this database under one exact `application_name`. */
export async function sessionsNamed(applicationName: string): Promise<{ pid: number; state: string | null }[]> {
  return observe<{ pid: number; state: string | null }>(
    "select pid, state from pg_stat_activity where datname = current_database() and application_name = $1 order by pid",
    [applicationName]);
}

/** The live sessions of one named barrier (`holdLock`'s `tag`), found by its exact `application_name`. */
export async function barrierSessions(tag: string): Promise<{ pid: number; state: string | null }[]> {
  return sessionsNamed(barrierSessionName(tag));
}

/** Re-read one named barrier's sessions until none is left, within the default evidence bound. */
export async function untilBarrierGone(tag: string): Promise<void> {
  await untilEvidence({
    read: () => barrierSessions(tag),
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
  /** For the schedules: close the connection once, and say whether its session was SEEN gone —
   * each proof of that within `cleanupMs` of its own. `evidence` is a seam for the harness's own
   * tests (`EvidenceSeam`); like `cleanupMs`, it is the first call's that counts. */
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
   * replacement for closing the connection (to stage a barrier that survives its release), and a
   * different `application_name` for its session (to stage one that cannot be found by its tag —
   * what an `application_name` in the connection string does to every session). */
  safety?: RunSafety;
  cleanupMs?: number;
  dispose?: (client: Client, rollback: boolean) => Promise<void>;
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
 * The tagged barrier session was SEEN to be absent within `ms`. Unreadable evidence is not absence —
 * and nor is evidence read too late: a read that shows the session gone only after `ms` is `false`.
 */
async function barrierAbsent(tag: string, ms: number, seam: EvidenceSeam = {}): Promise<boolean> {
  try {
    const read = seamed(seam, () => barrierSessions(tag));
    await untilEvidence({
      read,
      accept: (sessions) => sessions.length === 0,
      expected: `no session left for barrier ${tag}`,
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
  const dispose = opts.dispose ?? disposeOwned;
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
    try {
      await dispose(owner, begun);
    } catch {
      // Whatever closing did or did not do, only the evidence below counts.
    }
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
    const present = await backendRows(backend);
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
  /** The pool has been given the client back — to keep or to destroy. Never twice for one checkout. */
  disposed: boolean;
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
  /** Checkouts the pool did not take back when the harness retired them. Any makes cleanup unprovable. */
  undisposed: number;
  /** Its promise has resolved or rejected. */
  settled: boolean;
}

/** What the pool itself says to a second release of one checkout. */
const DOUBLE_RELEASE = "Release called on client which has already been released to the pool.";

/** Carry a release out: the lease leaves its operation's books, and the pool is given the client. */
function surrenderLease(sessions: RacedSessions, lease: Lease, error: unknown): unknown {
  lease.disposed = true;
  sessions.leases.delete(lease.pid);
  lease.unguard();
  return lease.surrender(error);
}

/**
 * Retire a CONDEMNED checkout whose release has been asked for: the pool is given the client with
 * an error — the operation's own if it gave one, the harness's otherwise — which is how a pool is
 * told to destroy a connection instead of keeping it. Any other lease is left exactly as it is.
 */
function retireLease(sessions: RacedSessions, lease: Lease): void {
  if (lease.disposed || lease.fate !== "condemned" || !lease.requested) return;
  try {
    surrenderLease(sessions, lease, lease.requested.error
      || new RaceHarnessError(`backend ${lease.pid} was signalled by the identity race harness: its connection is retired, not pooled`));
  } catch {
    // The pool did not take it: nothing says where that connection is now.
    sessions.undisposed += 1;
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
      disposed: false,
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
      // never a second hand-over, nor a different argument for the first.
      if (lease.disposed) return release.call(client, error);
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
  const rows = await observe<{ key: string }>("select hashtextextended($1,0)::text as key", [authorityLockName(teamId)]);
  return rows[0].key;
}

/** The advisory keys exactly this backend holds GRANTED in this database, as `pg_locks` shows them. */
export async function advisoryKeysHeld(pid: number): Promise<string[]> {
  const rows = await observe<{ key: string }>(
    `select ((l.classid::bigint << 32) | l.objid::bigint)::text as key
       from pg_locks l
      where l.pid = $1 and l.granted and l.locktype = 'advisory' and l.objsubid = 1
        and l.database = ${databaseOid}
      order by 1`, [pid]);
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
 * operation, or retired here — and every backend was then SEEN idle or gone.
 *
 * `beforeSignal` is a seam for the harness's own tests: it is awaited after the reservation and
 * before PostgreSQL is asked to execute the signal — the window in which a release used to be able
 * to hand a targeted backend to someone else.
 */
async function settleRaced(
  operations: Raced<unknown>[],
  bounds: RaceBounds,
  beforeSignal?: (pending: PendingSignal) => Promise<void>,
): Promise<Omit<CleanupReport, "barrierGone">> {
  const seen = () => [...new Set(operations.flatMap((operation) => [...operation.seen]))];
  const signalled = new Set<number>();
  const quiet = async (): Promise<boolean> =>
    (await withinBound(Promise.allSettled(operations.map((operation) => operation.result)), bounds.cleanupMs))
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
      if (beforeSignal) await beforeSignal({ signal: kind, backends: [...pids] });
    } catch (error) {
      // Nothing was sent, so nothing can still arrive: the connections may be given up.
      resolve("condemned");
      throw error;
    }
    for (const pid of pids) signalled.add(pid);
    try {
      await observe(`select ${kind === "cancel" ? "pg_cancel_backend" : "pg_terminate_backend"}(pid) from unnest($1::int[]) as pid`, [pids]);
    } catch {
      // Sent, perhaps, and perhaps still to be executed: these connections are never handed back,
      // so no outcome below can be anything but `unproven`.
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
    outcome,
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
  beforeSignal?: (pending: PendingSignal) => Promise<void>,
): Promise<T> {
  const barrierGone = await barrier.vanish(bounds.cleanupMs);
  const settled = await settleRaced(started, bounds, beforeSignal);
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
 * `whileQueued`, `beforeSignal` and `bounds` are seams for the harness's own tests: a moment, with
 * both operations proven waiting, at which a test may add sessions of its own (the two waits are
 * then proven again, unchanged); a moment in cleanup, after the leases a cancel or terminate is
 * aimed at have been reserved and before PostgreSQL is asked to execute it (see `settleRaced`); and
 * shorter bounds. The run-safety state is the barrier's (`BarrierOptions.safety`).
 */
export async function parkThenCompete<A, B>(opts: {
  seed: { teamId: string };
  barrier: Barrier;
  parksOn: "relation" | "advisory";
  first: () => Promise<A>;
  second: () => Promise<B>;
  whileQueued?: (waiting: { parked: number; competing: number }) => Promise<void>;
  beforeSignal?: (pending: PendingSignal) => Promise<void>;
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
    opts.beforeSignal,
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
