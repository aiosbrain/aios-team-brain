import "server-only";
import type { SqlQueryResult, TransactionSession } from "@/lib/db/types";
import { parseSlackTimestamp } from "./sources/slack-message-evidence";
import { scopedSlackChannelPathPrefix } from "./sources/slack-namespace";

/**
 * The single writer of `slack_sync_threads` — durable pending-thread work for the Slack timeline
 * (AIO-1170), with the lease/fence primitives a resumable hydration worker needs.
 *
 * ⚠️ WHAT A CLAIM PROVES, AND WHAT IT DOES NOT. A claim is ownership of one QUEUE ROW: the right to
 * be the worker currently reading that thread. It is not evidence of source visibility, of channel
 * permission, of namespace migration, of a complete body, or of permission to publish. There is
 * deliberately no terminal/acknowledge operation here: acknowledging a thread belongs INSIDE the
 * existing `ingestItem` transaction, after every publication gate, together with the item write —
 * a page checkpoint can never make the job complete, and an operation that looked like completion
 * would be the one a later caller reaches for by mistake.
 *
 * Four properties hold this module together:
 *
 *  1. IT NEVER OPENS A TRANSACTION. Every function takes the caller's `TransactionSession` and runs
 *     on that one bound connection (`session.executeSql`), so the publisher can later compose these
 *     writes into its own `runContextTransaction` atomically. Reaching for the pool would make a
 *     checkpoint survive its caller's rollback. There is no convenience wrapper that starts a
 *     transaction, because there is no caller yet that would be right to use one.
 *  2. THE DATABASE IS THE CLOCK AND THE ARBITER. Due-ness and lease expiry are decided by
 *     `clock_timestamp()` in the statement's own `WHERE`, never by a caller-supplied `now` and never
 *     by a read-then-write. Each operation is one atomic conditional `UPDATE … RETURNING`; zero rows
 *     means "you did not have the authority", and it is returned as an explicit outcome.
 *  3. THE FENCE IS CHECKED ON EVERY WRITE. `lib/jobs/store.ts` conditions completion on id + status,
 *     which lets a reclaimed worker finalize somebody else's job; here every write must match the
 *     full scope AND the owner token AND the lease generation AND an unexpired lease. An expired
 *     owner loses authority immediately — before anyone reclaims — and a reclaim bumps the
 *     generation, so the replaced worker stays refused even though the row is `running` again.
 *  4. NOTHING IS SWALLOWED. A SQL failure rejects. A `null`/`refused` result can only mean the
 *     conditional update matched no row, which is why no call site here catches anything: "no work"
 *     and "the database is broken" must never be the same value.
 *
 * The returned `SlackThreadClaim` is a plain value, not a capability: holding one proves nothing,
 * because the database re-checks it on every use. It is a convenience for carrying the scope, the
 * token and the fence together.
 *
 * One local convention worth stating: a refusal is reported as `{ outcome: "refused" }` and NEVER as
 * `{ ok: false }`. The transaction engine treats an `ok:false` return from a transaction callback as
 * a rollback signal (`returnedFailure` in `lib/db/pg/tx.ts`), so a caller that returned one of these
 * results straight out of its transaction would silently undo its own committed work.
 */

/** Fully scoped identity of one pending thread. `team_id` is a namespace above the Slack ids. */
export interface SlackThreadScope {
  readonly teamId: string;
  readonly workspaceId: string;
  readonly channelId: string;
  readonly rootTs: string;
}

export type SlackThreadStatus = "queued" | "running";

/** The stored row, as this module reports it. Progress fields are metadata, never evidence. */
export interface SlackThreadState {
  readonly scope: SlackThreadScope;
  readonly status: SlackThreadStatus;
  readonly dueAt: string;
  readonly attempts: number;
  readonly leaseGeneration: number;
  readonly leaseOwner: string | null;
  readonly leaseExpiresAt: string | null;
  readonly pageCursor: string | null;
  readonly snapshotGeneration: number;
  readonly checkpointedAt: string | null;
  readonly lastErrorCode: string | null;
}

