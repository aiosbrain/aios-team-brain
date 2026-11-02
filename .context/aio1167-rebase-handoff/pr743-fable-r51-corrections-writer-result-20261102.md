# PR743 R51 accepted Fable corrections — Opus writer result

Writer: existing Claude Opus 5.5 HIGH session `628402d5-a1c6-42b7-b736-e84358c1a749`.
Turn completed: `2026-11-02T15:54:11.151Z`, `end_turn`, non-error. Coordinator has not yet run tests, typechecks, commits, pushes, or reviews.

## Changed paths

- `ingestion/aios_ingest/state.py`
- `ingestion/aios_ingest/gdrive_sync.py`
- `ingestion/tests/test_lost_root_in_partial_build.py`
- `app/api/auth/gdrive/callback/route.ts`
- `test/gdrive-callback-identity-outcome.test.ts`

## F1 — High: root traversal restart safety

Writer added `defer_root_in_build`, which atomically marks the root deferred and, when this build already completed a traversal entry for it, closes its remaining entries. This is intended to prevent a restart from treating the old remainder as a complete enumeration. In the restore branch, a root with an unavailable marker is deferred whenever the current build touched it, independent of whether the traversal is already open; untouched roots still settle and receive a full listing. Provider deferrals and restricted roots use the same method. The existing deferred-root skip should keep the connection partial, and the existing controlled rescan should then enumerate under a fresh snapshot/page identity.

Added two root regressions:

- `test_a_restored_root_whose_traversal_is_still_open_is_relisted_in_a_fresh_snapshot`, with process interruption after loss and a parameterized second interruption during restore deferral. It asserts the root traversal is still open after withdrawal, SQLite reopen, fresh snapshot/page identities, complete reconciliation preserving each A document’s only connection claim, and stable `last_success_at` while incomplete.
- `test_a_folder_deferred_after_this_build_listed_part_of_it_never_resumes_the_old_remainder`, covering a provider 503 during partial listing and interruption during placeholder closure; recovery should use a fresh snapshot.

Writer states F1’s tests have not run. Potential affected behavior: deferring a partly traversed restricted/provider-deferred root closes remaining entries and forces a fresh rescan. Existing tests expecting those entries to resume need inspection. Existing SQLite state created by older code with a deferred marker and an open remainder may be indistinguishable from intentional recovery; writer notes the new code cannot remediate that historical state. Closure records can have no page, so all `traversal_queue` readers need coordinator review.

## F2 — Low: callback subject notice

Callback note generation now composes the subject tombstone status independently from verified-email outcomes. Added linked-email/active-connection and preserved-email/paused-connection cases, retaining the Admin identity repair path and avoiding an implication that a held subject prevents separate email attribution.

No tests or commands were run by the writer. These statements are writer-reported intent, not verified behavior. Coordinator review, regressions, checks, checkpoints and independent reviews remain outstanding.
