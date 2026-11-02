# Bounded Opus correction — PR743 Google legacy email tombstones

You are the existing sole implementation writer for AIO-1167, in the existing Claude Opus 5.5 HIGH session `628402d5-a1c6-42b7-b736-e84358c1a749`. This is a sequential continuation of that completed session, not a second writer. Use first-party Claude subscription authentication only; API-key overrides are unset. The latest full-user `/usage` at about 2026-11-02 08:05 UTC showed all-model week 40%, Fable week 46%, credits off; the CLI did not display a separate session percentage. Stop at 90% in any displayed applicable window or on a provider refusal.

## Exact decision and candidate

Read the repository instructions and accepted spec sections relevant to identity linking, then read:

- PR714’s Astra HIGH decision: `/Users/chetan/.codex/worktrees/b81f/aios-team-brain/.context/aio-1170-resume/aio1170-pr743-legacy-unlink-astra-decision-20261101.md` (SHA-256 `ff374ee337ebf52eb102c969a18d3326693a6577f0ea5d3b2a49bc7031ad476c`)
- Local acknowledgment: `.context/aio1167-rebase-handoff/pr743-pr714-ownership-ack-20261102.md`
- Current candidate manifest: `.context/aio1167-rebase-handoff/resume-20261102T0801Z/manifest.json`
- Current implementation: `lib/identity/member-identities.ts`, `lib/integrations/gdrive-oauth.ts`, and `test/datamechanics/gdrive-identity-tombstone-email.datamechanics.test.ts`

The candidate source is based on `5ecd2989e21fded915b41b508477bb267aaec06d`; its verified recovery checkpoint is `c3bade49b3da481e75d5eb51cde5ce601e88004a` on `origin/codex/aio-1167-r51-resume-20261102`. The R51 focused Python regressions already passed (48 tests); do not change them.

## Ownership and required behavior

Implement only the decision’s bounded PR743 slice: Google Drive `author-email:` equivalence and tombstone handling. PR743 owns this narrow correction. PR714 retains Slack suppression, generation, and attended-cutover semantics; do not edit or recreate PR714’s implementation. Do not add a migration or rewrite historical keys.

Use one explicitly documented comparison contract for the supported `gdrive` `author-email:` namespace, consistent across JavaScript and SQL: trim and case-fold the prefix/address only as accepted by the decision. Do not add Unicode normalization, provider-independent case folding, opaque-ID folding, or Slack raw/qualified conversion. Keep exact-spelling unlink and independent historical mapping/revision records.

Inside `withIdentityMutationBoundary`, inspect all equivalent live rows and historical mapping states before mutation, with deterministic locking/order. Preserve visible live-owner conflict precedence even if an equivalent tombstone exists. For automatic OAuth publication: zero equivalent tombstones preserves existing behavior; one applicable tombstone performs no identity write or revision/repair/authority/epoch/success-audit change; multiple equivalent historical states fail closed without selecting an arbitrary row or revision unless a defined explicit relink has resolved applicability. Keep credential authority separate from attribution intent.

An explicit Admin canonical relink must remain possible, reject stale evidence, and allow a subsequent OAuth reconnect. Make the exact mapping-state key fenced by `expectedRevision` explicit in API and tests; equal revision numbers for different spellings are not interchangeable. Preserve atomic rollback and existing conflict behavior. If the existing caller contract cannot safely express the required exact-key fence, implement the smallest compatible caller/UI propagation and update the focused tests; do not guess or weaken the fence.

## Required focused coverage

Extend the existing real-Postgres datamechanics suite to cover zero, one, and multiple equivalent historical states; mixed-case prefix/address variants; live-owner conflict before tombstone refusal; no side effects on automatic refusal; exact-spelling unlink; successful and stale explicit revision-fenced canonical relink; reconnect after accepted relink; both unlink/publication lock orders; and case-sensitive opaque-ID controls. Ensure an ambiguous state does not publish an arbitrary mapping. Keep existing behavior and unrelated provider identity contracts intact.

Inspect every affected caller of `setMemberIdentity`, especially the Admin actions/UI, OAuth publisher, identity discovery and reconnect paths. Report any necessary caller changes. Do not narrow privacy checks, auth boundaries, tier checks, or transaction ownership.

## Writer boundaries

Do not run tests, shell commands, commits, pushes, review dispatches, broad refactors, or alter the R51 Python corrections. Change only the minimal implementation/caller/test/documentation paths required by the decision; add a short spec/acceptance-map entry only if needed to record the exact equivalence and relink precedence. Return a concise completion result naming each changed path, the chosen exact-key revision-fence contract, test cases added, and any uncovered risk. The coordinator owns all verification, checkpointing, reviews, and handoff updates.
