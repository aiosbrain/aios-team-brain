# AIO-1170 — activation, attended cutover and live-evidence runbook

Status: **prepared, not executed, not reviewed.** Author: Sonnet 5 (coordinating session). Date: 2026-09-21. This is a checklist for a person, not a script. Every step cites the accepted spec (`docs/design/slack-timeline-reliability.md`, "spec" below) and is otherwise marked **OPEN**. Nothing here has been run, and nothing in it may be reported as verified until someone runs it and records the result.

Why it exists: the code for the new Slack pipeline is built and tested but deliberately **inactive** (`test/guards/slack-source-not-wired.test.ts`). Turning it on, migrating identities, and proving the timeline against a real workspace all need a person, a real workspace, or production authorization, and none can be done by an unattended session. This document makes that last mile a checklist.

## 0. Boundaries: who may do what

| Act | Needs |
| --- | --- |
| Merge PR 714, deploy, production apply or canary | Separate human authorization (spec line 126; `AGENTS.md`). |
| Delete the not-wired guard and wire the runner, scheduler or manual sync | A person, deliberately: the guard's own header says this is "the deliberate act that activation requires". |
| Attended identity cutover | A person present; disables legacy Slack writers (spec line 48). |
| Live evidence (AC-01, AC-13, AC-14) | A real workspace, authorized selected-channel access and, for AC-14, a non-copied sandbox where ingestion is permitted (spec lines 137, 149, 150, 160). Copied staging refuses ingestion; do not disable that protection (spec line 160). |

## 1. Preconditions (all must be true before section 2)

Code and review:
- [ ] The five pre-activation corrections PA-1 to PA-5 (`slack-timeline-preactivation-corrections.md`) are built, red-first, and each diff reviewed by Fable. **OPEN today.**
- [ ] The PR's other merge blockers are closed: active publication, historical namespace repair, attended identity cutover and repair, shared credit, the remaining timeline/API/UI, scheduled health, scoped deletion and private purge (graph retirement with retry, cache eviction after commit, staged raw-message purge, verified legacy mapping), and end-to-end tests (PR 714 body, blocker 1). **OPEN.**
- [ ] A clean broad `npm test` and full CI on the exact candidate, plus the final Fable review of that snapshot and a fresh Astra review (`AGENTS.md`). **OPEN.**

Environment and evidence to record before polling starts (spec line 76):
- [ ] Installation app/workspace ID, distribution category and its evidence (internal customer-built, Marketplace, or commercially distributed; if relying on an exemption, the installation date and exemption evidence).
- [ ] Token method capabilities, selected channel count, scheduler effective request throughput and backlog estimates. Record unavailable evidence and use the conservative budget; do not infer reduced limits for all commercial installs.
- [ ] Capacity plan computed (spec line 78): initial history time = `history_pages / allocated_history_requests_per_minute`; steady-state reconciliation time = `sum(reply_pages_per_known_root) / allocated_reconcile_requests_per_minute`, including backoff, reserved lanes and 15-second wake capacity. Reported separately from newest-message latency and cache latency.
- [ ] Note the spec's own caveat: "the current production selection is one enabled integration/one channel (coordinator read 2026-09-09)". That is stale; re-read it.

## 2. Attended rollout sequence (order is the spec's)

