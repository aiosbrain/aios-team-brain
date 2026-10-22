/**
 * One marker for the maintenance refusals a RETRY CANNOT FIX.
 *
 * `stopAndVerifyAll` (both adapters) polls a LISTING and re-requests a stop until its deadline. That
 * loop is the right place to absorb a transient stop-request failure — measured on 2026-09-07, the
 * first bootstrap stop returned `409 stop-unverified` 7,049 ms in because containment was still
 * finishing, and the very next poll would have observed the workload gone. The request throwing out
 * of the loop turned a recoverable moment into a failed refresh.
 *
 * But "retry until the deadline" must NOT swallow a refusal that is a statement about IDENTITY or
 * STATE rather than timing: a deployment outside the pinned app/Graphiti allowlist, or a status with
 * no safe stop transition, cannot become stoppable by waiting, and burning the whole deadline before
 * reporting it would replace a correct, fast refusal with a two-minute hang and a worse message.
 *
 * So those two are marked here and rethrown immediately; everything else is retried within the
 * existing bound. Nothing about what counts as STOPPED changes: the listing remains the sole
 * arbiter, so absorbing a failed request can never manufacture a success.
 */

export const NON_RETRYABLE_MAINTENANCE_REFUSAL = "staging-ops-non-retryable-refusal";

/** An error that the bounded stop loop must surface immediately rather than retry. */
export function nonRetryableRefusal(message) {
  return Object.assign(new Error(message), { code: NON_RETRYABLE_MAINTENANCE_REFUSAL });
}

export function isNonRetryableRefusal(error) {
  return Boolean(error && typeof error === "object" && error.code === NON_RETRYABLE_MAINTENANCE_REFUSAL);
}
