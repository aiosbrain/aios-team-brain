import type { SqlExecutor, TransactionSession } from "@/lib/db/types";
import { parseSlackTimestamp } from "./sources/slack-message-evidence";

/**
 * AIO-1170 AC-02 — INACTIVE enumeration of previously published Slack roots
 * (`docs/design/slack-known-root-requeue-spec.md`, §4, §6 and §7).
 *
 * Three things live here, and nothing else:
 *
 *  1. THE EXECUTION CONTEXT (§7.2): one allowance and one absolute deadline, created before the
 *     caller's transaction and shared by every attempt of it.
 *  2. THE SLICE-LOCAL SESSION (§7.3, §7.4): a decorator over the caller's own transaction session
 *     that admits each data statement against the deadline, refreshes the transaction-local
 *     `statement_timeout` and `lock_timeout` before every one, refuses every capability but
 *     `executeSql`, and restores both settings on a normal return. It is not a shared transaction
 *     facility: it opens nothing, commits nothing and cannot cancel a statement in flight.
 *  3. ENUMERATION (§4): one bounded page of a team's item ids in UUID order, each with its durable
 *     Slack locator or the closed reason it has none.
 *
 * Enumeration only READS, and without row locks. It proves nothing about canonical eligibility,
 * creates no gate, resolves no token and decides nothing about access: preparation checks every
 * fact again, under lock. A locator is not a capability.
 *
 * Nothing in the application imports this module
 * (`test/guards/slack-known-root-requeue-not-wired.test.ts`, `test/guards/slack-source-not-wired.test.ts`).
 */

export const SLACK_KNOWN_ROOT_LIMITS = Object.freeze({
  /** Items examined by one page. The lookahead id is not an examined item. */
  pageSize: Object.freeze({ min: 1, max: 100 }),
  /** The revisit policy. There is no runtime default: every first-page request states it. */
  revisitAfterMs: Object.freeze({ min: 60_000, max: 86_400_000 }),
  /** The operation allowance of one execution context, shared by every transaction attempt. */
  allowanceMs: Object.freeze({ default: 2_000, min: 1_000, max: 5_000 }),
  /** The cap on any single lock wait. */
  lockTimeoutMs: 250,
});

export const SLACK_KNOWN_ROOT_CURSOR_VERSION = 1;

/** A structured continuation: internal metadata, not a viewer API, a capability or sweep state. */
export interface SlackKnownRootCursor {
  readonly version: typeof SLACK_KNOWN_ROOT_CURSOR_VERSION;
  readonly teamId: string;
  /** The upper bound of the key range the first page froze. */
  readonly upperItemId: string;
  /** The last EXAMINED id. The item need not exist any more. */
  readonly afterItemId: string;
  /** The revisit policy the traversal was started with. */
  readonly revisitAfterMs: number;
}

export interface SlackKnownRootPageRequest {
  readonly teamId: string;
  /** Integer, 1–100. */
  readonly pageSize: number;
  /** Integer milliseconds, 60,000–86,400,000. Required; echoed into every entry. */
  readonly revisitAfterMs: number;
  /** Absent on a first page. */
  readonly cursor?: SlackKnownRootCursor;
}

/** Durable facts read during enumeration. Not a capability: preparation checks every one again. */
export interface SlackKnownRootLocator {
  readonly workspaceId: string;
  readonly channelId: string;
  readonly rootTs: string;
  readonly integrationId: string;
  readonly bindingConfigRevision: string;
  readonly namespaceRevision: number;
}

export type SlackKnownRootUnlocatedCategory =
  | "not_slack"
  | "invalid_metadata"
  | "missing_channel_binding"
  | "missing_namespace_pin";

interface SlackKnownRootEntryBase {
  readonly teamId: string;
  readonly itemId: string;
  /** The validated, echoed policy. Not durable source evidence and not an authority credential. */
  readonly revisitAfterMs: number;
}

export interface SlackKnownRootLocatedEntry extends SlackKnownRootEntryBase {
  readonly locator: SlackKnownRootLocator;
}

