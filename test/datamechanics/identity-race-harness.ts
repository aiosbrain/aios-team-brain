import { AsyncLocalStorage } from "node:async_hooks";
import { Client } from "pg";
import { expect, vi } from "vitest";
import { getPool } from "@/lib/db/pg/pool";

/**
 * TEST-ONLY harness for deterministic identity races against real PostgreSQL.
 *
 * A schedule is built from locks, never from a clock. One operation is PARKED on a lock a
 * connection of the test's own holds (a barrier); the other is then shown — from `pg_locks` — to be
 * waiting on the team's identity authority behind it; then the barrier is released.
 *
 * OWNERSHIP IS REGISTERED, NOT INFERRED. "This backend is blocked behind my barrier" does not make
 * it mine. So every raced operation runs inside a scope, and the application pool is instrumented
 * (here, in the test process only) to record the backend PID of every connection checked out
 * inside that scope, and when it is returned. Lock-wait evidence is read only for those registered
 * backends, and the only backends this harness will ever cancel or terminate are the ones a raced
 * operation of its own currently holds. The barrier and the monitor are connections this module
 * opens itself.
 *
 * CLEANUP IS PROVEN, NOT ASSUMED. After a barrier is released, every raced operation must settle,
 * return its connections, and be seen idle (or gone) in `pg_stat_activity` — all within a bound —
 * before the test may end and the next one truncate. If that takes a cancel or a terminate, the
 * test fails. If it cannot be proven at all, the harness goes FATAL: `raceHarnessFatal()` then
 * makes every remaining test of the file refuse to run rather than continue as if cleanup worked.
 */

/** How long one lock-evidence poll may wait for the expected waits to appear. */
const POLL_TIMEOUT_MS = 10_000;
/** How long each cleanup step may wait: operations settling, and their backends going idle. */
const CLEANUP_BOUND_MS = 5_000;
/** How long a harness-owned connection may take to connect, or one of its statements to run —
 * the barrier's own lock acquisition included. */
const OWNED_CONNECTION_BOUND_MS = 10_000;
/**
 * The timeout of every test that races. It must exceed the bounded waits such a test can make —
 * Vitest's default (5 s) is shorter than ONE poll. A failing test spends at most one barrier
 * acquisition, one poll timeout and three cleanup rounds (settle, cancel, terminate); the passing
 * polls return as soon as PostgreSQL shows the waits.
 */
export const RACE_TEST_TIMEOUT_MS = 90_000;

export class RaceHarnessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RaceHarnessError";
  }
}

let fatal: string | null = null;

/** Non-null once cleanup could not be proven: the file must stop, not truncate and carry on. */
export function raceHarnessFatal(): string | null {
  return fatal;
}

/** `true` if `work` finished inside the cleanup bound. The timer bounds CLEANUP only. */
async function withinBound(work: Promise<unknown>, ms = CLEANUP_BOUND_MS): Promise<boolean> {
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
  if (rollback) await withinBound(client.query("rollback"));
  // Ending the connection ends its session: the server rolls back whatever it still held.
  await withinBound(client.end());
}