/** What a successful claim/reclaim hands back. Every field is read from the returned row. */
export interface SlackThreadClaim {
  readonly scope: SlackThreadScope;
  readonly leaseOwner: string;
  readonly leaseGeneration: number;
  readonly leaseExpiresAt: string;
  readonly attempts: number;
  readonly pageCursor: string | null;
  readonly snapshotGeneration: number;
}

export interface SlackThreadEnqueueResult {
  /** False when the scope was already pending — the existing state is returned untouched. */
  readonly inserted: boolean;
  readonly state: SlackThreadState;
}

export type SlackThreadCheckpointResult =
  | { readonly outcome: "checkpointed"; readonly state: SlackThreadState }
  | { readonly outcome: "refused" };

export type SlackThreadReleaseResult =
  | { readonly outcome: "released"; readonly state: SlackThreadState }
  | { readonly outcome: "refused" };

/**
 * Lease duration bounds. A too-short lease expires mid-page and invites reclaim storms; a too-long
 * one is an effectively permanent claim that nothing can recover if the worker dies. The wake this
 * feeds works under a 20-second HTTP deadline, so 15 minutes is already generous.
 */
const MIN_LEASE_MS = 1_000;
const MAX_LEASE_MS = 900_000;

/** The DB caps this too; the app check exists so a bad value fails before it reaches a statement. */
const MAX_PAGE_CURSOR_LENGTH = 1_024;

/** A sanitized failure CATEGORY: lower-case, underscore-separated, short. Never a message or token. */
const ERROR_CODE = /^[a-z][a-z0-9_]{0,39}$/;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const STATE_COLUMNS = `team_id, workspace_id, channel_id, root_ts, status, due_at, attempts,
       lease_generation::text as lease_generation, lease_owner, lease_expires_at, page_cursor,
       snapshot_generation::text as snapshot_generation, checkpointed_at, last_error_code`;

interface StateRow {
  team_id: string;
  workspace_id: string;
  channel_id: string;
  root_ts: string;
  status: string;
  due_at: Date | string;
  attempts: number | string;
  lease_generation: string;
  lease_owner: string | null;
  lease_expires_at: Date | string | null;
  page_cursor: string | null;
  snapshot_generation: string;
  checkpointed_at: Date | string | null;
  last_error_code: string | null;
}

class SlackThreadStateError extends TypeError {
  constructor(message: string) {
    super(`slack thread state: ${message}`);
    this.name = "SlackThreadStateError";
  }
}

/**
 * Scope validation, reusing the pure helpers rather than restating their alphabets.
 *
 * `scopedSlackChannelPathPrefix` is called for its VERDICT and its result discarded: no path is
 * minted here, and the lower-cased form it would return is emphatically not what gets stored — the
 * row keeps the provider's bytes. Asking the namespace helper is how the id alphabet stays defined
 * in one place; the SQL check constraint is the storage-level restatement of the same rule, because
 * app validation is not a guarantee about what is in the table.
 */
function assertScope(scope: SlackThreadScope): void {
  if (typeof scope?.teamId !== "string" || !UUID.test(scope.teamId)) {
    throw new SlackThreadStateError(`teamId must be a UUID (got ${JSON.stringify(scope?.teamId)})`);
  }
  scopedSlackChannelPathPrefix(scope.workspaceId, scope.channelId);
  if (typeof scope.rootTs !== "string" || !parseSlackTimestamp(scope.rootTs)) {
    throw new SlackThreadStateError(
      `rootTs must be an exact Slack timestamp (got ${JSON.stringify(scope.rootTs)})`
    );
  }
}

