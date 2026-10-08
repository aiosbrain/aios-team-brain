import "server-only";

import type { PoolClient } from "pg";

import type { ContentAdmission } from "@/lib/access/admission";
import { visibleItemIdsForProjects } from "@/lib/access/enforce";
import type { AuthorizedSlackCreditItem } from "@/lib/attribution/slack-credit-batch";
import {
  SLACK_TIMELINE_PAGE_SIZE,
  SLACK_TIMELINE_WINDOW_DAYS,
  SlackTimelineError,
  assertComposedSlackDays,
  assertSlackTimelineBinding,
  assertSlackTimelineBindingUnchanged,
  assertSlackTimelineCursorFresh,
  assertSlackTimelineCursorRequest,
  canonicalSlackTimelineJson,
  compactSlackAggregate,
  compareSlackAggregateTuples,
  decodeSlackTimelineCursor,
  deriveSlackTimelineViewKey,
  encodeSlackTimelineCursor,
  isSlackTimelineError,
  mergeSlackTimelineDays,
  slackAggregateTuple,
  slackItemFingerprint,
  slackTimelineDigest,
  slackTimelineWindow,
  type SlackAggregate,
  type SlackAggregateTuple,
  type SlackTimelineBinding,
  type SlackTimelineCursorPayload,
  type SlackTimelinePage,
  type SlackTimelineWindow,
} from "@/lib/dashboard/slack-timeline-page-contract";
import type { TimelineDay } from "@/lib/dashboard/timeline-group";
import { PgClient } from "@/lib/db/pg/client";
import { getPool } from "@/lib/db/pg/pool";
import type { SqlExecutor } from "@/lib/db/types";
import { lookupSlackAccount, type SlackAccountMapping } from "@/lib/identity/resolve";
import { readSlackCreditInputSnapshotInSession } from "./slack-credit-input-snapshot";
import { composeSlackEvidence } from "./slack-evidence-adapter";
import { SLACK_CREDIT_READ_PAGE_SIZE, readSlackItemCreditLedgerInSession } from "./slack-item-credit-ledger-read";
import type { SlackTeamGenerations } from "./slack-message-ledger";
import { readVisibleSlackMessagesInSession } from "./slack-message-read";
import { projectSlackPersonDays } from "./slack-person-day";

/**
 * AIO-1170 AC-09 — the INACTIVE, read-only aggregate Slack page reader.
 *
 * A page is cut from COMPLETED `(item, member, UTC day)` groups, in the fixed order
 * `day DESC, at DESC, item ASC, member ASC`, and never from a capped set of items. Each page:
 *
 *  1. reads everything — admission, the packet's own correction owner/lock rows, the complete
 *     identity mappings and human roster, generations, provenance, presentation and messages —
 *     through ONE fresh `REPEATABLE READ, READ ONLY` evidence transaction;
 *  2. validates provenance over the whole authorized Slack set before any candidate is limited;
 *  3. keyset-pages SQL candidate groups, and requires them to equal the shared projector's groups
 *     in BOTH directions for every loaded item before the shared credit oracle filters them;
 *  4. recomputes every binding in a second, fresh validation transaction and compares, so evidence
 *     is never published under a newer stamp;
 *  5. returns the whole page or throws exactly one of the contract's four failures.
 *
 * It makes no authorization decision of its own beyond calling the real item-visibility oracle on
 * the transaction it is given, performs no write, and is imported by nothing in the application
 * (`test/guards/slack-aggregate-pagination-not-wired.test.ts`). Source admission, provenance proofs,
 * presentation and composition are trusted server-only dependencies: production adapters for them
 * are a later, separately reviewed integration gate.
 */

export const SLACK_PERSON_DAY_PAGE_BUDGETS = Object.freeze({
  /** Candidate groups fetched by one internal SQL query. */
  candidateFetchSize: 512,
  /** Candidate groups examined for one page, rejected and lookahead groups included. */
  maxCandidates: 100_000,
  /** Result rows across every dependency, read and validation query of one page, rereads included. */
  maxRows: 2_000_000,
  /** Cumulative UTF-8 JSON bytes of those rows and bundles. */
  maxReadBytes: 128 * 1024 * 1024,
  /** UTF-8 JSON bytes of the complete serialized page. */
  maxPageBytes: 4 * 1024 * 1024,
  /** Monotonic time for one page, validation included. */
  maxElapsedMs: 30_000,
});

export type SlackPersonDayPageBudgets = { -readonly [K in keyof typeof SLACK_PERSON_DAY_PAGE_BUDGETS]: number };

export interface SlackPagePrincipal {
  teamId: string;
  memberId: string;
}

export interface SlackPageRequestedView {
  mode: string;
  filters: Record<string, unknown>;
  locale: string;
  presentationPolicyVersion: string;
}

export interface SlackPersonDayPageRequest {
  teamId: string;
  principal: SlackPagePrincipal;
  requestedView: SlackPageRequestedView;
  windowDays: number;
  /** 1–512, default 128. A page size, not a corpus cap. */
  pageSize?: number;
  /** The opaque continuation of a previous page, or null for a first page. */
  cursor?: string | null;
}

export type SlackItemProvenance =
  | { status: "verified"; workspaceId: string; channelId: string; rootTs: string; workspaceUrl: string | null }
  | { status: "unverified" };

export interface SlackAdmissionResult {
  teamId: string;
  /** Canonical, stable identity of the principal. */
  principalKey: string;
  admission: ContentAdmission;
  /** Canonical description of the principal's current admission (role, grants, eligibility). */
  admissionBinding: unknown;
  /** Exactly the currently authorized, source-admitted, same-team Slack items. */
  slackItems: readonly { itemId: string; provenance: SlackItemProvenance }[];
  /** Canonical description of the source-admission decisions and proofs for those items. */
  sourceAdmissionBinding: unknown;
}

/** Handed to every opaque loader: its work must stop when the signal aborts. */
export interface SlackPageLoaderContext {
  signal: AbortSignal;
}

export interface SlackPersonDayPageDependencies {
  /** Server-only 32-byte cursor key. Injected; never read from configuration by this module. */
  slackTimelineCursorKey: Uint8Array;
  /** Wall clock: fixes `asOf` on a first page and judges expiry. */
  now: () => Date;
  /** Monotonic milliseconds: judges elapsed budgets independently of the wall clock. */
  monotonicNow: () => number;
  loadAdmission: (
    query: SqlExecutor,
    input: { teamId: string; principal: SlackPagePrincipal; requestedView: SlackPageRequestedView } & SlackPageLoaderContext
  ) => Promise<SlackAdmissionResult>;
  /** The complete, immutable, JSON-safe presentation bundle for ALL authorized Slack items. */
  loadPresentation: (
    query: SqlExecutor,
    input: {
      teamId: string; principal: SlackPagePrincipal; admission: ContentAdmission;
      slackItems: readonly { itemId: string; provenance: SlackItemProvenance }[];
      asOf: string; windowDays: number; viewKey: string;
    } & SlackPageLoaderContext
  ) => Promise<unknown>;
  /** Pure and synchronous: no clock, database, authorization call or mutation. */
  composeSlackPage: (input: {
    aggregates: readonly SlackAggregate[]; presentation: unknown; asOf: string; windowDays: number;
  }) => TimelineDay[];
  /** First page only: the frozen non-Slack days and the exact set of source items they depend on. */
  loadInitialNonSlack: (
    query: SqlExecutor,
    input: {
      teamId: string; principal: SlackPagePrincipal; admission: ContentAdmission;
      viewKey: string; asOf: string; windowDays: number;
    } & SlackPageLoaderContext
  ) => Promise<{ days: TimelineDay[]; sourceItemIds: readonly string[] }>;
  budgets?: Partial<SlackPersonDayPageBudgets>;
  /** Arms the page deadline and returns its cancel function. Default: the platform timer. */
  scheduleDeadline?: (callback: () => void, delayMs: number) => () => void;
}

/** One SQL candidate group, as the corruption seam sees it. */
export interface SlackCandidateGroupRow {
  itemId: string;
  memberId: string;
  day: string;
  at: string;
  messageCount: number;
  rootAuthored: boolean;
}

/** One resolved account of the SQL join's `(workspace, user, member)` relation. */
export interface SlackAccountRelationRow {
  workspaceId: string;
  userId: string;
  memberId: string;
}

/**
 * Server-only TEST seams. None is reachable by a client, none can widen authorization, and the
 * read-only transaction is enforced by the database whatever a seam attempts.
 */
export interface SlackPersonDayPageOptions {
  /** After the evidence transaction is configured, before its first read (e.g. a session time zone). */
  afterTransactionConfigured?: (query: SqlExecutor) => Promise<void>;
  /** Between candidate discovery and the shared projection, on the evidence transaction. */
  afterDiscovery?: (query: SqlExecutor) => Promise<void>;
  /** Between the evidence transaction and the validation transaction. */
  afterEvidence?: () => Promise<void>;
  /** Corrupt one internal batch of SQL candidate groups. */
  corruptCandidates?: (rows: SlackCandidateGroupRow[]) => SlackCandidateGroupRow[];
  /** Corrupt the resolved account relation the SQL join uses. */
  corruptAccountRelation?: (relation: SlackAccountRelationRow[]) => SlackAccountRelationRow[];
  /** Page size of the internal ledger and message reads (1–512). */
  messagePageSize?: number;
  /** An outer deadline (a drain's): aborting it ends the page as its own deadline would. */
  signal?: AbortSignal;
}

// ── small predicates ─────────────────────────────────────────────────────────

