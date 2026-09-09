import "server-only";
import type { SqlQueryResult, TransactionSession } from "@/lib/db/types";

/**
 * The single writer of `slack_method_budgets` — the durable, cross-process "when may the next
 * request of this method be sent" clock for the Slack timeline (AIO-1170).
 *
 * ⚠️ WHAT A GRANTED SLOT MEANS, AND WHAT IT DOES NOT. It means the local budget permits ONE request
 * of that method under that scope, and that the permission is already durable. It is not
 * authorization, not channel permission, not proof of workspace provenance, and not permission to
 * store anything that comes back. It does not send the request either — this module never performs
 * I/O; `lib/ingest/sources/slack-page-request.ts` is what turns a committed grant into exactly one
 * call.
 *
 * Five properties hold this module together:
 *
 *  1. IT NEVER OPENS A TRANSACTION. Every function takes the caller's `TransactionSession` and runs
 *     on that one bound connection, exactly like `slack-thread-state.ts` and `slack-namespace-gate.ts`,
 *     so a caller can compose a reservation with its own writes. What a caller must NOT do is hold
 *     that transaction open across the HTTP call: DB locks would be held across a network round
 *     trip, and a rollback would refund allowance the provider has already counted. The transport
 *     therefore opens its own SHORT transaction and waits for its commit before fetching.
 *  2. THE DATABASE IS THE CLOCK. Due-ness is `next_permitted_at <= clock_timestamp()` inside the
 *     statement's own `WHERE`, never a caller-supplied `now` and never a read-then-write. Two
 *     processes racing for one slot serialize on the row: the loser's re-check runs against the
 *     winner's committed value and matches nothing.
 *  3. A DENIAL NEVER RESERVES AND NEVER SLEEPS. `deferred` reports the persisted time and how long
 *     to wait; it does not book a future slot (which would let N pollers reserve N future slots in
 *     one tick) and it does not block the caller.
 *  4. BACKOFF ONLY EVER MOVES THE DEADLINE LATER. A provider 429 extends the SAME bucket with
 *     `greatest(stored, now + retry-after)`, so a late 429 for an old request cannot rewind a
 *     deadline a newer reservation or a longer backoff already set.
 *  5. NOTHING IS SWALLOWED. A SQL failure rejects. `deferred` can only mean the conditional update
 *     matched no row, because "no slot" and "the database is broken" must never be the same value —
 *     the first means wait, the second means we do not know.
 *
 * A refusal is reported as `{ outcome: "deferred" }` and NEVER as `{ ok: false }`: the transaction
 * engine treats an `ok:false` return from a transaction callback as a rollback signal
 * (`returnedFailure` in `lib/db/pg/tx.ts`), so a caller returning one of these results straight out
 * of its transaction would silently undo its own committed work — including the reservation.
 *
 * ⚠️ A CRASH AFTER A GRANT CONSUMES THE INTERVAL, ON PURPOSE. There is no refund path for a request
 * whose fetch or parse failed: the provider counted it, and handing the slot back is precisely how a
 * crash-looping worker turns into an unmetered request flood.
 */

/** Every Slack method this ingestion path calls. A method absent here has no budget and is refused. */
export const SLACK_BUDGETED_METHODS = [
  "auth.test",
  "bots.info",
  "conversations.info",
  "conversations.history",
  "conversations.replies",
  "users.list",
] as const;

export type SlackBudgetedMethod = (typeof SLACK_BUDGETED_METHODS)[number];

/**
 * The discriminated bucket key. Deliberately carries NEITHER a token NOR a channel: Slack meters per
 * app+workspace+method, so two tokens or two integrations for the same verified app and workspace
 * share one allowance.
 */
export type SlackMethodScope =
  | {
      readonly kind: "verified";
      readonly teamId: string;
      readonly workspaceId: string;
      readonly appId: string;
    }
  | { readonly kind: "provisional"; readonly teamId: string; readonly integrationId: string }
  /** The ONE `bots.info` bucket for a workspace — bootstrap and every later identity refresh. */
  | { readonly kind: "workspace_bootstrap"; readonly teamId: string; readonly workspaceId: string };

