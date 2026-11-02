Adjudication against source `4f515e0ee20e25649019b5889188977dedbf92f0`: **F1 ACCEPT — High; F2 ACCEPT — Low. F1’s proposed fix and regression are insufficient as stated.**

The checkout is now `d6b88f7`, rather than review HEAD `05944f3`; its differences from the frozen source are review/handoff artifacts only. Relevant implementation and tests match the frozen source. No files were edited or tests run.

**F1 — ACCEPT, High: a restored root can produce a complete snapshot missing live documents.**

- **Trigger:** A building snapshot has already listed A-only documents and still has open A traversal entries. A’s metadata returns 404; withdrawal commits; execution stops before all A entries close. A is restored before the next enumeration. A process interruption immediately after withdrawal is sufficient. Discovery-budget exhaustion also works when sibling listings precede remaining A descendants in the queue.
- **Evidence:** `gdrive_sync.py:2906–2917` withdraws membership but only defers restoration when traversal is closed. With open entries, `:2931` calls `settle_root`; `state.py:1121–1129` clears the unavailable marker. Withdrawal removes A-only membership and supersedes outstanding upserts (`state.py:2202–2254`). Traversal selects only unfinished rows in insertion order (`:1937–1946`); previously materialized pages never reapply membership (`:2518–2522`). Listing the remaining descendants therefore cannot recover documents from completed pages.
- **Actual reconciliation consequence:** Once remaining traversal, pending work and terminal drain finish, `gdrive_sync.py:1818–1851` submits the deficient membership union as complete. Both local coverage (`:1088–1105`) and server coverage (`lib/integrations/gdrive-root-coverage.ts:78–90`) accept the now-bound root. `lib/ingest/source-reconcile.ts:181–226` retires omitted connection claims and queues cleanup when no other claim survives. Thus this is erroneous claim retirement/suppression of provider-live material, not merely an inaccurate diagnostic. A change feed that does not independently trigger corrective enumeration leaves the path exposed. This violates accepted AC-03/05.

**Required correction to Fable’s fix:** Removing the `not root_traversal_open(...)` condition addresses the immediate fall-through, but is not sufficient across another interruption. If deferred placeholder closure remains unfinished, the next run treats the deferred root’s open traversal as recoverable, lists only the remainder, and calls `settle_root(..., enumerated=True)` (`gdrive_sync.py:2853–2864, 2879–2887, 2932–2933`). The withdrawn earlier membership is still missing.

The writer must preserve durable evidence that **this snapshot cannot establish A’s complete membership**, until a fresh full enumeration replaces it. Use the existing controlled-rescan mechanism; ensure interrupted closure cannot discharge that requirement by completing only the old traversal’s remainder.

**Required regression:**

- Assert withdrawal occurred **and A traversal remains open after the loss run**, then reopen SQLite and restore A.
- Exercise a second interruption during restoration/deferred closure, proving the eventual enumeration uses fresh snapshot/page identities.
- Check every subsequent complete reconciliation, retained connection claims, A-only documents without another connection’s protection, and unchanged `last_success_at` while partial.

Simply setting `finished=False` is inadequate. `_DriveWorld` listings return all immediate children without pagination (`test_gdrive_upgrade.py:5441–5456`), and unavailable placeholders consume no discovery pages (`gdrive_sync.py:3053–3079`). The current shallow A fixture can close all A entries during the loss run regardless of their number. Use deliberate traversal interleaving/deeper descendants or an interruption after durable withdrawal. Ordinary document-budget exhaustion also does not establish Fable’s claimed uncommitted-page stall: `_finish_materialized_pages` commits with `require_acks=False` (`:3215`; `state.py:2646–2659`).

**Unresolved evidence:** No executed reproduction or corrected implementation exists from this adjudication. The failure path is established by source inspection; regression execution and restart-safe fix verification remain required.

**F2 — ACCEPT, Low: callback hides a deliberately unlinked Google subject.**

- **Trigger:** Verified-email publication returns `{subject: "tombstoned", email: "linked"}` or `{subject: "tombstoned", email: "preserved"}`. These are reachable because subject and email mappings are decided independently (`lib/integrations/gdrive-oauth.ts:232–255`).
- **Evidence:** `app/api/auth/gdrive/callback/route.ts:190–194` constructs the subject explanation, but `:201–204` discards it for those email outcomes. Existing tests cover the tombstoned subject only alongside a tombstoned email (`test/gdrive-callback-identity-outcome.test.ts:92–97`).
- **Action:** Compose subject status independently of email status, retaining the Admin repair path, preserved-email explanation and paused-connection message. Add both missing combinations. Do not imply that a held subject prevents attribution through an independently linked email.
- **Severity rationale:** This is an actionable-status omission under AC-08, not an identity mutation or access-control failure. It requires no shared-writer changes and stays within PR743’s Google scope and the PR714 ownership decision.
- **Unresolved evidence:** Only implementation and test verification remain; reachability and omitted messaging are established.