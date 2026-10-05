import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

import { mergeTimelineSlackContinuation } from "./timeline-continuation-merge";
import type { EvidenceItem, PersonDay, SourceGroup, TaskGroup, TimelineDay } from "./timeline-group";

/**
 * AIO-1170 AC-09 — the INACTIVE, pure continuation contract for aggregate Slack pagination.
 *
 * One Slack aggregate is `(item, member, UTC day)`. A page of aggregates is resumed through an
 * opaque, authenticated, snapshot-bound cursor, and a page is either a whole answer or exactly one
 * of four named failures. Nothing here reads a clock, a database, an environment variable or a key
 * of its own: the caller injects all of them. Nothing in the application imports this module yet
 * (`test/guards/slack-aggregate-pagination-not-wired.test.ts`).
 */

export type SlackTimelineFailure = "invalid_request" | "restart_required" | "unavailable" | "budget_exhausted";

const FAILURES: ReadonlySet<string> = new Set(["invalid_request", "restart_required", "unavailable", "budget_exhausted"]);
const ERROR_BRAND = Symbol.for("aios.slack-timeline.error");

/**
 * The only error this packet reports. `reason` is a static, sanitized phrase: no identifier, key,
 * token, message text or member name is ever interpolated into it.
 */
export class SlackTimelineError extends Error {
  readonly code: SlackTimelineFailure;
  readonly reason: string;
  /** Counters only (never content), for a budget failure a later capacity gate must be able to read. */
  readonly diagnostics?: Readonly<Record<string, number>>;

  constructor(code: SlackTimelineFailure, reason: string, diagnostics?: Readonly<Record<string, number>>) {
    if (!FAILURES.has(code)) throw new TypeError("slack timeline: unknown failure class");
    super(`slack timeline ${code}: ${reason}`);
    this.name = "SlackTimelineError";
    this.code = code;
    this.reason = reason;
    if (diagnostics) this.diagnostics = Object.freeze({ ...diagnostics });
    Object.defineProperty(this, ERROR_BRAND, { value: true, enumerable: false });
  }
}

/**
 * True only for an error this contract constructed. A look-alike object that merely carries a
 * `name` and a `code` is not a failure class: callers treat it as an opaque dependency failure.
 */
export function isSlackTimelineError(error: unknown): error is SlackTimelineError {
  return error instanceof Error && (error as unknown as Record<symbol, unknown>)[ERROR_BRAND] === true &&
    FAILURES.has((error as SlackTimelineError).code);
}

function fail(code: SlackTimelineFailure, reason: string): never {
  throw new SlackTimelineError(code, reason);
}

export const SLACK_TIMELINE_CURSOR = Object.freeze({
  schemaVersion: 1,
  aad: "aios/slack-timeline-cursor/v1",
  maxEncodedBytes: 16 * 1024,
  ttlMs: 900_000,
  keyBytes: 32,
  nonceBytes: 12,
  tagBytes: 16,
});

/** Windows the contract can bind. The v1 drain permits seven days only. */
export const SLACK_TIMELINE_WINDOW_DAYS: readonly number[] = Object.freeze([7, 14, 21, 28, 30]);

export const SLACK_TIMELINE_PAGE_SIZE = Object.freeze({ min: 1, max: 512, default: 128 });

const DAY_MS = 86_400_000;
const WIRE_VERSION = 1;
const PROVIDER_IDENTITY_BYTES = 256;
const COMPACT_AGGREGATE_BYTES = 2048;

export interface SlackAggregateTuple {
  day: string;
  at: string;
  itemId: string;
  memberId: string;
}

export interface SlackTimelineBinding {
  schemaVersion: 1;
  teamId: string;
  principalKey: string;
  viewKey: string;
  admissionBindingDigest: string;
  sourceAdmissionBindingDigest: string;
  authorizedSlackItemFingerprint: string;
  windowDays: number;
  since: string;
  asOf: string;
  issuedAt: string;
  expiresAt: string;
  pageSize: number;
  dataGeneration: string;
  identityGeneration: string;
  presentationGeneration: string;
  creditInputDigest: string;
  presentationInputDigest: string;
}

export interface SlackTimelineCursorPayload extends SlackTimelineBinding {
  lastAggregateTuple: SlackAggregateTuple;
}

/** The compact projection of one authoritative person-day: no unbounded message list. */
export interface SlackAggregate {
  id: string;
  sourceItemId: string;
  workspaceId: string;
  channelId: string;
  rootTs: string;
  memberId: string;
  day: string;
  at: string;
  messageCount: number;
  rootAuthored: boolean;
  linkMessage: { messageTs: string; occurredAt: string };
}

export interface SlackTimelinePageAggregate {
  id: string;
  tuple: SlackAggregateTuple;
}

