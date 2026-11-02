# PR743 Google identity and reader correction — existing sole Opus writer

Resume only the existing Claude Opus 5.5 HIGH session `628402d5-a1c6-42b7-b736-e84358c1a749`, after the coordinator confirms its prior turn ended, fresh first-party Claude `/usage` is below 90% in each applicable window, and this prompt/ownership record is checkpointed. This is one sequential writer, not a new session or second writer.

## Controlling decisions

Read and follow all of:

- the accepted spec and acceptance mapping in `.context/aio1167-review-bundles/20261102-final-identity-review/`;
- combined final-review adjudication `adjudication.md`, especially §2 and the required identity regression matrix;
- prior PR714 writer decision `/Users/chetan/.codex/worktrees/b81f/aios-team-brain/.context/aio-1170-resume/aio1170-pr743-legacy-unlink-astra-decision-20261101.md`;
- fresh PR714 Google-reader extension decision `/Users/chetan/.codex/worktrees/b81f/aios-team-brain/.context/aio-1170-resume/aio1170-pr743-google-reader-extension-astra-decision-20261102.md`;
- PR743's explicit acceptance at `.context/aio1167-rebase-handoff/pr743-pr714-google-reader-ownership-ack-20261102.md`.

The two PR714 decisions are conditional compatibility/ownership rulings, not candidate acceptance. The coordinator has accepted and recorded the complete boundary. Do not reopen coordination or create another canonicalizer.

## Scope

Implement the accepted Google `author-email:` equivalence contract across the existing identity writer, OAuth outcome, Google readers, attribution and repair consumers. In scope, only as required to make that contract consistent:

- `lib/identity/member-identities.ts` and the Google-only branch in `lib/identity/resolve.ts`;
- Google author resolution, contribution evidence/persistence, dashboard projection, and Google-specific historical reattribution/repair paths in `lib/attribution/resolve-authors.ts`, `lib/ingest/gdrive-contribution-store.ts`, `lib/dashboard/gdrive-contributions.ts`, and the Google branches of `lib/ingest/reattribute.ts`;
- `lib/integrations/gdrive-oauth.ts` and `app/api/auth/gdrive/callback/route.ts` for typed preservation/unresolved-email outcome presentation;
- focused identity, attribution, repair, OAuth and callback tests.

The Python root-loss and late-watch-quota corrections are already implemented and coordinator-verified; leave them unchanged in this turn. Leave all PR714 Slack code and tests unchanged. Within shared files, ownership follows only the Google behavior described here. No migrations, historical-key rewrite, merge, deployment, activation or staging integration.

## Required behavior

1. Apply equivalence only to provider `gdrive` and trimmed keys whose prefix is case-insensitive `author-email:`. Trim the full key, prefix and address, then lowercase according to JavaScript `toLowerCase`; no Unicode normalization, no folding of `subject:`, `permission:`, opaque Drive IDs, Slack, or other providers. SQL row selection must be a guaranteed superset of the JavaScript comparator; use team/provider scope plus deterministic ordering, then the comparator as the sole arbiter.
2. Read every equivalent row/state in the shared team mutation boundary. Different-owner live conflicts remain visible before tombstone/preservation. Resolve states order-independently: a canonical state governs applicability; otherwise zero histories and exactly one linked history retain ordinary behavior, exactly one unlink is tombstoned, and multiple histories are ambiguous regardless of their values. Never use last-row-wins, attach one key's revision to another, or consolidate history.
3. Automatic publication encountering an admissible same-member live legacy spelling preserves its existing mapping through a typed non-writing outcome; it is not tombstoned. It creates no canonical email row/state, refreshes no legacy metadata, writes no email repair obligation, audit, epoch or authority revision. Credential publication proceeds. Different-owner conflict keeps precedence and transaction rollback. Explicit Admin linking keeps its unlink-first refusal for a differently spelled live mapping.
4. Readers and writers share the same Google-only authority decision. An admissible standing legacy owner resolves canonical connector evidence. An applicable unlink or ambiguity blocks that identity's Google provider credit and email/handle fallback. Canonical fenced relink restores resolution while retaining older history. Keep ambiguity distinct from never-reviewed and definite unlink; do not remove roster email globally or alter other providers.
5. Keep exact state-key bytes, unlink spelling, independent revisions and `expectedRevision` fences. `expectedRevisionKey` comparison is byte-for-byte to the canonical write key; never trim the submitted fence. Preserve authority-before-row-lock order, deterministic locks, ambient transaction reuse, caller snapshot validation, repair-turn ownership and rollback on downstream/read failure.
6. Repair nomination/consumption must cover equivalent Google evidence, including prefix/address whitespace and non-ASCII case pairs and cases without optional roster email, while preserving exact obligation tuples, Drive provenance, bounded scans, stale-revision rejection, correction locks, retry/completion ownership and cache finalization.
7. Propagate a minimal typed identity outcome through OAuth to the callback. For tombstoned/ambiguous email attribution, explain that the subject may already be resolved while the email attribution bridge is held, and point the Admin to Members repair. Preserve paused-connection messaging. A preserved same-owner live mapping must not be shown as a tombstone/unlinked account.
8. Preserve no-side-effects outcomes and all ten PR714 Slack invariants. The PR714 owner keeps Slack suppression/generation/lifecycle/cutover and generic reattribute behavior. Do not import Google canonical-state rules into Slack, add Slack fences beside survivors, change Slack account lookup/cutover, weaken directory admission, or replace generations with Google mapping revisions. MR-06 later reconciles lock ordering/shared transaction and runs both full suites; do not implement that integration here.

## Minimum permanent regressions

Cover real Postgres writer cases and actual caller chains, not only the pure identity lookup:

- zero/one/multiple equivalent histories; multiple all-linked and mixed linked/unlinked histories; shuffled row order; canonical linked/unlinked state; conflicting owners; repeat no-side-effect refusal;
- same-owner legacy mixed-case/whitespace rows, zero or one linked state, credential publication with typed preservation and byte-exact unchanged history; Admin refusal remains;
- different-owner precedence, explicit exact-key fenced canonical relink, stale/padded revision-key refusal and reconnect;
- full caller chain through author resolution, contribution persistence/evidence, historical reattribution, per-key repair and projection, exposing roster-email fallback; canonical relink restores it;
- non-ASCII case, whitespace/prefix boundaries, SQL-superset behavior, opaque-ID case distinction, cross-team/provider controls including Slack/Linear lookalikes;
- both actual concurrent unlink/publication orders, read-failure rollback, stale snapshot, locks, repair nomination without optional email, retry/idempotence;
- callback outcomes for tombstoned, ambiguous, preserved, ordinary linked and paused connections, including resolved subject plus held email attribution.

Reuse/extract a pure shared helper only if it remains dependency-safe and does not create another source of truth. Preserve existing exports/callers. Do not broaden generic clearing/scheduler/cursor ownership or change failure behavior when identity/authority reads are unavailable.

## Writer limits for this turn

Use only read/edit tools. Do not run shell commands or tests; do not commit, push, migrate or dispatch reviews. The coordinator owns checks, review routing, checkpoints, pushes and handoff records. Return the exact changed paths, behavior and regression names, and any unresolved limit. Stop and report if a required behavior would exceed this Google-only ownership boundary.
