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
 * What one schedule can spend, each part separately bounded: the barrier's acquisition
 * (`OWNED_CONNECTION_BOUND_MS`); its evidence waits, of which there are SEVERAL — `parkThenCompete`
 * makes three, five with `whileQueued`; `parkWhile` makes two around a bounded run — each up to
 * `pollMs`; then the barrier's disappearance (`cleanupMs`) and up to three cleanup rounds (settle,
 * cancel, terminate) of up to two `cleanupMs` each. A wait that succeeds returns as soon as
 * PostgreSQL shows the evidence, and a schedule stops at its first wait that fails, so in practice
 * one wait runs long. But nothing makes the others short: a schedule in which every wait takes
 * nearly its whole bound adds up to more than this timeout.
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
  /** The backends that were signalled: always, and only, ones a raced operation held at that moment. */
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

const pause = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

/**
 * Re-read `read` until `accept` holds. Stops early — with an error — as soon as `abort` gives a
 * reason the evidence can no longer appear, and otherwise when `timeoutMs` has passed.
 */
async function untilEvidence<T>(opts: {
  read: () => Promise<T>;
  accept: (value: T) => boolean;
  expected: string;
  show: (value: T) => string;
  timeoutMs: number;
  abort?: () => string | null;
}): Promise<T> {
  const deadline = Date.now() + opts.timeoutMs;
  for (;;) {
    const value = await opts.read();
    if (opts.accept(value)) return value;
    const aborted = opts.abort?.() ?? null;
    if (aborted) throw new RaceHarnessError(`${aborted} — expected ${opts.expected}; saw ${opts.show(value)}`);
    if (Date.now() >= deadline) {
      throw new RaceHarnessError(`no evidence within ${opts.timeoutMs} ms of ${opts.expected}; last saw ${opts.show(value)}`);
    }
    await pause(EVIDENCE_INTERVAL_MS);
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
  /** For the schedules: close the connection once, and say whether its session was SEEN gone. */
  vanish: (cleanupMs: number) => Promise<boolean>;
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

/** That exact backend was SEEN to be absent within `ms`. Unreadable evidence is not absence. */
async function backendAbsent(backend: BackendIdentity, ms: number): Promise<boolean> {
  try {
    await untilEvidence({
      read: () => observe<{ pid: number }>(
        "select pid from pg_stat_activity where pid = $1 and extract(epoch from backend_start)::text = $2", [backend.pid, backend.started]),
      accept: (sessions) => sessions.length === 0,
      expected: `backend ${backend.pid} (started ${backend.started}) gone`,
      show: (sessions) => JSON.stringify(sessions),
      timeoutMs: ms,
    });
    return true;
  } catch {
    return false;
  }
}

/** The tagged barrier session was SEEN to be absent within `ms`. Unreadable evidence is not absence. */
async function barrierAbsent(tag: string, ms: number): Promise<boolean> {
  try {
    await untilEvidence({
      read: () => barrierSessions(tag),
      accept: (sessions) => sessions.length === 0,
      expected: `no session left for barrier ${tag}`,
      show: (sessions) => JSON.stringify(sessions),
      timeoutMs: ms,
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
 * its name is still not mistaken for one that has gone.
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
  let vanished: Promise<boolean> | undefined;
  const vanish = (ms: number): Promise<boolean> => (vanished ??= (async () => {
    try {
      await dispose(owner, begun);
    } catch {
      // Whatever closing did or did not do, only the evidence below counts.
    }
    // A session that was opened and never identified cannot be seen gone: nothing says where to look.
    if (connected && !backend) return false;
    if (!(await barrierAbsent(tag, ms))) return false;
    return backend ? backendAbsent(backend, ms) : true;
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

interface RacedSessions {
  label: string;
  /** Backends of connections this operation holds checked out RIGHT NOW. */
  active: Set<number>;
  /** Every backend it has ever held: what must be seen idle or gone once it has finished. */
  seen: Set<number>;
  /** Checkouts whose backend PID could not be read. Any makes ownership unprovable. */
  unidentified: number;
  /** Its promise has resolved or rejected. */
  settled: boolean;
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
 * is and when it is returned. Installed once, on the application pool of THIS test process; outside
 * a raced scope it does nothing. The scope is read when `connect` is CALLED — a pooled connection
 * can be handed over later from another operation's release.
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
    const held = client as { processID?: unknown; release?: Release };
    const pid = held.processID;
    if (typeof pid !== "number" || !Number.isInteger(pid)) {
      sessions.unidentified += 1;
      return;
    }
    sessions.active.add(pid);
    sessions.seen.add(pid);
    // The pool installs a fresh `release` on every checkout; wrap this checkout's.
    const release = held.release;
    if (typeof release === "function") {
      held.release = (error?: unknown) => {
        sessions.active.delete(pid);
        return release.call(client, error);
      };
    }
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
  const sessions: RacedSessions = { label, active: new Set(), seen: new Set(), unidentified: 0, settled: false };
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
    read: async () => (await lockWaits()).filter((wait) => operation.active.has(wait.pid)),
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

/**
 * After the barrier is gone: establish that every raced operation has settled, has returned its
 * connections and left its backends idle or gone. If that does not happen by itself within the
 * bound, a cancel — and then, if still needed, a terminate — is sent to the backends the raced
 * operations hold checked out AT THAT MOMENT, and to no other backend, whatever else is waiting in
 * the database. Never throws: the report says which of the four outcomes it was.
 */
async function settleRaced(operations: Raced<unknown>[], bounds: RaceBounds): Promise<Omit<CleanupReport, "barrierGone">> {
  const seen = () => [...new Set(operations.flatMap((operation) => [...operation.seen]))];
  const held = () => [...new Set(operations.flatMap((operation) => [...operation.active]))];
  const signalled = new Set<number>();
  const quiet = async (): Promise<boolean> =>
    (await withinBound(Promise.allSettled(operations.map((operation) => operation.result)), bounds.cleanupMs))
    && operations.every((operation) => operation.unidentified === 0 && operation.active.size === 0)
    && (await sessionsIdle(seen(), bounds));
  const signal = async (fn: "pg_cancel_backend" | "pg_terminate_backend"): Promise<void> => {
    const pids = held();
    for (const pid of pids) signalled.add(pid);
    if (pids.length > 0) await observe(`select ${fn}(pid) from unnest($1::int[]) as pid`, [pids]).catch(() => undefined);
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
    await signal("pg_cancel_backend");
    if (await quiet()) return report("cancelled");
    await signal("pg_terminate_backend");
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
    case "cancelled": return `${barrier}${who} did not finish after the barrier was released: their own backends (${backends}) were cancelled and are now idle`;
    case "terminated": return `${barrier}${who} did not finish after the barrier was released: their own backends (${backends}) were terminated and are now gone`;
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
): Promise<T> {
  const barrierGone = await barrier.vanish(bounds.cleanupMs);
  const settled = await settleRaced(started, bounds);
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
 * `whileQueued` and `bounds` are seams for the harness's own tests: a moment, with both operations
 * proven waiting, at which a test may add sessions of its own (the two waits are then proven again,
 * unchanged); and shorter bounds. The run-safety state is the barrier's (`BarrierOptions.safety`).
 */
export async function parkThenCompete<A, B>(opts: {
  seed: { teamId: string };
  barrier: Barrier;
  parksOn: "relation" | "advisory";
  first: () => Promise<A>;
  second: () => Promise<B>;
  whileQueued?: (waiting: { parked: number; competing: number }) => Promise<void>;
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
        const own = new Set([holder.pid, ...calls.flatMap((call) => [...call.active])]);
        return calls.map((call) => waits.filter((wait) => call.active.has(wait.pid)).map((wait) => JSON.stringify({
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