export interface SlackKnownRootUnlocatedEntry extends SlackKnownRootEntryBase {
  readonly unlocated: SlackKnownRootUnlocatedCategory;
}

/** One entry per EXAMINED item id, whatever it turned out to be. */
export type SlackKnownRootEntry = SlackKnownRootLocatedEntry | SlackKnownRootUnlocatedEntry;

export interface SlackKnownRootItemPage {
  readonly entries: readonly SlackKnownRootEntry[];
  readonly nextCursor: SlackKnownRootCursor | null;
  /** The key range ended. Never "the source is synchronized" and never "reconciliation is complete". */
  readonly exhausted: boolean;
  readonly examined: number;
}

/** An invalid caller contract. The message is static: it never quotes the rejected value. */
export class SlackKnownRootValidationError extends Error {
  constructor() {
    super("slack known-root: invalid request");
    this.name = "SlackKnownRootValidationError";
  }
}

/** The slice's explicit deadline marker, read by the failure classifier and by nothing else. */
export class SlackKnownRootDeadlineError extends Error {
  readonly slackKnownRootDeadlineExceeded = true as const;

  constructor() {
    super("slack known-root: operation deadline exceeded");
    this.name = "SlackKnownRootDeadlineError";
  }
}

export interface SlackKnownRootExecutionOptions {
  /** Integer milliseconds, 1,000–5,000. Default 2,000. */
  readonly allowanceMs?: number;
  /**
   * An ambient deadline on the same monotonic clock, or `null` to DECLARE that there is none. The
   * session cannot discover one, so the caller always says.
   */
  readonly ambientDeadlineAt: number | null;
  /** Monotonic milliseconds. Production omits it; a test may control it. */
  readonly monotonicNow?: () => number;
}

/** Created BEFORE the transaction and reused across its attempts: a retry gets no fresh allowance. */
export interface SlackKnownRootExecution {
  readonly allowanceMs: number;
  /** The effective absolute deadline on the monotonic clock. */
  readonly deadlineAt: number;
  readonly monotonicNow: () => number;
}

function invalidRequest(): never {
  throw new SlackKnownRootValidationError();
}

/**
 * The contexts this module issued. Only one of these is ever admitted: an object that merely has the
 * same fields was validated by nobody.
 */
const issuedExecutions = new WeakSet<object>();

/** The most by which `reading + allowance - reading` may differ from the allowance: one microsecond. */
const DEADLINE_ARITHMETIC_TOLERANCE_MS = 0.001;

/** The largest value PostgreSQL accepts for a timeout setting, in milliseconds. */
const MAX_TIMEOUT_MS = 2_147_483_647;

/** The process's own monotonic clock, in milliseconds. */
function realMonotonicNow(): number {
  return performance.now();
}

/**
 * One reading of a monotonic clock. A clock that throws, or that answers with anything but a finite
 * number, is a broken caller contract: it is refused with the static error, and neither the clock's
 * exception nor the value it returned travels any further.
 */
function readMonotonicClock(clock: () => number): number {
  let reading: unknown;
  try {
    reading = clock();
  } catch {
    return invalidRequest();
  }
  if (typeof reading !== "number" || !Number.isFinite(reading)) return invalidRequest();
  return reading;
}

/**
 * The execution context of one logical operation: its allowance and its absolute deadline, fixed
 * from ONE clock reading taken here. It is created before the transaction and handed to every
 * attempt, so a retry is measured against the same deadline and receives no fresh allowance.
 *
 * The effective deadline is the earlier of `now + allowance` and the ambient deadline the caller
 * declared. An ambient deadline that has already passed is a valid declaration — it is a fact about
 * the caller's remaining time — and yields a context that is already out of time; refusing to start
 * work under it is the job of the primitive that is handed the context, not of this function.
 *
 * Throws only the static validation error. Every option is read once and copied; the options
 * object is not retained.
 */
