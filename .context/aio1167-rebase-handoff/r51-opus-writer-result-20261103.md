# Opus writer result

- Timestamp: 2026-11-03T05:21:45.461Z
- Model: claude-opus-5-5

I've implemented A1–A5 and added regressions for each. Nothing was run: no tests, typechecks, lint, builds, commits or pushes. I did run three read-only shell commands to navigate (one `wc -l` and two `grep`s), because the Grep tool wasn't available.

No new shared behaviour needed an ownership agreement. A2 and A5 stay inside the Google `author-email:` contract, and no Slack or PR714 code changed.

## Changed paths
- **Source:**
  - `ingestion/aios_ingest/gdrive_sync.py`
  - `ingestion/aios_ingest/state.py`
  - `ingestion/aios_ingest/sources/gdrive.py`
  - `ingestion/aios_ingest/sources/gdrive_watch.py`
  - `ingestion/aios_ingest/watch_lifecycle.py`
  - `ingestion/aios_ingest/watch_renewal.py`
  - `lib/integrations/gdrive-identity-discovery.ts`
  - `lib/identity/member-identities.ts`
  - `app/t/[team]/admin/members/actions.ts`
- **Tests:**
  - `ingestion/tests/test_explicit_trash_evidence.py`
  - `ingestion/tests/test_operation_minima.py` (new)
  - `ingestion/tests/test_watch_operation_minima.py` (new)
  - `test/datamechanics/gdrive-identity-discovery.datamechanics.test.ts`
  - `test/datamechanics/gdrive-identity-exact-unlink.datamechanics.test.ts` (new)

## What each fix does
- **A1 — trash after local membership loss:** the change-page branch now records the trash-carrying removal for any Google Doc reported trashed, even when this stream has no local membership for it.
  - The existing fenced, connection-scoped claim reconciler decides whether a claim exists: a document this connection never claimed is a no-op, and another connection's claim is never touched.
  - The document isn't read. Ambiguous `removed` hints, missing local state and root uncertainty still go through the existing absence checks.
- **A2 — held email can't mint a permission mapping:** discovery now checks `googleEmailAttributionHeld` on the identity map it already reads under the identity-authority lock. If the email is held, it counts the ID as `reviewed` and writes nothing.
  - An already-decided permission mapping is checked first and keeps its authority.
  - Roster email for other providers is unchanged.
- **A3 — listing and change-page minima survive a generation reset:**
  - Valid provider Retry-After minima are journaled through the existing resource-restriction owner as `list-folder:<folder>` and `changes:<drive>`. Nothing is keyed by page token, cursor or generation.
  - Before dispatch, the traversal skips a restricted folder's rows (a new `exclude_folders` option on `next_traversal`) while other folders continue, and a restricted drive's change drain stops with a partial checkpoint.
  - Publication and adoption reuse the existing restriction sections, so no schema change or migration was needed.
  - A missing or malformed header stays attempt-local, and the existing stream-level `retry_not_before` is kept.
- **A4 — durable non-quota watch minima:**
  - A new shared classifier, `operation_deferral`, built on the existing parser, recognises a provider-named minimum on a non-quota answer. The watch manager raises `WatchProviderMinimum` for a 5xx or 408 that names one.
  - **Creation:** the attempt stays `UNCERTAIN`. The minimum is journaled as `watch-create:<drive>` before the uncertain outcome is published, and later creations on that drive are blocked until it passes.
  - **Stop:** the minimum is journaled as `watch-stop:<resource>` under the current transport's account, not the record's older account. No stop attempt is spent, and the stop is skipped until the minimum passes.
  - **Late workers:** they journal the minimum on the owning event loop.
  - **Publication:** renewal now publishes outstanding restrictions after its create and cleanup calls; this is a no-op when nothing is outstanding.
  - 429 and quota-403 remain account-wide.
- **A5 — exact padded legacy unlink:** the Admin unlink action and `removeMemberIdentity` keep the exact persisted bytes of a recognized `gdrive` `author-email:` key; nothing trims or canonicalizes it.
  - Only that legacy spelling skips the new-link format check for removal.
  - The fencing by displayed holder and revision is unchanged.
  - Other Google IDs, Slack and every other provider keep their trimming and validation.

## Tests added (all pending; none run)
- **A1** (`test_explicit_trash_evidence.py`):
  - `test_explicit_trash_with_no_local_membership_is_still_reconciled_without_a_read`, for last claim and second-connection claim;
  - `test_membershipless_trash_evidence_survives_sink_failure_or_lost_ack_and_replays`;
  - `test_with_no_local_membership_an_ambiguous_removal_keeps_the_claim_and_stray_trash_is_harmless`.
- **A2** (discovery suite, new describe block):
  - a held email blocks discovery for a canonical unlink, one legacy unlink, and ambiguous histories, with no side effects and no author credit regained;
  - a canonical relink and an unheld email still link;
  - an independently established permission mapping survives a held email;
  - discovery serialized before a later email unlink keeps its mapping;
  - a real-transaction case where an email unlink commits while discovery waits on the identity authority.
- **A3** (`test_operation_minima.py`):
  - a folder-listing minimum survives a generation transition plus a fresh store, while the other folder is still listed, and expiry resumes it;
  - the same for change pages;
  - a missing or malformed header is not made durable.
- **A4** (`test_watch_operation_minima.py`):
  - a creation 503 stays uncertain and blocks that drive across a second sweep, a reopened store and a fresh restored store, and expiry resumes it;
  - a stop 503 waits without spending an attempt, under the transport account rather than the older record's;
  - a 503 with no minimum, or a malformed one, keeps its existing outcome.
- **A5** (`gdrive-identity-exact-unlink.datamechanics.test.ts`):
  - exact unlink through the real Admin action for outer ASCII whitespace, outer Unicode whitespace, whitespace after the prefix, mixed case, and a non-ASCII address, followed by an explicit canonical relink;
  - refusals: canonical-equivalent and trimmed requests, stale revision, wrong holder, missing observation, cross-team, non-admin;
  - Slack, opaque-ID and new-link validation controls.

## Unresolved design choices and gaps
- **A1 PostgreSQL owner not newly covered:** I didn't add new coverage of `stageGdriveReconciliation`'s team and connection filtering, last-claim suppression, epoch and cleanup. Whether the earlier explicit-trash case in `gdrive-audience-claims.datamechanics.test.ts` asserts exactly these needs checking; if it doesn't, a focused case is still owed. Restore ordering and multi-page bounds also aren't newly tested.
- **A1 queue cost:** trash of unrelated Google Docs in a watched drive now creates removal obligations (no-ops at the sink). These count against queue and page budgets.
- **A1 existing tests:** any test asserting that trash of an unselected document produces no removal will now fail.
- **A2 outcome label:** a held email is counted as `reviewed`, because adding an outcome type would change the discovery API.
- **A3 behaviour:** the gate leaves a restricted folder's rows open, so the build can't complete until the minimum passes. A restricted change drain writes a partial checkpoint on every run until then.
- **Coverage still missing:**
  - **A3:** same-account reconnect, A→B→A, and failed or lost publication acknowledgment.
  - **A4:** late-worker 503 journaling, publication failure or lost acknowledgment after a creation 503, and stale-fence behaviour.
  - **A5:** a concurrent remap during unlink.
- **A5 behaviour change:** a caller sending a padded string to remove a canonical row now gets `removed: false`, because only exact bytes match.
- **Not run:** all tests, typecheck, lint, build, docs and schema checks, and `git diff --check`.
