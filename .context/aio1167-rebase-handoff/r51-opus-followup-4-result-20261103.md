# Opus writer follow-up 4 — result

- Terminal: successful `success`, exit 0; no writer remains active.
- Existing Claude session: `628402d5-a1c6-42b7-b736-e84358c1a749`; canonical model `claude-opus-5-5`.
- Writer-reported: no tests, typecheck, lint, commit, push or review. Coordinator verification is still required.
- CLI usage for this turn: uncached input 64,257; cached input read 11,513,111; cache-creation input 297,002; output 51,784. These are token counts, not subscription percentages.

All four corrections are in place, each with a focused regression. Nothing has been run: no tests, typecheck or lint, and no commit, push or review.

**Two pre-edit checks I could not do:**
- **Clean tree:** this session has no shell, so I couldn't run `git status`. The session-start snapshot showed only your `CURRENT.md` modified, and I didn't touch it.
- **PR714/PR743 decision file:** reading it was refused because it sits outside this worktree. I relied on the disposition and `CURRENT.md`, which both record that PR743 owns this Google repair fix and PR714 keeps Slack. I found no conflict with the accepted spec or that ownership.

I left `reattribute.ts`, `member-identities.ts`, the Slack code, schema and migrations untouched, and added no API or authorization behavior.

## 1. Same-page trash then restore with existing membership (P2)
- **Source** (`ingestion/aios_ingest/gdrive_sync.py`): when explicit trash removes membership, that removal is now held in its own list. After the page, it is kept only if the document's last state in the page is still trashed.
  - So a removal belonging to a cancelled trash obligation is dropped along with it.
  - A genuine later removal in the same page (moved out of scope, absence) still stands, as does restore-then-trash.
  - The rule that a page applies additions before removals is unchanged.
- **Tests** (`ingestion/tests/test_explicit_trash_evidence.py`):
  - **Main test:** starts from a completed baseline with existing membership, for both direct-file and folder selection, and reopens the SQLite store before the change page and again before a quiet poll. After the trash-then-restore page:
    - membership remains and the restored document is pushed;
    - nothing is owed and nothing is removed;
    - no claim is retired and there is no rescan.
  - **Quiet poll:** completes with no push, no listing and no read of the document.
  - **Controls:** trash only, restore then trash, and trash → restore → moved out of scope. Each must lose membership and retire this connection's claim.

## 2. Ambiguous Google email in the per-key repair (P2)
- **Source** (`lib/ingest/identity-repair.ts`): when an item's or version's evidence resolves to nobody, established credit is now kept if:
  - the current owner is not a connector account;
  - some author's Google email history is ambiguous;
  - and no author carries a definite unlink.

  This copies the rule in `reattribute.ts`: ambiguity blocks new credit but is not an unlink. A definite unlink anywhere still clears credit, and a remap still reassigns it (it resolves before this check is reached). Correction locks, the identity-authority fencing and the obligation handling are unchanged.
- **Tests** (`test/datamechanics/gdrive-identity-email-reader.datamechanics.test.ts`):
  - **Both ambiguity shapes**, each draining a real current obligation:
    - linked/linked, created through `advanceIdentityMappingState`;
    - linked/unlinked, created through `removeMemberIdentity`.

    In both, the obligation goes from pending to complete, and the credited document keeps its item and version credit. An uncredited document stays uncredited, its contribution evidence stays unresolved, and a second drain changes nothing.
  - **Controls:** a link, then a forced remap that reassigns credit, then a definite unlink that clears it.

## 3. Repair progress on zero-candidate pages (Fable L2)
- **Source** (same file): `items_scanned` and the returned `scanned` count now use the whole scanned page, not the matching candidates. For non-email keys the two counts were already the same.
- **Test** (same test file): three documents that don't name the address, with batch size 2.
  - The first call returns partial with 2 scanned, the cursor on the second document and `items_scanned` at 2.
  - The second call returns complete with 1 scanned, the cursor on the third document and `items_scanned` at 3.

## 4. Restricted folder listing diagnostic (Fable L4)
- **Source:**
  - `ingestion/aios_ingest/state.py`: a new read-only query, `open_traversal_folders`.
  - `ingestion/aios_ingest/gdrive_sync.py`: before the traversal loop, if a standing `list-folder:` minimum still has open rows, `provider_restricted_resource` is set to 1 using the same set-to-1 pattern the root-deferral diagnostic uses, so it is never counted per row or added to. The check runs before the loop, so it also covers the loop's early returns. It completes no rows and doesn't change traversal or retry behaviour.
- **Test** (`ingestion/tests/test_operation_minima.py`):
  - **While held:** after a generation change with a fresh store, the run reports the category exactly once and stays incomplete; folder-a is not listed, folder-b is, and folder-a's rows are still open.
  - **After the minimum passes:** folder-a is listed, the category is gone, and the run completes.

## Open questions
- **Per stream, not per folder:** item 4 reports the category once per stream summary. If several held folders were each meant to be counted, that would be a one-line change.
- **Possible double count:** if another code path also adds `provider_restricted_resource` in the same held run, the L4 test's `== 1` will catch it. I couldn't check that without running.
- **Dispositions applied:** L1 (unrelated trash and the queue bound) was left as is; L3 (Admin listing for ambiguous addresses) is deferred and untouched.