export function createSlackKnownRootExecution(options: SlackKnownRootExecutionOptions): SlackKnownRootExecution {
  let allowance: unknown;
  let ambient: unknown;
  let clock: unknown;
  try {
    if (typeof options !== "object" || options === null || Array.isArray(options)) return invalidRequest();
    const supplied = options as unknown as Record<string, unknown>;
    allowance = supplied.allowanceMs;
    ambient = supplied.ambientDeadlineAt;
    clock = supplied.monotonicNow;
  } catch {
    // An options object whose accessor throws is as invalid as one that is not an object.
    return invalidRequest();
  }

  const limits = SLACK_KNOWN_ROOT_LIMITS.allowanceMs;
  let allowanceMs: number;
  if (allowance === undefined) allowanceMs = limits.default;
  else if (typeof allowance === "number" && Number.isSafeInteger(allowance) && allowance >= limits.min && allowance <= limits.max) allowanceMs = allowance;
  else return invalidRequest();

  // The caller always SAYS: `null` declares that there is no ambient deadline, a finite number is
  // one. An absent declaration is refused — the session cannot discover a deadline on its own.
  let ambientDeadlineAt: number | null;
  if (ambient === null) ambientDeadlineAt = null;
  else if (typeof ambient === "number" && Number.isFinite(ambient)) ambientDeadlineAt = ambient;
  else return invalidRequest();

  let monotonicNow: () => number;
  if (clock === undefined) monotonicNow = realMonotonicNow;
  else if (typeof clock === "function") monotonicNow = clock as () => number;
  else return invalidRequest();

  const createdAt = readMonotonicClock(monotonicNow);
  const operationDeadlineAt = createdAt + allowanceMs;
  // The sum must still BE the reading plus the allowance. At a magnitude where the clock's floating
  // point spacing swallows the allowance (or part of it) the sum silently collapses onto the reading
  // or lands a millisecond or more away, and the deadline would be narrower or wider than declared.
  // A fractional real clock cannot be added bit-exactly, so the test is one microsecond, far below
  // the whole milliseconds every later admission check works in.
  if (!Number.isFinite(operationDeadlineAt) || Math.abs(operationDeadlineAt - createdAt - allowanceMs) > DEADLINE_ARITHMETIC_TOLERANCE_MS) {
    return invalidRequest();
  }
  const deadlineAt = ambientDeadlineAt === null ? operationDeadlineAt : Math.min(operationDeadlineAt, ambientDeadlineAt);

  const execution: SlackKnownRootExecution = Object.freeze({ allowanceMs, deadlineAt, monotonicNow });
  issuedExecutions.add(execution);
  return execution;
}

/**
 * Admission: is this a context this module issued, and does it still have at least one whole
 * millisecond? Returns the remaining whole milliseconds.
 *
 * Only an object returned by `createSlackKnownRootExecution` is a context. A look-alike with the
 * same fields was validated by nobody and is refused with the static validation error, as is a
 * clock that throws or misreports. A context that is out of time is refused with the slice's
 * deadline error. Nothing here touches a session, so a caller checks admission BEFORE its first
 * statement and no statement is issued for a context that fails it.
 */
export function admitSlackKnownRootExecution(execution: unknown): number {
  if (typeof execution !== "object" || execution === null || !issuedExecutions.has(execution)) return invalidRequest();
  const context = execution as SlackKnownRootExecution;
  const remainingMs = Math.floor(context.deadlineAt - readMonotonicClock(context.monotonicNow));
  if (!(remainingMs >= 1)) throw new SlackKnownRootDeadlineError();
  return Math.min(remainingMs, MAX_TIMEOUT_MS);
}

// ── validation and capture (§6) ──────────────────────────────────────────────

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROVIDER_ID = /^[A-Za-z0-9]+$/;
const CONFIG_REVISION = /^[0-9a-f]{64}$/;
const DECIMAL = /^(?:0|[1-9][0-9]*)$/;
/** Private bounds of this primitive: not a schema or provider syntax rule. */
const PROVIDER_ID_BYTES = 256;
const TIMESTAMP_BYTES = 128;

const UNLOCATED_CATEGORIES: readonly SlackKnownRootUnlocatedCategory[] = [
  "not_slack", "invalid_metadata", "missing_channel_binding", "missing_namespace_pin",
];

/** A plain object — never an array, a class instance or a primitive — or null. */
function plainRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null ? (value as Record<string, unknown>) : null;
}

function hasExactlyKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Reflect.ownKeys(record);
  return own.length === keys.length && keys.every((key) => own.includes(key));
}

const isUuid = (value: unknown): value is string => typeof value === "string" && UUID.test(value);
const isProviderId = (value: unknown): value is string =>
  typeof value === "string" && PROVIDER_ID.test(value) && Buffer.byteLength(value, "utf8") <= PROVIDER_ID_BYTES;
/** A Slack root `ts` the existing exact parser accepts. Its bytes are kept; only the verdict is taken. */
const isRootTimestamp = (value: unknown): value is string =>
  typeof value === "string" && Buffer.byteLength(value, "utf8") <= TIMESTAMP_BYTES && parseSlackTimestamp(value) !== null;
const isConfigRevision = (value: unknown): value is string => typeof value === "string" && CONFIG_REVISION.test(value);
const isRevision = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** UUIDs are captured lower-case: that spelling's text order is PostgreSQL's UUID order. */
function capturedUuid(value: unknown): string {
  return isUuid(value) ? value.toLowerCase() : invalidRequest();
}

function capturedInteger(value: unknown, limits: { readonly min: number; readonly max: number }): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < limits.min || value > limits.max) return invalidRequest();
  return value;
}

/** A caller-supplied team id, validated and copied. Throws only the static validation error. */
export function captureSlackKnownRootTeamId(value: unknown): string {
  return capturedUuid(value);
}

function capturedLocator(value: unknown): SlackKnownRootLocator {
  const locator = plainRecord(value);
  if (locator === null || !hasExactlyKeys(locator, [
    "workspaceId", "channelId", "rootTs", "integrationId", "bindingConfigRevision", "namespaceRevision",
  ])) return invalidRequest();
  const { workspaceId, channelId, rootTs, bindingConfigRevision, namespaceRevision } = locator;
  if (!isProviderId(workspaceId) || !isProviderId(channelId) || !isRootTimestamp(rootTs) ||
      !isConfigRevision(bindingConfigRevision) || !isRevision(namespaceRevision)) return invalidRequest();
  return Object.freeze({
    workspaceId, channelId, rootTs, integrationId: capturedUuid(locator.integrationId), bindingConfigRevision, namespaceRevision,
  });
}

/**
 * One enumerated entry, validated in full and copied into a frozen object of its own. The locator is
 * validated AGAIN here, exactly as if it had never been produced by this module: it is not a
 * capability, and a fabricated one gets no further than a real one would. Throws only the static
 * validation error, and never quotes what it refused.
 */
export function captureSlackKnownRootEntry(value: unknown): SlackKnownRootEntry {
  try {
    const entry = plainRecord(value);
    if (entry === null) return invalidRequest();
    const base = ["teamId", "itemId", "revisitAfterMs"];
    const located = hasExactlyKeys(entry, [...base, "locator"]);
    if (!located && !hasExactlyKeys(entry, [...base, "unlocated"])) return invalidRequest();
    const teamId = capturedUuid(entry.teamId);
    const itemId = capturedUuid(entry.itemId);
    const revisitAfterMs = capturedInteger(entry.revisitAfterMs, SLACK_KNOWN_ROOT_LIMITS.revisitAfterMs);
    if (located) return Object.freeze({ teamId, itemId, revisitAfterMs, locator: capturedLocator(entry.locator) });
    const category = entry.unlocated;
    const unlocated = UNLOCATED_CATEGORIES.find((known) => known === category);
    if (unlocated === undefined) return invalidRequest();
    return Object.freeze({ teamId, itemId, revisitAfterMs, unlocated });
  } catch {
    return invalidRequest();
  }
}

interface CapturedPageRequest {
  readonly teamId: string;
  readonly pageSize: number;
  readonly revisitAfterMs: number;
  readonly cursor: SlackKnownRootCursor | null;
}