const ANY_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOWER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CANONICAL_ACCOUNT = /^([A-Z0-9]+):([A-Z0-9]+)$/;
const MICRO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const LIBRARY_LINK = /^\/library\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[/?#].*)?$/i;
const IDENTITY_BYTES = 256;
const ID_BATCH = 500;
/** A floor on the internal fetch, so a long rejected run is not scanned one group per query. */
const FETCH_FLOOR = 64;
const QUERY_CANCELED = "57014";
/**
 * The largest delay a Node timer honours and the largest `statement_timeout` PostgreSQL accepts
 * (a signed 32-bit count of milliseconds). One more and the timer fires after a single millisecond.
 */
const MAX_TIMER_MS = 2_147_483_647;

/**
 * A duration as the whole number of milliseconds a timer or a `statement_timeout` is given: never
 * below 1 (0 means "no timeout" to the server, and "now" to a timer) and never above the maximum
 * either accepts. Every deadline delay and every statement timeout of a page is derived HERE, so a
 * monotonic clock that steps back — leaving more than the budget "remaining" — cannot produce a
 * value the platform or the server refuses.
 */
function timerMs(durationMs: number): number {
  return Math.min(MAX_TIMER_MS, Math.max(1, Math.ceil(durationMs)));
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const nonempty = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const identity = (value: unknown): value is string => nonempty(value) && Buffer.byteLength(value, "utf8") <= IDENTITY_BYTES;

function invalidRequest(reason: string): never {
  throw new SlackTimelineError("invalid_request", reason);
}
function unavailable(reason: string): never {
  throw new SlackTimelineError("unavailable", reason);
}
function restart(reason: string): never {
  throw new SlackTimelineError("restart_required", reason);
}

function platformTimer(callback: () => void, delayMs: number): () => void {
  const handle = setTimeout(callback, delayMs);
  return () => clearTimeout(handle);
}

function chunks<T>(values: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < values.length; index += size) out.push(values.slice(index, index + size));
  return out;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const entry of Object.values(value as Record<string, unknown>)) deepFreeze(entry);
  }
  return value;
}

// ── request and dependency validation (synchronous: before the first await) ──

interface ValidRequest {
  teamId: string;
  principal: SlackPagePrincipal;
  requestedView: SlackPageRequestedView;
  windowDays: number;
  pageSize: number;
  cursor: string | null;
}

function validRequest(request: SlackPersonDayPageRequest): ValidRequest {
  const r = request as unknown;
  if (!isRecord(r) || typeof r.teamId !== "string" || !ANY_UUID.test(r.teamId)) return invalidRequest("invalid team");
  const teamId = r.teamId.toLowerCase();
  const principal = r.principal;
  if (!isRecord(principal) || typeof principal.teamId !== "string" || typeof principal.memberId !== "string" ||
      !ANY_UUID.test(principal.memberId) || principal.teamId.toLowerCase() !== teamId) return invalidRequest("invalid principal");
  const view = r.requestedView;
  if (!isRecord(view) || !nonempty(view.mode) || !isRecord(view.filters) || !nonempty(view.locale) ||
      !nonempty(view.presentationPolicyVersion)) return invalidRequest("invalid view");
  if (typeof r.windowDays !== "number" || !SLACK_TIMELINE_WINDOW_DAYS.includes(r.windowDays)) return invalidRequest("unsupported window");
  const pageSize = r.pageSize === undefined ? SLACK_TIMELINE_PAGE_SIZE.default : r.pageSize;
  if (typeof pageSize !== "number" || !Number.isSafeInteger(pageSize) || pageSize < SLACK_TIMELINE_PAGE_SIZE.min ||
      pageSize > SLACK_TIMELINE_PAGE_SIZE.max) return invalidRequest("unsupported page size");
  const cursor = r.cursor === undefined || r.cursor === null ? null : r.cursor;
  if (cursor !== null && typeof cursor !== "string") return invalidRequest("cursor is malformed or cannot be verified");
  // The filters are the one caller-owned object graph of the request. They are validated as
  // JSON-safe and copied HERE, synchronously: a filter the view key cannot bind is refused before
  // any database work, and a caller mutating its object later cannot change the view between the
  // evidence and validation snapshots of one page.
  let filters: Record<string, unknown>;
  try {
    filters = deepFreeze(JSON.parse(canonicalSlackTimelineJson(view.filters)) as Record<string, unknown>);
  } catch {
    return invalidRequest("invalid view");
  }
  return {
    teamId,
    principal: { teamId, memberId: principal.memberId.toLowerCase() },
    requestedView: Object.freeze({
      mode: view.mode, filters, locale: view.locale, presentationPolicyVersion: view.presentationPolicyVersion,
    }),
    windowDays: r.windowDays,
    pageSize,
    cursor,
  };
}

interface ValidDependencies {
  key: Uint8Array;
  now: () => Date;
  monotonicNow: () => number;
  loadAdmission: SlackPersonDayPageDependencies["loadAdmission"];
  loadPresentation: SlackPersonDayPageDependencies["loadPresentation"];
  composeSlackPage: SlackPersonDayPageDependencies["composeSlackPage"];
  loadInitialNonSlack: SlackPersonDayPageDependencies["loadInitialNonSlack"];
  budgets: SlackPersonDayPageBudgets;
  scheduleDeadline: (callback: () => void, delayMs: number) => () => void;
}

function validDependencies(dependencies: SlackPersonDayPageDependencies): ValidDependencies {
  const d = dependencies as unknown;
  if (!isRecord(d)) return unavailable("page dependencies are missing");
  for (const name of ["now", "monotonicNow", "loadAdmission", "loadPresentation", "composeSlackPage", "loadInitialNonSlack"]) {
    if (typeof d[name] !== "function") return unavailable("page dependencies are missing");
  }
  const callerKey = d.slackTimelineCursorKey;
  if (!(callerKey instanceof Uint8Array) || callerKey.byteLength !== 32) return unavailable("cursor key is not configured");
  // Copied HERE, synchronously, into storage of its own: the caller may overwrite or zeroise its
  // buffer while a dependency is suspended, and the page must still open and seal cursors with the
  // key it was given. `new Uint8Array(typedArray)` copies the bytes; it never shares a Buffer slice.
  const key = new Uint8Array(callerKey);
  const scheduleDeadline = d.scheduleDeadline === undefined ? platformTimer : d.scheduleDeadline;
  if (typeof scheduleDeadline !== "function") return unavailable("deadline scheduler is misconfigured");

  const overrides = d.budgets;
  if (overrides !== undefined && !isRecord(overrides)) return unavailable("page budgets are misconfigured");
  const budgets: SlackPersonDayPageBudgets = { ...SLACK_PERSON_DAY_PAGE_BUDGETS };
  for (const name of Object.keys(SLACK_PERSON_DAY_PAGE_BUDGETS) as (keyof SlackPersonDayPageBudgets)[]) {
    const value = overrides?.[name];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) return unavailable("page budgets are misconfigured");
    budgets[name] = value;
  }
  if (budgets.candidateFetchSize > SLACK_PERSON_DAY_PAGE_BUDGETS.candidateFetchSize) return unavailable("page budgets are misconfigured");
  // Refused HERE, as configuration: a longer budget is neither a deadline nor a statement timeout.
  if (budgets.maxElapsedMs > MAX_TIMER_MS) return unavailable("page budgets are misconfigured");

  return {
    key,
    now: dependencies.now,
    monotonicNow: dependencies.monotonicNow,
    loadAdmission: dependencies.loadAdmission,
    loadPresentation: dependencies.loadPresentation,
    composeSlackPage: dependencies.composeSlackPage,
    loadInitialNonSlack: dependencies.loadInitialNonSlack,
    budgets,
    scheduleDeadline: scheduleDeadline as ValidDependencies["scheduleDeadline"],
  };
}

function internalPageSize(options: SlackPersonDayPageOptions): number {
  const size = options.messagePageSize === undefined ? SLACK_CREDIT_READ_PAGE_SIZE : options.messagePageSize;
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 1 || size > SLACK_CREDIT_READ_PAGE_SIZE) {
    return unavailable("internal page size is misconfigured");
  }
  return size;
}

/**
 * The outer signal a caller supplied, or none. It is runtime input: anything but an actual
 * `AbortSignal` — a controller, a deserialized look-alike with the two listener methods — is
 * refused here, before a deadline is armed, a listener attached or a connection asked for.
 */
function outerSignal(value: unknown): AbortSignal | undefined {
  if (value === undefined) return undefined;
  const refuse = (): never => unavailable("outer signal is not an AbortSignal");
  if (typeof AbortSignal !== "function" || !(value instanceof AbortSignal)) return refuse();
  // `instanceof` only walks a prototype chain, and any object can be given this one. The platform's
  // own `aborted` getter checks the BRAND: called on a forgery it throws, and called on a real
  // signal it only reports a boolean — it never throws the signal's abort reason. It is taken from
  // the prototype, so a property the value defines for itself cannot answer in its place.
  const brand = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")?.get;
  if (typeof brand !== "function") return refuse();
  try {
    brand.call(value);
  } catch {
    return refuse();
  }
  return value;
}

// ── one page's budgets, deadline and abort ───────────────────────────────────

/**
 * The shared budget state of one page (or one final validation). Every wait — an opaque loader, a
 * pool checkout, a single driver statement — is raced against a single deadline; when it fires, the
 * signal handed to the loaders is aborted, every registered canceller runs (a snapshot transaction
 * destroys its connection there) and the pending wait rejects at once, without waiting for the
 * abandoned work. The first budget failure observed is remembered: a dependency that swallows it
 * (the access adapter returns an error envelope) cannot turn it into a different outcome, or into a
 * result. A failed clock is remembered the same way.
 */
