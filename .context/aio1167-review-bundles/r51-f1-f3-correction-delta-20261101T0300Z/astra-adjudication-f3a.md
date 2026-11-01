# Astra F3-A adjudication — AIO-1167 R51

**ACCEPT/FIX — F3-A, Medium.** The defect is confirmed by static inspection of the requested source paths; no tests or edits were performed.

The path is reachable while a snapshot is building: `gdrive_sync.py:2163` skips `_deferred_root_admissible`, and baseline completion can publish the retained placeholder before consuming the child's removal in the same run. `absence_withheld` then sees the root's verified 404 at `gdrive_sync.py:2485–2493` and calls `record_root_unavailable`; `state.py:1168–1172` changes it to bound/unavailable without changing retained membership. Because `held` remains false, only the named child receives a removal obligation, no replacement snapshot is requested, and completion may retain other stale members.

**Smallest safe correction:** in `absence_withheld`'s absent branch, if the root is in `deferred_here`, set `held = True` and do not call `record_root_unavailable`. The existing caller seeds the controlled replacement through `subtree_recovery_required` and the snapshot owner. Keep the ordinary non-deferred unavailable transition unchanged; do not modify `record_root_unavailable` globally.

**Regression:** extend `test_a_deferred_folder_gone_after_its_placeholder_is_decided_by_a_replacement_snapshot` with a child `removed` change and no folder tombstone before SQLite restart. Assert the deferred marker survives, replacement snapshot occurs, no complete snapshot carries stale `doc-a2`, last success waits for verified completion, the gone root is not listed, and only its unsupported membership is removed. Preserve direct selection, sibling root and the other integration's `doc-a1` claim. Keep explicit document-trash handling independent; the shared helper also serves folder tombstones and should conservatively seed the replacement.

This is within accepted F3 / AC-03, AC-05 and AC-07. It changes neither claim-writer ownership nor identity/tombstone or PR #714 ownership, broadens no audience, and does not alter quota/publication owners. The code defect is confirmed; live-provider frequency is unknown.