function capturedCursor(value: unknown, teamId: string, revisitAfterMs: number): SlackKnownRootCursor {
  const cursor = plainRecord(value);
  if (cursor === null || !hasExactlyKeys(cursor, ["version", "teamId", "upperItemId", "afterItemId", "revisitAfterMs"])) return invalidRequest();
  if (cursor.version !== SLACK_KNOWN_ROOT_CURSOR_VERSION) return invalidRequest();
  const upperItemId = capturedUuid(cursor.upperItemId);
  const afterItemId = capturedUuid(cursor.afterItemId);
  // The cursor continues ONE traversal: the same team, the same policy, and a position inside the
  // key range that traversal froze. The item it names need not exist any more.
  if (capturedUuid(cursor.teamId) !== teamId || cursor.revisitAfterMs !== revisitAfterMs || afterItemId > upperItemId) return invalidRequest();
  return Object.freeze({ version: SLACK_KNOWN_ROOT_CURSOR_VERSION, teamId, upperItemId, afterItemId, revisitAfterMs });
}

function capturedPageRequest(value: unknown): CapturedPageRequest {
  try {
    const request = plainRecord(value);
    if (request === null) return invalidRequest();
    const allowed = ["teamId", "pageSize", "revisitAfterMs", "cursor"];
    if (!Reflect.ownKeys(request).every((key) => typeof key === "string" && allowed.includes(key))) return invalidRequest();
    const teamId = capturedUuid(request.teamId);
    const pageSize = capturedInteger(request.pageSize, SLACK_KNOWN_ROOT_LIMITS.pageSize);
    // There is no runtime default revisit interval: an absent policy is an invalid request.
    const revisitAfterMs = capturedInteger(request.revisitAfterMs, SLACK_KNOWN_ROOT_LIMITS.revisitAfterMs);
    const cursor = request.cursor === undefined ? null : capturedCursor(request.cursor, teamId, revisitAfterMs);
    return { teamId, pageSize, revisitAfterMs, cursor };
  } catch {
    return invalidRequest();
  }
}

// ── the slice-local session (§7.3, §7.4) ─────────────────────────────────────

/** Not a caller-contract failure and not a deadline: something the session or the store did. */
function unexpected(reason: string): never {
  throw new Error(`slack known-root: ${reason}`);
}

const READ_TIMEOUTS_SQL = `
  select name, setting
    from pg_settings
   where name in ('statement_timeout', 'lock_timeout')`;

const APPLY_TIMEOUTS_SQL = `select set_config('statement_timeout', $1, true), set_config('lock_timeout', $2, true)`;

interface TimeoutSettings {
  /** Whole milliseconds, as the server normalizes them. Zero means the limit is disabled. */
  readonly statementMs: number;
  readonly lockMs: number;
}

function parsedTimeout(setting: unknown): number {
  if (typeof setting !== "string" || !DECIMAL.test(setting)) return unexpected("a session timeout setting is unreadable");
  const value = Number(setting);
  return Number.isSafeInteger(value) && value <= MAX_TIMEOUT_MS ? value : unexpected("a session timeout setting is unreadable");
}

async function readTimeouts(original: SqlExecutor): Promise<TimeoutSettings> {
  const { rows } = await original<{ name: unknown; setting: unknown }>(READ_TIMEOUTS_SQL);
  const statement = rows.filter((row) => row.name === "statement_timeout");
  const lock = rows.filter((row) => row.name === "lock_timeout");
  if (rows.length !== 2 || statement.length !== 1 || lock.length !== 1) return unexpected("the session timeout settings are unreadable");
  return { statementMs: parsedTimeout(statement[0].setting), lockMs: parsedTimeout(lock[0].setting) };
}

/** The caller's own connection-bound executor, taken once. A session without one is a broken contract. */
function originalExecutor(session: TransactionSession): SqlExecutor {
  let executor: unknown;
  try {
    executor = (session as { executeSql?: unknown } | null | undefined)?.executeSql;
  } catch {
    return invalidRequest();
  }
  if (typeof executor !== "function") return invalidRequest();
  const bound = executor as (this: unknown, text: string, params?: unknown[]) => Promise<unknown>;
  return ((text: string, params?: unknown[]) => bound.call(session, text, params)) as SqlExecutor;
}

