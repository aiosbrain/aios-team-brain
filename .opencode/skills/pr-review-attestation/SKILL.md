---
name: pr-review-attestation
description: >
  Walk this repo's pre-push review gate: review the branch diff with a local
  reviewer subagent, adversarially double-check any HIGH/blocker finding before
  trusting it, then record a `## Review — Reviewed by <tool> — verdict …` line in
  the PR body (or apply `ready-for-review` if no reviewer is available). Use
  before pushing a PR branch in aios-team-brain — and again right after
  `gh pr create`, which is when the attestation line can actually be written —
  or when asked "did this get reviewed", "attest this PR", or
  /pr-review-attestation.
---

# PR review attestation

## Why this exists

`CLAUDE.md`'s Review gate (§ "Review gate — local review before pushing a PR")
requires every PR branch to get a local diff review before it ships, and the
result recorded on the PR in a specific, auditable format. It's easy to forget
the exact format, easy to skip the review under time pressure, and easy for a
single reviewer pass to raise a false-positive HIGH finding that triggers
unnecessary rework. This skill packages the gate exactly as documented and adds
a second, independent check before treating any HIGH finding as real.

This gate is **flexible and never blocks a push** — it complements CI and
label-gated CodeRabbit; only required CI checks actually block a merge. Never
refuse to push because of an unresolved MEDIUM/LOW finding.

## When this runs

The review happens **before you push** — that's the point of the gate: findings
get fixed while the branch is still yours. But the attestation is recorded *on a
PR*, and before `gh pr create` there is no PR number. So the skill straddles the
push:

| Phase | Steps | Requires a PR? |
| --- | --- | --- |
| Pre-push | 1–4 (diff → review → adversarial check → fix) | no |
| Push + open the PR | `git push` then `gh pr create` | — |
| Post-create | 5–6 (write the attestation / label) | yes |

If the PR already exists (re-review of a pushed branch, or someone asks "did
this get reviewed"), run 1–4 then go straight to 5. Either way, **do not stall
at step 5 waiting for a PR number that doesn't exist yet** — create the PR
first. You can also fold the attestation into creation in one shot
(`gh pr create --body "$BODY"$'\n\n'"$ATTESTATION_LINE"`) once steps 1–4 are
genuinely done.

## Steps

1. **Get the diff — against a fresh `origin/main`.**
   ```bash
   git fetch origin main
   git diff origin/main...HEAD
   ```
   The fetch is not optional. PRs merge fast in this repo, so a checkout whose
   `origin/main` ref is a few hours stale produces a diff carrying other
   people's already-merged commits — the reviewer then raises HIGH findings on
   code that isn't yours, and step 3 burns a skeptic pass per phantom finding.
   If the diff is empty, stop — there's nothing to review or attest.

2. **Primary review (subagent).** Spawn one independent review subagent against
   the diff — prefer `Agent(subagent_type: "code-reviewer", model: "fable")` (the
   pattern CLAUDE.md names for Chetan's flow); in a runtime without subagent
   support, use whatever local reviewer is actually available (e.g. Local
   Bugbot in Cursor). If no reviewer of any kind is available, skip to **Step
   6 — No reviewer available**.

3. **Adversarially verify every HIGH/blocker finding.** For each HIGH or
   blocker finding the primary reviewer raised, spawn one *independent* skeptic
   subagent whose only job is to try to refute it against the actual diff —
   prompt it explicitly to argue the finding is wrong or not applicable, and to
   default to "finding stands" if it can't build a real refutation. Do this per
   finding, not once for the whole batch, so one loud false-positive can't
   piggyback other real findings past the check.
   - If the skeptic **refutes** the finding: downgrade it to MEDIUM. Treat it
     like any other MEDIUM in step 4 (a one-line deferral reason is enough).
   - If the skeptic **fails to refute** it: it stays HIGH and must be
     addressed in step 4.

4. **Resolve findings.**
   - Fix every finding still rated HIGH/blocker after step 3.
   - For every MEDIUM/LOW (including any downgraded in step 3), either fix it
     or add a one-line reason for deferring it — put that reason in the PR body
     near the attestation line, not just in chat.

5. **Record the attestation.** Append **exactly** this line to the PR body
   (preserve the existing body — read it first, then write body + line back):
   ```
   ## Review — Reviewed by <tool> — verdict <one-line summary>
   ```
   - `<tool>` is the actual reviewer used, e.g. `code-reviewer (fable)` or
     `Local Bugbot`.
   - `<one-line summary>` names the outcome plainly, e.g. "no blockers, 1 LOW
     deferred (see below)" or "fixed 1 HIGH (SQL injection in query.ts), clean
     otherwise".
   ```bash
   gh pr edit <number> --body "$(printf '%s\n\n%s' "$EXISTING_BODY" "$ATTESTATION_LINE")"
   ```
   Never fabricate this line — only write it after a review subagent actually
   ran in this session against this diff.

6. **No reviewer available.** If step 2 found no reviewer of any kind in the
   current runtime, say so explicitly to the user and instead:
   ```bash
   gh pr edit <number> --add-label ready-for-review
   ```
   so CodeRabbit reviews the PR. Do not write an attestation line you didn't
   earn.

## Boundaries

- Never treat this as a merge blocker — CLAUDE.md is explicit that the gate
  never blocks a push. Report unresolved MEDIUM/LOW findings; don't refuse to
  proceed over them.
- Never write the `## Review — Reviewed by …` line without a review subagent
  actually having run against the current diff in this session.
- Adversarial verification is per-finding — never batch-refute a whole review
  with one skeptic call.