function assertLeaseMs(leaseMs: number): void {
  if (!Number.isSafeInteger(leaseMs) || leaseMs < MIN_LEASE_MS || leaseMs > MAX_LEASE_MS) {
    throw new SlackThreadStateError(
      `leaseMs must be a whole number of milliseconds between ${MIN_LEASE_MS} and ${MAX_LEASE_MS} ` +
        `(got ${JSON.stringify(leaseMs)})`
    );
  }
}

function assertInstant(field: string, value: Date): void {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new SlackThreadStateError(`${field} must be a valid Date (got ${JSON.stringify(value)})`);
  }
}

function assertGeneration(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new SlackThreadStateError(
      `snapshotGeneration must be a non-negative whole number (got ${JSON.stringify(value)})`
    );
  }
}

function assertPageCursor(value: string | null): void {
  if (value === null) return;
  if (typeof value !== "string" || value.trim() === "" || value.length > MAX_PAGE_CURSOR_LENGTH) {
    throw new SlackThreadStateError(
      `pageCursor must be null or a non-blank string of at most ${MAX_PAGE_CURSOR_LENGTH} characters`
    );
  }
}

function assertErrorCode(value: string | null | undefined): void {
  if (value === null || value === undefined) return;
  if (typeof value !== "string" || !ERROR_CODE.test(value)) {
    throw new SlackThreadStateError(
      `errorCode must be a sanitized lower-case category matching ${ERROR_CODE.source} ` +
        `(got ${JSON.stringify(value)}) — never a provider message or token`
    );
  }
}

/** bigint arrives as text so nothing is silently rounded; a value past 2^53 is reported, not lost. */
function counter(field: string, value: number | string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new SlackThreadStateError(`${field} is not representable as a safe integer (${value})`);
  }
  return parsed;
}

function instant(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new SlackThreadStateError(`unreadable timestamp from the database (${String(value)})`);
  }
  return date.toISOString();
}

function toState(row: StateRow): SlackThreadState {
  if (row.status !== "queued" && row.status !== "running") {
    throw new SlackThreadStateError(`unknown stored status ${JSON.stringify(row.status)}`);
  }
  return {
    scope: {
      teamId: row.team_id,
      workspaceId: row.workspace_id,
      channelId: row.channel_id,
      rootTs: row.root_ts,
    },
    status: row.status,
    dueAt: instant(row.due_at),
    attempts: counter("attempts", row.attempts),
    leaseGeneration: counter("lease_generation", row.lease_generation),
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at === null ? null : instant(row.lease_expires_at),
    pageCursor: row.page_cursor,
    snapshotGeneration: counter("snapshot_generation", row.snapshot_generation),
    checkpointedAt: row.checkpointed_at === null ? null : instant(row.checkpointed_at),
    lastErrorCode: row.last_error_code,
  };
}

function scopeParams(scope: SlackThreadScope): [string, string, string, string] {
  return [scope.teamId, scope.workspaceId, scope.channelId, scope.rootTs];
}

const SCOPE_PREDICATE = `team_id = $1 and workspace_id = $2 and channel_id = $3 and root_ts = $4`;

/**
 * Make one thread pending, or report the pending state that already exists.
 *
 * `ON CONFLICT DO NOTHING`, never an upsert: a duplicate enqueue must not reset a running lease, the
 * attempt count, the fence, the cursor or the due time — a discovery pass re-reporting a root it has
 * already reported is the NORMAL case, and an upsert would let it evict the worker mid-page. The
 * generic 23505 retry in `runContextTransaction` covers only items/context inserts, which is the
 * other reason the conflict is handled here rather than left to raise.
 *
 * Re-prioritizing an already-pending root (pulling `due_at` earlier because new replies were seen)
 * is deliberately NOT here: it is a lane-discovery decision that needs its own rules and its own
 * tests, and it cannot be smuggled in as a side effect of enqueue.
 */