class PageRun {
  readonly signal: AbortSignal;
  candidates = 0;
  private readonly controller = new AbortController();
  private readonly startedAt: number;
  private readonly deadline: Promise<never>;
  private readonly cancelDeadline: () => void;
  private readonly detach: () => void;
  private readonly cancellers = new Set<() => void>();
  private rejectDeadline: (error: SlackTimelineError) => void = () => undefined;
  private finished = false;
  private expired = false;
  private budgetFailure: SlackTimelineError | null = null;
  private clockFailure: SlackTimelineError | null = null;
  private rows = 0;
  private bytes = 0;

  constructor(private readonly deps: ValidDependencies, outer: AbortSignal | undefined) {
    this.signal = this.controller.signal;
    this.startedAt = this.clock();
    this.deadline = new Promise<never>((_resolve, reject) => { this.rejectDeadline = reject; });
    this.deadline.catch(() => undefined);

    const expire = (): void => {
      if (this.finished) return; // a deadline that fires after the page settled is inert
      this.finished = true;
      this.expired = true;
      const failure = this.exhausted("page exceeded its elapsed budget while work was pending");
      this.controller.abort();
      for (const cancel of [...this.cancellers]) {
        try {
          cancel();
        } catch {
          // A canceller disposes of a connection; nothing it throws may keep the deadline from ending the page.
        }
      }
      this.rejectDeadline(failure);
    };
    let cancel: unknown;
    try {
      cancel = deps.scheduleDeadline(expire, timerMs(deps.budgets.maxElapsedMs));
    } catch {
      cancel = undefined;
    }
    if (typeof cancel !== "function") {
      this.finished = true;
      unavailable("deadline scheduler is misconfigured");
    }
    this.cancelDeadline = cancel as () => void;
    if (outer) {
      if (outer.aborted) expire();
      else outer.addEventListener("abort", expire, { once: true });
    }
    this.detach = () => outer?.removeEventListener("abort", expire);
  }

  /**
   * One monotonic reading. A clock that throws or misreports is a failed dependency, never a raw
   * error — and it stays failed: a dependency that swallowed the failure cannot continue the page.
   */
  private clock(): number {
    if (this.clockFailure) throw this.clockFailure;
    let value: unknown;
    let reason: string | null = null;
    try {
      value = this.deps.monotonicNow();
    } catch {
      reason = "monotonic clock failed";
    }
    if (reason === null && (typeof value !== "number" || !Number.isFinite(value))) reason = "monotonic clock is misconfigured";
    if (reason !== null) {
      this.clockFailure = new SlackTimelineError("unavailable", reason);
      throw this.clockFailure;
    }
    return value as number;
  }

  /** A budget failure carrying counters only. The first one observed is the one reported. */
  exhausted(reason: string): SlackTimelineError {
    this.budgetFailure ??= new SlackTimelineError("budget_exhausted", reason, {
      candidatesExamined: this.candidates, rowsRead: this.rows, bytesRead: this.bytes,
    });
    return this.budgetFailure;
  }

  get observedBudgetFailure(): SlackTimelineError | null {
    return this.budgetFailure;
  }

  /** Milliseconds of budget left, after one clock reading. Throws when the budget is spent. */
  remaining(): number {
    if (this.clockFailure) throw this.clockFailure;
    if (this.budgetFailure) throw this.budgetFailure;
    const elapsed = this.clock() - this.startedAt;
    if (elapsed > this.deps.budgets.maxElapsedMs) throw this.exhausted("page exceeded its elapsed budget");
    return this.deps.budgets.maxElapsedMs - elapsed;
  }

  /** Stop promptly: an already observed budget failure, or an elapsed budget that has run out. */
  check(): void {
    this.remaining();
  }

  /**
   * True while the deadline has neither fired nor been passed on the clock — whatever ELSE has
   * failed. It is what a rollback asks: a page refused for its rows still has time to end its
   * transaction properly; a page whose time is gone does not. Never throws, records no failure.
   */
  hasTime(): boolean {
    if (this.expired) return false;
    try {
      return this.clock() - this.startedAt <= this.deps.budgets.maxElapsedMs;
    } catch {
      return false;
    }
  }

  /** True once the deadline fired or the outer signal aborted. It never becomes false again. */
  get cancelled(): boolean {
    return this.expired;
  }

  /**
   * Register work to cancel when the deadline fires or the outer signal aborts. The canceller runs
   * synchronously inside that event, before the pending wait is rejected; at once when the page is
   * already cancelled. Returns the function that withdraws it.
   */
  onCancel(cancel: () => void): () => void {
    if (this.expired) {
      cancel();
      return () => undefined;
    }
    this.cancellers.add(cancel);
    return () => { this.cancellers.delete(cancel); };
  }

  /**
   * The rows of ONE materialized driver result: their number, and the UTF-8 length of their JSON.
   * (Object keys sorted or not, the length is the same, so this is the canonical length too.) A
   * result with no rows materialized nothing. One that cannot be measured cannot be admitted.
   */
  meterRows(rows: readonly unknown[]): void {
    if (rows.length === 0) return;
    let bytes: number;
    try {
      bytes = Buffer.byteLength(JSON.stringify(rows), "utf8");
    } catch {
      return unavailable("a result could not be measured");
    }
    this.rows += rows.length;
    this.meterBytes(bytes);
    if (this.rows > this.deps.budgets.maxRows) throw this.exhausted("page exceeded its row budget");
  }

  meterBytes(bytes: number): void {
    this.bytes += bytes;
    if (this.bytes > this.deps.budgets.maxReadBytes) throw this.exhausted("page exceeded its read-byte budget");
  }

  /** Await opaque work under the deadline. The abandoned work's later outcome is ignored. */
  async race<T>(work: () => T | Promise<T>): Promise<T> {
    this.check();
    const pending = Promise.resolve().then(work);
    pending.catch(() => undefined);
    const result = await Promise.race([pending, this.deadline]);
    this.check();
    return result;
  }

  /**
   * Await work that has ALREADY started — a pool checkout, one driver statement — under the
   * deadline, and nothing else: no clock is read here. The caller keeps the promise, and so keeps
   * knowing when the work itself settles after a deadline has ended the wait for it.
   */
  untilDeadline<T>(pending: Promise<T>): Promise<T> {
    return Promise.race([pending, this.deadline]);
  }

  /** Cancel the deadline and drop the outer listener. Idempotent; called on every terminal path. */
  finish(): void {
    this.finished = true;
    this.cancelDeadline();
    this.detach();
  }

  /** Whatever was thrown, as exactly one of the four failures. */
  classify(error: unknown): SlackTimelineError {
    if (isSlackTimelineError(error)) return error;
    if (this.clockFailure) return this.clockFailure;
    if (this.budgetFailure) return this.budgetFailure;
    if (isRecord(error) && error.code === QUERY_CANCELED) return this.exhausted("a statement exceeded the remaining runtime");
    return new SlackTimelineError("unavailable", "a read or dependency failed");
  }
}

interface Snapshot {
  query: SqlExecutor;
  /** Re-apply the transaction-local statement timeout from the CURRENT remaining budget. */
  refreshTimeout: () => Promise<void>;
}

/**
 * One fresh `REPEATABLE READ, READ ONLY` transaction on its own pooled connection, demonstrably
 * configured before any read. Its executor re-derives the transaction-local `statement_timeout`
 * from the remaining budget before EVERY statement (never 0, which the server reads as "no
 * timeout"), and refuses to run once the transaction has ended. Every row the driver returns on
 * that connection — for the transaction's own control statements too — is metered.
 */
function inSnapshot<T>(run: PageRun, body: (snapshot: Snapshot) => Promise<T>): Promise<T> {
  return new SnapshotTransaction(run).execute(body);
}

/** The rows one driver result materialized. A control statement's result has none. */
const rowsOf = (result: unknown): unknown[] => (isRecord(result) && Array.isArray(result.rows) ? result.rows : []);

/**
 * Give a pooled client back so that the pool DISCARDS it: pg-pool removes a client released with an
 * error, and pg destroys the socket of one that is mid-statement instead of waiting for it. This is
 * the only way a session of unknown state leaves this module.
 */
function discard(client: PoolClient, reason: string): void {
  try {
    client.release(new Error(`slack page snapshot: ${reason}`));
  } catch {
    // Already released: the pool has it, and there is nothing further to do from here.
  }
}

/**
 * The packet's own owner of one snapshot transaction: checkout, BEGIN, configuration, every
 * statement, COMMIT or ROLLBACK, and the fate of the connection. It exists because the page deadline
 * has to reach all of those, and a race around a transaction helper reaches none of them: the helper
 * would still wake up on a late connection and run a transaction for a page that no longer exists.
 *
 *  - Cancellation is registered before the checkout, and only the checkout is raced. A client the
 *    pool hands over after the page ended is discarded on the spot, with no statement sent on it.
 *  - Every statement the driver is ever given goes through `send`, and nowhere else.
 *  - The driver's own promise is tracked until IT settles. When the deadline fires, or the outer
 *    signal aborts, the connection is discarded there and then: nothing is queued behind a running
 *    statement, and a session that may be mid-statement is never returned for reuse.
 *  - A session goes back to the pool reusable only after the server ANSWERED its COMMIT or ROLLBACK.
 */
class SnapshotTransaction {
  private client: PoolClient | null = null;
  private phase: "setup" | "open" | "ended" = "setup";
  /** The client has left this transaction's hands, reusable or discarded. Set once. */
  private handedBack = false;
  /** Driver statements dispatched and not yet settled — whatever became of whoever awaited them. */
  private outstanding = 0;
  private applied = -1;