export type SlackMethodScopeKind = SlackMethodScope["kind"];

/**
 * `bots.info` is budgeted under the workspace bootstrap scope and NOWHERE else — including the
 * verified scope, which otherwise budgets every method.
 *
 * ONE workspace, ONE bots.info allowance, for identity bootstrap AND every later identity refresh.
 * If the verified scope kept its own bots.info bucket, binding an app would mint a second allowance
 * for the same workspace (a third for the next app), so a bootstrap request could be followed
 * immediately by a verified one — which is the shared allowance the bootstrap bucket exists to be.
 */
export const SLACK_BOOTSTRAP_ONLY_METHOD = "bots.info" satisfies SlackBudgetedMethod;

/**
 * Which methods each scope may budget. The narrow scopes exist for ONE bootstrap call each; a
 * history budget under an unverified identity is the thing they are bounded to prevent, so this is
 * enforced here AND restated as a SQL constraint.
 *
 * `verified` is DERIVED from the supported list minus the bootstrap-only method, so a method added
 * later joins it automatically while the one exclusion stays stated in exactly one place.
 */
const METHODS_BY_SCOPE: Record<SlackMethodScopeKind, readonly SlackBudgetedMethod[]> = {
  verified: SLACK_BUDGETED_METHODS.filter((method) => method !== SLACK_BOOTSTRAP_ONLY_METHOD),
  provisional: ["auth.test"],
  workspace_bootstrap: [SLACK_BOOTSTRAP_ONLY_METHOD],
};

/**
 * The CONSERVATIVE unknown-installation-category budget: one request per minute, per method, per
 * scope. Slack's real ceiling depends on a distribution category this installation has not proved
 * (see docs/design/slack-timeline-reliability.md), and unknown is never a permissive default.
 *
 * It is a per-method map rather than one constant so a verified higher-budget policy can join at
 * activation by supplying different values — NOT so a caller can pass its own. There is deliberately
 * no override parameter on the reservation call: a permissive caller override is how a conservative
 * default becomes decorative.
 */
export const SLACK_UNKNOWN_CATEGORY_INTERVAL_MS = 60_000;

const METHOD_INTERVAL_MS: Record<SlackBudgetedMethod, number> = {
  "auth.test": SLACK_UNKNOWN_CATEGORY_INTERVAL_MS,
  "bots.info": SLACK_UNKNOWN_CATEGORY_INTERVAL_MS,
  "conversations.info": SLACK_UNKNOWN_CATEGORY_INTERVAL_MS,
  "conversations.history": SLACK_UNKNOWN_CATEGORY_INTERVAL_MS,
  "conversations.replies": SLACK_UNKNOWN_CATEGORY_INTERVAL_MS,
  "users.list": SLACK_UNKNOWN_CATEGORY_INTERVAL_MS,
};

/**
 * The conservative page size for `conversations.history` / `conversations.replies` under the unknown
 * category. Enforced at the one-request adapter, which is the only place a `limit` reaches Slack.
 */
export const SLACK_UNKNOWN_CATEGORY_PAGE_LIMIT = 15;

/** The floor a missing or unusable `Retry-After` falls back to — never zero, never "retry now". */
export const SLACK_BACKOFF_FLOOR_MS = 60_000;

/**
 * The largest delay this module can carry end to end — a REPRESENTABILITY bound, NOT a claim about
 * how long a provider cooldown can be.
 *
 * ⚠️ There used to be a 24-hour cap here, justified by "no genuine Slack cooldown exceeds a day".
 * There is no source for that, and the cap could only ever SHORTEN a real cooldown: a 48-hour
 * `Retry-After` became 24, so the next request would have gone out a full day inside the window the
 * provider refused. A valid delay now keeps its whole duration.
 *
 * What genuinely bounds it: a persisted deadline is read back through `new Date(...)`, so the
 * ECMAScript time-value limit (±8.64e15 ms) is the ceiling on `now + delay`. Half that limit leaves
 * room for any clock this can run on, and it is ~137,000 years — far past anything a provider could
 * mean. A delay beyond it is REFUSED rather than shortened, because silently substituting a nearer
 * deadline is the failure this constant replaced.
 */
