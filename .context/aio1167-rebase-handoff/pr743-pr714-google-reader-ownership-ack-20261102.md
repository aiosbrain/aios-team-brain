# PR743 acknowledgment of PR714 Google reader ownership decision

Date: 2026-11-02 (UTC)

PR743 acknowledges and accepts the conditional ownership decision in:

- `/Users/chetan/.codex/worktrees/b81f/aios-team-brain/.context/aio-1170-resume/aio1170-pr743-google-reader-extension-astra-decision-20261102.md`
- SHA-256: `e5ad42c945d4445d69911e0dc2f447855d3d0280704e653b07fc266c3a9bca47`

This extends the prior PR714 decision in `aio1170-pr743-legacy-unlink-astra-decision-20261101.md` (SHA-256 `ff374ee337ebf52eb102c969a18d3326693a6577f0ea5d3b2a49bc7031ad476c`) from the Google writer correction to the bounded Google reader/consumer correction. PR743 accepts every exact condition in the fresh decision: Google-only `author-email:` equivalence, SQL candidate selection as a superset of the JavaScript comparison, order-independent 0/1/multiple-state handling with visible different-owner precedence and fail-closed ambiguity, typed non-writing same-owner preservation, byte-exact history and revision fencing, consistent Google attribution/fallback/repair behavior, authority transaction ordering and rollback, no side effects on refused/preserved outcomes, and exact repair tuples.

Ownership is attached to behavior, not whole files. PR743's existing sole writer owns only the Google `author-email:` branches and their minimum Google-specific attribution and repair consumers. PR714 retains all Slack suppression, generation, lifecycle, attended-cutover, and generic reattribute behavior. Integration remains staging-first and requires PR714 MR-06 to reconcile lock ordering and shared transaction participation while preserving all ten Slack invariants and both projects' suites. No migration or historical key rewrite is authorized or needed. This acknowledgment does not accept a candidate, authorize merge/deployment/activation, or change the one-writer rule.

The new decision is conditional on a corrected frozen candidate and required fresh reviews. The exact prior b86 snapshot is not approved by this ownership ruling.