  constructor(private readonly run: PageRun) {}

  async execute<T>(body: (snapshot: Snapshot) => Promise<T>): Promise<T> {
    // BEFORE the checkout: from here a deadline finds this transaction, whatever it is waiting for.
    const withdraw = this.run.onCancel(() => this.destroy("its page was cancelled"));
    try {
      await this.checkout();
      let value: T;
      try {
        await this.configure();
        this.phase = "open";
        value = await body({ query: this.query, refreshTimeout: () => this.refreshTimeout() });
        // A dependency that resolved with a statement of its own still running has not finished its
        // read: that result was never metered, and COMMIT may not be queued behind it.
        if (this.outstanding > 0) unavailable("a statement was still running when the snapshot's work ended");
      } catch (error) {
        await this.endFailed();
        throw error;
      }
      await this.commit();
      return value;
    } finally {
      withdraw();
      // Whatever path led here without a disposition — an abandoned checkout included — ends closed.
      this.destroy("its transaction ended in an uncertain state");
    }
  }

  /** The executor and every statement refuse here: on the page's own failure when it was cancelled. */
  private refuse(): never {
    if (this.run.cancelled) throw this.run.exhausted("page exceeded its elapsed budget while work was pending");
    return unavailable("snapshot transaction has ended");
  }

  private async checkout(): Promise<void> {
    this.run.check();
    // Pool checkout cannot be cancelled, so the wait for it is what ends at the deadline. The
    // observer below is attached in the same step as the checkout itself, and is the one piece of
    // work that may outlive the page: it does exactly one thing to a late client — discards it.
    const acquiring = getPool().connect().then((client) => {
      if (this.phase === "ended") {
        discard(client, "it was acquired after its page had ended");
        return;
      }
      this.client = client;
    });
    acquiring.catch(() => undefined);
    await this.run.untilDeadline(acquiring);
  }

  /**
   * The ONE place a statement reaches the driver — BEGIN, configuration, the timeout, verification,
   * every application read, COMMIT and ROLLBACK alike. State and budget are judged immediately
   * before the dispatch (nothing is awaited in between); the driver's promise is observed at once
   * and counted until it settles; the wait for it, and only the wait, ends at the deadline; every
   * row the driver materialized is metered here and nowhere else; and the budget is judged again
   * before the result is handed on. It never refreshes the statement timeout itself.
   *
   * `rule` is "budget" for everything but ROLLBACK, which asks only whether time is left: a page
   * refused for its rows must still be able to end its transaction. `answered` runs the instant the
   * server's answer arrives, before any metering or check can fail — it is how COMMIT and ROLLBACK
   * tell "the server ended the transaction" from "something went wrong afterwards".
   */
  private async send(
    text: string, params?: unknown[], rule: "budget" | "time" = "budget", answered?: () => void
  ): Promise<unknown[]> {
    const client = this.client;
    if (client === null || this.handedBack) return this.refuse();
    if (rule === "budget") this.run.check();
    else if (!this.run.hasTime()) return this.refuse();

    let driver: Promise<unknown>;
    try {
      driver = Promise.resolve(params === undefined ? client.query(text) : client.query(text, params));
    } catch (error) {
      driver = Promise.reject(error);
    }
    this.outstanding++;
    const settled = (): void => { this.outstanding--; };
    driver.then(settled, settled);

    let answer: unknown;
    try {
      answer = await this.run.untilDeadline(driver);
    } catch (error) {
      // The server cancelled the statement: remember it even if the caller swallows the error.
      if (isRecord(error) && error.code === QUERY_CANCELED) this.run.exhausted("a statement exceeded the remaining runtime");
      throw error;
    }
    answered?.();
    // A text of several statements comes back as one result per statement: each is metered.
    const results: unknown[] = Array.isArray(answer) ? answer : [answer];
    for (const result of results) this.run.meterRows(rowsOf(result));
    if (rule === "budget") this.run.check();
    return results;
  }

