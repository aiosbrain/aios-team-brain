# PR743 accepted Fable R51 corrections — existing Opus writer

Continue in the existing Claude Opus 5.5 HIGH writer session `628402d5-a1c6-42b7-b736-e84358c1a749`. This is a sequential continuation of the sole writer; do not start or delegate to another writer. The reviewed source before this turn is `4f515e0ee20e25649019b5889188977dedbf92f0` (the current worktree HEAD adds only review/handoff records). Coordinator owns tests, checkpoints, review routing and pushes.

Read the current repository `AGENTS.md`, the accepted AIO-1167 spec/acceptance map, the PR714 ownership acknowledgments and decision, the Fable report and Astra adjudication before editing:

- `.context/aio1167-review-bundles/20261102-final-r51-identity-rootwatch/fable-delta-review-report.md`
- `.context/aio1167-review-bundles/20261102-final-r51-identity-rootwatch/astra-fable-delta-adjudication.md`
- `.context/aio1167-rebase-handoff/pr743-pr714-ownership-ack-20261102.md`
- `.context/aio1167-rebase-handoff/pr743-pr714-google-reader-ownership-ack-20261102.md`
- `/Users/chetan/.codex/worktrees/b81f/aios-team-brain/.context/aio-1170-resume/aio1170-pr743-legacy-unlink-astra-decision-20261101.md`

Implement only the two accepted findings below and meaningful regressions. Keep PR743’s Google-only ownership. Do not change Slack/PR714 paths, migrations, or unrelated behavior. Preserve the already-reviewed Google identity semantics and the root/watch fixes.

## F1 — High: restored Drive root can lead to incomplete complete-snapshot reconciliation

A root can become unavailable after pages have already materialized documents, causing their only-root support to be withdrawn while traversal rows remain open. If restored, settling or continuing only the old traversal can publish a complete membership snapshot that omits still-live documents; reconciliation can then retire their only connection claims. Astra confirmed the path and accepted the finding.

Fix the state machine so durable evidence that this building snapshot cannot establish the root’s complete membership survives process restarts and cannot be discharged by finishing only the old traversal remainder. Use the repository’s existing controlled-rescan/fresh-snapshot machinery where appropriate. A fresh full enumeration must replace the old snapshot/page identities before this connection can submit complete coverage. Keep partial/incomplete runs from updating `last_success_at` or retiring claims.

Add a regression that proves the actual durable lifecycle, not only `finished=False`:

1. Materialize A-only documents and assert the A traversal is still open after the loss run; observe withdrawal.
2. Reopen SQLite, restore A, and interrupt again during restoration/deferred closure.
3. Reopen/resume and prove the eventual enumeration uses fresh snapshot/page identities rather than merely finishing the old remainder.
4. Exercise each subsequent complete reconciliation. Assert the A-only documents and their connection claims survive; verify another connection cannot mask missing A support. Assert `last_success_at` stays unchanged while incomplete.

Use deliberate traversal interleaving/deeper descendants or a controlled interruption after durable withdrawal; the shallow `_DriveWorld` fixture eagerly lists immediate children, and unavailable placeholders consume no discovery pages. Do not claim ordinary document-budget exhaustion proves an uncommitted-page stall: page materialization commits without requiring acknowledgments. Inspect the test harness, page finalization, reconciliation and existing provenance/control-rescan contracts before choosing the regression.

## F2 — Low: callback hides a deliberately unlinked subject

Keep the Google subject outcome independent from the verified-email outcome. If the subject is tombstoned while email outcome is `preserved` or `linked`, the callback must still explain that the subject remains unlinked and retain the Admin repair path, while also accurately explaining the email outcome and paused-connection state. Do not imply that a held subject prevents attribution through an independently linked email. Add both missing callback combinations.

## Boundaries and handoff

- Do not run tests, typechecks, migrations, commits, pushes, or reviews; the foreground coordinator owns them. Do inspect and edit the relevant implementation/test files, and return a concise result naming changed paths, design choices, regression scenarios, and unresolved limits.
- Do not reduce required coverage to save tokens or omit caller/reconciliation/privacy boundaries relevant to these findings.
- Use subscription-authenticated Claude only with `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` unset. Coordinator admission was fresh at 2026-11-02 14:53 UTC: Claude.ai Max / firstParty, all-model week 48%, Fable week 57%, credits off; no session utilization percentage was displayed. Stop promptly at 90% or a provider refusal.
- Preserve one active coordinator and this sole writer. The coordinator captures a local and remote checkpoint at the required cadence and will run meaningful affected tests, inspect the final diff, then obtain fresh exact-candidate Fable, blind Astra HIGH and blind GPT-6.1 Sol HIGH reviews. No merge, staging integration or deployment is authorized.
