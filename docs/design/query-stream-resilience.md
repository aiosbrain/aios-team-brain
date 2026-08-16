# Query stream resilience — bounded retry before first delta (QSTREAMRETRY-1)

Status: proposed · Owner: chetan · Tier build-with: unit (pure logic)

## Problem

A dashboard query fails on the *first* try and works on retry. Root cause (verified in
the merged tree):

- The streaming answer path has **no app-level retry**. `lib/query/claude.ts`
  `streamAnswer` (Anthropic) has zero retry, and `streamOpenAICompatible` retries only a
  **token-limit** 400/422 (`looksLikeTokenLimit`). Any 429 / 529 "overloaded" / 5xx /
  mid-stream disconnect throws straight out.
- `app/api/dashboard/query/route.ts` catches it and emits the **raw** `e.message` over the
  `error` SSE event — which for the OpenAI path is
  `LLM <model> @ <baseUrl>: 529 <body>`, i.e. it both reads as a bare "Query failed" to the
  user **and leaks the internal model + base URL** to the client.

So a single transient upstream blip is a hard, user-visible failure. Retrying seconds later
usually just works (calmer provider + a warm prompt cache) — which is exactly the reported
"failed once, worked on retry" signature.

## Decision

Add a **bounded retry-with-backoff** wrapper around the answer stream that retries **only
before the first delta has been emitted to the client**, for **transient** errors, across
**both** backends; and **sanitize** the terminal client message.

Why "before the first delta": once any answer text has been streamed to the browser,
restarting the upstream call would duplicate or corrupt the visible answer. Pre-first-delta
failure is the safe, common case (connection refused, immediate 429/529, empty error frame
before any token) and it covers the reported failure. A restart there is invisible to the
user — they just wait a beat longer.

Concretely:

1. `lib/query/stream-retry.ts` (new, pure, unit-tested):
   - `StreamHttpError(status, message)` — an `Error` carrying `.status` so the OpenAI path's
     non-2xx failures can be classified without string-scraping.
   - `isRetryableStreamError(err)` — true for `{408,409,429,500,502,503,504,529}` (by
     `.status`/`.statusCode`) and for connection/`overloaded`-shaped errors (Anthropic
     `APIConnectionError`, `ECONNRESET`, `fetch failed`, "overloaded", …). **False** for
     4xx auth/validation (401/403/404/422) and token-limit 400 (already handled upstream).
   - `streamRetryDelayMs(attempt)` — pure exponential backoff (≈400ms, 800ms, capped a few
     seconds), so total added latency stays well inside `maxDuration = 120`.
   - `clientErrorMessage(err)` — a friendly, **sanitized** message: a "the model was busy —
     try again in a moment" line for transient/overload errors, a generic "something went
     wrong" otherwise. Never contains the model name or base URL.
   - `withStreamRetry(makeStream, opts)` — the higher-order retry generator (injectable
     `sleep`/`delayMs` for deterministic tests): re-invokes `makeStream()` on a retryable
     pre-first-delta failure up to `maxAttempts` (default 3); rethrows once any delta was
     yielded, the error is non-retryable, or attempts are exhausted.

2. `lib/query/claude.ts`:
   - The OpenAI path throws `StreamHttpError` (same message text, so existing tests hold).
   - Extract the current body into `streamAnswerOnce`; `streamAnswer` becomes
     `withStreamRetry(() => streamAnswerOnce(...), retryOpts)`.
   - The Anthropic client is constructed with `maxRetries: 0` so this wrapper is the single,
     uniform retry owner across both backends (no double-retry).

3. `app/api/dashboard/query/route.ts`:
   - The stream `catch` logs the **real** error server-side (diagnosis is not lost) and
     sends `clientErrorMessage(e)` to the client instead of the raw message.

## Explicitly NOT in this slice (named next work)

- **Per-attempt / first-token timeout** to abort a *stalled* (not errored) upstream and
  retry. This addresses the cold-prompt-cache "slow first run" cause, but safely racing an
  async generator against a timer (without leaking the underlying stream) deserves its own
  slice + review. Retry already covers the transient-error and pre-delta-disconnect causes.
- **Mid-stream reattach / resume after a delta has been sent** — that is the background-job
  work in **QBGSTREAM-1** (Q2), not here.
- The `/sync` command's error path (`syncResponse`) — a different, non-LLM surface.

## What would falsify this

- A pre-first-delta 529/`overloaded`/connection failure that still surfaces as a hard error
  on the first user attempt (retry not firing) → the wrapper or classifier is wrong.
- A retry firing *after* answer text was already streamed (duplicated/garbled answer) → the
  `emitted` guard is wrong.
- A 401/403/422/token-limit-400 being retried (wasted latency on a permanent error) → the
  classifier is too broad.
- The client `error` message containing the base URL or model name → sanitization failed.
