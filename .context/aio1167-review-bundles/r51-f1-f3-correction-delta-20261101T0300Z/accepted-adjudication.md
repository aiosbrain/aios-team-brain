# Astra HIGH adjudication — Fable R51 correction findings

**Decision: ACCEPT/FIX all three findings.** F1 remains High; F2 and F3 are Medium. The adjudication was read-only; no source edits, commands, tests, or writer resumption occurred. Candidate manifest SHA-256: `419fdf79ca384e58fcd54b5a7c25da5a67c717273881ed45b1f97483825ee91a`.

## F1 — Deferred enumeration marker overwritten (High)

`state.py:1076` overwrites the deferred detail in `mark_root_uncertain`; `deferred_roots` (`state.py:1113`) and metadata-only settlement (`state.py:1136`) depend on that prefix. A non-404, non-`ProviderDeferred` root read becomes `unverified` at `gdrive_sync.py:819`, and both baseline and change-page callers can overwrite the marker (`gdrive_sync.py:2885–2889`, `2478–2484`). A later metadata success can settle the root while the placeholder traversal remains closed; the completion gate (`gdrive_sync.py:1818`) may reconcile incomplete membership and retire existing claims. This violates accepted AC-03/05/07.

**Smallest fix:** preserve a deferred detail when `mark_root_uncertain` updates that root. Keep the prefix contract and use a conditional update; no schema or protocol change. Only actual listing completion, relocation/rebind, or verified unavailable transitions may discharge the debt.

**Required tests:** defer a folder, inject a non-deferral metadata failure, recover it, and reopen SQLite. Assert the marker survives; metadata success alone cannot settle; nested/paginated content is listed before complete reconciliation; existing claims survive; and last-success does not advance before completion. Cover the change-page uncertainty caller and keep ordinary-uncertainty recovery as a negative control.

## F2 — Quota hold written after retirement publication (Medium)

`watch_renewal.py:383` awaits RETIRED publication before raising `_AccountQuotaHeld`; the durable `hold_connection` write is only in the outer handler at `watch_renewal.py:524`. A failed or timed-out RETIRED checkpoint bypasses journaling, so later polling/renewal can call Google before Retry-After. This violates AC-04 and the accepted journal-before-publication requirement.

**Smallest fix:** synchronously call the existing monotonic `hold_connection` owner inside `_create`'s `WatchQuotaLimited` branch, before awaiting retirement. On successful retirement, continue through the existing quota handler/shared restriction publisher; its duplicate monotonic write is harmless. On retirement failure, retain the local hold, report publication outstanding, and terminate the connection run while preserving the original exception/cancellation. Defer shared restriction publication to fresh acquisition; do not publish an unacknowledged changed document or mask authority refusal, uncertain acknowledgment, or cancellation. Do not use an unconditional `finally` that replaces the original result with `_AccountQuotaHeld`.

**Required tests:** inject failed delivery, terminal authority refusal, and timeout/lost acknowledgment specifically on the quota-rejected attempt's RETIRED checkpoint. Assert hold exists before checkpoint invocation; no second create/stop call; reopened SQLite blocks renewal and polling; fresh acquisition repairs publication; predecessor/cursor/cleanup attempts stay unchanged; and lease release occurs. Cancellation must propagate after journaling. Failed retirement must not be projected as acknowledged, and an uncertain dispatch must not become active during recovery.

## F3 — Deferred 404 retains placeholder membership (Medium)

The placeholder copies retained membership and closes traversal (`gdrive_sync.py:3003`). Later a verified root 404 calls `record_unavailable` before the closed-deferred check (`gdrive_sync.py:2890`); `state.py:1160` clears uncertainty but does not remove that snapshot's retained membership. Coverage can therefore pass with stale membership, and `_deferred_root_admissible` (`gdrive_sync.py:701`) may no longer schedule a controlled rescan. Per-document removal events are not guaranteed. This violates AC-05/07 and the bound-root loss contract.

**Smallest fix:** in the baseline folder loop, if a root was deferred and its traversal is already closed, leave it deferred and skip metadata observation in that build. Existing admissibility then starts a controlled replacement snapshot. Its open traversal can process verified 404 as empty or enumerate a present root. This preserves the canonical snapshot owner without rewriting committed placeholder pages.

**Required test:** begin with retained membership; defer A while sibling B keeps the build open; then make A's metadata return 404 without per-document changes and reopen SQLite. Assert no complete reconciliation/last-success advancement with stale A membership, a controlled replacement snapshot, A is not listed after verified 404, and only A's unsupported membership disappears. Preserve direct/other-root selections and another connection's claim; keep non-404, restricted-root, and explicit-trash controls.

The identity/tombstone slice and PR #714 ownership remain frozen. No broader quota-sharing redesign or claim-writer change is needed. This adjudication is not readiness or publication approval.

**Next authorized step:** checkpoint this decision, then after verifying the existing sole Opus writer is idle and fresh subscription usage is below 90%, resume that same writer for only these three corrections and regressions. Coordinator verification and fresh required reviews follow on the exact new snapshot.