export const SLACK_BACKOFF_REPRESENTABLE_MAX_MS = 4_320_000_000_000_000;

export type SlackMethodReservation =
  | {
      readonly outcome: "granted";
      readonly scope: SlackMethodScope;
      readonly method: SlackBudgetedMethod;
      /** When the NEXT request may go — i.e. this grant's interval, already persisted. */
      readonly nextPermittedAt: string;
    }
  | {
      readonly outcome: "deferred";
      readonly scope: SlackMethodScope;
      readonly method: SlackBudgetedMethod;
      readonly nextPermittedAt: string;
      /** Measured at the DATABASE, so a skewed app clock cannot turn a wait into "go now". */
      readonly retryAfterMs: number;
    };

export interface SlackMethodBackoff {
  readonly scope: SlackMethodScope;
  readonly method: SlackBudgetedMethod;
  readonly nextPermittedAt: string;
  readonly retryAfterMs: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The provider-id alphabet the Slack tables store, restated because this module has no path helper. */
const PROVIDER_ID = /^[A-Za-z0-9]+$/;

interface BudgetRow {
  next_permitted_at: Date | string;
  retry_after_ms: string;
}

const BUDGET_COLUMNS = `next_permitted_at,
       greatest(0, ceil(extract(epoch from (next_permitted_at - clock_timestamp())) * 1000))::bigint::text
         as retry_after_ms`;

export class SlackMethodBudgetError extends TypeError {
  constructor(message: string) {
    super(`slack method budget: ${message}`);
    this.name = "SlackMethodBudgetError";
  }
}

function assertProviderId(field: string, value: unknown): void {
  if (typeof value !== "string" || !PROVIDER_ID.test(value)) {
    throw new SlackMethodBudgetError(
      `${field} must be a Slack provider id matching ${PROVIDER_ID.source} (got ${JSON.stringify(value)})`
    );
  }
}

function assertUuid(field: string, value: unknown): void {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new SlackMethodBudgetError(`${field} must be a UUID (got ${JSON.stringify(value)})`);
  }
}

/**
 * Validate the scope AND the scope/method pairing together, because they are one rule: a scope is
 * only meaningful for the calls it was defined to bound. A method this scope may not budget is a
 * caller BUG and throws — reporting it as `deferred` would let a broken call site look like a busy
 * one and retry forever.
 */
function assertScopeAndMethod(scope: SlackMethodScope, method: SlackBudgetedMethod): void {
  if (!SLACK_BUDGETED_METHODS.includes(method)) {
    throw new SlackMethodBudgetError(
      `method must be one of ${SLACK_BUDGETED_METHODS.join(", ")} (got ${JSON.stringify(method)})`
    );
  }
  assertUuid("teamId", scope?.teamId);
  switch (scope.kind) {
    case "verified":
      assertProviderId("workspaceId", scope.workspaceId);
      assertProviderId("appId", scope.appId);
      break;
    case "provisional":
      assertUuid("integrationId", scope.integrationId);
      break;
    case "workspace_bootstrap":
      assertProviderId("workspaceId", scope.workspaceId);
      break;
    default:
      throw new SlackMethodBudgetError(
        `unknown scope kind ${JSON.stringify((scope as { kind?: unknown })?.kind)}`
      );
  }
  const allowed = METHODS_BY_SCOPE[scope.kind];
  if (!allowed.includes(method)) {
    // NOT translated to the bootstrap scope on the caller's behalf. Rewriting a scope inside the
    // writer would hide the call site's mistake and make the shared bucket reachable under a key
    // nothing else agrees with; the caller must ask for the scope it actually means.
    const hint =
      method === SLACK_BOOTSTRAP_ONLY_METHOD
        ? ` — ${SLACK_BOOTSTRAP_ONLY_METHOD} is budgeted only under the workspace_bootstrap scope, which is shared and retained for identity refreshes`
        : "";
    throw new SlackMethodBudgetError(
      `the ${scope.kind} scope may budget only ${allowed.join(", ")} — refusing ${method}${hint}`
    );
  }
}

