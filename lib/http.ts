import "server-only";

/**
 * Default timeout for outbound connector HTTP (audit M8). Connectors previously called `fetch`
 * with no timeout, so a stalled upstream (Slack/GitHub/Linear/Plane hanging the socket) would await
 * forever — and because the ingest loop's single-flight `running` flag is released in a `finally`,
 * a never-settling fetch left it stuck `true`, silently wedging every later tick. A timeout makes the
 * fetch reject, the `finally` runs, and the connector recovers on the next tick.
 */
export const INGEST_FETCH_TIMEOUT_MS = Number(process.env.INGEST_FETCH_TIMEOUT_MS ?? 30_000);

/**
 * `fetch` drop-in that applies INGEST_FETCH_TIMEOUT_MS when the caller didn't pass its own signal.
 * Matches `typeof fetch`, so it's a safe default for the connectors' injectable `fetchImpl`.
 */
export const timeoutFetch: typeof fetch = (input, init) =>
  fetch(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(INGEST_FETCH_TIMEOUT_MS) });
