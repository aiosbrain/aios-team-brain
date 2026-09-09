import "server-only";
import type { DbClient } from "@/lib/db/types";
import { INGEST_FETCH_TIMEOUT_MS } from "@/lib/http";
import { runContextTransaction } from "@/lib/projects/context/transaction";
import {
  extendSlackMethodBackoff,
  parseRetryAfterMs,
  reserveSlackMethodSlot,
  slackMethodPageLimit,
  type SlackBudgetedMethod,
  type SlackMethodScope,
} from "@/lib/ingest/slack-method-budget";
import type { SlackMessage } from "./slack";

/**
 * ONE reserved Slack request. The transport half of the durable method budget (AIO-1170).
 *
 * ⚠️ WHAT IT DOES: reserves a slot in its OWN short transaction, waits for that transaction to
 * COMMIT, and only then sends exactly one HTTP request. What it does not do: aggregate pages, follow
 * a cursor, decide whether a page completed anything, retry, sleep, or store a single byte. The
 * caller — a later channel/thread worker — owns all of that, and this module is deliberately unable
 * to help it, because a helper that quietly paged would defeat the per-request budget it exists to
 * respect.
 *
 * The ordering is the point, and it is the one thing a test must pin:
 *
 *  1. RESERVE, THEN COMMIT, THEN FETCH. A request Slack has already counted must survive a crash of
 *     the process that made it. Reserving inside a transaction that is still open when the request
 *     goes out means a crash — or a rollback — refunds a slot the provider will not.
 *  2. NO CALLER TRANSACTION CROSSES THE NETWORK. This takes a `DbClient`, never a
 *     `TransactionSession`: an uncommitted caller transaction handed to a network helper would hold
 *     DB locks across a round trip, and its rollback would erase the reservation while the request
 *     is in flight. Composing a reservation into a bigger transaction is legitimate — that is what
 *     `reserveSlackMethodSlot` is for — but then the caller, not this module, must not fetch.
 *  3. A DENIED RESERVATION SENDS ZERO REQUESTS. `deferred` returns before `fetchImpl` is touched.
 *  4. A 429 IS RECOGNISED BEFORE THE BODY IS PARSED. Slack's rate-limit response is frequently not
 *     JSON at all; requiring a parse first turns a cooldown into a parse error, and the cooldown is
 *     then never persisted.
 *  5. NO SLOT IS EVER REFUNDED. A timeout, a socket error or a malformed body leaves the reservation
 *     consumed. The provider counted the request; handing the slot back is how a failing worker
 *     becomes an unmetered request loop.
 *
 * DIAGNOSTICS CARRY CATEGORIES, NEVER CONTENT. No result, error or thrown value here contains the
 * token, a header, or the response body — a `category` is a short sanitized code, the same
 * discipline as `slack_sync_threads.last_error_code`. An unrecognised provider code is admitted only
 * if it already matches that shape; anything else becomes `provider_error`, because the alternative
 * is copying arbitrary provider text into every log that records the failure.
 */

const SLACK_API = "https://slack.com/api";

/** Sanitized failure CATEGORY shape: lower-case, underscore-separated, short. Never a message. */
const CATEGORY = /^[a-z][a-z0-9_]{0,39}$/;

/**
 * Slack error codes that mean THE CREDENTIAL OR ITS SCOPES, not a transient fault. They are called
 * out because the caller's response differs in kind: a blocked configuration needs an operator, and
 * retrying it on a schedule burns budget forever without ever succeeding.
 */
const AUTH_ERRORS = new Set([
  "invalid_auth",
  "not_authed",
  "account_inactive",
  "token_revoked",
  "token_expired",
  "no_permission",
  "missing_scope",
  "not_allowed_token_type",
  "ekm_access_denied",
]);

export interface SlackRequestContext {
  /**
   * The app's transaction-capable client. NOT a `TransactionSession` — see property 2 in the header.
   */
  readonly db: DbClient;
  readonly scope: SlackMethodScope;
  /** Used for exactly one thing: the `Authorization` header. It is never logged or returned. */
  readonly token: string;
}

/** The provider's page, preserved. Nothing here is aggregated, advanced or judged complete. */
export interface SlackPage {
  /** Verbatim `messages`, when the method returns them. Absent (not `[]`) when it does not. */
  readonly messages?: SlackMessage[];
  /** `has_more` exactly as sent; absent is false, which is what Slack means by omitting it. */
  readonly hasMore: boolean;
  /** `response_metadata.next_cursor`; Slack's empty string means "no more" and reads as null. */
  readonly nextCursor: string | null;
}

