# Bounded Opus correction — AIO-1167 R51 F3-A

Implement only the accepted Astra F3-A correction and regression in the exact source worktree. Read:

- `accepted-spec.md`
- `accepted-adjudication.md`
- `review.text`
- `astra-adjudication-f3a.md`
- `ingestion/aios_ingest/gdrive_sync.py`
- `ingestion/tests/test_deferred_folder_enumeration.py`

The confirmed path is: while an active snapshot has a closed deferred-root placeholder, a child-only ambiguous `removed` event can call `absence_withheld`; if the root metadata returns 404, `record_root_unavailable` currently clears the deferred marker without a rescan. Astra ACCEPT/FIX (Medium): inside `absence_withheld`'s `absent` branch, when the root belongs to `deferred_here`, set `held = True` and skip `record_root_unavailable`. Preserve ordinary non-deferred verified absence. Let the existing caller mark `subtree_recovery_required` and the snapshot owner create the controlled replacement; do not introduce another owner or change global `record_root_unavailable` behavior.

Extend the existing F3 fixture with an ambiguous child `removed` change and no folder tombstone before SQLite restart. Verify the deferred marker survives, a replacement snapshot is run, no complete reconciliation carries stale `doc-a2`, last success waits for verified completion, the gone root is not listed, and only its unsupported membership disappears; direct selection, sibling root and another integration's `doc-a1` claim remain. Preserve explicit document-trash behavior. The helper also handles folder tombstones, which should conservatively route through replacement recovery.

Do not run tests, edit docs, commit, push, dispatch reviews, or modify any other source path. Report exact changed paths and behavior plus test cases the coordinator must run. The coordinator owns tests, hash verification, checkpointing, quota, reviews and handoff. Keep this as a continuation of the existing sole Opus writer session; do not start a second writer.