/** The inactive page envelope. Its internal fields are not a promise to change any HTTP DTO. */
export interface SlackTimelinePage {
  days: TimelineDay[];
  window_days: number;
  asOf: string;
  binding: SlackTimelineBinding;
  aggregates: SlackTimelinePageAggregate[];
  nextSlackCursor: string | null;
  slackComplete: boolean;
  /** First page only: the frozen non-Slack snapshot's complete backing item IDs. */
  initialNonSlackSourceItemIds?: string[];
}

// ── primitive validation ─────────────────────────────────────────────────────

const LOWER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ANY_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DIGEST = /^[0-9a-f]{64}$/;
const GENERATION = /^(0|[1-9][0-9]*)$/;
const MILLI_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MICRO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const nonempty = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const isCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** A canonical millisecond UTC instant: exact shape and a real calendar instant. */
function isMilliInstant(value: unknown): value is string {
  if (typeof value !== "string" || !MILLI_INSTANT.test(value)) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

/** A six-digit-microsecond UTC instant whose millisecond prefix is a real calendar instant. */
function isMicroInstant(value: unknown): value is string {
  if (typeof value !== "string" || !MICRO_INSTANT.test(value)) return false;
  const milli = `${value.slice(0, 23)}Z`;
  const time = Date.parse(milli);
  return Number.isFinite(time) && new Date(time).toISOString() === milli;
}

function isCalendarDay(value: unknown): value is string {
  if (typeof value !== "string" || !DAY.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}

/** The microsecond rendering of a canonical millisecond instant, for fixed-width comparison. */
const microOf = (milliInstant: string): string => `${milliInstant.slice(0, 23)}000Z`;

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

const TUPLE_KEYS = ["day", "at", "itemId", "memberId"] as const;

function isTuple(value: unknown): value is SlackAggregateTuple {
  return isRecord(value) && hasExactKeys(value, TUPLE_KEYS) && isCalendarDay(value.day) && isMicroInstant(value.at) &&
    (value.at as string).slice(0, 10) === value.day && typeof value.itemId === "string" && LOWER_UUID.test(value.itemId) &&
    typeof value.memberId === "string" && LOWER_UUID.test(value.memberId);
}

const BINDING_KEYS = [
  "schemaVersion", "teamId", "principalKey", "viewKey", "admissionBindingDigest", "sourceAdmissionBindingDigest",
  "authorizedSlackItemFingerprint", "windowDays", "since", "asOf", "issuedAt", "expiresAt", "pageSize",
  "dataGeneration", "identityGeneration", "presentationGeneration", "creditInputDigest", "presentationInputDigest",
] as const;
const DIGEST_KEYS = [
  "viewKey", "admissionBindingDigest", "sourceAdmissionBindingDigest", "authorizedSlackItemFingerprint",
  "creditInputDigest", "presentationInputDigest",
] as const;
const GENERATION_KEYS = ["dataGeneration", "identityGeneration", "presentationGeneration"] as const;

/** Every bound field present, well-formed and mutually consistent. Extra keys are refused. */
function isBindingFields(value: Record<string, unknown>): boolean {
  if (value.schemaVersion !== SLACK_TIMELINE_CURSOR.schemaVersion) return false;
  if (typeof value.teamId !== "string" || !LOWER_UUID.test(value.teamId) || !nonempty(value.principalKey)) return false;
  if (DIGEST_KEYS.some((key) => typeof value[key] !== "string" || !DIGEST.test(value[key] as string))) return false;
  if (GENERATION_KEYS.some((key) => typeof value[key] !== "string" || !GENERATION.test(value[key] as string))) return false;
  if (typeof value.windowDays !== "number" || !SLACK_TIMELINE_WINDOW_DAYS.includes(value.windowDays)) return false;
  if (!Number.isSafeInteger(value.pageSize) || (value.pageSize as number) < SLACK_TIMELINE_PAGE_SIZE.min ||
      (value.pageSize as number) > SLACK_TIMELINE_PAGE_SIZE.max) return false;
  const { since, asOf, issuedAt, expiresAt } = value;
  if (!isMilliInstant(since) || !isMilliInstant(asOf) || !isMilliInstant(issuedAt) || !isMilliInstant(expiresAt)) return false;
  const asOfMs = Date.parse(asOf);
  if (issuedAt !== asOf) return false;
  if (Date.parse(since) !== asOfMs - value.windowDays * DAY_MS) return false;
  return Date.parse(expiresAt) === asOfMs + SLACK_TIMELINE_CURSOR.ttlMs;
}

function isBinding(value: unknown): value is SlackTimelineBinding {
  return isRecord(value) && hasExactKeys(value, BINDING_KEYS) && isBindingFields(value);
}

function tupleInWindow(tuple: SlackAggregateTuple, binding: { since: string; asOf: string }): boolean {
  return tuple.at >= microOf(binding.since) && tuple.at <= microOf(binding.asOf);
}

function isCursorPayload(value: unknown): value is SlackTimelineCursorPayload {
  return isRecord(value) && hasExactKeys(value, [...BINDING_KEYS, "lastAggregateTuple"]) && isBindingFields(value) &&
    isTuple(value.lastAggregateTuple) &&
    tupleInWindow(value.lastAggregateTuple, value as unknown as SlackTimelineBinding);
}

function bindingOf(value: SlackTimelineBinding): SlackTimelineBinding {
  const out: Record<string, unknown> = {};
  for (const key of BINDING_KEYS) out[key] = (value as unknown as Record<string, unknown>)[key];
  return out as unknown as SlackTimelineBinding;
}

function tupleCopy(tuple: SlackAggregateTuple): SlackAggregateTuple {
  return { day: tuple.day, at: tuple.at, itemId: tuple.itemId, memberId: tuple.memberId };
}

/** A complete, well-formed binding or `unavailable`: for server-built bindings, never client input. */
export function assertSlackTimelineBinding(value: unknown): SlackTimelineBinding {
  if (!isBinding(value)) fail("unavailable", "incomplete or malformed snapshot binding");
  return bindingOf(value as SlackTimelineBinding);
}

// ── canonical bytes and digests ──────────────────────────────────────────────

function canonical(value: unknown, depth: number): string {
  if (depth > 64) return fail("unavailable", "binding input is too deeply nested");
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    return Number.isFinite(value) ? JSON.stringify(value) : fail("unavailable", "binding input is not JSON-safe");
  }
  if (Array.isArray(value)) return `[${value.map((entry) => canonical(entry, depth + 1)).join(",")}]`;
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return fail("unavailable", "binding input is not JSON-safe");
    const record = value as Record<string, unknown>;
    const parts: string[] = [];
    for (const key of Object.keys(record).sort(compareText)) {
      // An undefined property is ABSENT. An explicit null is a value, and hashes differently.
      if (record[key] === undefined) continue;
      parts.push(`${JSON.stringify(key)}:${canonical(record[key], depth + 1)}`);
    }
    return `{${parts.join(",")}}`;
  }
  return fail("unavailable", "binding input is not JSON-safe");
}