function ownedClient(): Client {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
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
    const client = ownedClient();
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

// ── Barriers: explicitly owned connections that hold one lock ──────────────────────────────────

export interface Barrier {
  /** The barrier's own backend: the exact blocker a parked operation must be waiting on. */
  pid: number;
  /** Idempotent, and safe to call concurrently: every call resolves when the lock is gone. */
  release: () => Promise<void>;
}

/**
 * A connection of the harness's own, in a transaction that holds the lock `sql` takes until
 * `release()`. Connecting, BEGIN, the lock itself and the PID read are all bounded; if any of them
 * fails, the transaction is rolled back where one was begun and the client is closed before the
 * error is rethrown — a barrier that was not handed out holds nothing.
 */
export async function holdLock(sql: string, params: unknown[] = []): Promise<Barrier> {
  const owner = ownedClient();
  let begun = false;
  try {
    await owner.connect();
    await owner.query("begin");
    begun = true;
    // The barrier waits for nobody: if its lock is not free, that is a failed schedule, not a wait.
    await owner.query("select set_config('lock_timeout', $1, true)", [`${OWNED_CONNECTION_BOUND_MS}ms`]);
    await owner.query(sql, params);
    const pid: unknown = (await owner.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]?.pid;
    if (typeof pid !== "number" || !Number.isInteger(pid)) {
      throw new RaceHarnessError("the barrier's backend could not be identified");
    }
    let released: Promise<void> | undefined;
    return { pid, release: () => (released ??= disposeOwned(owner, true)) };
  } catch (error) {
    await disposeOwned(owner, begun);
    throw error;
  }
}

/** ACCESS EXCLUSIVE on one identity table: every read and write of it waits, nothing else does. */
export const holdTable = (table: "member_identities" | "member_identity_mapping_state") =>
  holdLock(`lock table ${table} in access exclusive mode`);

/** The writer's own exact-identity advisory key — taken after the team authority, before its rows. */
export const holdIdentityKey = (teamId: string, provider: string, externalId: string) =>
  holdLock("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`${teamId}:identity:${provider}:${externalId}`]);

const authorityLockName = (teamId: string) => `${teamId}:identity-authority`;

// ── Registered raced operations ────────────────────────────────────────────────────────────────

interface RacedSessions {
  label: string;
  /** Backends of connections this operation holds checked out RIGHT NOW. */
  active: Set<number>;
  /** Every backend it has ever held: what must be seen idle or gone once it has finished. */
  seen: Set<number>;
  /** Checkouts whose backend PID could not be read. Any makes ownership unprovable. */
  unidentified: number;
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
  const sessions: RacedSessions = { label, active: new Set(), seen: new Set(), unidentified: 0 };
  const result = racedScope.run(sessions, async () => run());
  result.catch(() => undefined);
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
        and l.database = (select oid from pg_database where datname = current_database())
      order by l.pid`);
}

/** The advisory key of one team's identity authority — the lock the mutation boundary takes first. */
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

/**
 * Wait — on PostgreSQL's own lock table, never on a clock — until the backends `operation` holds
 * show exactly ONE wait, and it is exactly `expected`. Only this operation's registered sessions
 * are read; whatever else waits in the database is neither counted nor required to be absent.
 * Returns the waiting backend.
 */
async function untilWaiting(operation: RacedSessions, expected: ExpectedWait, authority: string): Promise<number> {
  let waiting: LockWait[] = [];
  await expect.poll(async () => {
    if (operation.unidentified > 0) return [`${operation.label}: a session's backend could not be identified`];
    waiting = (await lockWaits()).filter((wait) => operation.active.has(wait.pid));
    return waiting.map((wait) => describeWait({ locktype: wait.locktype, authority: wait.key === authority, blockedBy: wait.blockers }));
  }, { timeout: POLL_TIMEOUT_MS, message: `${operation.label} must be waiting on exactly: ${describeWait(expected)}` })
    .toEqual([describeWait(expected)]);
  return waiting[0].pid;
}

// ── Proven cleanup ─────────────────────────────────────────────────────────────────────────────

/** Every one of these backends is idle — no statement, no open transaction — or gone. */
async function sessionsIdle(pids: number[]): Promise<boolean> {
  if (pids.length === 0) return true;
  try {
    await vi.waitFor(async () => {
      const busy = await observe<{ pid: number; state: string | null }>(
        "select pid, state from pg_stat_activity where pid = any($1::int[]) and state is distinct from 'idle'", [pids]);
      if (busy.length > 0) throw new Error(`still busy: ${JSON.stringify(busy)}`);
    }, { timeout: CLEANUP_BOUND_MS, interval: 25 });
    return true;
  } catch {
    return false;
  }
}

/**
 * After the barrier is gone: prove every raced operation has settled, has returned its connections
 * and left its backends idle or gone. Returns only when that is proven without help. If it takes a
 * cancel, or then a terminate — sent ONLY to backends a raced operation of this harness still holds
 * — it throws, so the test fails. If it cannot be proven even then, the harness goes fatal.
 */
