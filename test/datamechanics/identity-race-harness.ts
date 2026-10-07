import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { getPool } from "@/lib/db/pg/pool";
import { runLatch, type RunLatch } from "./run-fatal-latch";

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
 * CLEANUP IS PROVEN, NOT ASSUMED. After a barrier is released — on every path, a failed schedule
 * included — every raced operation must settle, return its connections, and be seen idle (or gone)
 * in `pg_stat_activity`, all within a bound, BEFORE the outcome is reported. If that takes a cancel
 * or a terminate, the test fails. If it cannot be proven at all, the RUN is stopped: the fatal
 * latch (`run-fatal-latch`) is set, and the tier's global `beforeEach` — which runs before any test
 * file's own hooks — then refuses to truncate or run anything else for the rest of that run.
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
 * The timeout of every test that races. It must exceed the bounded waits such a test can make —
 * Vitest's default (5 s) is shorter than ONE evidence wait. A failing test spends at most one
 * barrier acquisition, one evidence wait and three cleanup rounds (settle, cancel, terminate); the
 * passing waits return as soon as PostgreSQL shows the evidence.
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
   * the raced operations' own backends. `unproven`: not even then — the run has been stopped. */
  outcome: CleanupOutcome;
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
  return runLatch.read();
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

function ownedClient(role: string): Client {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    application_name: `${APPLICATION}/${role}`,
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

/** The live sessions of one named barrier (`holdLock`'s `tag`), found by its exact `application_name`. */
export async function barrierSessions(tag: string): Promise<{ pid: number; state: string | null }[]> {
  return observe<{ pid: number; state: string | null }>(
    "select pid, state from pg_stat_activity where datname = current_database() and application_name = $1 order by pid",
    [`${APPLICATION}/barrier/${tag}`]);
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
  /** The name its session can be found under (`barrierSessions`). */
  tag: string;
  /** Idempotent, and safe to call concurrently: every call resolves when the lock is gone. */
  release: () => Promise<void>;
}

/**
 * A connection of the harness's own, in a transaction that holds the lock `sql` takes until
 * `release()`. Connecting, BEGIN, the lock itself and the PID read are all bounded; if any of them
 * fails, the transaction is rolled back where one was begun and the client is closed before the
 * error is rethrown — a barrier that was not handed out holds nothing and leaves no session.
 *
 * `tag` names the session (so a test can prove what became of it); `lockTimeoutMs` shortens how
 * long the barrier's own lock request may wait before PostgreSQL refuses it.
 */
export async function holdLock(
  sql: string,
  params: unknown[] = [],
  opts: { tag?: string; lockTimeoutMs?: number } = {},
): Promise<Barrier> {
  const tag = opts.tag ?? randomUUID().slice(0, 12);
  const owner = ownedClient(`barrier/${tag}`);
  let begun = false;
  try {
    await owner.connect();
    await owner.query("begin");
    begun = true;
    // The barrier waits for nobody: if its lock is not free, that is a failed schedule, not a wait.
    await owner.query("select set_config('lock_timeout', $1, true)", [`${opts.lockTimeoutMs ?? OWNED_CONNECTION_BOUND_MS}ms`]);
    await owner.query(sql, params);
    const pid: unknown = (await owner.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]?.pid;
    if (typeof pid !== "number" || !Number.isInteger(pid)) {
      throw new RaceHarnessError("the barrier's backend could not be identified");
    }
    let released: Promise<void> | undefined;
    return { pid, tag, release: () => (released ??= disposeOwned(owner, true)) };
  } catch (error) {
    await disposeOwned(owner, begun);
    throw error;
  }
}

/** ACCESS EXCLUSIVE on one identity table: every read and write of it waits, nothing else does. */
export const holdTable = (
  table: "member_identities" | "member_identity_mapping_state",
  opts: { tag?: string; lockTimeoutMs?: number } = {},
) => holdLock(`lock table ${table} in access exclusive mode`, [], opts);

/** The name of the writer's own exact-identity advisory lock — taken after the team authority, before its rows. */
export const identityLockName = (teamId: string, provider: string, externalId: string) =>
  `${teamId}:identity:${provider}:${externalId}`;

export const holdIdentityKey = (teamId: string, provider: string, externalId: string) =>
  holdLock("select pg_advisory_xact_lock(hashtextextended($1, 0))", [identityLockName(teamId, provider, externalId)]);

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
async function authorityKey(teamId: string): Promise<string> {
  const rows = await observe<{ key: string }>("select hashtextextended($1,0)::text as key", [authorityLockName(teamId)]);
  return rows[0].key;
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
async function settleRaced(operations: Raced<unknown>[], bounds: RaceBounds): Promise<CleanupReport> {
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
  const report = (outcome: CleanupOutcome): CleanupReport => ({
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

const describeCleanup = (cleanup: CleanupReport): string => {
  const who = cleanup.operations.map((operation) => operation.label).join(" and ") || "nothing started";
  const backends = cleanup.signalled.join(",");
  switch (cleanup.outcome) {
    case "quiet": return `${who} settled and left their backends idle`;
    case "cancelled": return `${who} did not finish after the barrier was released: their own backends (${backends}) were cancelled and are now idle`;
    case "terminated": return `${who} did not finish after the barrier was released: their own backends (${backends}) were terminated and are now gone`;
    case "unproven": return `${who} could not be proven settled, idle or disposed after the barrier was released `
      + `(backends ever held: ${cleanup.operations.flatMap((operation) => operation.backends).join(",") || "none identified"})`;
  }
};

/**
 * Release the barrier and establish cleanup on every path, THEN report: the schedule's own failure
 * first (carrying the cleanup report), else a cleanup that needed help, else the results. An
 * unproven cleanup stops the run before anything is reported.
 */
async function finish<T>(
  barrier: Barrier,
  started: Raced<unknown>[],
  failure: { error: unknown } | null,
  results: () => Promise<T>,
  bounds: RaceBounds,
  latch: RunLatch,
): Promise<T> {
  await barrier.release();
  const cleanup = await settleRaced(started, bounds);
  if (cleanup.outcome === "unproven") {
    latch.set(`identity race harness: ${describeCleanup(cleanup)}. Sessions that may still hold locks must not be truncated around.`);
  }
  if (failure) {
    const message = failure.error instanceof Error ? failure.error.message : String(failure.error);
    throw new RaceScheduleError(`${message} [cleanup: ${describeCleanup(cleanup)}]`, cleanup, failure.error);
  }
  if (cleanup.outcome !== "quiet") throw new RaceScheduleError(describeCleanup(cleanup), cleanup);
  return results();
}

// ── The two schedules ──────────────────────────────────────────────────────────────────────────

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
 * `whileQueued`, `bounds` and `latch` are seams for the harness's own tests: a moment, with both
 * operations proven waiting, at which a test may add sessions of its own (the two waits are then
 * proven again, unchanged); shorter bounds; and a latch other than the run's.
 */
export async function parkThenCompete<A, B>(opts: {
  seed: { teamId: string };
  barrier: Barrier;
  parksOn: "relation" | "advisory";
  first: () => Promise<A>;
  second: () => Promise<B>;
  whileQueued?: (waiting: { parked: number; competing: number }) => Promise<void>;
  bounds?: Partial<RaceBounds>;
  latch?: RunLatch;
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
    bounds, opts.latch ?? runLatch,
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
  return finish(holder, started, failure, async () => [await one!.result, await other!.result] as [T, T], bounds, runLatch);
}