/** Canonical JSON: recursively sorted object keys, array order kept, explicit null, no lossy values. */
export function canonicalSlackTimelineJson(value: unknown): string {
  return canonical(value, 0);
}

/** SHA-256 over the canonical bytes — never over iteration order. */
export function slackTimelineDigest(value: unknown): string {
  return createHash("sha256").update(canonicalSlackTimelineJson(value), "utf8").digest("hex");
}

/** The sorted, lowercase, duplicate-free authorized Slack item set, as one fixed-size digest. */
export function slackItemFingerprint(itemIds: Iterable<string>): string {
  if (itemIds === null || itemIds === undefined || typeof (itemIds as Iterable<string>)[Symbol.iterator] !== "function") {
    return fail("unavailable", "authorized Slack item set is not a collection");
  }
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const raw of itemIds) {
    if (typeof raw !== "string" || !ANY_UUID.test(raw)) return fail("unavailable", "authorized Slack item set holds an invalid ID");
    const id = raw.toLowerCase();
    if (seen.has(id)) return fail("unavailable", "authorized Slack item set holds a duplicate ID");
    seen.add(id);
    ids.push(id);
  }
  return slackTimelineDigest({ kind: "aios/slack-item-set/v1", ids: ids.sort(compareText) });
}

export interface SlackTimelineViewDescriptor {
  teamId: string;
  principalKey: string;
  admissionKind: string;
  view: Record<string, unknown>;
  locale: string;
  presentationPolicyVersion: string;
}

/**
 * The key of one logical view across pages, derived server-side from the complete descriptor. It is
 * never a caller's authorization assertion: grants and eligibility are bound separately.
 */
export function deriveSlackTimelineViewKey(descriptor: SlackTimelineViewDescriptor): string {
  const d = descriptor as unknown as Record<string, unknown>;
  if (!isRecord(d) || typeof d.teamId !== "string" || !ANY_UUID.test(d.teamId) || !nonempty(d.principalKey) ||
      !nonempty(d.admissionKind) || !isRecord(d.view) || !nonempty(d.locale) || !nonempty(d.presentationPolicyVersion)) {
    return fail("unavailable", "incomplete view descriptor");
  }
  return slackTimelineDigest({
    kind: "aios/slack-timeline-view/v1",
    teamId: d.teamId.toLowerCase(),
    principalKey: d.principalKey,
    admissionKind: d.admissionKind,
    view: d.view,
    locale: d.locale,
    presentationPolicyVersion: d.presentationPolicyVersion,
  });
}

// ── window and lifetime ──────────────────────────────────────────────────────

export interface SlackTimelineWindow {
  windowDays: number;
  since: string;
  asOf: string;
  issuedAt: string;
  expiresAt: string;
}

