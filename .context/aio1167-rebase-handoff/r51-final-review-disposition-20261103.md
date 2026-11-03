# R51 final-candidate review disposition

Updated: 2026-11-03 06:01 UTC. Candidate source commit: `97b7bc92133f656ff369d31e437232d0a2a53cc8`; base: `5ecd2989e21fded915b41b508477bb267aaec06d`. Current handoff HEAD: `29db34cabb5978eb9cf554006bbd474f9d3c956a`. Remote recovery branch was previously verified at that handoff HEAD; verify again before the next writer phase.

## Review results

- **Astra HIGH, blind final review:** CHANGES REQUIRED, one confirmed P2: same-page trash→restore for a document already in the local selection appends `membership_removals`, then the new final-observation filter cancels only the trash obligation. `StateStore.materialize_page` applies additions before removals. The restore therefore loses membership, its upsert is skipped while still owed, and the connection cannot converge without another event/rescan. Astra checked the full 70-path manifest and patch hash. The behavior is in the changed restore/explicit-trash contract; additions-before-removals predates this candidate.
- **GPT-6.1 Sol HIGH, blind final review:** CHANGES REQUIRED, confirming Astra's P2 and adding a second confirmed P2: a per-key identity-repair obligation for an ambiguous equivalent Google email state enters `repairOneItem`; null resolution clears established item/version credit, contrary to the ambiguity-preservation rule in the shared reattribution path. The ambiguity test covers reattribution but does not drain per-key repair obligations. Sol reviewed the same immutable 70-path candidate/hash.
- **Claude Fable 5.1, blind final review:** CLEAN; no confirmed defect. It inspected all 70 paths and affected callers, but did not identify either P2. Its clean verdict and the discrepancy are retained; the two P2s are accepted based on reproducible source paths, affected state/queue contracts, and independent Astra/Sol confirmation.

## Adjudication and writer scope

Accept both P2 findings and require narrow fixes plus discriminating regressions. The current Google Drive connector branch owns `lib/ingest/identity-repair.ts`; PR714's current worktree has no such file. Keep PR714's Slack suppression/generation/cutover ownership and the accepted PR714/PR743 identity conditions intact. Do not edit the shared `lib/ingest/reattribute.ts`, Slack suppression code, identity lock protocol, schema or migration for these corrections. Align per-key repair with the existing rule: ambiguity blocks new attribution but preserves established item/version credit; definite unlink/remap keeps its existing clearing/reassignment behavior and correction locks.

Also accept two bounded Fable Low diagnostics corrections in this same review cycle: (a) email-key repair progress must count the full scanned page, including pages with zero candidates; (b) a blocked baseline folder listing should report `provider_restricted_resource` once when matching rows remain open. Add focused regressions. These do not change authorization or identity-resolution policy.

Defer Fable L1 (unselected trash consumes bounded queue/reconcile budget): keep the tested connection-scoped, no-op-at-sink path because it is needed to recover explicit evidence when local membership is absent; keep the existing per-stream bound. Defer L3 (Admin listing for ambiguous equivalent histories): explicit fenced relink remains the recovery path; this is a UI visibility enhancement outside this correction slice. Track both for later acceptance review. No new migration is authorized.

## Required verification and acceptance boundaries

After the sole Opus writer returns, the coordinator will inspect the full changed-file list and run targeted Python tests for explicit trash ordering and restricted listings; targeted TypeScript/datamechanics tests for identity-repair ambiguity and zero-candidate progress; then the full ingestion suite, TypeScript typecheck, changed-file lint, docs drift/skill synchronization and `git diff --check` as applicable. Re-run the full ingestion suite using the approved full-user route if loopback tests require it. Capture local and remote checkpoints before long reviews and every 10–15 minutes during edits; stop if a fresh authoritative subscription window reaches 90% or the provider refuses work.

The supplied latest full ingestion result is 1,075 passed / 28 skipped (approved full-user run); predecessor TypeScript/Postgres identity checks are 137 passed, and changed TypeScript production was unchanged after those checks. These are evidence for the previous candidate only; corrections require fresh checks. Fable did no execution and Astra/Sol did static review only.

Live Google certification/sandbox evidence and the 24-hour soak remain open release acceptance gates. No merge, deployment, API billing or permission bypass is authorized.