  /** Demonstrably a fresh `REPEATABLE READ, READ ONLY` transaction, under the page's own timeout, before any read. */
  private async configure(): Promise<void> {
    await this.send("BEGIN");
    await this.send("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
    await this.refreshTimeout();
    const [configured] = await this.send(
      `select current_setting('transaction_isolation') as isolation, current_setting('transaction_read_only') as read_only`
    );
    const row = rowsOf(configured)[0];
    if (!isRecord(row) || row.isolation !== "repeatable read" || row.read_only !== "on") {
      unavailable("transaction is not a fresh read-only snapshot");
    }
  }

  /**
   * Re-derive the transaction-local `statement_timeout` from the budget that actually remains (one
   * clock reading, which also stops a spent budget). Never 0, which the server reads as "no timeout".
   */
  private async refreshTimeout(): Promise<void> {
    if (this.phase === "ended") return this.refuse();
    const timeout = timerMs(this.run.remaining());
    // Only an unchanged bound is skipped; any change in the remaining budget is sent to the server.
    if (timeout === this.applied) return;
    await this.send(`select set_config('statement_timeout', $1, true)`, [String(timeout)]);
    this.applied = timeout;
  }

  /**
   * The executor belongs to THIS transaction only, and only while its body runs. Once the body has
   * ended — by returning, failing or being cancelled — a dependency that kept the executor is
   * refused, never run on a session that now belongs to someone else.
   */
  private readonly query: SqlExecutor = async <R>(text: string, params: unknown[] = []) => {
    if (this.phase !== "open") return this.refuse();
    // Immediately before EVERY statement: a later statement never inherits the larger timeout an
    // earlier statement was given.
    await this.refreshTimeout();
    if (this.phase !== "open") return this.refuse();
    const results = await this.send(text, params);
    // The executor's contract is one result: of a multi-statement text, the last statement's.
    const last = results[results.length - 1];
    return { rows: rowsOf(last) as R[], rowCount: isRecord(last) && typeof last.rowCount === "number" ? last.rowCount : 0 };
  };

  /**
   * Setup or the body failed. With the transaction configured, no statement running and time left,
   * it is rolled back under the deadline and the session is reused once the server has answered.
   * In every other case — setup never completed, a statement still running, no time, a ROLLBACK
   * that failed or went unanswered — the session is discarded and nothing more is sent on it.
   */
  private async endFailed(): Promise<void> {
    const configured = this.phase === "open";
    this.phase = "ended";
    if (this.client === null || this.handedBack) return;
    if (!configured) return this.destroy("its transaction setup did not complete");
    if (this.outstanding > 0) return this.destroy("a statement was still running when its transaction failed");
    const rollback = { answered: false };
    try {
      await this.send("ROLLBACK", undefined, "time", () => { rollback.answered = true; });
    } catch {
      // Judged below: only the server's answer makes the session reusable.
    }
    if (rollback.answered) this.handBack();
    else this.destroy("its rollback did not complete");
  }

  /**
   * The body succeeded. A COMMIT the server answered leaves a clean session, whatever the metering
   * and checks after it decide; one that failed, or lost the race to the deadline, leaves a session
   * of unknown state, which is discarded. A read-only transaction commits nothing, so an answer of
   * anything but COMMIT means a statement had failed inside it and a dependency hid that.
   */
  private async commit(): Promise<void> {
    this.phase = "ended";
    const commit = { answered: false };
    let results: unknown[];
    try {
      results = await this.send("COMMIT", undefined, "budget", () => { commit.answered = true; });
    } finally {
      if (commit.answered) this.handBack();
      else this.destroy("its commit did not complete");
    }
    const [result] = results;
    if (!isRecord(result) || result.command !== "COMMIT") unavailable("snapshot transaction had already failed");
  }

  /** Return the session for reuse. Only ever reached after the server answered COMMIT or ROLLBACK. */
  private handBack(): void {
    const client = this.client;
    if (client === null || this.handedBack) return;
    if (this.outstanding > 0) return this.destroy("a statement was still running at the end of its transaction");
    this.handedBack = true;
    client.release();
  }

  /** Close the executor and discard the session, at once and whatever it is doing. Idempotent. */
  private destroy(reason: string): void {
    this.phase = "ended";
    const client = this.client;
    if (client === null || this.handedBack) return;
    this.handedBack = true;
    discard(client, reason);
  }
}

// ── the complete bound state of one snapshot ─────────────────────────────────

interface BoundItem {
  provenance: SlackItemProvenance;
  currentMemberId: string | null;
  locked: boolean;
}

interface Captured {
  admission: ContentAdmission;
  principalKey: string;
  viewKey: string;
  itemIds: string[];
  items: Map<string, BoundItem>;
  mappings: SlackAccountMapping[];
  humanMemberIds: ReadonlySet<string>;
  generations: SlackTeamGenerations;
  presentation: unknown;
  binding: SlackTimelineBinding;
}

function validProvenance(value: unknown): SlackItemProvenance | null {
  if (!isRecord(value)) return null;
  if (value.status === "unverified") return { status: "unverified" };
  if (value.status !== "verified" || !identity(value.workspaceId) || !identity(value.channelId) || !identity(value.rootTs)) return null;
  let workspaceUrl: string | null = null;
  if (value.workspaceUrl !== null) {
    // A separately verified Slack HTTPS workspace URL; never synthesized, never a foreign host.
    if (typeof value.workspaceUrl !== "string") return null;
    let url: URL;
    try {
      url = new URL(value.workspaceUrl);
    } catch {
      return null;
    }
    if (url.protocol !== "https:" || !url.hostname.endsWith(".slack.com") || url.username !== "" || url.password !== "") return null;
    workspaceUrl = value.workspaceUrl;
  }
  return { status: "verified", workspaceId: value.workspaceId, channelId: value.channelId, rootTs: value.rootTs, workspaceUrl };
}

function validAdmission(result: unknown, request: ValidRequest): {
  admission: ContentAdmission; principalKey: string; items: Map<string, SlackItemProvenance>;
  admissionBindingDigest: string; sourceAdmissionBindingDigest: string; bytes: number;
} {
  const incomplete = (): never => unavailable("admission result is incomplete or malformed");
  if (!isRecord(result) || typeof result.teamId !== "string" || result.teamId.toLowerCase() !== request.teamId ||
      !nonempty(result.principalKey) || !isRecord(result.admission) || !nonempty(result.admission.kind) ||
      !Array.isArray(result.slackItems) || result.admissionBinding === undefined || result.admissionBinding === null ||
      result.sourceAdmissionBinding === undefined || result.sourceAdmissionBinding === null) return incomplete();
  const items = new Map<string, SlackItemProvenance>();
  for (const entry of result.slackItems as unknown[]) {
    if (!isRecord(entry) || typeof entry.itemId !== "string" || !LOWER_UUID.test(entry.itemId) || items.has(entry.itemId)) {
      return incomplete();
    }
    const provenance = validProvenance(entry.provenance);
    if (provenance === null) return incomplete();
    items.set(entry.itemId, provenance);
  }
  const admissionJson = canonicalSlackTimelineJson(result.admissionBinding);
  const sourceJson = canonicalSlackTimelineJson(result.sourceAdmissionBinding);
  // The admission is copied out of the loader's hands in the step it arrived, and frozen: every
  // later loader, the view key and the visibility oracle are given THIS value, whatever the loader
  // goes on to do with the object it returned while the page awaits its next statement.
  let admission: ContentAdmission;
  try {
    admission = deepFreeze(structuredClone(result.admission)) as unknown as ContentAdmission;
  } catch {
    return incomplete();
  }
  return {
    admission,
    principalKey: result.principalKey,
    items,
    admissionBindingDigest: slackTimelineDigest(result.admissionBinding),
    sourceAdmissionBindingDigest: slackTimelineDigest(result.sourceAdmissionBinding),
    bytes: Buffer.byteLength(admissionJson, "utf8") + Buffer.byteLength(sourceJson, "utf8"),
  };
}

/**
 * Read and bind EVERYTHING a page depends on, through one executor. Used for the evidence snapshot,
 * again for the validation snapshot, and by final validation: the same code computes each binding,
 * so two snapshots can only compare equal when their complete inputs are equal.
 */
async function capture(
  run: PageRun, snapshot: Snapshot, deps: ValidDependencies, request: ValidRequest, window: SlackTimelineWindow
): Promise<Captured> {
  const { query } = snapshot;
  const loaded = await run.race(() => deps.loadAdmission(query, {
    teamId: request.teamId, principal: { ...request.principal }, requestedView: request.requestedView, signal: run.signal,
  }));
  const admitted = validAdmission(loaded, request);
  run.meterBytes(admitted.bytes);
  await snapshot.refreshTimeout();
  const itemIds = [...admitted.items.keys()].sort(compareText);
  const viewKey = deriveSlackTimelineViewKey({
    teamId: request.teamId, principalKey: admitted.principalKey, admissionKind: admitted.admission.kind,
    view: { mode: request.requestedView.mode, filters: request.requestedView.filters },
    locale: request.requestedView.locale, presentationPolicyVersion: request.requestedView.presentationPolicyVersion,
  });

  // The packet's OWN session reader for correction owner and lock. These values are never taken
  // from a dependency: a real correction changes only this row, and no Slack generation.
  const items = new Map<string, BoundItem>();
  for (const batch of chunks(itemIds, ID_BATCH)) {
    const { rows } = await query<{ id: string; memberId: string | null; locked: boolean }>(
      `select id, member_id as "memberId", member_id_locked as locked
         from items
        where team_id = $1::uuid and id = any($2::uuid[]) and frontmatter->>'source' = 'slack'`,
      [request.teamId, batch]
    );
    for (const row of rows) {
      const provenance = admitted.items.get(row.id);
      if (!provenance || items.has(row.id) || typeof row.locked !== "boolean" ||
          (row.memberId !== null && typeof row.memberId !== "string")) return unavailable("Slack item metadata is inconsistent");
      items.set(row.id, { provenance, currentMemberId: row.memberId, locked: row.locked });
    }
  }
  // Exact coverage: an authorized ID that is not a same-team Slack item is never silently omitted.
  if (items.size !== itemIds.length) return unavailable("an authorized Slack item has no same-team Slack row");

  // Complete live mappings (exact stored spelling — collision evidence is not normalized away), the
  // complete current human roster, and the durable generations, in this same transaction.
  const identities = await readSlackCreditInputSnapshotInSession(query, request.teamId, [], SLACK_CREDIT_READ_PAGE_SIZE);

  // Strict provenance over the WHOLE authorized set, before any candidate is filtered or limited.
  // An item with an eligible surviving author needs a verified proof that matches its one ledger
  // binding — whether or not that author resolves, and whether or not it is in the window.
  for (const batch of chunks(itemIds, ID_BATCH)) {
    const { rows } = await query<{ itemId: string; workspaceId: string; channelId: string; rootTs: string; eligible: number }>(
      `select m.item_id as "itemId", m.workspace_id as "workspaceId", m.channel_id as "channelId",
              m.root_ts as "rootTs",
              (count(*) filter (where m.eligible and m.deleted_at is null))::int as eligible
         from slack_messages m
        where m.team_id = $1::uuid and m.item_id = any($2::uuid[])
        group by m.item_id, m.workspace_id, m.channel_id, m.root_ts
        order by m.item_id, m.workspace_id, m.channel_id, m.root_ts`,
      [request.teamId, batch]
    );
    const bound = new Set<string>();
    for (const row of rows) {
      const item = items.get(row.itemId);
      if (!item) return unavailable("ledger row outside the authorized Slack items");
      if (bound.has(row.itemId)) return unavailable("a Slack item's ledger is bound to more than one thread");
      bound.add(row.itemId);
      const proof = item.provenance;
      if (proof.status === "verified") {
        if (proof.workspaceId !== row.workspaceId || proof.channelId !== row.channelId || proof.rootTs !== row.rootTs) {
          return unavailable("verified provenance contradicts the source ledger");
        }
      } else if (row.eligible > 0) {
        return unavailable("an eligible ledger author has no verified provenance");
      }
    }
  }
  await snapshot.refreshTimeout();

  const presentationInput = await run.race(() => deps.loadPresentation(query, {
    teamId: request.teamId, principal: { ...request.principal }, admission: admitted.admission,
    slackItems: itemIds.map((itemId) => ({ itemId, provenance: items.get(itemId)!.provenance })),
    asOf: window.asOf, windowDays: window.windowDays, viewKey, signal: run.signal,
  }));
  if (presentationInput === undefined || presentationInput === null) return unavailable("presentation bundle is incomplete");
  // Captured ONCE, in the step the bundle arrived and before anything else is awaited: an immutable
  // copy rebuilt from its canonical bytes. That copy is what the composer renders AND what the
  // digest binds — the loader's own graph, which it may keep and change, is never read again.
  const presentationJson = canonicalSlackTimelineJson(presentationInput);
  const presentation = deepFreeze(JSON.parse(presentationJson) as unknown);
  const presentationInputDigest = slackTimelineDigest(presentation);
  run.meterBytes(Buffer.byteLength(presentationJson, "utf8"));
  await snapshot.refreshTimeout();

  const mappings = [...identities.mappings].sort((a, b) =>
    compareText(a.provider, b.provider) || compareText(a.externalId, b.externalId) || compareText(a.memberId, b.memberId));
  const creditInputDigest = slackTimelineDigest({
    kind: "aios/slack-credit-input/v1",
    items: itemIds.map((id) => {
      const item = items.get(id)!;
      return { id, currentMemberId: item.currentMemberId, locked: item.locked, provenance: item.provenance };
    }),
    mappings: mappings.map((row) => ({
      teamId: row.teamId, provider: row.provider, externalId: row.externalId, memberId: row.memberId, state: row.state,
    })),
    humans: [...identities.humanMemberIds].sort(compareText),
  });

  const binding = assertSlackTimelineBinding({
    schemaVersion: 1,
    teamId: request.teamId,
    principalKey: admitted.principalKey,
    viewKey,
    admissionBindingDigest: admitted.admissionBindingDigest,
    sourceAdmissionBindingDigest: admitted.sourceAdmissionBindingDigest,
    authorizedSlackItemFingerprint: slackItemFingerprint(itemIds),
    windowDays: window.windowDays,
    since: window.since,
    asOf: window.asOf,
    issuedAt: window.issuedAt,
    expiresAt: window.expiresAt,
    pageSize: request.pageSize,
    dataGeneration: identities.generations.dataGeneration,
    identityGeneration: identities.generations.identityGeneration,
    presentationGeneration: identities.generations.presentationGeneration,
    creditInputDigest,
    presentationInputDigest,
  });
  run.check();
  return {
    admission: admitted.admission,
    principalKey: admitted.principalKey,
    viewKey,
    itemIds,
    items,
    mappings: identities.mappings,
    humanMemberIds: identities.humanMemberIds,
    generations: identities.generations,
    // The same immutable copy the digest was computed over: the composer cannot change it either.
    presentation,
    binding,
  };
}

/** The real item-visibility oracle, on this snapshot, under this admission. */
async function oracleVisibleItemIds(run: PageRun, query: SqlExecutor, teamId: string, admission: ContentAdmission): Promise<ReadonlySet<string>> {
  const projectIds = admission.kind === "member" ? admission.grantedProjectIds : [];
  const visible = await visibleItemIdsForProjects(new PgClient({ executor: query, bound: true }), teamId, new Set(projectIds));
  // Its one materialized query was metered by the executor on return; an over-limit read fails here,
  // before the result is used. A read error is unavailable — never an empty authorized set.
  run.check();
  if (visible.error) return unavailable("item visibility could not be read");
  return visible.ids;
}

/** The frozen backing IDs must still be visible to the CURRENT admission; removal needs restart. */
async function assertBackingItemsVisible(
  run: PageRun, query: SqlExecutor, teamId: string, admission: ContentAdmission, sourceItemIds: readonly string[]
): Promise<void> {
  if (sourceItemIds.length === 0) return;
  const visible = await oracleVisibleItemIds(run, query, teamId, admission);
  if (sourceItemIds.some((id) => !visible.has(id))) restart("non-Slack evidence is no longer authorized");
}

function backingIdList(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((id) => typeof id !== "string" || !ANY_UUID.test(id))) {
    return unavailable("non-Slack backing items are not declared");
  }
  const ids = (value as string[]).map((id) => id.toLowerCase());
  if (new Set(ids).size !== ids.length) return unavailable("non-Slack backing items are not declared");
  return ids.sort(compareText);
}