/** The fixed window of a first page: `asOf` is the initial clock, expiry fifteen minutes later. */
export function slackTimelineWindow(now: Date, windowDays: number): SlackTimelineWindow {
  if (typeof windowDays !== "number" || !SLACK_TIMELINE_WINDOW_DAYS.includes(windowDays)) {
    return fail("invalid_request", "unsupported window");
  }
  if (!(now instanceof Date)) return fail("unavailable", "wall clock did not return a date");
  const asOfMs = now.getTime();
  const sinceMs = asOfMs - windowDays * DAY_MS;
  const expiresMs = asOfMs + SLACK_TIMELINE_CURSOR.ttlMs;
  if (![asOfMs, sinceMs, expiresMs].every((time) => Number.isSafeInteger(time) && Math.abs(time) <= 8_640_000_000_000_000)) {
    return fail("unavailable", "wall clock is outside the representable range");
  }
  const window = {
    windowDays,
    since: new Date(sinceMs).toISOString(),
    asOf: new Date(asOfMs).toISOString(),
    issuedAt: new Date(asOfMs).toISOString(),
    expiresAt: new Date(expiresMs).toISOString(),
  };
  if (![window.since, window.asOf, window.expiresAt].every(isMilliInstant)) {
    return fail("unavailable", "wall clock is outside the representable range");
  }
  return window;
}

/**
 * The lifetime check, made on admission and again immediately before publication. A cursor issued
 * after the current clock (zero tolerated skew) is invalid; one at or past its expiry needs restart.
 */
export function assertSlackTimelineCursorFresh(binding: { issuedAt: string; expiresAt: string }, now: Date): void {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) fail("unavailable", "wall clock did not return a valid date");
  if (!isRecord(binding) || !isMilliInstant(binding.issuedAt) || !isMilliInstant(binding.expiresAt)) {
    fail("unavailable", "incomplete or malformed snapshot binding");
  }
  const time = now.getTime();
  if (time < Date.parse(binding.issuedAt)) fail("invalid_request", "cursor was issued after the current clock");
  if (time >= Date.parse(binding.expiresAt)) fail("restart_required", "cursor lifetime has ended");
}

// ── authenticated cursor ─────────────────────────────────────────────────────

function cursorKey(key: unknown): Uint8Array {
  if (!(key instanceof Uint8Array) || key.byteLength !== SLACK_TIMELINE_CURSOR.keyBytes) {
    return fail("unavailable", "cursor key is not configured");
  }
  return key;
}

/**
 * Seal a complete binding and last emitted tuple into an opaque token:
 * base64url( version | 12-byte nonce | AES-256-GCM ciphertext | 16-byte tag ), fixed AAD, fresh nonce.
 */
export function encodeSlackTimelineCursor(payload: SlackTimelineCursorPayload, key: Uint8Array): string {
  const secret = cursorKey(key);
  if (!isCursorPayload(payload)) return fail("unavailable", "cursor payload is incomplete or malformed");
  const plaintext = JSON.stringify({ ...bindingOf(payload), lastAggregateTuple: tupleCopy(payload.lastAggregateTuple) });
  const nonce = randomBytes(SLACK_TIMELINE_CURSOR.nonceBytes);
  const cipher = createCipheriv("aes-256-gcm", secret, nonce, { authTagLength: SLACK_TIMELINE_CURSOR.tagBytes });
  cipher.setAAD(Buffer.from(SLACK_TIMELINE_CURSOR.aad, "utf8"));
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const token = Buffer.concat([Buffer.from([WIRE_VERSION]), nonce, body, cipher.getAuthTag()]).toString("base64url");
  if (Buffer.byteLength(token, "utf8") > SLACK_TIMELINE_CURSOR.maxEncodedBytes) {
    return fail("budget_exhausted", "cursor exceeds its encoded size bound");
  }
  return token;
}

/**
 * Authenticate first, then validate strictly. Anything malformed, oversized, tampered, re-keyed or
 * of an unsupported schema is `invalid_request`; a missing key is `unavailable`. Expiry is NOT
 * judged here: an authentic expired cursor decodes, and `assertSlackTimelineCursorFresh` refuses it.
 */
export function decodeSlackTimelineCursor(token: string, key: Uint8Array): SlackTimelineCursorPayload {
  const invalid = (): never => fail("invalid_request", "cursor is malformed or cannot be verified");
  if (typeof token !== "string" || token.length === 0 || token.length > SLACK_TIMELINE_CURSOR.maxEncodedBytes ||
      !BASE64URL.test(token)) return invalid();
  const secret = cursorKey(key);
  const raw = Buffer.from(token, "base64url");
  const overhead = 1 + SLACK_TIMELINE_CURSOR.nonceBytes + SLACK_TIMELINE_CURSOR.tagBytes;
  if (raw.toString("base64url") !== token || raw.length <= overhead || raw[0] !== WIRE_VERSION) return invalid();
  const nonce = raw.subarray(1, 1 + SLACK_TIMELINE_CURSOR.nonceBytes);
  const tag = raw.subarray(raw.length - SLACK_TIMELINE_CURSOR.tagBytes);
  const body = raw.subarray(1 + SLACK_TIMELINE_CURSOR.nonceBytes, raw.length - SLACK_TIMELINE_CURSOR.tagBytes);
  let plaintext: string;
  try {
    const decipher = createDecipheriv("aes-256-gcm", secret, nonce, { authTagLength: SLACK_TIMELINE_CURSOR.tagBytes });
    decipher.setAAD(Buffer.from(SLACK_TIMELINE_CURSOR.aad, "utf8"));
    decipher.setAuthTag(tag);
    plaintext = Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
  } catch {
    return invalid();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    return invalid();
  }
  if (!isCursorPayload(parsed)) return invalid();
  return { ...bindingOf(parsed), lastAggregateTuple: tupleCopy(parsed.lastAggregateTuple) };
}

