# Astra final review — PR743 candidate `b86b22d2`

**Disposition: changes required before approval.** Review target source commit `b86b22d2e6b1561d0f7e57e0a4caac07e9880fb3`; source base `5ecd2989e21fded915b41b508477bb267aaec06d`. This static review found one High and one Medium. The worktree HEAD advanced to packet-only commit `bc806ef`; comparison found no source differences from the reviewed snapshot.

## High / P1 — a folder lost during a partially built snapshot can retain previously enumerated documents

Trigger: folder A's pages have committed membership into a building snapshot; pagination or sibling folder B keeps the snapshot unfinished; A then becomes unavailable before the next run, and the change drain has no corresponding tombstone yet.

The unavailable-root branch in `ingestion/aios_ingest/gdrive_sync.py:2906` records A as settled. Remaining traversal at `:3032` closes outstanding pages empty but does not remove membership from pages already committed. `publish_selection_snapshot` preserves that membership. Root coverage accepts `bound` plus unavailable detail, and `_bound_root_drift` compares root identity/location, not retained support. Complete reconciliation at `:1840` can therefore submit A's stale documents and advance `last_success_at`.

Expected: verified root loss retires that root's support while preserving independently supported documents. Actual: inaccessible content can retain the connection's claim despite processed loss evidence.

Regression: adapt `test_a_deferred_folder_gone_after_its_placeholder_is_decided_by_a_replacement_snapshot`, but let A enumerate successfully before B holds the build open, so A was never deferred. Remove A and its children, return an empty change drain, reopen SQLite, and assert every subsequent complete snapshot excludes A-only documents while direct/overlapping claims survive. Existing deferred-only protection does not cover this case.

## Medium / P2 — equivalent legacy email tombstones still permit attribution through email fallback

Trigger: unlink legacy `AUTHOR-EMAIL:Alice@Example.com`, reconnect, then ingest Drive evidence with `external_id: "author-email:alice@example.com"` and `email: "alice@example.com"`.

The writer refuses the equivalent tombstone without creating canonical state, but `lib/identity/resolve.ts:30` preserves case for all Google keys, so `providerIdentityState` misses the legacy tombstone. `lib/attribution/resolve-authors.ts:154` and `lib/ingest/gdrive-contribution-store.ts:128` then fall back to confirmed roster email and credit Alice. Historical repair's `explicitlyUnlinked` check has the same mismatch.

Expected: deliberate unlink remains effective for attribution until explicit relink. Actual: the identity registry remains unlinked while content and timeline evidence receive credit. This is an AC-08/09 gap; the unchanged resolver is not newly introduced by the final identity commit.

Regression: extend the legacy-tombstone fixture through actual author resolution, contribution persistence, historical repair and timeline projection. Assert unresolved credit after refusal, then successful resolution after fenced canonical relink. Preserve opaque-ID case sensitivity and canonical-state precedence; do not collapse history rows with last-row-wins semantics.

## Other review notes

- Fable's same-member legacy-spelling OAuth generic 500 issue is not duplicated in this report and remains to be adjudicated across reports.
- Locking all team/provider Google identities is ordered correctly through team identity authority; cost scales with identity count.
- SQL selects by team/provider, with JavaScript as sole equivalence arbiter; non-ASCII and Unicode-whitespace tests cover the domain.
- PR714 boundary and authority overlap remain as specified for MR-06.
- No additional confirmed defect found in the reviewed identity corrections.
- Review was read-only: no tests, edits, network calls or delegation. It did not establish live Google certification, soak, staging, merge, production or release readiness.