/** The SQL identity of a scope: the same values in the same order for the key and the predicate. */
function scopeParams(scope: SlackMethodScope): [string, string, string | null, string | null, string | null] {
  switch (scope.kind) {
    case "verified":
      return [scope.teamId, scope.kind, scope.workspaceId, scope.appId, null];
    case "provisional":
      return [scope.teamId, scope.kind, null, null, scope.integrationId];
    case "workspace_bootstrap":
      return [scope.teamId, scope.kind, scope.workspaceId, null, null];
  }
}

/**
 * `is not distinct from` throughout, not `=`: three of the five key columns are NULL for some scope
 * shapes, and `null = null` is unknown — a plain equality predicate would match no row for every
 * provisional and bootstrap bucket, so every reservation would look like a fresh one and grant
 * unconditionally.
 */
const SCOPE_PREDICATE = `team_id = $1
     and scope_kind = $2
     and workspace_id is not distinct from $3
     and app_id is not distinct from $4
     and integration_id is not distinct from $5::uuid
     and method = $6`;

function instant(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new SlackMethodBudgetError(`unreadable timestamp from the database (${String(value)})`);
  }
  return date.toISOString();
}

function millis(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new SlackMethodBudgetError(`retry delay is not representable as a safe integer (${value})`);
  }
  return parsed;
}

/** One row or none. More than one would mean the per-scope unique index is not doing its job. */
function single(result: SqlQueryResult<BudgetRow>): BudgetRow | undefined {
  if (result.rows.length > 1) {
    throw new SlackMethodBudgetError(`expected at most one row, got ${result.rows.length}`);
  }
  return result.rows[0];
}

/**
 * Create the bucket if it is not there yet, DUE, so the caller's next statement decides the outcome.
 *
 * A bare `ON CONFLICT DO NOTHING` with no conflict target: the three scope shapes have three partial
 * unique indexes, and naming one would mean branching the statement per scope for no gain — any of
 * them conflicting means the bucket exists, which is the whole question.
 *
 * A concurrent inserter's speculative row makes this statement WAIT until that transaction settles,
 * which is the serialization the reservation depends on; it is also why the caller's transaction
 * must be short.
 */
async function ensureBucket(
  session: TransactionSession,
  scope: SlackMethodScope,
  method: SlackBudgetedMethod
): Promise<void> {
  await session.executeSql(
    `insert into slack_method_budgets
            (team_id, scope_kind, workspace_id, app_id, integration_id, method)
          values ($1, $2, $3, $4, $5::uuid, $6)
     on conflict do nothing`,
    [...scopeParams(scope), method]
  );
}

/**
 * Claim ONE request slot for this scope+method, or report when the next one is due.
 *
 * The grant and the advance are the SAME statement: a conditional `UPDATE … WHERE next_permitted_at
 * <= clock_timestamp()` that pushes the deadline forward by the method's interval. Two connections
 * racing on one bucket serialize on the row lock, and the loser re-evaluates its `WHERE` against the
 * winner's committed value — so exactly one of them is granted.
 *
 * ⚠️ THE GRANT IS ONLY REAL WHEN THE CALLER'S TRANSACTION COMMITS. This function runs on the
 * caller's session; a rollback un-reserves the slot. That is correct for composition, and it is
 * exactly why the transport commits before it fetches rather than fetching inside the transaction.
 *
 * A `deferred` result is a persisted fact, not advice: the deadline was already stored by whoever
 * consumed the slot, and this call does NOT extend it. Reserving a future slot on a busy bucket
 * would let a tick's worth of pollers each book a turn, which is a queue we have no way to honour.
 */