export interface SlackTimelineCursorRequest {
  teamId: string;
  principalKey: string;
  viewKey: string;
  windowDays: number;
  pageSize: number;
  authorizedSlackItemIds: ReadonlySet<string>;
}

/** A valid cursor presented with a different legitimate request — or whose item is gone — needs restart. */
export function assertSlackTimelineCursorRequest(payload: SlackTimelineCursorPayload, request: SlackTimelineCursorRequest): void {
  if (!isCursorPayload(payload)) fail("unavailable", "cursor payload is incomplete or malformed");
  if (!isRecord(request) || typeof request.teamId !== "string" || !(request.authorizedSlackItemIds instanceof Set)) {
    fail("unavailable", "incomplete continuation request");
  }
  if (payload.teamId !== request.teamId.toLowerCase() || payload.principalKey !== request.principalKey ||
      payload.viewKey !== request.viewKey || payload.windowDays !== request.windowDays ||
      payload.pageSize !== request.pageSize) {
    fail("restart_required", "cursor is bound to a different request");
  }
  if (!request.authorizedSlackItemIds.has(payload.lastAggregateTuple.itemId)) {
    fail("restart_required", "cursor item is no longer authorized");
  }
}

/**
 * Every bound field is part of the snapshot: any difference — including a generation that merely
 * moved forward — needs restart. An incomplete binding on either side is never "unchanged".
 * Either side may be an authenticated cursor payload; its tuple is not a bound value.
 */
export function assertSlackTimelineBindingUnchanged(expected: unknown, actual: unknown): void {
  const strip = (value: unknown): unknown => {
    if (!isRecord(value) || !Object.prototype.hasOwnProperty.call(value, "lastAggregateTuple")) return value;
    const rest: Record<string, unknown> = {};
    for (const key of Object.keys(value)) if (key !== "lastAggregateTuple") rest[key] = value[key];
    return rest;
  };
  const a = strip(expected);
  const b = strip(actual);
  if (!isBinding(a) || !isBinding(b)) fail("unavailable", "incomplete or malformed snapshot binding");
  for (const key of BINDING_KEYS) {
    if ((a as Record<string, unknown>)[key] !== (b as Record<string, unknown>)[key]) {
      fail("restart_required", "bound snapshot state changed");
    }
  }
}

// ── aggregate order and compaction ───────────────────────────────────────────

/** `day DESC, at DESC, itemId ASC, memberId ASC` — negative when `a` is emitted before `b`. */
export function compareSlackAggregateTuples(a: SlackAggregateTuple, b: SlackAggregateTuple): number {
  return compareText(b.day, a.day) || compareText(b.at, a.at) || compareText(a.itemId, b.itemId) ||
    compareText(a.memberId, b.memberId);
}

export const slackAggregateId = (tuple: Pick<SlackAggregateTuple, "itemId" | "memberId" | "day">): string =>
  JSON.stringify([tuple.itemId, tuple.memberId, tuple.day]);

export const slackAggregateTuple = (aggregate: Pick<SlackAggregate, "day" | "at" | "sourceItemId" | "memberId">): SlackAggregateTuple =>
  ({ day: aggregate.day, at: aggregate.at, itemId: aggregate.sourceItemId, memberId: aggregate.memberId });

const withinIdentityBound = (value: unknown): value is string =>
  nonempty(value) && Buffer.byteLength(value, "utf8") <= PROVIDER_IDENTITY_BYTES;

/** The shape of the authoritative projection this module compacts (`SlackPersonDay`). */
export interface SlackProjectedPersonDay {
  id: string;
  sourceItemId: string;
  workspaceId: string;
  channelId: string;
  rootTs: string;
  memberId: string;
  day: string;
  at: string;
  messageCount: number;
  rootAuthored: boolean;
  messages: readonly { messageTs: string; occurredAt: string }[];
}

/**
 * Compact one completed, validated person-day. The link is the surviving root this member authored
 * that day when there is one, otherwise the latest surviving message of the group (ties by message
 * id ascending). Nothing is truncated: an oversized identity or record is `unavailable`.
 */
