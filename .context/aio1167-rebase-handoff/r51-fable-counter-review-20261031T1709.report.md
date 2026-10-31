**Verdict: no actionable findings in reviewed scope.** The Note A correction does what Astra asked, the two `cause` callers are the only callers that charge before flushing, and the binding-catch regression exercises the real path for both authority codes. No HOLD. Two optional diagnostics below are not correctness findings on this delta.

## Correctness findings

None.

## Contract verification

- **`cause` is supplied only by callers that already charged.** The seven call sites of `_flush_restriction_evidence` are `gdrive_sync.py:489`, `:1409`, `:1458`, `:1516`, `:1559`, `:1593`, `:1857`. Only `:1516` and `:1593` pass `cause=exc`, and each is immediately preceded by `total.failed += 1` plus `total.failure_categories[exc.code] = 1` (`:1511` to `:1512`, `:1591` to `:1592`). So `charge=cause is None` at `:440` suppresses the second charge exactly where the run was already counted.
- **No global suppression.** The no-cause callers (standing hold `:1409`, identity prerequisite `:1458`, no-streams `:1559`, end-of-run `:1857`, and `_open_account_hold` `:489`) keep `charge=True`. The drain handler at `:1711` calls `_note_flush_authority(total, exc)` with the default and is byte-unchanged from the prior snapshot.
- **Categories once each, cause preserved.** `_note_unpublished` at `:321` sets each owner to exactly 1 via the per-summary seen set. `_note_flush_authority` at `:454` adds the code only if absent and never touches existing categories. The cause code and the terminal code cannot collide, since `_publish_restriction_evidence` only re-raises codes in `_TERMINAL_AUTHORITY_CODES` (`:46`, `:403`) and the terminal-cause branch at `:430` returns before publishing.
- **No exception text, no later action.** Only `error.code` is reported. Both `cause` callers `return total` right after the flush (`:1517`, `:1594`). The drain and no-cause flows are unchanged.
- **Delta extent.** Comparing the prior bundle diff with the current one, the only `gdrive_sync.py` changes are the comment at `:436` to `:438`, the `charge=` argument at `:440`, and the `_note_flush_authority` signature and docstring at `:443` to `:452`. The hunk offset shift (+2 then +7) matches those additions, and the writer log shows a single Edit on each path.

## Regression verification

`test_a_binding_brain_error_then_a_refused_flush_is_charged_once` (`test_flush_authority_outcome.py:208` to `:231`) drives the real path: `_DriveWorld._metadata` raises the stored `BrainError` for `file-b` (`test_gdrive_upgrade.py:5471`), `_bind_selected_roots` re-raises it (`:1031`), the coordinator catch charges once and flushes with `cause`, and the one checkpoint fault refuses with the parametrized code. Assertions cover `failed == 1`, `server_error == 1`, the code once, `document_restriction_unpublished` once, exactly one refusal, and the retained local minimum for `file-a` (the earlier named minimum). The helper-level test at `:185` to `:205` keeps the no-cause control at `failed == 1` with progress preserved.

## Optional diagnostics (not blocking, for Astra's disposition)

- **Pre-existing analog outside Note A's scope.** The no-streams return at `:1552` to `:1560` and the unresolved-roots charge at `:1532` set `failed` once at run level, then a refused flush (or, after `:1532`, a refused drain checkpoint at `:1711`) charges a second time. Those are run-level charges, not document failures, so Astra's "do not let a document failure stand in" rule does not cover them. This predates the delta and was not changed by it. Expected per Note A's logic would be `failed == 1`; actual is 2. Impact is diagnostic count only.
- **Regression hardening.** The binding test does not assert that no checkpoint follows the refusal. The standing-hold test does so with a `later` sentinel and a `world.revision` check (`:60`, `:81`). Adding the same to the binding test would pin the "no later action" claim.

## Coverage ledger

| Path | Coverage | Evidence |
|---|---|---|
| `ingestion/aios_ingest/gdrive_sync.py` | PARTIAL | Lines 46-62, 150-510, 983-1073, 1380-1870, 2655-2685, 3602-3614, 3750-3780 read on the current file. All current hunks compared against the prior bundle diff. Prior FULL read is reusable for the rest, since the delta is confined to the helper region. |
| `ingestion/tests/test_flush_authority_outcome.py` | FULL | Whole file read, plus the `_DriveWorld` and `_two_root_world` harness code it depends on. |

The other 40 paths carry identical SHA-256 values in `delta-since-r51-fable.json` against the current manifest, so the prior Fable coverage is reusable for them. I could not recompute hashes without a shell. The prior version of the test file lives only in the untracked archive, which I could not open, so the "before" state of that test is taken from Astra's note.

I ran nothing. The coordinator counts remain coordinator evidence. No whole-branch, merge, or release-readiness claim. Note B stays deferred; nothing in this delta changes its safety or contract.