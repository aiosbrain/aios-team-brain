/**
 * Request-admission bounds for `POST /api/v1/codebases` (AUDITFIX-17 / AIO-1136).
 *
 * WHY A COUNT BOUND AND NOT ONLY A TRANSPORT ONE. `lib/codebases/ingest` writes the codebase and
 * the metrics snapshot and then projects EVERY element of `metrics.recent_commits` through
 * `ingestItem`, one synchronous write each. The Python scanner is already bounded — it appends
 * only while `len(recent) < 20` (`ingestion/aios_ingest/analyzers/codebase.py`) — but the HTTP
 * boundary was not, so a valid team-tier key could hand the ingest owner an arbitrary number of
 * commits. This is an admitted-work bound; it is not a claim that the scanner ever emitted more.
 *
 * WHY 100. Explicit engineering headroom: five times the scanner's current 20, which keeps every
 * scan this fleet produces comfortably inside the ceiling while making direct-client
 * amplification finite. It is NOT a benchmark, a latency guarantee, or a fleet concurrency
 * allocation — none of those are measured. A future scanner may widen its window within it.
 *
 * WHY 2,400,000 BYTES. It is the ceiling the route already had: the old gate compared
 * `Content-Length` against `2_000_000 * 1.2` while reporting "max 2 MB". The number is unchanged
 * and now honest — what changed is that it is MEASURED off the body rather than believed from a
 * header a chunked request never sends.
 *
 * Both bounds are INCLUSIVE, and both are published in the shared admission supplement
 * (canonical: `aios-workspace/docs/contract/codebase-request-limits-v1.json`; vendored at
 * `test/fixtures/contract/codebase-request-limits-v1.json`). The supplement is versioned on its
 * own `revision` and deliberately does NOT bump the member API version — see
 * `test/guards/codebase-request-limits-contract.test.ts`, which runs the published boundary cases
 * through the real schema rather than comparing these constants to themselves.
 */

/** Inclusive ceiling on `metrics.recent_commits`, counted BEFORE normalization/deduplication. */
export const MAX_RECENT_COMMITS = 100;

/**
 * Inclusive ceiling on the bytes exposed by `Request.body`, including JSON syntax, whitespace and
 * unknown fields. Raw bytes — not decoded character count.
 */
export const MAX_SCAN_BODY_BYTES = 2_400_000;

/**
 * `route.ts` answers with `issues[0].message` verbatim and drops the issue `path`, so the field,
 * the ceiling and the recovery all have to be inside the message or the 422 is undiagnosable.
 *
 * The advice is a SMALLER WINDOW, never two pushes: `code_metrics` upserts on
 * `(codebase_id, head_sha)` and REPLACES the row, so a second push of the same snapshot would
 * silently discard the first half rather than append to it.
 */
export const RECENT_COMMITS_LIMIT_MESSAGE = `metrics.recent_commits: at most ${MAX_RECENT_COMMITS} entries per scan; send a complete scan with a smaller recent-commit window; do not split a snapshot across pushes`;

/** Same posture for the transport bound: name the ceiling and the recovery, never just "too big". */
export const SCAN_BODY_LIMIT_MESSAGE = `body: at most ${MAX_SCAN_BODY_BYTES} bytes per scan; reduce the scan payload and retry; do not split a snapshot across pushes`;