export function compactSlackAggregate(personDay: SlackProjectedPersonDay): SlackAggregate {
  const bad = (): never => fail("unavailable", "projected Slack group is malformed");
  const p = personDay as unknown;
  if (!isRecord(p)) return bad();
  const { id, sourceItemId, workspaceId, channelId, rootTs, memberId, day, at, messageCount, rootAuthored } = p;
  if (typeof sourceItemId !== "string" || !LOWER_UUID.test(sourceItemId) || typeof memberId !== "string" ||
      !LOWER_UUID.test(memberId) || !isCalendarDay(day) || !isMicroInstant(at) || at.slice(0, 10) !== day ||
      typeof rootAuthored !== "boolean" || !Array.isArray(p.messages)) return bad();
  if (id !== JSON.stringify([sourceItemId, memberId, day])) return bad();
  if (!withinIdentityBound(workspaceId) || !withinIdentityBound(channelId) || !withinIdentityBound(rootTs)) {
    return fail("unavailable", "Slack source identity exceeds its size bound");
  }
  const messages: unknown[] = p.messages;
  if (typeof messageCount !== "number" || !Number.isSafeInteger(messageCount) || messageCount < 1 ||
      messageCount !== messages.length) return bad();

  let latest: { messageTs: string; occurredAt: string } | null = null;
  let root: { messageTs: string; occurredAt: string } | null = null;
  for (const message of messages) {
    if (!isRecord(message)) return bad();
    const { messageTs, occurredAt } = message;
    if (!nonempty(messageTs) || !isMicroInstant(occurredAt) || occurredAt.slice(0, 10) !== day) return bad();
    const candidate = { messageTs, occurredAt };
    if (latest === null || candidate.occurredAt > latest.occurredAt ||
        (candidate.occurredAt === latest.occurredAt && candidate.messageTs < latest.messageTs)) latest = candidate;
    if (candidate.messageTs === rootTs) root = candidate;
  }
  if (latest === null || latest.occurredAt !== at) return bad();
  // rootAuthored without that root among the group's surviving messages is a contradiction.
  if (rootAuthored && root === null) return bad();
  const linkMessage = rootAuthored && root !== null ? root : latest;
  if (!withinIdentityBound(linkMessage.messageTs)) return fail("unavailable", "Slack source identity exceeds its size bound");

  const compact: SlackAggregate = {
    id: id as string, sourceItemId, workspaceId, channelId, rootTs, memberId, day, at, messageCount, rootAuthored,
    linkMessage: { messageTs: linkMessage.messageTs, occurredAt: linkMessage.occurredAt },
  };
  if (Buffer.byteLength(JSON.stringify(compact), "utf8") > COMPACT_AGGREGATE_BYTES) {
    return fail("unavailable", "compact Slack group exceeds its size bound");
  }
  return compact;
}

// ── timeline shape (the shared merger's own rules, checked BEFORE it is invoked) ──

function validDayShape(day: unknown): day is TimelineDay {
  if (!isRecord(day) || !nonempty(day.date) || !nonempty(day.label) || !Array.isArray(day.people)) return false;
  return day.date === "unknown" || isCalendarDay(day.date);
}

function validPersonShape(person: unknown): person is PersonDay {
  return isRecord(person) && nonempty(person.memberId) && nonempty(person.name) && typeof person.handle === "string" &&
    isCount(person.total) && isCount(person.unlinked) && Array.isArray(person.tasks) && Array.isArray(person.other) &&
    Array.isArray(person.signals) && (person.avatarUrl === null || person.avatarUrl === undefined || typeof person.avatarUrl === "string");
}

function validTaskShape(task: unknown): task is TaskGroup {
  if (!isRecord(task) || !nonempty(task.taskId) || !nonempty(task.title) || typeof task.status !== "string" ||
      !nonempty(task.source) || !isCount(task.evidenceCount) || !Array.isArray(task.sources)) return false;
  if (task.assignee === undefined) return true;
  const assignee = task.assignee;
  return isRecord(assignee) && nonempty(assignee.name) &&
    (assignee.avatarUrl === null || assignee.avatarUrl === undefined || typeof assignee.avatarUrl === "string");
}

const SLACK_ROW_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;

function validSlackRow(item: unknown): item is EvidenceItem {
  if (!isRecord(item) || !nonempty(item.id) || !nonempty(item.title) || item.source !== "slack" || !nonempty(item.kind) ||
      typeof item.at !== "string" || !SLACK_ROW_INSTANT.test(item.at) || Number.isNaN(Date.parse(item.at))) return false;
  if (item.url !== undefined && typeof item.url !== "string") return false;
  if (item.linkVia !== undefined && !["commit-text", "pr", "inferred"].includes(item.linkVia as string)) return false;
  if (item.via !== undefined && item.via !== "submitter") return false;
  if (item.linkedTask === undefined) return true;
  const linked = item.linkedTask;
  return isRecord(linked) && nonempty(linked.key) && nonempty(linked.title) && typeof linked.status === "string";
}