async function settleRaced(operations: Raced<unknown>[]): Promise<void> {
  const labels = operations.map((operation) => operation.label).join(" and ");
  const seen = () => [...new Set(operations.flatMap((operation) => [...operation.seen]))];
  const held = () => [...new Set(operations.flatMap((operation) => [...operation.active]))];
  const quiet = async (): Promise<boolean> =>
    (await withinBound(Promise.allSettled(operations.map((operation) => operation.result))))
    && operations.every((operation) => operation.unidentified === 0 && operation.active.size === 0)
    && (await sessionsIdle(seen()));
  const signal = async (fn: "pg_cancel_backend" | "pg_terminate_backend"): Promise<number[]> => {
    const pids = held();
    if (pids.length > 0) await observe(`select ${fn}(pid) from unnest($1::int[]) as pid`, [pids]).catch(() => undefined);
    return pids;
  };

  if (await quiet()) return;
  const cancelled = await signal("pg_cancel_backend");
  if (await quiet()) {
    throw new RaceHarnessError(`${labels} did not finish after the barrier was released: their own backends (${cancelled.join(",")}) were cancelled and are now idle`);
  }
  const terminated = await signal("pg_terminate_backend");
  if (await quiet()) {
    throw new RaceHarnessError(`${labels} did not finish after the barrier was released: their own backends (${terminated.join(",")}) were terminated and are now gone`);
  }
  fatal = `identity race harness: ${labels} could not be proven settled, idle or disposed after their barrier was released `
    + `(backends ever held: ${seen().join(",") || "none identified"}). Refusing to run the rest of this file against sessions that may still hold locks.`;
  throw new RaceHarnessError(fatal);
}

/** Release the barrier and prove cleanup, on every path; a schedule's own failure is reported first. */
async function finish<T>(
  barrier: Barrier,
  started: Raced<unknown>[],
  failure: { error: unknown } | null,
  results: () => Promise<T>,
): Promise<T> {
  let cleanup: { error: unknown } | null = null;
  try {
    await barrier.release();
    await settleRaced(started);
  } catch (error) {
    cleanup = { error };
  }
  if (failure) throw failure.error;
  if (cleanup) throw cleanup.error;
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
 * On EVERY path — a failed or timed-out poll included — the barrier is released and cleanup of
 * whatever was started is proven (see `settleRaced`).
 */
export async function parkThenCompete<A, B>(opts: {
  seed: { teamId: string };
  barrier: Barrier;
  parksOn: "relation" | "advisory";
  first: () => Promise<A>;
  second: () => Promise<B>;
}): Promise<{ first: A; second: B }> {
  const started: Raced<unknown>[] = [];
  let first: Raced<A> | undefined;
  let second: Raced<B> | undefined;
  let failure: { error: unknown } | null = null;
  try {
    const authority = await authorityKey(opts.seed.teamId);
    const parkedOnBarrier = { locktype: opts.parksOn, authority: false, blockedBy: [opts.barrier.pid] };
    first = race("the parked operation", opts.first);
    started.push(first);
    const holder = await untilWaiting(first, parkedOnBarrier, authority);
    second = race("the competing operation", opts.second);
    started.push(second);
    await untilWaiting(second, { locktype: "advisory", authority: true, blockedBy: [holder] }, authority);
    await untilWaiting(first, parkedOnBarrier, authority);
  } catch (error) {
    failure = { error };
  }
  return finish(opts.barrier, started, failure, async () => ({ first: await first!.result, second: await second!.result }));
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
  const holder = await holdLock("select pg_advisory_xact_lock(hashtextextended($1,0))", [authorityLockName(seed.teamId)]);
  const queued = { locktype: "advisory", onAuthority: true, behindHolder: true, foreignBlockers: 0 };
  const started: Raced<unknown>[] = [];
  let one: Raced<T> | undefined;
  let other: Raced<T> | undefined;
  let failure: { error: unknown } | null = null;
  try {
    const authority = await authorityKey(seed.teamId);
    const calls = [race("the first queued call", first), race("the second queued call", second)];
    [one, other] = calls;
    started.push(...calls);
    await expect.poll(async () => {
      if (calls.some((call) => call.unidentified > 0)) return "a queued call's backend could not be identified";
      const waits = await lockWaits();
      const own = new Set([holder.pid, ...calls.flatMap((call) => [...call.active])]);
      return calls.map((call) => waits.filter((wait) => call.active.has(wait.pid)).map((wait) => ({
        locktype: wait.locktype,
        onAuthority: wait.key === authority,
        behindHolder: wait.blockers.includes(holder.pid),
        foreignBlockers: wait.blockers.filter((pid) => !own.has(pid)).length,
      })));
    }, { timeout: POLL_TIMEOUT_MS, message: "both calls must be queued on the team identity authority, behind the harness's holder" })
      .toEqual([[queued], [queued]]);
  } catch (error) {
    failure = { error };
  }
  return finish(holder, started, failure, async () => [await one!.result, await other!.result] as [T, T]);
}
