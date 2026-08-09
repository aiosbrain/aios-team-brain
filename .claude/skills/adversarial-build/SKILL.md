---
name: adversarial-build
description: >
  The full build loop for a feature slice in this repo: AIOS-CLI ticket
  (create-or-update) → write code with spec-first tests → Fable adversarial
  review → fold → Codex adversarial review → fold → push the PR → update the
  ticket. Use when asked to "build the next phase/slice", "build X with
  reviews", or /adversarial-build. Every step below traces to a defect one of
  the two reviewers actually caught while this loop was being practiced
  (PCCA-1/PCCA-2, PRs #519/#520) — none of it is ceremony. Never merges; the
  merge word belongs to the human.
---

# Adversarial build loop

The spine, verbatim from the operator:

> **aios ticket (create or update) → write code → Fable adversarial review → fold →
> Codex adversarial review → fold → push the PR → aios ticket update**

Two different models review because they demonstrably catch different defect
distributions: on the slices this loop was built on, Fable found the
reserved-slug hijack and the untested fail-open scope direction; Codex found the
planted-agent-in-builtin oracle hole and the Everyone-vs-External asymmetry —
each after the other had passed the same code. One reviewer is a gate; two are
an experiment with replication.

## 0. Ticket first (AIOS CLI)

- Detect first: `grep '<KEY>' ~/Projects/chetan-workspace/3-log/tasks.md` (or scan for the
  work's obvious key prefix). If no ticket exists: append a row to `3-log/tasks.md` in
  `~/Projects/chetan-workspace` — ID matching `[A-Z][A-Z0-9]+-\d+` (ONE hyphen,
  uppercase; `ARC-STAB-1` silently fails to close), status `in_progress`.
  If one exists: update its row instead.
- `cd ~/Projects/chetan-workspace && set -a && . ./.env && set +a`, then
  `/opt/homebrew/bin/aios push --dry-run` (always preview) and
  `/opt/homebrew/bin/aios push`. The binary path matters: bare `aios` is a
  shell function that fails outside a workspace.
- Read the projection back (`/opt/homebrew/bin/aios status` → `pm projection: ok · N synced`
  — both `push` and `status` print that line).
  Cite the BRAIN row key in branch/PR/trailer, never the Linear `AIO-*` key.

## 1. Write the code

- Branch from `origin/main` — or from the prerequisite slice's branch when
  stacking (PR base = that branch; retarget to `main` after it merges).
- Spec-first tests in the tier that catches the failure mode (CLAUDE.md §4);
  for access/persistence work that means real-Postgres data-mechanics, not
  FakeSupabase. Update `docs/ARCHITECTURE.md` (drift blocks + sources-of-truth
  row) in the same change.
- Full local verification: `npx tsc --noEmit` · `npm run lint` · `npm test` ·
  `npm run db:test:up && npm run test:datamechanics:local` · `npm run check:docs`.
  (The npm script pins the test-DB URL/port; never hand-write the incantation — it drifts.)
- **Commit BEFORE mutation-testing.** Mutations are reverted with
  `git checkout <file>`, which restores the file from the index/HEAD — either
  way, uncommitted edits are gone. Running it against an uncommitted tree
  silently destroys unfolded work (this happened; the folds had to be
  re-applied by hand).
- Mutation-verify every guard and security-relevant branch: break the thing,
  confirm the INTENDED test reddens (not just any test), revert, confirm the
  tree is clean (`git status --short`). A guard that survives its mutation is
  decoration.

## 2. Fable adversarial review

Spawn the reviewer (`Agent`, `subagent_type: "code-reviewer"`, `model: "fable"`,
background) on the branch diff. The prompt shape that works:

- Name the exact diff command (`git diff <base>...HEAD`) and what the diff IS,
  including which spec sections govern it.
- If a prior review round already ran, list what was found AND folded — so the
  reviewer hunts new defects and attacks the folds for second-order bugs
  instead of re-reporting.
- Give a concrete attack list per surface (schema traps, races, fail-open
  paths, guard evasions, green-by-construction tests, false claims in
  comments/docs) and require file:line evidence plus a CLEAR/BLOCKED verdict.
- **Forbid DB-touching test runs in the reviewer** ("do NOT run the
  data-mechanics tier or npm test — shared test-Postgres collision with the
  main session; pure unit tests are fine"). Concurrent runs against the shared
  container produce phantom failures that read as product bugs.
- Never run your own data-mechanics tier while the reviewer is live, for the
  same reason.

## 3. Fold — with re-derivation both ways

- **Every finding is a hypothesis.** Re-derive it against the code before
  touching anything. Confirmed → fix + a regression test named for the finding.
  Wrong → REFUTE with evidence and record the refutation in the commit/PR
  (example from practice: a claimed regex match disproven with a one-line
  `node -e` repro — the fold would otherwise have "fixed" working code).
- Re-run the full verification set after folding; mutation-verify the new
  fixes; commit as `fix(...): fold Fable review — <finding list>`.
- Deferring a finding is allowed only with the reason written down (PR body +
  a code comment at the site), never silently.

## 4. Codex adversarial review

`codex exec --sandbox read-only -m gpt-5.6 "<prompt>"` in the background (model
id current as of 2026-08; update as Codex models roll). Same prompt discipline
as step 2, plus:

- Tell it what Fable found and what was folded (including refuted claims), and
  explicitly task it with breaking the folds.
- Same DB-test prohibition.
- Expect it to find things Fable missed — that is the point of the second
  model, not a formality. If both passes come back CLEAR on first try, be
  suspicious of the prompts before being proud of the code.

## 5. Fold again

Same discipline as step 3. Commit as `fix(...): fold Codex review — <list>`.
Re-run everything; the tiers must be green after EVERY fold, not just at the
end.

## 6. Push the PR (never merge)

- `git push -u origin <branch>`, then `gh pr create` — base `main`, or the
  prerequisite branch when stacked.
- PR body must carry, honestly:
  - what the slice is + what is deliberately NOT in it (next slices named);
  - the verification table (tier counts, mutations run and what each reddened);
  - `## Review` attestation naming BOTH reviewers, their verdicts INCLUDING
    the BLOCKED rounds and refuted claims — an attestation that only says
    CLEAR launders the process; the blocked-then-folded history is the value.
    **At least one line must parse as `Reviewed by <tool> — verdict <summary>`**
    — that exact shape is what the required `pr-review-gate` check matches
    (`scripts/pr-review-gate.mjs`); a bullet-list rendering with no such line
    fails the gate. Steps 2–5 SATISFY the CLAUDE.md Review gate — do not run
    the separate `pr-review-attestation` protocol on top; use it only for its
    line-format reference;
  - deferrals with reasons;
  - `AIOS-Work: <ROW-KEY>` trailer (brain row key, not Linear key).
- Stacked-PR trap: `ci.yml` fires only on PRs targeting `main`/`staging`, so a
  stacked PR runs just the gate workflows. Close the gap yourself:
  `npm run test:http:local` (the http tier is otherwise CI-only) and comment
  the result on the PR. Read the brain-task check's RUNTIME log line
  (`Found work key(s): …`) — the check is advisory and greens on failure.
- Watch checks to a terminal state (background `until … pending …` loop).
- **Do not merge.** Report and stop; the merge word is the human's.

## 7. Close the loop (AIOS CLI again)

- After pushing: update the ticket row if scope changed; the PR link lands via
  the work-events trailer.
- After the HUMAN merges: set the row's `Status` to `done` in
  `3-log/tasks.md`, `/opt/homebrew/bin/aios push` (dry-run first), and read the status back.
  The merge automation deliberately does NOT close workspace-pushed rows
  (`linked`, not `applied`) — closing it yourself is the only thing that
  closes it (CLAUDE.md close gate).

## Failure modes this loop exists to catch (all observed, none hypothetical)

| Class | Caught by | Example from practice |
|---|---|---|
| Second-order bug in your own fix | either reviewer | tier-only builtin filter added in a fold; agent-in-Everyone passed it |
| Fail-open direction untested | Fable | `[]`→`NULL` scope conflation had no red test; suite stayed green |
| Guard evasion | both | backtick quotes, variable-table idiom, SQL files unscanned |
| Spec ruling silently unimplemented | Fable | "no external-tier delegation" stated twice, enforced nowhere |
| Reviewer hallucination | you | regex-matches claim refuted with a node repro |
| Phantom test failures | process rule | concurrent data-mechanics runs on the shared container |
| Lost work during mutation testing | process rule | `git checkout` against an uncommitted tree |