export async function enqueueSlackThread(
  session: TransactionSession,
  scope: SlackThreadScope,
  opts: { dueAt?: Date } = {}
): Promise<SlackThreadEnqueueResult> {
  assertScope(scope);
  if (opts.dueAt !== undefined) assertInstant("dueAt", opts.dueAt);

  const inserted = await session.executeSql<StateRow>(
    `insert into slack_sync_threads (team_id, workspace_id, channel_id, root_ts, due_at)
          values ($1, $2, $3, $4, coalesce($5::timestamptz, clock_timestamp()))
     on conflict (team_id, workspace_id, channel_id, root_ts) do nothing
       returning ${STATE_COLUMNS}`,
    [...scopeParams(scope), opts.dueAt ?? null]
  );
  const fresh = single(inserted);
  if (fresh) return { inserted: true, state: toState(fresh) };

  const existing = await session.executeSql<StateRow>(
    `select ${STATE_COLUMNS} from slack_sync_threads where ${SCOPE_PREDICATE}`,
    scopeParams(scope)
  );
  const row = single(existing);
  if (!row) {
    // The insert conflicted, so a row existed; its disappearance inside this transaction is an
    // anomaly (a concurrent team cascade, or a caller that raised the isolation level above the
    // engine's READ COMMITTED so this statement cannot see the committed conflicting row), not an
    // empty result to paper over.
    throw new SlackThreadStateError(
      "enqueue conflicted but the conflicting row is gone — refusing to report a state it does not have"
    );
  }
  return { inserted: false, state: toState(row) };
}

/**
 * Take ownership of one specified thread: a queued row that has come DUE, or a running row whose
 * lease has EXPIRED (the reclaim arm). One atomic conditional update decides both.
 *
 * Every successful acquisition — first claim and reclaim alike — increments `attempts` and the
 * `lease_generation` fence and mints a fresh owner token in the database, so the previous owner is
 * stale from that moment even though the row is `running` again.
 *
 * `null` means NOT ACQUIRED (unknown scope, not yet due, or somebody's lease is still live). It can
 * never mean a failed statement: a SQL error rejects, and the caller is asked to read the token that
 * came back rather than assume a claim it did not observe.
 *
 * `last_error_code` is deliberately left alone — it records the last failure, and erasing it on the
 * next attempt would delete the diagnosis while the retry is in flight.
 */
export async function claimSlackThread(
  session: TransactionSession,
  scope: SlackThreadScope,
  opts: { leaseMs: number }
): Promise<SlackThreadClaim | null> {
  assertScope(scope);
  assertLeaseMs(opts.leaseMs);

  const result = await session.executeSql<StateRow>(
    `update slack_sync_threads
        set status = 'running',
            attempts = attempts + 1,
            lease_generation = lease_generation + 1,
            lease_owner = gen_random_uuid()::text,
            lease_expires_at = clock_timestamp() + ($5::double precision * interval '1 millisecond'),
            updated_at = clock_timestamp()
      where ${SCOPE_PREDICATE}
        and (
              (status = 'queued' and due_at <= clock_timestamp())
              or (status = 'running' and lease_expires_at <= clock_timestamp())
            )
  returning ${STATE_COLUMNS}`,
    [...scopeParams(scope), opts.leaseMs]
  );

  const row = single(result);
  if (!row) return null;

  const state = toState(row);
  if (state.leaseOwner === null || state.leaseExpiresAt === null) {
    // Unreachable while the lease codec holds; asserted anyway because the alternative is handing
    // back a claim whose token nobody read, which is the one failure mode that must fail closed.
    throw new SlackThreadStateError("claimed row came back without a lease — refusing to report it");
  }
  return {
    scope: state.scope,
    leaseOwner: state.leaseOwner,
    leaseGeneration: state.leaseGeneration,
    leaseExpiresAt: state.leaseExpiresAt,
    attempts: state.attempts,
    pageCursor: state.pageCursor,
    snapshotGeneration: state.snapshotGeneration,
  };
}