export type SlackRequestResult =
  /** The local budget refused. No request was sent. */
  | {
      readonly outcome: "deferred";
      readonly method: SlackBudgetedMethod;
      readonly nextPermittedAt: string;
      readonly retryAfterMs: number;
    }
  /** HTTP 429. The cooldown is already PERSISTED on the same bucket before this returns. */
  | {
      readonly outcome: "rate_limited";
      readonly method: SlackBudgetedMethod;
      readonly category: "rate_limited";
      readonly nextPermittedAt: string;
      readonly retryAfterMs: number;
    }
  /** The credential or its scopes. Retrying on a timer cannot fix it. */
  | { readonly outcome: "auth_error"; readonly method: SlackBudgetedMethod; readonly category: string }
  /** Slack answered and said no, for a reason that is not about the credential. */
  | { readonly outcome: "provider_error"; readonly method: SlackBudgetedMethod; readonly category: string }
  /** We never got a readable answer: timeout, socket failure, or a body that is not JSON. */
  | { readonly outcome: "transport_error"; readonly method: SlackBudgetedMethod; readonly category: string }
  /** Slack said ok. `body` is the parsed response; `page` is the paging trio, when present. */
  | {
      readonly outcome: "ok";
      readonly method: SlackBudgetedMethod;
      readonly body: Record<string, unknown>;
      readonly page: SlackPage;
    };

export interface SlackRequestOptions {
  /** Injectable transport, per the existing connector convention (`slack-validate.ts`). */
  readonly fetchImpl?: typeof fetch;
}

/**
 * Only `string` parameter values, and no `limit` from the caller for a paged method — the page size
 * is policy, not a call-site choice (see `applyPageLimit`).
 */
export type SlackRequestParams = Readonly<Record<string, string>>;

class SlackPageRequestError extends TypeError {
  constructor(message: string) {
    super(`slack page request: ${message}`);
    this.name = "SlackPageRequestError";
  }
}

/**
 * Clamp the page size for the two paged methods, and set it when the caller omitted one.
 *
 * `Math.min`, not an overwrite: a DELETION CONFIRMATION asks `conversations.replies` for `limit=1`,
 * and that request must stay a one-message probe rather than being inflated to a 15-message page. A
 * caller asking for more than the policy allows is silently reduced — the budget is not negotiable,
 * and throwing would only move the same decision to every call site.
 */
function applyPageLimit(
  method: SlackBudgetedMethod,
  params: SlackRequestParams
): Record<string, string> {
  const cap = slackMethodPageLimit(method);
  const out: Record<string, string> = { ...params };
  if (cap === null) return out;
  const requested = Number(out.limit);
  const effective = Number.isSafeInteger(requested) && requested > 0 ? Math.min(requested, cap) : cap;
  out.limit = String(effective);
  return out;
}

/** A provider code is usable as a category only if it already has the shape of one. */
function categoryOf(code: unknown, fallback: string): string {
  return typeof code === "string" && CATEGORY.test(code) ? code : fallback;
}

function assertToken(token: unknown): void {
  // Shape only, and the value is NEVER quoted back: this is the one argument whose contents are the
  // hazard, exactly as with the sanitized reason codes elsewhere in this feature.
  if (typeof token !== "string" || token.trim() === "") {
    throw new SlackPageRequestError(
      "token must be a non-empty string. Its value is deliberately omitted from this message."
    );
  }
}

function assertParams(params: SlackRequestParams): void {
  for (const [key, value] of Object.entries(params ?? {})) {
    if (typeof value !== "string") {
      throw new SlackPageRequestError(
        `parameter ${JSON.stringify(key)} must be a string (got ${typeof value})`
      );
    }
  }
}

/** The paging trio, read off whatever Slack returned. Absent fields are absent, never invented. */
function readPage(body: Record<string, unknown>): SlackPage {
  const messages = Array.isArray(body.messages) ? (body.messages as SlackMessage[]) : undefined;
  const metadata = body.response_metadata;
  const rawCursor =
    metadata && typeof metadata === "object"
      ? (metadata as { next_cursor?: unknown }).next_cursor
      : undefined;
  const nextCursor = typeof rawCursor === "string" && rawCursor !== "" ? rawCursor : null;
  return {
    // A successful empty array IS provider data — "this page has no messages" — and must stay
    // distinguishable from a method that returns no messages at all. Neither is a failure fallback.
    ...(messages === undefined ? {} : { messages }),
    hasMore: body.has_more === true,
    nextCursor,
  };
}