// ── first page: the frozen non-Slack snapshot ────────────────────────────────

interface InitialNonSlack {
  days: TimelineDay[];
  sourceItemIds: string[];
}

/** What the non-Slack loader resolved with, as this page's OWN deeply frozen graph. */
interface InitialCapture {
  days: unknown;
  sourceItemIds: unknown;
  /** UTF-8 bytes of the canonical JSON the capture was rebuilt from. */
  bytes: number;
}

/**
 * Copy the loader's result out of the loader's hands. Canonical JSON admits only plain JSON values,
 * so parsing it back yields a graph that shares no object with the one the loader returned — and
 * may keep, cache and change. Everything this page validates, traverses, meters, merges and
 * publishes of its non-Slack evidence is this copy; the loader's graph is never frozen or read again.
 */
function captureInitialNonSlack(result: unknown): InitialCapture {
  if (!isRecord(result)) return unavailable("initial non-Slack result is incomplete");
  let json: string;
  try {
    json = canonicalSlackTimelineJson({ days: result.days, sourceItemIds: result.sourceItemIds });
  } catch {
    return unavailable("initial non-Slack result is not JSON-safe");
  }
  const copy = deepFreeze(JSON.parse(json) as { days?: unknown; sourceItemIds?: unknown });
  return { days: copy.days, sourceItemIds: copy.sourceItemIds, bytes: Buffer.byteLength(json, "utf8") };
}

/**
 * Days as they are PUBLISHED: a deeply frozen graph of their own. The shared merger and the composer
 * hand back containers that still hold the objects they were given; a page must not change after it
 * was assembled, through any of them or through its own reader. Nothing a dependency retains is
 * frozen: the page is a copy.
 */
function publishedDays(days: readonly TimelineDay[]): TimelineDay[] {
  let json: string;
  try {
    json = JSON.stringify(days);
  } catch {
    return unavailable("page days are not JSON-safe");
  }
  return deepFreeze(JSON.parse(json) as TimelineDay[]);
}

/**
 * True when any source group, or any row inside one, is Slack's. Deliberately tolerant of every
 * other malformation — it runs on an unvalidated dependency result, and shape is judged afterwards.
 */
function carriesSlackEvidence(days: unknown): boolean {
  if (!Array.isArray(days)) return false;
  const isSlack = (group: unknown): boolean =>
    isRecord(group) && (group.source === "slack" ||
      (Array.isArray(group.items) && group.items.some((item) => isRecord(item) && item.source === "slack")));
  for (const day of days) {
    if (!isRecord(day) || !Array.isArray(day.people)) continue;
    for (const person of day.people as unknown[]) {
      if (!isRecord(person)) continue;
      if (Array.isArray(person.other) && person.other.some(isSlack)) return true;
      if (!Array.isArray(person.tasks)) continue;
      for (const task of person.tasks as unknown[]) {
        if (isRecord(task) && Array.isArray(task.sources) && task.sources.some(isSlack)) return true;
      }
    }
  }
  return false;
}

/**
 * Load, validate and freeze the non-Slack days of a first page. Two rules are this packet's own:
 * the days may hold no Slack group at all (legacy Slack rows from a reused builder are refused
 * before anything is merged), and the declared backing IDs must cover every source item the days
 * visibly depend on — a row whose own id is a same-team item, and any item a row or a signal cites
 * through `/library/<id>`. A row that is no item and cites none needs no backing ID.
 */
async function loadInitial(
  run: PageRun, snapshot: Snapshot, deps: ValidDependencies, request: ValidRequest, captured: Captured
): Promise<InitialNonSlack> {
  // The capture is taken INSIDE the awaited work: it runs in the same step in which the loader's
  // result arrives, with no other await between the two. A loader that goes on to change the graph
  // it returned — while this page is still reading, or after it was published — changes nothing here.
  const result = await run.race(async () => {
    const loaded: unknown = await deps.loadInitialNonSlack(snapshot.query, {
      teamId: request.teamId, principal: { ...request.principal }, admission: captured.admission,
      viewKey: captured.viewKey, asOf: captured.binding.asOf, windowDays: captured.binding.windowDays, signal: run.signal,
    });
    // An answer that arrives after the page was cancelled is dropped, not copied.
    return run.cancelled ? null : captureInitialNonSlack(loaded);
  });
  if (result === null) return unavailable("initial non-Slack result is incomplete");
  await snapshot.refreshTimeout();
  const sourceItemIds = backingIdList(result.sourceItemIds);
  // Slack evidence is refused BEFORE the shared merger sees these days. The merger reconciles Slack
  // rows, so two conflicting legacy Slack rows would otherwise surface as a merge conflict — a
  // restart — when the truth is a malformed dependency result.
  if (carriesSlackEvidence(result.days)) return unavailable("initial non-Slack days carry Slack evidence");
  // Then shape — every non-Slack row included — by the packet's own rules, with nothing merged in yet.
  const days = mergeSlackTimelineDays(result.days as TimelineDay[], []);
  // Metered once, as the bundle the page actually holds: the capture, not the loader's graph.
  run.meterBytes(result.bytes);

  const rowIds = new Set<string>();
  const cited = new Set<string>();
  const cite = (url: unknown): void => {
    const match = typeof url === "string" ? LIBRARY_LINK.exec(url) : null;
    if (match) cited.add(match[1].toLowerCase());
  };
  for (const day of result.days as TimelineDay[]) {
    for (const person of day.people) {
      for (const group of [...person.tasks.flatMap((task) => task.sources), ...person.other]) {
        if (group.source === "slack") return unavailable("initial non-Slack days carry Slack evidence");
        for (const item of group.items as unknown[]) {
          if (!isRecord(item)) return unavailable("initial non-Slack result is incomplete");
          if (item.source === "slack") return unavailable("initial non-Slack days carry Slack evidence");
          if (typeof item.id === "string" && ANY_UUID.test(item.id)) rowIds.add(item.id.toLowerCase());
          cite(item.url);
        }
      }
      for (const group of person.signals as unknown[]) {
        if (!isRecord(group) || !Array.isArray(group.items)) return unavailable("initial non-Slack result is incomplete");
        for (const signal of group.items as unknown[]) if (isRecord(signal)) cite(signal.url);
      }
    }
  }
  const declared = new Set(sourceItemIds);
  const undeclaredRows = [...rowIds].filter((id) => !declared.has(id) && !cited.has(id));
  for (const batch of chunks(undeclaredRows, ID_BATCH)) {
    const { rows } = await snapshot.query<{ id: string }>(
      `select id from items where team_id = $1::uuid and id = any($2::uuid[])`, [request.teamId, batch]
    );
    // A rendered row that IS a same-team item, and is not declared: the list is incomplete.
    if (rows.length > 0) return unavailable("non-Slack backing items are incomplete");
  }
  if ([...cited].some((id) => !declared.has(id))) return unavailable("non-Slack backing items are incomplete");
  return { days, sourceItemIds };
}

// ── candidate discovery and the shared projection ────────────────────────────

interface ProjectedGroup {
  id: string;
  tuple: SlackAggregateTuple;
  messageCount: number;
  rootAuthored: boolean;
  /** The compact record when the shared credit oracle credits this group; null when it does not. */
  credited: SlackAggregate | null;
}

function candidateRow(value: unknown): SlackCandidateGroupRow {
  if (!isRecord(value) || typeof value.itemId !== "string" || !LOWER_UUID.test(value.itemId) ||
      typeof value.memberId !== "string" || !LOWER_UUID.test(value.memberId) ||
      typeof value.day !== "string" || !DAY.test(value.day) || typeof value.at !== "string" || !MICRO_INSTANT.test(value.at) ||
      value.at.slice(0, 10) !== value.day || typeof value.messageCount !== "number" || !Number.isSafeInteger(value.messageCount) ||
      value.messageCount < 1 || typeof value.rootAuthored !== "boolean") {
    return unavailable("SQL candidate group is malformed");
  }
  return {
    itemId: value.itemId, memberId: value.memberId, day: value.day, at: value.at,
    messageCount: value.messageCount, rootAuthored: value.rootAuthored,
  };
}

