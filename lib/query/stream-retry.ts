/**
 * Bounded retry for the streaming answer path (QSTREAMRETRY-1).
 *
 * Pure + injectable (no real clock in the hot logic) so the retry schedule, the error
 * classifier, and the client-facing message are all unit-testable. `lib/query/claude.ts`
 * wraps its per-attempt generator with `withStreamRetry`; the route uses `clientErrorMessage`
 * to sanitize what reaches the browser.
 *
 * The one invariant that makes retry SAFE here: we only re-run the upstream call when NOTHING
 * has been streamed to the client yet. Once a delta has been yielded, restarting would
 * duplicate/garble the visible answer, so we rethrow instead. Mid-stream resume is a different
 * feature (QBGSTREAM-1), not this.
 */

/**
 * A provider non-2xx from the OpenAI-compatible path, carrying the status so it can be
 * classified without scraping the message string. Mirrors `LlmHttpError` in lib/llm/complete.ts
 * (kept separate to avoid coupling the streaming path to that module).
 */
export class StreamHttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "StreamHttpError";
  }
}

/**
 * HTTP statuses worth retrying: rate-limit (429), Anthropic "overloaded" (529), and the
 * transient 5xx family + request-timeout/conflict. Deliberately EXCLUDES 4xx auth/validation
 * (401/403/404/422) and the token-limit 400 (already handled by the token-limit ladder in
 * lib/query/claude.ts) — retrying those just burns latency on a permanent error.
 */
export const RETRYABLE_STATUS: ReadonlySet<number> = new Set([408, 409, 429, 500, 502, 503, 504, 529]);

/** Connection/transport failures that carry no HTTP status but are still worth one more try. */
const RETRYABLE_MESSAGE =
  /APIConnection|ECONNRESET|ETIMEDOUT|EPIPE|ENOTFOUND|EAI_AGAIN|socket hang ?up|fetch failed|network error|connection (?:error|reset|closed)|\boverloaded\b/i;

/**
 * True iff `err` is a transient failure worth retrying (before any delta has been emitted).
 * Status-first (StreamHttpError / SDK APIError both expose `.status`), then a narrow
 * connection/overloaded message fallback. False for anything else — a non-retryable error
 * must surface immediately, not after N wasted attempts.
 */
export function isRetryableStreamError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const status = (err as { status?: unknown }).status;
  if (typeof status === "number" && RETRYABLE_STATUS.has(status)) return true;
  const statusCode = (err as { statusCode?: unknown }).statusCode;
  if (typeof statusCode === "number" && RETRYABLE_STATUS.has(statusCode)) return true;
  const name = typeof (err as { name?: unknown }).name === "string" ? (err as { name: string }).name : "";
  const message = typeof (err as { message?: unknown }).message === "string" ? (err as { message: string }).message : "";
  return RETRYABLE_MESSAGE.test(`${name} ${message}`);
}

/** Attempts including the first: 1 try + 2 retries. */
export const DEFAULT_STREAM_ATTEMPTS = 3;
const BASE_RETRY_DELAY_MS = 400;
const MAX_RETRY_DELAY_MS = 5_000;

/**
 * Delay before the next attempt given the number of the attempt that just failed (1-based).
 * Pure exponential (400ms, 800ms, 1600ms, …) capped at MAX_RETRY_DELAY_MS, so even a full run
 * of retries adds well under a second or two — comfortably inside the route's 120s ceiling.
 */
export function streamRetryDelayMs(failedAttempt: number): number {
  const n = Math.max(1, Math.floor(failedAttempt));
  const exp = Math.min(n - 1, 20); // cap the exponent before shifting
  return Math.min(BASE_RETRY_DELAY_MS * 2 ** exp, MAX_RETRY_DELAY_MS);
}

/**
 * A friendly, SANITIZED message for the browser. Never includes the underlying error text —
 * the raw message carries the internal model + base URL (`LLM <model> @ <baseUrl>: …`), which
 * must not leak to the client. The real error is logged server-side by the caller.
 */
export function clientErrorMessage(err: unknown): string {
  if (isRetryableStreamError(err)) {
    return "The model was busy or briefly unavailable. Please try again in a moment.";
  }
  return "Something went wrong answering your question. Please try again.";
}

export interface StreamRetryOptions {
  /** Total attempts including the first. Default DEFAULT_STREAM_ATTEMPTS. */
  maxAttempts?: number;
  /** Backoff before the next attempt, given the failed attempt number. Default streamRetryDelayMs. */
  delayMs?: (failedAttempt: number) => number;
  /** Injectable sleep (tests pass a no-op). Default real setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** Observability hook fired just before each retry sleep (e.g. server-side logging). */
  onRetry?: (info: { attempt: number; error: unknown; delayMs: number }) => void;
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run `makeStream()`, yielding its events. If it throws BEFORE any "committed" event
 * (`isCommitted` → a delta) was yielded, the error is retryable, and attempts remain, back off
 * and re-run a FRESH `makeStream()`. Once a committed event has been yielded — or the error is
 * non-retryable, or attempts are exhausted — rethrow. Generic over the event type so this file
 * has no dependency on the concrete stream module.
 */
export async function* withStreamRetry<T>(
  makeStream: () => AsyncGenerator<T>,
  isCommitted: (event: T) => boolean,
  opts: StreamRetryOptions = {}
): AsyncGenerator<T> {
  const maxAttempts = Math.max(1, opts.maxAttempts ?? DEFAULT_STREAM_ATTEMPTS);
  const delayMs = opts.delayMs ?? streamRetryDelayMs;
  const sleep = opts.sleep ?? realSleep;

  for (let attempt = 1; ; attempt++) {
    let emitted = false;
    try {
      for await (const event of makeStream()) {
        if (isCommitted(event)) emitted = true;
        yield event;
      }
      return; // completed cleanly
    } catch (err) {
      // Safe to retry ONLY when nothing has been streamed yet, the error is transient, and we
      // have another attempt left. Any of those failing → surface the error.
      if (emitted || attempt >= maxAttempts || !isRetryableStreamError(err)) {
        throw err;
      }
      const ms = delayMs(attempt);
      opts.onRetry?.({ attempt, error: err, delayMs: ms });
      await sleep(ms);
    }
  }
}