/**
 * Record how far this claim has read: the provider's page cursor and the generation of the snapshot
 * it belongs to. PROGRESS METADATA ONLY — it publishes nothing, completes nothing, and asserts
 * nothing about the thread's content.
 *
 * Refused unless the full scope, `status='running'`, the owner token, the fence generation AND an
 * unexpired lease all still hold at the database. `snapshot_generation` may advance or stay put but
 * never rewind, and that test is part of the same statement, so a rejected rewind cannot leave its
 * cursor behind. The caller cannot move the lease generation: it is not in the SET list.
 *
 * A refusal deliberately carries no reason. Every cause (expired, reclaimed, wrong scope, rewound)
 * has the same consequence — this worker must abandon the claim — and classifying it would mean a
 * second read of a row somebody else may already own, which would be a worse kind of answer.
 */
export async function checkpointSlackThread(
  session: TransactionSession,
  claim: SlackThreadClaim,
  progress: { pageCursor: string | null; snapshotGeneration: number }
): Promise<SlackThreadCheckpointResult> {
  assertScope(claim.scope);
  assertPageCursor(progress.pageCursor);
  assertGeneration(progress.snapshotGeneration);

  const result = await session.executeSql<StateRow>(
    `update slack_sync_threads
        set page_cursor = $7,
            snapshot_generation = $8::bigint,
            checkpointed_at = clock_timestamp(),
            updated_at = clock_timestamp()
      where ${SCOPE_PREDICATE}
        and status = 'running'
        and lease_owner = $5
        and lease_generation = $6::bigint
        and lease_expires_at > clock_timestamp()
        and $8::bigint >= snapshot_generation
  returning ${STATE_COLUMNS}`,
    [
      ...scopeParams(claim.scope),
      claim.leaseOwner,
      String(claim.leaseGeneration),
      progress.pageCursor,
      String(progress.snapshotGeneration),
    ]
  );

  const row = single(result);
  return row ? { outcome: "checkpointed", state: toState(row) } : { outcome: "refused" };
}

/**
 * Hand the thread back for a later attempt: queued again, at the supplied time, with a sanitized
 * failure category and no lease.
 *
 * It touches nothing it did not earn — the cursor, the snapshot generation, the attempt count and
 * the fence are all left exactly as they are, so a retry resumes where the pass got to. It requires
 * the same full fence as a checkpoint, which is what stops a stale worker postponing (or requeueing)
 * a NEW worker's live claim.
 *
 * There is no success counterpart. A thread that has been read to completion is acknowledged inside
 * the publication transaction, not here.
 */
export async function releaseSlackThreadForRetry(
  session: TransactionSession,
  claim: SlackThreadClaim,
  opts: { nextDueAt: Date; errorCode?: string | null }
): Promise<SlackThreadReleaseResult> {
  assertScope(claim.scope);
  assertInstant("nextDueAt", opts.nextDueAt);
  assertErrorCode(opts.errorCode);

  const result = await session.executeSql<StateRow>(
    `update slack_sync_threads
        set status = 'queued',
            lease_owner = null,
            lease_expires_at = null,
            due_at = $7::timestamptz,
            last_error_code = $8,
            updated_at = clock_timestamp()
      where ${SCOPE_PREDICATE}
        and status = 'running'
        and lease_owner = $5
        and lease_generation = $6::bigint
        and lease_expires_at > clock_timestamp()
  returning ${STATE_COLUMNS}`,
    [
      ...scopeParams(claim.scope),
      claim.leaseOwner,
      String(claim.leaseGeneration),
      opts.nextDueAt,
      opts.errorCode ?? null,
    ]
  );

  const row = single(result);
  return row ? { outcome: "released", state: toState(row) } : { outcome: "refused" };
}

/** One row or none. More than one would mean the scope uniqueness constraint is not doing its job. */
function single(result: SqlQueryResult<StateRow>): StateRow | undefined {
  if (result.rows.length > 1) {
    throw new SlackThreadStateError(`expected at most one row, got ${result.rows.length}`);
  }
  return result.rows[0];
}