/**
 * Run one operation of this slice on the caller's own transaction session, through a decorated
 * session that is the ONLY thing the operation and its dependencies are handed.
 *
 * Before every data statement the decorator checks the deadline, sets the transaction-local
 * `statement_timeout` to no more than the time that remains (and any stricter original limit),
 * sets `lock_timeout` to no more than 250 ms, the time that remains and any stricter original
 * limit, checks the deadline again, runs the statement, and checks the deadline once more. The
 * settings are recomputed each time, never assumed. Statements are strictly sequential; `db` and
 * `optionalAudit` fail closed; and the decorator stops working the moment the operation ends.
 *
 * On a NORMAL return both original settings are restored on the same connection before this
 * resolves, and a restoration that fails throws. On ANY throw nothing more is sent: after a SQL
 * failure the transaction may already be aborted, a restoring statement would only mask the primary
 * error, and the caller's rollback restores transaction-local settings by itself. The error that was
 * thrown is rethrown as it is. There is no hard cancellation here: a statement already in flight is
 * bounded by the server-side limits above, not by this function.
 */
export async function runSlackKnownRootOperation<T>(
  session: TransactionSession,
  execution: SlackKnownRootExecution,
  operation: (decorated: TransactionSession) => Promise<T>
): Promise<T> {
  // Admission first: an invalid or expired context issues no statement at all.
  admitSlackKnownRootExecution(execution);
  const original = originalExecutor(session);

  const before = await readTimeouts(original);
  admitSlackKnownRootExecution(execution);

  let active = true;
  let running = false;
  const executeSql = (async (text: string, params?: unknown[]) => {
    if (!active) return unexpected("the session is no longer active");
    if (running) return unexpected("a statement is already running on the session");
    running = true;
    try {
      const remainingMs = admitSlackKnownRootExecution(execution);
      const statementMs = before.statementMs === 0 ? remainingMs : Math.min(remainingMs, before.statementMs);
      let lockMs = Math.min(SLACK_KNOWN_ROOT_LIMITS.lockTimeoutMs, remainingMs);
      if (before.lockMs !== 0) lockMs = Math.min(lockMs, before.lockMs);
      if (before.statementMs !== 0) lockMs = Math.min(lockMs, before.statementMs);
      // Timeout control goes to the underlying executor: through the decorator it would recurse.
      await original(APPLY_TIMEOUTS_SQL, [String(statementMs), String(lockMs)]);
      admitSlackKnownRootExecution(execution);
      const result = await original(text, params);
      admitSlackKnownRootExecution(execution);
      return result;
    } finally {
      running = false;
    }
  }) as SqlExecutor;

  const decorated: TransactionSession = Object.freeze({
    get db(): never {
      throw new Error("slack known-root: only statements are available on this session");
    },
    executeSql,
    optionalAudit(): never {
      throw new Error("slack known-root: only statements are available on this session");
    },
  });

  let value: T;
  try {
    value = await operation(decorated);
  } finally {
    // Whatever the outcome, an executor somebody kept is of no further use.
    active = false;
  }
  await original(APPLY_TIMEOUTS_SQL, [String(before.statementMs), String(before.lockMs)]);
  admitSlackKnownRootExecution(execution);
  return value;
}

// ── enumeration (§4.2, §4.3) ─────────────────────────────────────────────────

// `order by … limit 1`, never `max(uuid)`.
const UPPER_ITEM_SQL = `
  select id::text as id
    from items
   where team_id = $1::uuid
   order by id desc
   limit 1`;

// Exact team, the fixed upper bound, PostgreSQL UUID order, no OFFSET. Two texts, not one with an
// optional predicate, so each has a plain range on (team_id, id).
const FIRST_ITEM_IDS_SQL = `
  select id::text as id
    from items
   where team_id = $1::uuid and id <= $2::uuid
   order by id
   limit $3`;

const NEXT_ITEM_IDS_SQL = `
  select id::text as id
    from items
   where team_id = $1::uuid and id > $2::uuid and id <= $3::uuid
   order by id
   limit $4`;