/**
 * Reserve a slot, commit, then send exactly one Slack request.
 *
 * Every failure that is not a DB failure comes back as a typed outcome; a DB failure REJECTS. That
 * asymmetry is deliberate and load-bearing on the 429 path: if the cooldown cannot be persisted, the
 * caller must see the database error, because reporting an empty page or a plain rate-limit result
 * would send the next request straight back into the cooldown Slack just asked for.
 */
export async function slackReservedRequest(
  context: SlackRequestContext,
  method: SlackBudgetedMethod,
  params: SlackRequestParams = {},
  options: SlackRequestOptions = {}
): Promise<SlackRequestResult> {
  assertToken(context?.token);
  assertParams(params);
  const fetchImpl = options.fetchImpl ?? fetch;

  // ── 1. reserve, in its own SHORT transaction, and wait for the commit ──────────────────────────
  // `runContextTransaction` resolves only after COMMIT, so awaiting it is what "the reservation is
  // durable" means here. Nothing below runs until it does; a SQL failure rejects out of this
  // function without a request having been made.
  const reservation = await runContextTransaction(context.db, (session) =>
    reserveSlackMethodSlot(session, context.scope, method)
  );
  if (reservation.outcome === "deferred") {
    return {
      outcome: "deferred",
      method,
      nextPermittedAt: reservation.nextPermittedAt,
      retryAfterMs: reservation.retryAfterMs,
    };
  }

  // ── 2. exactly one request ────────────────────────────────────────────────────────────────────
  const query = new URLSearchParams(applyPageLimit(method, params)).toString();
  const url = `${SLACK_API}/${method}${query ? `?${query}` : ""}`;

  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${context.token}` },
      // The existing connector deadline. No retry loop and no sleep: a wake is a bounded slice of
      // work, and waiting inside it is how one stalled socket eats the whole slice.
      signal: AbortSignal.timeout(INGEST_FETCH_TIMEOUT_MS),
    });
  } catch (error) {
    // The slot stays consumed. Whether Slack served the request before the socket died is not
    // knowable from here, and guessing "it did not" is what turns a flapping network into a flood.
    return { outcome: "transport_error", method, category: transportCategory(error) };
  }

  // ── 3. 429 BEFORE any JSON is required ────────────────────────────────────────────────────────
  if (response.status === 429) {
    const retryAfterMs = parseRetryAfterMs(response.headers?.get?.("retry-after"));
    // A SECOND short transaction. It is separate from the reservation on purpose: the reservation
    // committed before the request, so there is no open transaction to extend, and this write must
    // land on its own regardless of what the request did.
    const backoff = await runContextTransaction(context.db, (session) =>
      extendSlackMethodBackoff(session, context.scope, method, { retryAfterMs })
    );
    return {
      outcome: "rate_limited",
      method,
      category: "rate_limited",
      nextPermittedAt: backoff.nextPermittedAt,
      retryAfterMs: backoff.retryAfterMs,
    };
  }

  // ── 4. read the answer ────────────────────────────────────────────────────────────────────────
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await response.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new SlackPageRequestError("response body was not a JSON object");
    }
    body = parsed as Record<string, unknown>;
  } catch {
    // The body is NOT attached, quoted or logged: it is arbitrary remote content and may carry
    // anything. The status is a bounded, safe fact, so it becomes part of the category.
    return { outcome: "transport_error", method, category: `malformed_response_${response.status}` };
  }

  if (body.ok !== true) {
    // Two different unknowns, kept apart. NO `error` field at all is a fact about the response, and
    // the status is a bounded safe value, so it becomes the category. An `error` field that is not
    // category-shaped is arbitrary remote text — it is REPLACED, never truncated or escaped, because
    // a category is meant to be safe to put in a log line or a `last_error_code` column.
    const code =
      body.error === undefined || body.error === null
        ? `http_${response.status}`
        : categoryOf(body.error, "provider_error");
    return AUTH_ERRORS.has(code)
      ? { outcome: "auth_error", method, category: code }
      : { outcome: "provider_error", method, category: code };
  }

  return { outcome: "ok", method, body, page: readPage(body) };
}

/**
 * Why we never got an answer, as a category. `AbortSignal.timeout` rejects with a `TimeoutError`
 * DOMException, which is a different object from an ordinary socket failure and a different thing
 * for a caller to do about it — so the two are kept apart rather than folded into "network".
 */
function transportCategory(error: unknown): string {
  const name = error && typeof error === "object" ? (error as { name?: unknown }).name : undefined;
  if (name === "TimeoutError") return "timeout";
  if (name === "AbortError") return "aborted";
  return "network_error";
}