const CANDIDATE_SQL = `
  with relation as (
    select * from unnest($5::text[], $6::text[], $7::uuid[]) as r(workspace_id, user_id, member_id)
  ), grouped as (
    select m.item_id, r.member_id,
           (m.occurred_at at time zone 'UTC')::date as group_day,
           max(m.occurred_at) as latest_at,
           count(*) as message_count,
           bool_or(m.is_root and m.message_ts = m.root_ts) as root_authored
      from slack_messages m
      join items i on i.id = m.item_id and i.team_id = m.team_id
      join relation r on r.workspace_id = m.workspace_id and r.user_id = m.author_external_id
     where m.team_id = $1::uuid
       and m.item_id = any($2::uuid[])
       and i.frontmatter->>'source' = 'slack'
       and m.eligible = true and m.deleted_at is null
       and m.occurred_at >= $3::timestamptz and m.occurred_at <= $4::timestamptz
       -- A whole-UTC-day exclusion only: it can remove a group, never split one. The cursor's
       -- instant is NOT pushed into the message input, which would re-aggregate an emitted group.
       and ($8::date is null or m.occurred_at < (($8::date + 1)::timestamp at time zone 'UTC'))
     group by m.item_id, r.member_id, (m.occurred_at at time zone 'UTC')::date
  )
  select item_id as "itemId", member_id as "memberId", to_char(group_day, 'YYYY-MM-DD') as "day",
         to_char(latest_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "at",
         message_count::text as "messageCount", root_authored as "rootAuthored"
    from grouped
   where $8::date is null
      or group_day < $8::date
      or (group_day = $8::date and latest_at < $9::timestamptz)
      or (group_day = $8::date and latest_at = $9::timestamptz and item_id > $10::uuid)
      or (group_day = $8::date and latest_at = $9::timestamptz and item_id = $10::uuid and member_id > $11::uuid)
   order by group_day desc, latest_at desc, item_id asc, member_id asc
   limit $12`;

/**
 * Scan completed aggregate groups after `after` until `pageSize + 1` DELIVERABLE groups exist or SQL
 * exhaustion is proven, and return the deliverable ones in order. Rejected groups cost candidate
 * budget, never a page slot.
 */
async function deliverableAggregates(
  run: PageRun, snapshot: Snapshot, deps: ValidDependencies, request: ValidRequest, captured: Captured,
  after: SlackAggregateTuple | null, options: SlackPersonDayPageOptions, internalSize: number
): Promise<SlackAggregate[]> {
  const { query } = snapshot;
  const { teamId } = request;
  const since = new Date(captured.binding.since);
  const asOf = new Date(captured.binding.asOf);

  // The ONE identity oracle. The SQL join receives its results as a relation; the projector calls
  // it directly. No second, more permissive resolver exists in SQL.
  const resolve = (qualifiedAuthorId: string, verifiedWorkspaceId: string): string | null => {
    const result = lookupSlackAccount({
      teamId, externalId: qualifiedAuthorId, verifiedItemWorkspaceId: verifiedWorkspaceId, mappings: captured.mappings,
    });
    return result.memberId && captured.humanMemberIds.has(result.memberId) ? result.memberId : null;
  };
  let relation: SlackAccountRelationRow[] = [];
  const accounts = new Set<string>();
  for (const mapping of captured.mappings) {
    const match = CANONICAL_ACCOUNT.exec(mapping.externalId);
    if (!match || accounts.has(mapping.externalId)) continue;
    accounts.add(mapping.externalId);
    const memberId = resolve(mapping.externalId, match[1]);
    if (memberId) relation.push({ workspaceId: match[1], userId: match[2], memberId });
  }
  if (options.corruptAccountRelation) relation = options.corruptAccountRelation(relation);
  if (!Array.isArray(relation) || relation.some((row) => !isRecord(row) || !nonempty(row.workspaceId) ||
      !nonempty(row.userId) || typeof row.memberId !== "string" || !ANY_UUID.test(row.memberId))) {
    return unavailable("account relation is malformed");
  }
  const relationParams = [
    relation.map((row) => row.workspaceId), relation.map((row) => row.userId), relation.map((row) => row.memberId),
  ];

  /** Projected groups of every item loaded so far that SQL has not yet returned on this page. */
  const awaited = new Map<string, ProjectedGroup>();
  const loadedItems = new Set<string>();
  const deliverable: SlackAggregate[] = [];
  let frontier = after;
  let exhausted = false;
  let discovered = false;

  while (deliverable.length < request.pageSize + 1 && !exhausted) {
    await snapshot.refreshTimeout();
    const allowance = deps.budgets.maxCandidates - run.candidates;
    const needed = request.pageSize + 1 - deliverable.length;
    // The additional row detects overrun, and counts.
    const limit = Math.max(1, Math.min(deps.budgets.candidateFetchSize, allowance + 1, Math.max(needed, FETCH_FLOOR)));
    const fetched = await query<{ itemId: string; memberId: string; day: string; at: string; messageCount: string; rootAuthored: boolean }>(
      CANDIDATE_SQL,
      [teamId, captured.itemIds, captured.binding.since, captured.binding.asOf, ...relationParams,
        frontier?.day ?? null, frontier?.at ?? null, frontier?.itemId ?? null, frontier?.memberId ?? null, limit]
    );
    const raw = fetched.rows.map((row) => candidateRow({ ...row, messageCount: Number(row.messageCount) }));
    run.candidates += raw.length;
    if (raw.length > allowance) throw run.exhausted("page exceeded its candidate budget");
    exhausted = raw.length < limit;
    // The scan position follows what SQL returned, so the interval compared below is the interval
    // SQL claims to have covered — whatever a corruption seam then does to the rows.
    const scannedThrough = raw.length > 0 ? slackAggregateTuple({ ...raw[raw.length - 1], sourceItemId: raw[raw.length - 1].itemId }) : frontier;

    const candidates = (options.corruptCandidates ? options.corruptCandidates(raw.map((row) => ({ ...row }))) : raw);
    if (!Array.isArray(candidates)) return unavailable("SQL candidate batch is malformed");
    const rows = candidates.map(candidateRow);

    if (!discovered) {
      discovered = true;
      if (options.afterDiscovery) {
        const seam = options.afterDiscovery;
        await run.race(() => seam(query));
        await snapshot.refreshTimeout();
      }
    }

    // Load, once, the complete ledger and in-window messages of every item this batch surfaces, and
    // project it with the shared projector and the shared credit oracle.
    const fresh = [...new Set(rows.map((row) => row.itemId))].filter((id) => !loadedItems.has(id)).sort(compareText);
    for (const itemId of fresh) if (!captured.items.has(itemId)) return unavailable("SQL candidate outside the authorized Slack items");
    for (const batch of chunks(fresh, SLACK_CREDIT_READ_PAGE_SIZE)) {
      const ledgers = await readSlackItemCreditLedgerInSession(query, teamId, batch, internalSize);
      const messages = await readVisibleSlackMessagesInSession(query, { teamId, since, asOf, itemIds: batch }, internalSize);
      const metadata = batch.map((itemId): AuthorizedSlackCreditItem => {
        const item = captured.items.get(itemId)!;
        return {
          teamId, itemId, source: "slack", locked: item.locked, currentMemberId: item.currentMemberId,
          // Verified-ledger-only slice: explicit empties, because no absent-ledger fallback is emitted.
          frontmatter: null, legacyVersionMemberIds: [], legacyLatestWorkerId: null,
          ...(item.provenance.status === "verified" ? { verifiedItemWorkspaceId: item.provenance.workspaceId } : {}),
        };
      });
      const composed = composeSlackEvidence({
        teamId, ledgers, mappings: captured.mappings, humanMemberIds: captured.humanMemberIds,
        generations: captured.generations, messages,
      }, metadata);
      const credited = new Map(composed.personDays.map((personDay) => [personDay.id, personDay]));
      // The complete UNSCOPED projection, with the same resolver: what SQL must equal.
      for (const group of projectSlackPersonDays(messages, resolve)) {
        const proof = captured.items.get(group.sourceItemId)?.provenance;
        if (!proof || proof.status !== "verified" || proof.workspaceId !== group.workspaceId ||
            proof.channelId !== group.channelId || proof.rootTs !== group.rootTs) {
          return unavailable("projected thread identity contradicts verified provenance");
        }
        const tuple = slackAggregateTuple(group);
        // Groups at or before the request cursor belong to earlier pages.
        if (after !== null && compareSlackAggregateTuples(after, tuple) >= 0) continue;
        const creditedDay = credited.get(group.id);
        awaited.set(group.id, {
          id: group.id, tuple, messageCount: group.messageCount, rootAuthored: group.rootAuthored,
          credited: creditedDay ? Object.freeze(compactSlackAggregate(creditedDay)) : null,
        });
      }
      for (const itemId of batch) loadedItems.add(itemId);
      run.check();
    }

    // Two-way equality over the interval SQL covered. First direction: every SQL group is a
    // projected group with the identical tuple, count and root flag.
    const matched: ProjectedGroup[] = [];
    for (const row of rows) {
      const id = JSON.stringify([row.itemId, row.memberId, row.day]);
      const group = awaited.get(id);
      if (!group || group.tuple.at !== row.at || group.messageCount !== row.messageCount || group.rootAuthored !== row.rootAuthored) {
        return unavailable("SQL candidates and the shared projection disagree");
      }
      if ((frontier !== null && compareSlackAggregateTuples(frontier, group.tuple) >= 0) ||
          (scannedThrough !== null && compareSlackAggregateTuples(group.tuple, scannedThrough) > 0)) {
        return unavailable("SQL candidates and the shared projection disagree");
      }
      awaited.delete(id);
      matched.push(group);
    }
    // Second direction: every projected group of EVERY loaded item inside the covered interval was
    // returned — including an item first loaded batches ago and absent from this one. When SQL
    // claims exhaustion the interval runs to the end of the window.
    for (const group of awaited.values()) {
      if (exhausted || (scannedThrough !== null && compareSlackAggregateTuples(group.tuple, scannedThrough) <= 0)) {
        return unavailable("SQL candidates omit a projected group");
      }
    }

    matched.sort((a, b) => compareSlackAggregateTuples(a.tuple, b.tuple));
    // A group the credit oracle does not credit is legitimately suppressed (a lock never transfers
    // messages to its owner). It is skipped here and has already cost candidate budget.
    for (const group of matched) if (group.credited) deliverable.push(group.credited);
    frontier = scannedThrough;
    run.check();
  }

  if (!discovered && options.afterDiscovery) {
    const seam = options.afterDiscovery;
    await run.race(() => seam(query));
  }
  return deliverable;
}

