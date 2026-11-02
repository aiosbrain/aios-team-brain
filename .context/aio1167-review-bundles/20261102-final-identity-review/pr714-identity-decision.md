# Fresh Astra HIGH — PR714 / PR743 legacy-unlink compatibility decision

## Verdict

**COMPATIBLE WITH EXACT CONDITIONS**

This is an ownership/contract decision only. PR714 can remain frozen while PR743 owns the narrow Google `author-email:` legacy-tombstone correction.

PR714 HEAD and preparation-packet SHA-256 match the supplied identities: `07375946e5ed87b5b7c44d4a9055ef1415028088` and `2285744e8848e3a18a7d14174cfa486b4030fbfe221ffa8e43a389e0a96af122`. PR743 HEAD matches `5ecd2989e21fded915b41b508477bb267aaec06d`, but its current tracked diff hashes to `781f4dd65d1f815a363e99877960696849658246b45367e4df59e51747e6b217`, not supplied `3fba7ef58921884657d101cb3694683a2a25482d5a1cb0db10c1bd0554f3de40`. Reconcile that discrepancy before treating this as acceptance of a frozen candidate.

## 1. Compatibility with all ten PR714 invariants

Conditional yes. The reported trigger is present: PR743 `canonicalIdentityId` canonicalizes Google email keys; `setMemberIdentity` reads mapping state exactly and checks alternate spellings only among live rows; `removeMemberIdentity` tombstones the stored spelling. OAuth uses `respectTombstone: true`.

Required conditions:

- Scope equivalence to `gdrive`'s `author-email:` namespace. Reuse one defined comparison contract consistent with existing prefix-insensitive matching, trimming and lowercasing. Do not add Unicode normalization, provider-independent case folding, opaque-ID folding, or Slack raw/qualified conversion. Ensure SQL comparison and JavaScript canonicalization agree over the supported domain.
- Read equivalent states and resolve live-owner conflicts inside `withIdentityMutationBoundary`, before mutation. Preserve visible existing-owner conflict precedence, including alternate live spellings; never hide a conflicting owner behind a tombstoned result.
- With zero equivalent tombstones, preserve existing behavior. With one applicable tombstone, automatic publication performs no identity write. With multiple equivalent historical states, automatic publication must fail closed unless a defined accepted relink decision resolves applicability; it must not select an arbitrary row or revision.
- Preserve exact-spelling unlink and independent historical mapping/revision records. Specify which exact state key `expectedRevision` fences; equal revision numbers belonging to different keys are not interchangeable.
- An explicit fenced canonical relink must remain possible, reject stale evidence, and permit subsequent reconnect/metadata refresh. An unconditional “any historical equivalent tombstone always wins” implementation fails this requirement. Document and test its precedence without merging historical revisions.
- A refused automatic email transition changes no mapping, mapping revision, repair obligation, authority revision, epoch, or successful-transition audit. Repeated refusal remains idempotent; errors roll back atomically.

## 2. Single-owner acceptance

Yes, within that scope. PR743 owns the generic writer's Google email-equivalence correction. PR714 retains ownership of Slack suppression, generation and attended-cutover semantics. During MR-06, adapt conflicting scaffolding around the accepted PR743 implementation; do not create a second canonicalizer or independently reimplement its fix.

The boundaries currently differ: PR714 takes advisory lock `(7341014, hashtext(teamId))`; PR743 takes the team `identity-authority` lock through `withIdentityMutationBoundary`. MR-06 must establish consistent ordering and shared transaction membership across affected writers, deletion/lifecycle paths and readers. Merely retaining both lock statements does not prove serialization.

## 3. Migration impact

None required for the proposed comparison-only correction. Canonicalizing new links while comparing existing tombstones does not require rewriting historical keys. Any historical persisted-key rewrite is outside this narrow decision; it needs a separately reviewed, idempotent migration and explicit collision/revision policy. It cannot silently consolidate mapping history.

PR714's reserved `20261023120000_slack_channel_history_segments.sql` owns Slack channel cursor/history segments, not identity-email keys. No semantic collision arises from this correction, and no proposed new migration means no numerical collision. Recheck reservations against staging if scope expands.

## 4. MR-06 semantic union and tests

Retain PR743's serialized authority boundary, Google canonical-email tombstone behavior, owner-conflict precedence, revision-fenced relink and repair/epoch protocol together with PR714's Slack rules: case-folded matching, exact ambiguous-variant unlink, no fence beside a surviving variant, final-variant fence, absent/repeated unlink, raw/qualified refusal, explicit relink, atomic generation changes, lifecycle handling and directory admission.

On the resulting integrated snapshot, preserve and run PR714's Slack suppression tests, especially AC-PA-15/16/17a/17b and its survivor-refresh negative control, rollback tests, both lock orders, counterpart tests and DIR-05. Also run PR743's new legacy mixed-case/prefix-case tombstone tests, conflicting-owner cases, concurrent unlink/publication, and explicit fenced relink followed by reconnect. Include zero/one/multiple historical-state cases and opaque-ID controls. These tests discriminate the required union from choosing either entire file.

## Smallest follow-up

PR743 records the precise equivalence, ambiguity and relink-precedence contract, implements the bounded fix and regression tests, then supplies a reconciled immutable checkpoint with verification evidence. PR714 consumes the accepted staging checkpoint during MR-06 and reruns the union tests.

No implementation, tests, merge, deployment, activation or wiring was performed or authorized by this decision.

## Cited evidence

- PR743 identity writer: `/Users/chetan/.codex/worktrees/8d96/aios-team-brain/.context/aio1167-rebase-worktree/lib/identity/member-identities.ts`
- PR743 OAuth publication: `/Users/chetan/.codex/worktrees/8d96/aios-team-brain/.context/aio1167-rebase-worktree/lib/integrations/gdrive-oauth.ts`
- PR743 adjudication: `/Users/chetan/.codex/worktrees/8d96/aios-team-brain/.context/aio1167-rebase-worktree/.context/aio1167-rebase-handoff/r51-blind-final-adjudication-20261031.md`
- PR714 identity writer: `/Users/chetan/.codex/worktrees/b81f/aios-team-brain/lib/identity/member-identities.ts`
- PR714 Slack suppression controls: `/Users/chetan/.codex/worktrees/b81f/aios-team-brain/test/datamechanics/slack-account-suppression.datamechanics.test.ts`