function validInitialGroups(groups: unknown): groups is SourceGroup[] {
  if (!Array.isArray(groups)) return false;
  for (const group of groups) {
    if (!isRecord(group) || !nonempty(group.source) || !isCount(group.count) || !Array.isArray(group.items)) return false;
    if (group.source === "slack" && (group.count !== group.items.length || !group.items.every(validSlackRow))) return false;
  }
  return true;
}

/** Days that may be merged INTO: an authorized snapshot of any sources, structurally sound and duplicate-free. */
function validExistingDays(days: unknown): days is TimelineDay[] {
  if (!Array.isArray(days)) return false;
  const dates = new Set<string>();
  for (const day of days) {
    if (!validDayShape(day) || dates.has(day.date)) return false;
    dates.add(day.date);
    const members = new Set<string>();
    for (const person of day.people) {
      if (!validPersonShape(person) || members.has(person.memberId)) return false;
      members.add(person.memberId);
      if (!person.signals.every((group) => isRecord(group) && Array.isArray(group.items))) return false;
      const tasks = new Set<string>();
      for (const task of person.tasks) {
        if (!validTaskShape(task) || tasks.has(task.taskId) || !validInitialGroups(task.sources)) return false;
        tasks.add(task.taskId);
      }
      if (!validInitialGroups(person.other)) return false;
    }
  }
  return true;
}

function validContinuationGroups(groups: unknown, date: string): groups is SourceGroup[] {
  if (!Array.isArray(groups) || groups.length === 0) return false;
  for (const group of groups) {
    if (!isRecord(group) || group.source !== "slack" || !isCount(group.count) || !Array.isArray(group.items) ||
        group.items.length === 0) return false;
    const ids = new Set<string>();
    for (const item of group.items) {
      if (!validSlackRow(item) || item.at.slice(0, 10) !== date || ids.has(item.id)) return false;
      ids.add(item.id);
    }
  }
  return true;
}

/** Days of newly returned Slack groups only: dated, non-empty, no synopsis, no signals, no other source. */
function validContinuationDays(days: unknown): days is TimelineDay[] {
  if (!Array.isArray(days)) return false;
  const dates = new Set<string>();
  for (const day of days) {
    if (!validDayShape(day) || day.date === "unknown" || dates.has(day.date) || day.people.length === 0) return false;
    dates.add(day.date);
    const members = new Set<string>();
    for (const person of day.people) {
      if (!validPersonShape(person) || members.has(person.memberId)) return false;
      members.add(person.memberId);
      if (person.summary !== undefined || person.signals.length !== 0) return false;
      if (person.tasks.length === 0 && person.other.length === 0) return false;
      const tasks = new Set<string>();
      for (const task of person.tasks) {
        if (!validTaskShape(task) || tasks.has(task.taskId) || !validContinuationGroups(task.sources, day.date)) return false;
        tasks.add(task.taskId);
      }
      if (person.other.length > 0 && !validContinuationGroups(person.other, day.date)) return false;
    }
  }
  return true;
}

interface AggregateRef {
  id: string;
  memberId: string;
  day: string;
  at: string;
}

function aggregateRefs(aggregates: unknown): Map<string, AggregateRef> {
  if (!Array.isArray(aggregates)) return fail("unavailable", "aggregate list is malformed");
  const refs = new Map<string, AggregateRef>();
  for (const aggregate of aggregates) {
    if (!isRecord(aggregate) || !nonempty(aggregate.id)) return fail("unavailable", "aggregate list is malformed");
    const source = isRecord(aggregate.tuple) ? aggregate.tuple : aggregate;
    if (!nonempty(source.memberId) || !isCalendarDay(source.day) || !isMicroInstant(source.at) || refs.has(aggregate.id)) {
      return fail("unavailable", "aggregate list is malformed");
    }
    refs.set(aggregate.id, { id: aggregate.id, memberId: source.memberId, day: source.day, at: source.at });
  }
  return refs;
}

/**
 * Every Slack row names one of `refs` under that aggregate's own member and day at its exact
 * instant, and every aggregate is rendered at least once. Task associations may repeat an ID.
 */
function assertSlackRowsCover(refs: ReadonlyMap<string, AggregateRef>, days: readonly TimelineDay[], slackOnly: boolean): void {
  const rendered = new Set<string>();
  for (const day of days) {
    for (const person of day.people) {
      const groups = [...person.tasks.flatMap((task) => task.sources), ...person.other];
      for (const group of groups) {
        if (group.source !== "slack") {
          if (slackOnly) fail("unavailable", "composed days carry non-Slack evidence");
          continue;
        }
        for (const item of group.items) {
          const ref = refs.get(item.id);
          if (!ref || ref.memberId !== person.memberId || ref.day !== day.date || ref.at !== item.at) {
            fail("unavailable", "composed days do not match their aggregates");
          }
          rendered.add(item.id);
        }
      }
    }
  }
  if (rendered.size !== refs.size) fail("unavailable", "composed days omit an aggregate");
}