// ── the public service ───────────────────────────────────────────────────────

function composeDays(deps: ValidDependencies, captured: Captured, aggregates: readonly SlackAggregate[]): TimelineDay[] {
  let days: unknown;
  try {
    days = deps.composeSlackPage({
      aggregates, presentation: captured.presentation, asOf: captured.binding.asOf, windowDays: captured.binding.windowDays,
    });
  } catch {
    return unavailable("composer failed");
  }
  // Pure and SYNCHRONOUS: a promise is not days.
  if (!Array.isArray(days)) return unavailable("composer output is malformed");
  assertComposedSlackDays({ aggregates, days });
  return days as TimelineDay[];
}

/**
 * One aggregate Slack page: a first page (`cursor` null) or the continuation of an authenticated
 * cursor. Returns the complete page, or throws a `SlackTimelineError`:
 *
 *  - `invalid_request` — malformed, tampered, unverifiable or oversized cursor; invalid bounds;
 *  - `restart_required` — expired cursor, or any bound state that changed since it was issued;
 *  - `unavailable` — a read, dependency, provenance, SQL-consistency or composer failure;
 *  - `budget_exhausted` — a runtime, candidate, row, byte or page budget was exceeded.
 *
 * No partially accumulated page is ever consumable.
 */
export async function readSlackPersonDayPage(
  request: SlackPersonDayPageRequest,
  dependencies: SlackPersonDayPageDependencies,
  options: SlackPersonDayPageOptions = {}
): Promise<SlackTimelinePage> {
  // Everything caller-controlled is validated and captured before the first await.
  const valid = validRequest(request);
  const deps = validDependencies(dependencies);
  const seams: SlackPersonDayPageOptions = isRecord(options) ? options : {};
  const internalSize = internalPageSize(seams);
  const outer = outerSignal(seams.signal);

  let payload: SlackTimelineCursorPayload | null = null;
  if (valid.cursor !== null) payload = decodeSlackTimelineCursor(valid.cursor, deps.key);
  let admittedAt: Date;
  try {
    admittedAt = deps.now();
  } catch {
    // A clock that throws is a failed trusted dependency, like any other: never a raw error.
    return unavailable("wall clock failed");
  }
  let window: SlackTimelineWindow;
  if (payload !== null) {
    assertSlackTimelineCursorFresh(payload, admittedAt);
    if (payload.teamId !== valid.teamId || payload.windowDays !== valid.windowDays || payload.pageSize !== valid.pageSize) {
      return restart("cursor is bound to a different request");
    }
    window = {
      windowDays: payload.windowDays, since: payload.since, asOf: payload.asOf, issuedAt: payload.issuedAt, expiresAt: payload.expiresAt,
    };
  } else {
    window = slackTimelineWindow(admittedAt, valid.windowDays);
  }
  const after = payload?.lastAggregateTuple ?? null;

  const run = new PageRun(deps, outer);
  try {
    // ── the evidence snapshot ──
    const evidence = await inSnapshot(run, async (snapshot) => {
      if (seams.afterTransactionConfigured) {
        const seam = seams.afterTransactionConfigured;
        await run.race(() => seam(snapshot.query));
        await snapshot.refreshTimeout();
      }
      const captured = await capture(run, snapshot, deps, valid, window);
      // Only a valid, complete, within-budget snapshot reaches the binding comparison: a provenance
      // conflict was already refused above and is never downgraded to a restart.
      if (payload !== null) {
        assertSlackTimelineBindingUnchanged(payload, captured.binding);
        assertSlackTimelineCursorRequest(payload, {
          teamId: valid.teamId, principalKey: captured.principalKey, viewKey: captured.viewKey,
          windowDays: valid.windowDays, pageSize: valid.pageSize, authorizedSlackItemIds: new Set(captured.itemIds),
        });
      }
      const initial = payload === null ? await loadInitial(run, snapshot, deps, valid, captured) : null;
      const deliverable = await deliverableAggregates(run, snapshot, deps, valid, captured, after, seams, internalSize);
      // The extra group is lookahead only. The page resumes from its last EMITTED tuple.
      const emitted = deliverable.slice(0, valid.pageSize);
      const more = deliverable.length > valid.pageSize;
      const slackDays = composeDays(deps, captured, Object.freeze([...emitted]));
      // Initial composition goes through the shared merger; a continuation holds only its own groups.
      // Either way the page's days are copied and frozen HERE, in the step that assembled them.
      const days = publishedDays(initial === null ? slackDays : mergeSlackTimelineDays(initial.days, slackDays));
      run.check();
      return { captured, initial, emitted, more, days };
    });

    if (seams.afterEvidence) {
      const seam = seams.afterEvidence;
      await run.race(() => seam());
    }

    // ── the validation snapshot: one fresh transaction, every binding recomputed ──
    await inSnapshot(run, async (snapshot) => {
      const current = await capture(run, snapshot, deps, valid, window);
      assertSlackTimelineBindingUnchanged(evidence.captured.binding, current.binding);
      if (evidence.initial !== null) {
        await assertBackingItemsVisible(run, snapshot.query, valid.teamId, current.admission, evidence.initial.sourceItemIds);
      }
    });

    // ── publication ──
    const binding = evidence.captured.binding;
    const last = evidence.emitted[evidence.emitted.length - 1];
    const nextSlackCursor = evidence.more && last
      ? encodeSlackTimelineCursor({ ...binding, lastAggregateTuple: slackAggregateTuple(last) }, deps.key)
      : null;
    const page: SlackTimelinePage = {
      days: evidence.days,
      window_days: binding.windowDays,
      asOf: binding.asOf,
      binding,
      aggregates: evidence.emitted.map((aggregate) => ({ id: aggregate.id, tuple: slackAggregateTuple(aggregate) })),
      nextSlackCursor,
      slackComplete: nextSlackCursor === null,
      ...(evidence.initial !== null ? { initialNonSlackSourceItemIds: deepFreeze([...evidence.initial.sourceItemIds]) } : {}),
    };
    if (Buffer.byteLength(JSON.stringify(page), "utf8") > deps.budgets.maxPageBytes) {
      throw run.exhausted("page exceeded its serialized size budget");
    }
    // Expiry and clock skew are judged again immediately before publication.
    assertSlackTimelineCursorFresh(binding, deps.now());
    // The last clock reading of the page: nothing follows it.
    run.check();
    return page;
  } catch (error) {
    throw run.classify(error);
  } finally {
    run.finish();
  }
}

export interface SlackPersonDayFinalValidationInput extends SlackPersonDayPageRequest {
  /** The binding the drain pinned on its first page. */
  binding: SlackTimelineBinding;
  /** The first page's frozen non-Slack backing IDs. */
  initialNonSlackSourceItemIds: readonly string[];
}

/**
 * The drain's fresh, read-only FINAL validation, mandatory even for a one-page drain. In one new
 * transaction it recomputes the complete Slack binding and compares it with the pinned one, requires
 * the non-Slack backing IDs to still be visible through the real oracle, and judges expiry. It does
 * not trust any earlier assertion, and it runs under the per-page read ceilings.
 */
export async function validateSlackPersonDayFinal(
  input: SlackPersonDayFinalValidationInput,
  dependencies: SlackPersonDayPageDependencies,
  options: Pick<SlackPersonDayPageOptions, "signal"> = {}
): Promise<void> {
  const valid = validRequest(input);
  const deps = validDependencies(dependencies);
  const pinned = assertSlackTimelineBinding((input as unknown as Record<string, unknown>).binding);
  const sourceItemIds = backingIdList((input as unknown as Record<string, unknown>).initialNonSlackSourceItemIds);
  const outer = outerSignal(isRecord(options) ? options.signal : undefined);
  const window: SlackTimelineWindow = {
    windowDays: pinned.windowDays, since: pinned.since, asOf: pinned.asOf, issuedAt: pinned.issuedAt, expiresAt: pinned.expiresAt,
  };

  const run = new PageRun(deps, outer);
  try {
    await inSnapshot(run, async (snapshot) => {
      const current = await capture(run, snapshot, deps, { ...valid, cursor: null }, window);
      assertSlackTimelineBindingUnchanged(pinned, current.binding);
      await assertBackingItemsVisible(run, snapshot.query, valid.teamId, current.admission, sourceItemIds);
    });
    assertSlackTimelineCursorFresh(pinned, deps.now());
    run.check();
  } catch (error) {
    throw run.classify(error);
  } finally {
    run.finish();
  }
}