// Bounded scalar locator metadata for the selected ids ONLY. Every frontmatter value is projected
// through its JSON type and its byte length, so a value of another type, or an oversized one, comes
// back NULL and is never truncated into an accepted identity. No body, no whole frontmatter object,
// no ledger. The channel row and the gate row are each unique for the key they are joined on.
const LOCATOR_SQL = `
  select i.id::text as id,
         m.is_slack,
         m.workspace_id,
         m.channel_id,
         m.root_ts,
         c.binding_integration_id::text as binding_integration_id,
         c.binding_config_revision,
         g.revision::text as namespace_revision
    from unnest($2::uuid[]) as wanted(id)
    join items i on i.team_id = $1::uuid and i.id = wanted.id
   cross join lateral (
         select (jsonb_typeof(i.frontmatter->'source') = 'string' and i.frontmatter->>'source' = 'slack') as is_slack,
                case when jsonb_typeof(i.frontmatter->'workspace_id') = 'string'
                      and octet_length(i.frontmatter->>'workspace_id') <= ${PROVIDER_ID_BYTES}
                     then i.frontmatter->>'workspace_id' end as workspace_id,
                case when jsonb_typeof(i.frontmatter->'channel_id') = 'string'
                      and octet_length(i.frontmatter->>'channel_id') <= ${PROVIDER_ID_BYTES}
                     then i.frontmatter->>'channel_id' end as channel_id,
                case when jsonb_typeof(i.frontmatter->'ts') = 'string'
                      and octet_length(i.frontmatter->>'ts') <= ${TIMESTAMP_BYTES}
                     then i.frontmatter->>'ts' end as root_ts
         ) m
    left join slack_sync_channels c
           on c.team_id = i.team_id and c.workspace_id = m.workspace_id and c.channel_id = m.channel_id
    left join slack_channel_migration_gates g
           on g.team_id = i.team_id and g.raw_channel_id = m.channel_id`;

interface LocatorRow {
  id: unknown;
  is_slack: unknown;
  workspace_id: unknown;
  channel_id: unknown;
  root_ts: unknown;
  binding_integration_id: unknown;
  binding_config_revision: unknown;
  namespace_revision: unknown;
}

/** A stored gate revision: decimal text, parsed losslessly, or null. */
function storedRevision(value: unknown): number | null {
  if (typeof value !== "string" || !DECIMAL.test(value)) return null;
  const revision = Number(value);
  return Number.isSafeInteger(revision) ? revision : null;
}

/**
 * One examined item as an entry: a complete, validated locator, or the ONE closed category that
 * says why it has none. An item that vanished between the id read and this one has no stored
 * metadata to call Slack's, and is reported as `not_slack` for this observation.
 */
function entryOf(base: { teamId: string; itemId: string; revisitAfterMs: number }, row: LocatorRow | undefined): SlackKnownRootEntry {
  const unlocated = (category: SlackKnownRootUnlocatedCategory): SlackKnownRootEntry => Object.freeze({ ...base, unlocated: category });
  if (row === undefined || row.is_slack !== true) return unlocated("not_slack");
  const { workspace_id: workspaceId, channel_id: channelId, root_ts: rootTs } = row;
  if (!isProviderId(workspaceId) || !isProviderId(channelId) || !isRootTimestamp(rootTs)) return unlocated("invalid_metadata");
  const integrationId = row.binding_integration_id;
  const bindingConfigRevision = row.binding_config_revision;
  if (!isUuid(integrationId) || !isConfigRevision(bindingConfigRevision)) return unlocated("missing_channel_binding");
  const namespaceRevision = storedRevision(row.namespace_revision);
  if (namespaceRevision === null) return unlocated("missing_namespace_pin");
  return Object.freeze({
    ...base,
    locator: Object.freeze({
      workspaceId, channelId, rootTs, integrationId: integrationId.toLowerCase(), bindingConfigRevision, namespaceRevision,
    }),
  });
}

/** The greatest value of the UUID order: the range check of a read that has no upper bound of its own. */
const GREATEST_UUID = "ffffffff-ffff-ffff-ffff-ffffffffffff";