export async function reserveSlackMethodSlot(
  session: TransactionSession,
  scope: SlackMethodScope,
  method: SlackBudgetedMethod
): Promise<SlackMethodReservation> {
  assertScopeAndMethod(scope, method);
  const intervalMs = slackMethodIntervalMs(method);

  await ensureBucket(session, scope, method);

  const granted = await session.executeSql<BudgetRow>(
    `update slack_method_budgets
        set next_permitted_at = clock_timestamp() + ($7::double precision * interval '1 millisecond'),
            updated_at = clock_timestamp()
      where ${SCOPE_PREDICATE}
        and next_permitted_at <= clock_timestamp()
  returning ${BUDGET_COLUMNS}`,
    [...scopeParams(scope), method, intervalMs]
  );

  const row = single(granted);
  if (row) {
    return { outcome: "granted", scope, method, nextPermittedAt: instant(row.next_permitted_at) };
  }

  // Not granted, so read back WHY — the persisted deadline somebody else set. A separate statement
  // gets a fresh READ COMMITTED snapshot, so this is the committed value, not a stale one.
  const busy = await session.executeSql<BudgetRow>(
    `select ${BUDGET_COLUMNS} from slack_method_budgets where ${SCOPE_PREDICATE}`,
    [...scopeParams(scope), method]
  );
  const pending = single(busy);
  if (!pending) {
    // The bucket was ensured moments ago on this same connection. Its absence is an anomaly (a
    // concurrent team/integration cascade, or an isolation level above the engine's READ COMMITTED),
    // not an empty result to paper over — and reporting "granted" here would authorize an unmetered
    // request, which is the one failure this module must never produce.
    throw new SlackMethodBudgetError(
      "the bucket vanished between ensure and read — refusing to report a slot that was not reserved"
    );
  }
  return {
    outcome: "deferred",
    scope,
    method,
    nextPermittedAt: instant(pending.next_permitted_at),
    retryAfterMs: millis(pending.retry_after_ms),
  };
}

/**
 * Persist a provider cooldown on the SAME bucket the request was reserved from.
 *
 * `greatest(stored, clock_timestamp() + delay)` is the whole rule, and it is one statement so it
 * cannot be observed apart: a 429 arriving late — after a newer reservation, or after a longer
 * backoff — can only ever leave the deadline where it is. A shorter `Retry-After` therefore never
 * rewinds a longer cooldown.
 *
 * A missing, malformed, negative or non-finite delay takes the conservative floor rather than being
 * rejected. The provider has just told us to stop; refusing to record that because the header was
 * unusable would send the next request immediately, which is the opposite of the instruction. A
 * delay that is real but unrepresentable THROWS instead (`usableBackoffMs`) — the caller must treat
 * that as blocked, not silently accept a 60-second cooldown in place of the stated one.
 *
 * ⚠️ ITS FAILURE MUST REACH THE CALLER. If this write fails, the cooldown is not persisted, and a
 * transport that swallowed the error would report an empty page and go straight back to the
 * provider. The caller is expected to surface the DB failure.
 */
export async function extendSlackMethodBackoff(
  session: TransactionSession,
  scope: SlackMethodScope,
  method: SlackBudgetedMethod,
  opts: { retryAfterMs?: number | null } = {}
): Promise<SlackMethodBackoff> {
  assertScopeAndMethod(scope, method);
  const delayMs = usableBackoffMs(opts.retryAfterMs);

  await ensureBucket(session, scope, method);

  const result = await session.executeSql<BudgetRow>(
    `update slack_method_budgets
        set next_permitted_at = greatest(
              next_permitted_at,
              clock_timestamp() + ($7::double precision * interval '1 millisecond')
            ),
            updated_at = clock_timestamp()
      where ${SCOPE_PREDICATE}
  returning ${BUDGET_COLUMNS}`,
    [...scopeParams(scope), method, delayMs]
  );

  const row = single(result);
  if (!row) {
    throw new SlackMethodBudgetError(
      "the bucket vanished between ensure and backoff — refusing to report a cooldown it did not persist"
    );
  }
  return {
    scope,
    method,
    nextPermittedAt: instant(row.next_permitted_at),
    retryAfterMs: millis(row.retry_after_ms),
  };
}

/**
 * A usable cooldown from whatever the provider sent. Pure, so the header parsing that feeds it can
 * be tested without a database.
 *
 * Three inputs, three answers. Missing/malformed/negative takes the conservative FLOOR — the
 * provider has just told us to stop, and refusing to record that would send the next request
 * immediately. A usable delay is kept WHOLE, however long. A finite delay too large to carry is
 * THROWN, not floored: quietly persisting 60 seconds in place of a cooldown we were told to honour
 * is the one outcome that looks ordinary in the table and is wrong in the provider's eyes.
 */
