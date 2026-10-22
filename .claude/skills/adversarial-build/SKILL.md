---
name: adversarial-build
description: >
  The full build loop for a feature slice in this repo: AIOS-CLI ticket
  (create-or-update) → write the spec → A MODEL REVIEWS THE SPEC (Codex, before
  any code and before the eval — additive to CLAUDE.md's Fable plan review, not
  a replacement) → spec gate (`aios spec eval` must say SPEC_READY) → write code
  with spec-first tests → Fable adversarial
  review → fold → Codex adversarial review → fold → push the PR → update the
  ticket. Use when asked to "build the next phase/slice", "build X with
  reviews", or /adversarial-build. Every step below traces to a defect one of
  the two reviewers actually caught while this loop was being practiced
  (PCCA-1/PCCA-2, PRs #519/#520) — none of it is ceremony. Never merges; the
  merge word belongs to the human.
---

# Adversarial build loop

The spine, from the operator (spec gate added by operator revision):

> **aios ticket (create or update) → write the spec → Codex reviews the SPEC → fold →
> spec gate (`aios spec eval`) → write code → Fable adversarial review → fold →
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

## 0.5 Author the spec (no eval yet)

- **Locate the governing spec.** A build slice must trace to a written spec
  (CLAUDE.md task gate: anything touching schema, money, or more than one
  surface). For this repo's access work that is
  `docs/specs/project-context-classification-v1.md` §-references in the PR.
- **If no spec exists**: author one before any code — scaffold with
  `/opt/homebrew/bin/aios spec init <path>` (writes the issue-template shape)
  or write it in `docs/design/`/`docs/specs/`.
- **Measure before designing.** Read the terrain the spec's claims rest on
  (prod, read-only), put the numbers IN the spec, and name what is NOT measured
  as such. On MTGATT-2 the plan-review blockers were inferences drawn from real
  numbers, never the numbers themselves.
- **Then §0.6 — do not run the eval yet.** §0.6 explains why that way round.

## 0.6 Codex reviews the SPEC — before the eval, before any code

**Order matters and is not arbitrary: the model reads the spec FIRST, then the
eval runs.** The eval is deterministic and checks SHAPE (anchors, tiers,
resolvable paths); a model reads the spec cold and attacks the DESIGN. Gating
first tidies a document that may not deserve to exist — and worse, a
`SPEC_READY` verdict reads like a green light, which makes the design review
feel like the formality it is not. Review, fold, then gate, so the thing the
eval blesses is the design that survived.

Nothing stops you running the eval as a cheap PREFLIGHT and handing its blocker
list to the reviewer — those findings are real (§0.7 lists what it catches).
What must not happen is `SPEC_READY` being the last word before code.

**ADDITIVE to the Fable plan review CLAUDE.md requires, not a replacement.**
Where both models are available the spec gets both: on MTGATT-2 the first Fable
DIFF round found a HIGH that five Codex rounds had already cleared, so extra
rounds of one model are correlated rather than additive. When one is
unavailable, name which, and say so in the PR.

```
codex exec --sandbox read-only -m gpt-5.6-sol "<prompt>" < /dev/null
```

Prompt discipline (same shape as the diff reviews, aimed at the design):

- Name the spec path and tell it **no code has been written yet**.
- Name the files/specs it must read to judge the design, and the tests that
  define behaviour the spec would CHANGE — a spec that quietly reverses shipped
  intent is the failure this step catches most often.
- Give it the measured terrain (numbers from prod, read-only) and tell it to
  **attack the INFERENCES drawn from them**, not the numbers.
- Ask explicitly whether the slice should be **built at all, built differently,
  or DECLINED** — and say a decline is a legitimate, non-embarrassing outcome.
  Require `VERDICT: BLOCKED | CLEAR-WITH-CONDITIONS | CLEAR | DECLINE` plus the
  one sentence that most changes what to do next.
- Same evidence bar as a diff review: file:line or a concrete
  inputs→wrong-outcome scenario; same DB-test prohibition.

**Fold with re-derivation both ways** (step 3's discipline applies here):
verify each finding against the code before accepting it, and REFUTE with
evidence what does not hold. Then re-run the review on the REVISED spec — a
second round attacks the fix, and in practice that is where over-correction gets
caught.

WHY THIS STEP EXISTS (MTGATT-2, 2026-08-18 — every clause is a real outcome):
round 1 returned **DECLINE**, killing a safety premise the spec asserted while
the code it consumed did the opposite, and killing an identifier that would have
fused unrelated meetings. Round 2 returned **DECLINE on the fix for round 1** —
the rewrite reversed a shipped, tested product contract (`Bob pushed nothing…
the meeting is still a record of work he did`) and leaned on a field that is the
resolved AUTHOR rather than the pusher. Both were re-derived and both held. The
slice that shipped was a fraction of what was specced, and the two rounds cost
minutes against a build that would have had to be reversed. Note also what the
eval could NOT have caught: it passed `SPEC_READY` on the version that was later
declined **twice** — shape was never the problem.

## 0.7 Spec gate (AIOS CLI) — run AFTER the design has survived §0.6

- **Gate the spec** with the eval tool, and mind two sharp edges learned in
  practice:
  - Run **from the repo root** with the workspace env loaded:
    `set -a && . ~/Projects/chetan-workspace/.env && set +a &&
    /opt/homebrew/bin/aios spec eval <file> --tier deterministic --no-llm`.
    Running from the workspace directory resolves the spec's repo-relative
    code paths against the wrong tree and emits dozens of FALSE `SR3` blockers
    (observed; cost a full debugging detour).
  - Required outcome: `verdict: SPEC_READY`, exit 0. Real blockers this gate
    has caught: acceptance criteria with no observable anchor (it reads only
    each bullet's FIRST source line — put the test-tier/backtick anchor
    there), a missing build-with tier, module references that don't resolve.
  - `--tier full` adds the adversarial LLM layer when its key
    (`DEEPSEEK_API_KEY`) is configured; when absent, the loop's two model
    reviews stand in as the adversarial layer — say so in the PR, don't
    pretend the layer ran.
  - `aios spec fix <file>` exists for the bounded auto-fix loop; hand-fixing
    against the blocker list is usually faster for a spec you just wrote.
- Re-run the eval after ANY spec amendment mid-build — SPEC_READY is a state,
  not a milestone.

## 1. Write the code

- Branch from the contribution base (currently `staging`, declared in `scripts/branches.mjs`) — or from the prerequisite slice's branch when
  stacking (PR base = that branch; retarget to the contribution base (currently `staging`, declared in `scripts/branches.mjs`) after it merges).
- Spec-first tests in the tier that catches the failure mode (CLAUDE.md §4);
  for access/persistence work that means real-Postgres data-mechanics, not
  FakeSupabase. Update `docs/ARCHITECTURE.md` (drift blocks + sources-of-truth
  row) in the same change.
- Full local verification: `npx tsc --noEmit` · `npm run lint` · `npm test` ·
  `npm run db:test:up && npm run test:datamechanics:local` · `npm run check:docs`.
  (The npm script pins the test-DB URL/port; never hand-write the incantation — it drifts.)
- **Mutation-test with ONE command — `node scripts/mutate.mjs`.** It does the whole sequence: refuses
  unless the tree is a committed checkpoint (by calling `scripts/mutation-guard.mjs`, so there is one
  owner of that question), refuses an untracked target, applies the `--edit` pairs simultaneously
  against the original bytes, runs the tests you name, restores the file, verifies the restore, and
  prints a verdict — `REDDENED` with the failing test names, or `SURVIVED`.

  ```
  node scripts/mutate.mjs lib/foo.ts --edit /tmp/needle.txt /tmp/replacement.txt -- test/foo.test.ts
  ```

  **Paste that verdict into the PR body. Do not narrate it from memory** — that is the half of this
  failure no start-of-run check can see, and it is how two commits in one session came to claim changes
  their diffs did not contain.

  **`--keep` when the mutation IS the change** ("prove this term is dead, then leave it deleted"): it
  leaves the edit applied and prints a diff stat scoped to the target, removing the
  re-apply-from-memory step that lost work three times. It expects the tests to stay GREEN and refuses
  to keep a red edit unless you pass `--keep-even-if-red`.

  **Exit codes track the expectation, not the verdict:** `0` met, `2` missed, `1` refused (always with a
  message naming why), so the default `--expect reddened` exits 0 when the mutation is caught. Note
  `--keep` on a RED edit exits **2**, not 1 — it is an expectation missed, not a usage error.

  **Mutation-verify every guard and security-relevant branch**, and confirm the INTENDED test reddens —
  not just any test. A guard that survives its mutation is decoration; a mutation that reddens something
  else has told you nothing about the guard.

  WHY A COMMAND AND NOT A RULE: this step said "commit BEFORE mutation-testing" in prose for its whole
  life, then MUTGUARD-1 added a check you had to remember to call — and the same operator lost work
  three times in the session after it shipped, because a mutation is a SEQUENCE and every ad-hoc
  spelling of it skipped the check. Precisely (verified against real git, after both reviewers corrected
  an earlier overstatement): `git checkout -- <file>` restores from the INDEX, so an UNSTAGED edit is
  destroyed by the command you expect to succeed, a STAGED one survives, and untracked files cannot be
  reached at all. MUTFLOW-1.

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

`codex exec --sandbox read-only -m gpt-5.6-sol "<prompt>"` in the background. Same prompt
discipline as step 2, plus:

- **`gpt-5.6-sol` (probe-verified supported on this account; previously `gpt-5.5`).** Bare `gpt-5.6`
  failed on a ChatGPT-login account with `400 invalid_request_error: The 'gpt-5.6' model is
  not supported when using Codex with a ChatGPT account` — and such failures land AFTER the
  prompt is sent, burning a round trip and reading like a hang (this step said `gpt-5.6`
  and cost exactly that on GRAPHSMALL-1). ALSO: quota exhaustion is a real state — the
  account's rolling window ran dry 2026-08-20→22 mid-loop; when that happens, name the
  missing reviewer in the PR rather than substituting a correlated same-model round and
  calling it replication. Update the id when the account's
  supported set actually changes, and verify with a one-line probe before a long review.

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

- `git push -u origin <branch>`, then `gh pr create` — base: the contribution base (currently `staging`, declared in `scripts/branches.mjs`), or the
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
| A spec whose premise the code contradicts | Codex, on the SPEC | "each person only asserts about themselves" while the code credited every invitee |
| A fix that reverses shipped intent | Codex, on the REVISED spec | narrowing attendance to the pusher deleted a deliberate, tested behaviour |
| Reviewer hallucination | you | regex-matches claim refuted with a node repro |
| Phantom test failures | process rule | concurrent data-mechanics runs on the shared container |
| Lost work during mutation testing | `scripts/mutate.mjs` | `git checkout` on an uncommitted tree — three times in one session, while the rule was prose plus a skippable check |