1. **Freeze legacy writers.** Disable and drain the old Slack workers before any new write is enabled; "no old writer may run after activation" (spec lines 48, 56). The PR body repeats this: the readiness-proof producer requires old workers drained. **OPEN:** the concrete drain procedure (which scheduler entries, how to verify drained).
2. **Identity cutover, one DB transaction** (spec line 48). Disable legacy Slack ingestion, login-link and admin-link writes; resolve provenance; migrate each provable raw-ID row **in place** to `WORKSPACE:USER`, preserving its row and member ID and auditing the previous ID; reconcile an existing qualified row only when the member mappings are identical, with an explicit migration record; a conflicting mapping **blocks that account** and is never chosen automatically; archive unprovable or conflicting raw rows outside the resolver map; preserve item locks. The migration and the cutover marker are one transaction, after which a Slack-only DB trigger rejects raw-ID identity writes. Replaying is a no-op. Consumers switch in the same deployment (spec line 50). **OPEN:** the operator entry point that runs this; the classifier and the snapshot reader exist as inactive helpers, the transaction does not.
3. **Per-channel namespace gate** (spec line 56). **OPEN:** the readiness producer that sets a channel `ready` is built as an inactive helper (`prepareNewSlackChannelNamespace`) but has no caller and no operator entry point. A channel becomes `ready` only after every pre-existing legacy row for that raw channel is matched to verified workspace provenance and migrated in place; a quarantined or conflicting row keeps it `blocked`. A live old-path item colliding with a new-path target is an operator-visible conflict; never delete either history to pass a uniqueness constraint. New channels with no legacy rows become ready transactionally after the same check.
4. **Repair, dry-run first** (spec line 124). Resumable, explicit team/integration/channel scope, dry-run default, bounded batches; it reports legacy matches and collisions, source range, pending reads, counts, unresolved mappings and locked exceptions; applying uses the normal writers keyed by repair ID and cursor. Dry run must mutate nothing (AC-12). **OPEN:** the command itself is not built.
5. **Enable new writers (activation).** Remove the guard's protection on purpose and wire the runner, scheduler wake (15 seconds, 20-second HTTP deadline, spec line 72), manual sync and admin entry points. **OPEN:** this slice does not exist; it is the next build after PA-1 to PA-5.
6. **Certification** (section 3, AC-14). Begins only after initial backfill completes; backfill may exceed 24 hours and must stay visibly pending.
7. **Rollback** (spec line 126). **OPEN:** no rollback entry point exists; the spec defines the behavior, not a command. Disable new readers and workers and invalidate cache and summaries. Never delete ledger evidence or reverse mappings blindly. There is **no transparent old-binary rollback**: hold the affected Slack view unavailable or partial until a compatible build is restored. Never restart legacy writers against cut-over data. Expect a one-time full GitHub file/commit watermark pass because identity-map keys change (spec line 126).

## 3. Live evidence: what must be observed

Nothing below can be satisfied by a fixture (spec line 137: "no fixture-only claim of incident resolution").

**AC-01, the incident trace** (spec line 137). Take the actual missing permalink and the visible control, and trace each through scope, provider, run, item, message, identity, query, cache and UI, producing a sanitized live before/after trace. Pass: both are explained end to end and the missing one now appears with the correct credit. **OPEN:** the specific permalinks (spec line 160 needs "representative missing/control permalinks").

**AC-13, People context** (spec line 149). In a rendered browser: the People context shows the linked workspace/login and a truthful pending or conflict state; an admin can correct it; an unrelated member cannot edit it; an OAuth or token result never falsely claims a mapped success. Evidence: API/action authorization tests plus rendered browser proof. Pass requires all four behaviors observed. Note the ruling in force since 2026-09-21: an admin's unlink stays until an admin relinks, so a fenced owner must see a `conflict`/pending page, not success.

**AC-14, 24-hour controlled sandbox soak** (spec lines 78, 150). In a non-copied sandbox where ingestion and authorized writes are permitted, after initial backfill: include an outage, an old-thread reply and an identity correction; expected eligible source messages must reconcile to message/day groups; report latency against the measured target and **every exception**. Certification requires observing at least one full steady-state cycle over the selected scope, not the estimate. If capacity cannot complete that cycle within the 24-hour observation, do **not** claim AC-14 or activate certified polling; report the exact shortfall (a reduced-tier large corpus can fail this gate; events-plus-reconciliation is then a separate design for adjudication, not an automatic fallback). Also record the observed database-to-Slack clock skew: `PA-3` assumes it stays well under its 60-second allowance and treats more than half of it (30 seconds) as a defect.

## 4. Sign-off record (fill in when run; leave blank until then)

| Item | Who ran it | When | Evidence link | Result |
| --- | --- | --- | --- | --- |
| Section 1 preconditions | | | | |
| Section 2, step 1 to 5 | | | | |
| AC-01 | | | | |
| AC-13 | | | | |
| AC-14 | | | | |