export function usableBackoffMs(retryAfterMs: number | null | undefined): number {
  if (typeof retryAfterMs !== "number" || !Number.isFinite(retryAfterMs)) {
    return SLACK_BACKOFF_FLOOR_MS;
  }
  const whole = Math.ceil(retryAfterMs);
  if (!Number.isSafeInteger(whole) || whole > SLACK_BACKOFF_REPRESENTABLE_MAX_MS) {
    throw new SlackMethodBudgetError(
      `a cooldown of ${whole} ms cannot be represented — refusing to persist a shorter one instead`
    );
  }
  return Math.max(SLACK_BACKOFF_FLOOR_MS, whole);
}

/**
 * What Slack's `Retry-After` said, as one of three distinguishable states. It is not a number,
 * because "we could not read it" and "we read it and cannot carry it" call for opposite responses:
 * the first takes the conservative floor, the second must NOT — a near-term retry there would go out
 * inside a cooldown the provider stated.
 */
export type SlackRetryAfter =
  /** A usable delay, at its full duration. */
  | { readonly kind: "delay"; readonly retryAfterMs: number }
  /** Absent, or not an integer count of seconds. Routes to `SLACK_BACKOFF_FLOOR_MS`. */
  | { readonly kind: "unreadable" }
  /** Digits, but a duration this path cannot carry (`SLACK_BACKOFF_REPRESENTABLE_MAX_MS`). */
  | { readonly kind: "unrepresentable" };

const UNREADABLE = { kind: "unreadable" } as const;
const UNREPRESENTABLE = { kind: "unrepresentable" } as const;

/**
 * Read Slack's `Retry-After` header.
 *
 * DELIBERATELY SECONDS-ONLY. RFC 9110 also allows an HTTP-date, but Slack documents an integer count
 * of seconds, and accepting a date here would mean trusting a remote clock to schedule our own
 * requests.
 *
 * The digit run is UNBOUNDED, unlike the 9-digit cap this replaced: a length limit is a syntax rule
 * standing in for a magnitude rule, and it made `172800` and a 10-digit value fail for the same
 * stated reason. Leading zeros are syntax, not magnitude, so `0000172800` is the same duration as
 * `172800`. Magnitude is judged separately, and reported separately.
 */
export function readRetryAfterHeader(header: string | null | undefined): SlackRetryAfter {
  if (typeof header !== "string") return UNREADABLE;
  const trimmed = header.trim();
  if (!/^\d+$/.test(trimmed)) return UNREADABLE;
  const retryAfterMs = Number(trimmed) * 1_000;
  if (!Number.isSafeInteger(retryAfterMs) || retryAfterMs > SLACK_BACKOFF_REPRESENTABLE_MAX_MS) {
    return UNREPRESENTABLE;
  }
  return { kind: "delay", retryAfterMs };
}

/** The conservative page size for a paged method, or null for a method that does not page. */
export function slackMethodPageLimit(method: SlackBudgetedMethod): number | null {
  return method === "conversations.history" || method === "conversations.replies"
    ? SLACK_UNKNOWN_CATEGORY_PAGE_LIMIT
    : null;
}

/**
 * The interval a granted slot costs. Exported for tests and diagnostics; NOT a caller input — the
 * reservation reads the map itself, so there is no argument through which a call site could ask for
 * a longer allowance than the policy gives it.
 *
 * The lookup is widened to `| undefined` deliberately: the map is `Record<SlackBudgetedMethod, …>`,
 * so the compiler believes every key is present, and an untyped caller passing a string is exactly
 * the case that would otherwise produce `NaN` milliseconds and an interval of "now".
 */
export function slackMethodIntervalMs(method: SlackBudgetedMethod): number {
  const interval: number | undefined = METHOD_INTERVAL_MS[method];
  if (typeof interval !== "number" || !Number.isFinite(interval)) {
    throw new SlackMethodBudgetError(`no interval is defined for ${JSON.stringify(method)}`);
  }
  return interval;
}