/**
 * The composer contract: Slack-only continuation-shaped days in which every input aggregate appears
 * at least once under its own member, day and instant, and nothing else appears at all. Accepts
 * compact aggregates or page aggregate entries (`{ id, tuple }`).
 */
export function assertComposedSlackDays(input: { aggregates: readonly unknown[]; days: unknown }): void {
  if (!isRecord(input)) fail("unavailable", "composer output is malformed");
  const refs = aggregateRefs(input.aggregates);
  if (!validContinuationDays(input.days)) fail("unavailable", "composer output is malformed");
  assertSlackRowsCover(refs, input.days as TimelineDay[], true);
}

/**
 * The same coverage for an ASSEMBLED first page, whose days also hold the frozen non-Slack
 * snapshot: its Slack rows are exactly the page's aggregates, and its other sources are left alone.
 */
export function assertAssembledSlackDays(input: { aggregates: readonly unknown[]; days: unknown }): void {
  if (!isRecord(input)) fail("unavailable", "assembled days are malformed");
  const refs = aggregateRefs(input.aggregates);
  if (!validExistingDays(input.days)) fail("unavailable", "assembled days are malformed");
  assertSlackRowsCover(refs, input.days as TimelineDay[], false);
}

/**
 * The packet-owned wrapper around the unchanged shared merger. Both inputs are validated first, so
 * a malformed shape is `unavailable` before any merge; a throw from the merger call itself, after
 * those validations, is a valid-shape cross-page conflict and needs restart. Neither input is mutated.
 */
export function mergeSlackTimelineDays(existing: TimelineDay[], page: TimelineDay[]): TimelineDay[] {
  if (!validExistingDays(existing)) return fail("unavailable", "accumulated days are malformed");
  if (!validContinuationDays(page)) return fail("unavailable", "continuation days are malformed");
  let merged: TimelineDay[];
  try {
    merged = mergeTimelineSlackContinuation(existing, page);
  } catch {
    return fail("restart_required", "pages disagree about shared presentation");
  }
  return merged;
}

// ── page protocol ────────────────────────────────────────────────────────────

/**
 * Terminal and progress invariants of one successful page, judged on aggregates — never on how many
 * presentation rows or task associations they render as. `requestTuple` is the authenticated tuple
 * of the cursor that requested the page (null for a first page); `nextTuple` is the authenticated
 * tuple of `nextSlackCursor` (null when there is none).
 */
export function assertSlackTimelinePageProtocol(input: {
  page: unknown;
  requestTuple: SlackAggregateTuple | null;
  nextTuple: SlackAggregateTuple | null;
}): void {
  const violation = (): never => fail("unavailable", "page violates the continuation protocol");
  if (!isRecord(input)) return violation();
  const page: unknown = input.page;
  const requestTuple: unknown = input.requestTuple;
  const nextTuple: unknown = input.nextTuple;
  if (!isRecord(page)) return violation();
  const binding: unknown = page.binding;
  if (!isBinding(binding) || !Array.isArray(page.days) || !Array.isArray(page.aggregates) ||
      typeof page.slackComplete !== "boolean") return violation();
  if (page.window_days !== binding.windowDays || page.asOf !== binding.asOf) return violation();
  if (page.nextSlackCursor !== null && !nonempty(page.nextSlackCursor)) return violation();
  if (page.slackComplete !== (page.nextSlackCursor === null)) return violation();
  const request: SlackAggregateTuple | null = requestTuple === null ? null : isTuple(requestTuple) ? requestTuple : violation();
  const next: SlackAggregateTuple | null = nextTuple === null ? null : isTuple(nextTuple) ? nextTuple : violation();

  const aggregates = page.aggregates as unknown[];
  if (aggregates.length > binding.pageSize) return violation();
  // A nonterminal page is full: scanning must fill it or fail. A terminal page holds 0..pageSize.
  if (!page.slackComplete && aggregates.length !== binding.pageSize) return violation();

  const ids = new Set<string>();
  let previous: SlackAggregateTuple | null = request;
  for (const entry of aggregates) {
    if (!isRecord(entry)) return violation();
    const tuple: unknown = entry.tuple;
    if (!isTuple(tuple) || entry.id !== slackAggregateId(tuple) || ids.has(entry.id as string)) return violation();
    ids.add(entry.id as string);
    if (!tupleInWindow(tuple, binding)) return violation();
    // Strictly after the request cursor and after every earlier aggregate of the page.
    if (previous !== null && compareSlackAggregateTuples(previous, tuple) >= 0) return violation();
    previous = tuple;
  }

  if (page.slackComplete) {
    if (next !== null) return violation();
    return;
  }
  // The authenticated next cursor is exactly the last EMITTED tuple (`previous`, as the page is full).
  if (next === null || previous === null || compareSlackAggregateTuples(next, previous) !== 0) return violation();
}