/** Item ids exactly as one bounded read must return them: UUIDs, strictly ascending, inside the range. */
function itemIds(rows: readonly { id: unknown }[], after: string | null, upper: string, limit: number): string[] {
  if (rows.length > limit) return unexpected("an item id read returned more than it was limited to");
  const ids: string[] = [];
  let previous = after;
  for (const row of rows) {
    if (!isUuid(row.id)) return unexpected("an item id read returned an unreadable id");
    const id = row.id.toLowerCase();
    if ((previous !== null && id <= previous) || id > upper) return unexpected("an item id read returned an id outside its range");
    ids.push(id);
    previous = id;
  }
  return ids;
}

/**
 * One bounded page of a team's item ids in UUID order, each with its durable Slack locator or the
 * closed reason it has none.
 *
 * The first page freezes a KEY RANGE — the team's greatest item id at that moment — and every
 * continuation stays inside it. At most `pageSize + 1` ids are read; the extra one is lookahead only
 * and is neither examined nor returned. Exactly one entry comes back per examined id, whatever the
 * item turned out to be: classification never decides which ids enter the page, and nothing searches
 * forward for "enough" Slack roots. The next page continues after the last examined id.
 *
 * The request and the execution context are validated before the session is used at all, and the
 * returned page, its entries and its cursor are frozen objects that share nothing with the request.
 */
export async function readSlackKnownRootItemPage(
  session: TransactionSession,
  request: SlackKnownRootPageRequest,
  execution: SlackKnownRootExecution
): Promise<SlackKnownRootItemPage> {
  // Everything caller-controlled is validated and copied before the first await.
  const { teamId, pageSize, revisitAfterMs, cursor } = capturedPageRequest(request);
  admitSlackKnownRootExecution(execution);

  return runSlackKnownRootOperation<SlackKnownRootItemPage>(session, execution, async (decorated): Promise<SlackKnownRootItemPage> => {
    let upperItemId: string;
    if (cursor !== null) {
      upperItemId = cursor.upperItemId;
    } else {
      const upper = await decorated.executeSql<{ id: unknown }>(UPPER_ITEM_SQL, [teamId]);
      if (upper.rows.length === 0) {
        // An empty team: nothing to bound, and no sentinel id is invented.
        return Object.freeze({ entries: Object.freeze([]), nextCursor: null, exhausted: true, examined: 0 });
      }
      const [greatest] = itemIds(upper.rows, null, GREATEST_UUID, 1);
      if (greatest === undefined) return unexpected("an item id read returned no id");
      upperItemId = greatest;
    }

    const afterItemId = cursor === null ? null : cursor.afterItemId;
    const read = afterItemId === null
      ? await decorated.executeSql<{ id: unknown }>(FIRST_ITEM_IDS_SQL, [teamId, upperItemId, pageSize + 1])
      : await decorated.executeSql<{ id: unknown }>(NEXT_ITEM_IDS_SQL, [teamId, afterItemId, upperItemId, pageSize + 1]);
    const found = itemIds(read.rows, afterItemId, upperItemId, pageSize + 1);
    const examinedIds = found.slice(0, pageSize);
    const more = found.length > pageSize;

    const located = new Map<string, LocatorRow>();
    if (examinedIds.length > 0) {
      const enriched = await decorated.executeSql<LocatorRow>(LOCATOR_SQL, [teamId, examinedIds]);
      for (const row of enriched.rows) {
        const id = isUuid(row.id) ? row.id.toLowerCase() : null;
        if (id === null || !examinedIds.includes(id) || located.has(id)) return unexpected("a locator read returned an unexpected row");
        located.set(id, row);
      }
    }

    const entries = examinedIds.map((itemId) => entryOf({ teamId, itemId, revisitAfterMs }, located.get(itemId)));
    const nextCursor: SlackKnownRootCursor | null = more
      ? Object.freeze({
          version: SLACK_KNOWN_ROOT_CURSOR_VERSION, teamId, upperItemId,
          afterItemId: examinedIds[examinedIds.length - 1], revisitAfterMs,
        })
      : null;
    return Object.freeze({ entries: Object.freeze(entries), nextCursor, exhausted: !more, examined: examinedIds.length });
  });
}
