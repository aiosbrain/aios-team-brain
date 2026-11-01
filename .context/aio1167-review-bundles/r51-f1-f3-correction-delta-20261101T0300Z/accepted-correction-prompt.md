# Bounded Opus correction — R51 Fable/Astra findings

Resume only the existing sole Opus 5.5 HIGH writer session `628402d5-a1c6-42b7-b736-e84358c1a749` after the coordinator confirms it is idle and fresh first-party Claude `/usage` is below 90% in every applicable window. Do not create another writer/session or change models.

Read `accepted-spec.md`, `accepted-adjudication.md`, `astra-adjudication-result.md`, the current manifest, and the focused tests before editing. Treat Astra's three accepted dispositions as the complete scope for this turn. Preserve user changes, the exact base and one-writer ownership. Do not edit docs, unrelated source, or identity/tombstone ownership; do not run commands/tests, commit, push, or dispatch reviews. Return a concise changed-file list, behavior summary, and test cases added/adjusted so the coordinator can independently verify and checkpoint.

## F1 — Keep deferred enumeration debt through ordinary uncertainty (High)

In `state.py`, make `mark_root_uncertain` preserve an existing `ROOT_DEFERRED_PREFIX` detail when adding ordinary uncertainty. Do not add schema/protocol. Metadata recovery alone must not settle an unlisted root; only actual listing completion, relocation/rebind, or verified unavailable transition may discharge the debt.

Add regressions that defer a folder, inject a non-deferral metadata error, reopen SQLite, then recover metadata. Assert the deferred marker survives, metadata alone does not settle it, nested/paginated children are listed before complete reconciliation, existing claims survive, and last-success remains unchanged until completion. Exercise the change-page uncertainty caller and retain ordinary-uncertainty recovery as a control.

## F2 — Journal watch Retry-After before RETIRED publication (Medium)

In `_create`'s `WatchQuotaLimited` path in `watch_renewal.py`, synchronously record the existing monotonic `hold_connection` before awaiting RETIRED publication. On success, use the existing quota handling/shared restriction publication; a duplicate monotonic journal write is safe. If RETIRED publication fails, times out/lost-acks, or is refused, retain the local hold and terminate the connection run without projecting the unacknowledged document, dispatching another watch call, or masking the original exception/cancellation. Defer shared restriction publication to fresh acquisition. Do not use an unconditional `finally` that replaces the original outcome.

Add exact-boundary regressions for delivery failure, authority refusal, timeout/lost acknowledgment, and cancellation. Assert the hold is present before checkpoint invocation; no second create/stop call; reopened SQLite blocks poll and renewal; fresh acquisition repairs publication; predecessor/cursor/cleanup remain unchanged; lease release occurs; failed retirement is not projected as acknowledged; and uncertain dispatch does not become active during recovery.

## F3 — Do not metadata-probe a previously deferred closed root (Medium)

In the baseline folder loop, when a root was already deferred and its current traversal is closed, keep it deferred and skip metadata observation in this build. Let existing admissibility start a controlled replacement snapshot. Do not rewrite committed placeholder pages. That replacement snapshot should enumerate a present root or settle a verified 404 as empty.

Add a restart regression: retain membership, defer root A while sibling B keeps the build open, then return 404 for A without per-document changes. Assert no complete reconciliation or last-success advancement with stale A membership, that a controlled replacement snapshot runs, A is not listed after verified 404, and only A's unsupported membership disappears. Preserve direct/other-root selections and another connection's claim. Keep non-404, restricted-root, and explicit-trash controls.

Make only the smallest changes needed to satisfy these contracts and focused regressions. Report ambiguities without broadening scope; do not weaken existing authority, quota, retry, checkpoint, or authorization protections.
