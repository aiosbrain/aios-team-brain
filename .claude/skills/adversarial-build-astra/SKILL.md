---
name: adversarial-build-astra
description: >
  The adversarial build loop with the ROLES INVERTED: gpt-6-astra AUTHORS (the
  spec, then the code) and Fable 5.1 is the independent reviewer. Spine — AIOS
  ticket → astra writes the spec → fold → Fable reviews the SPEC → fold → cycle
  to convergence → spec gate (`aios spec eval` must say SPEC_READY) → astra
  writes the code → Fable reviews the DIFF → fold → astra reviews the DIFF cold
  → fold → push the PR → update the ticket. Use when asked to build a slice with
  astra as the author, or /adversarial-build-astra. The sibling skill
  `adversarial-build` is the same loop with Claude authoring; prefer that one
  unless astra is specifically wanted. Never merges; the merge word belongs to
  the human.
---

# Adversarial build loop — astra authoring

The spine:

> **aios ticket → astra WRITES the spec → fold → Fable reviews the SPEC → fold →
> cycle until convergence → spec gate (`aios spec eval`) → astra WRITES the code →
> Fable reviews the DIFF → fold → astra reviews the DIFF (fresh session) → fold →
> push the PR → update the ticket**

**What is different from `adversarial-build`, and why it matters.** In the sibling
skill Claude authors and two models review. Here **astra authors both the spec and
the code**, which changes two things you must not paper over:

1. **Astra gets WRITE access to the worktree** (`--sandbox workspace-write`). The
   sibling skill only ever ran Codex read-only. §6 bounds that.
2. **The astra code review is CORRELATED with the astra build.** Same model, same
   blind spots. It is the *weaker* of the two rounds and is sequenced last
   deliberately — Fable, the independent reviewer, goes first and is the round that
   must clear. Never treat an astra CLEAR as substituting for a Fable one.

Everything below that is not about model identity — the ticket, the spec gate,
mutation testing, the attestation, "never merge" — is inherited from
`adversarial-build` because it traces to a real defect, not to which model is
holding the pen.

---

## 0. Prerequisite — the CLI, probed, before anything long

**`gpt-6-astra` needs a recent Codex CLI.** Measured 2026-09-05: `codex-cli 0.147.0`
(Homebrew cask) returns, *after the prompt is sent*:

```
400 invalid_request_error: The 'gpt-6-astra' model requires a newer version of
Codex. Please upgrade to the latest app or CLI and try again.
```

That is a different failure from an unsupported model — the id is real and the
account can use it; the binary is stale. Upgrade with `brew upgrade --cask codex`.

**Probe before every long run, not once ever:**

```bash
codex exec --model gpt-6-astra --sandbox read-only --skip-git-repo-check \
  "reply with exactly: OK" < /dev/null 2>&1 | tail -3
```

A clean `OK` is the only green light. Two failure shapes to tell apart, because
they have different fixes:

- `requires a newer version of Codex` → upgrade the CLI;
- `is not supported when using Codex with a ChatGPT account` → the id is wrong for
  this account; fall back to `gpt-5.6-sol` and **say in the PR which model actually
  ran**. Never silently substitute a model and describe it as astra.

Also inherited: `codex exec` **hangs without `< /dev/null`**, and quota exhaustion
is a real mid-loop state — when it happens, name the missing reviewer in the PR
rather than substituting a correlated round and calling it replication.

---

## 1. Ticket first (AIOS CLI)

- Detect first: `grep '<KEY>' ~/Projects/chetan-workspace/3-log/tasks.md`. If no
  ticket exists, append a row; if one exists, update it. ID must match
  `[A-Z][A-Z0-9]+-\d+` — ONE hyphen, uppercase.
- `cd ~/Projects/chetan-workspace && set -a && . ./.env && set +a`, then
  `/opt/homebrew/bin/aios push --dry-run 3-log/tasks.md` and
  `/opt/homebrew/bin/aios push 3-log/tasks.md`. The bare `aios` on PATH is a shell
  function that fails outside a workspace — use the binary path.
- **Read the projection back** (`aios query "what is the status of <KEY>?"`). A push
  that printed `ok` is not proof the row moved.
- Cite the **brain row key** in the branch, PR and `AIOS-Work:` trailer — never the
  Linear `AIO-*` key, which resolves to nothing.

---

## 2. Astra writes the spec

**Measure the terrain first and put the numbers IN the prompt.** The most expensive
failures in this repo's history were specs whose scope came from a count taken
afterwards — one slice was blocked four times across two models for exactly that,
and the count was wrong three times running. Give astra the measured facts and tell
it to attack the *inferences*, not the numbers.

```bash
codex exec --model gpt-6-astra --sandbox workspace-write --skip-git-repo-check - \
  < /tmp/astra-spec-prompt.md > /tmp/astra-spec.out 2>&1 &
```

The prompt must carry:

- **the ticket key and the problem**, in the operator's words;
- **the measured terrain** (live, read-only reads — prod, git, `gh api`) with each
  number's provenance, and an instruction to re-derive anything it doubts;
- **where the spec goes** — `docs/design/<slug>.md` — and the shape this repo's
  gate expects: a status line, `· Owner:`, `· Tier build-with:`, **Deps**,
  **Increment**, Problem, Decision, **Scope** (in *and* cut, each with a reason),
  **Acceptance criteria**, **What would falsify this**;
- **the criteria rules**: each bullet's FIRST line carries the tier anchor and a
  backticked observable; a criterion naming design vocabulary rather than an
  observable is a defect; every Decision needs at least one criterion;
- **the files it must read** to judge the design, and the tests that state intent
  it would be CHANGING — a spec that quietly reverses shipped behaviour is the
  failure this catches most often;
- an explicit invitation to say the slice should be **built differently or
  DECLINED**. A decline is a legitimate, non-embarrassing outcome.

**Do not run `aios spec eval` yet.** §4 explains the ordering.

---

## 3. Fold, then Fable reviews the SPEC — and cycle

**Fold with re-derivation both ways.** Every finding is a hypothesis: verify it
against the code before accepting, and **refute with evidence** what does not hold.
A fold that "fixes" working code because a reviewer asserted a bug is a real cost —
it has happened here, and a one-line `node -e` repro is usually enough to settle it.

Then the independent round:

```
Agent(subagent_type: "code-reviewer", model: "fable", run_in_background: true)
```

Prompt discipline:

- say **no code has been written yet** — review the design, not a diff;
- name the spec path and the files/specs it must read to judge it;
- hand it the measured terrain and say **attack the inferences, not the numbers**;
- give a per-surface attack list (schema traps, fail-open directions, green-by-
  construction criteria, existential-where-universal, a Decision with no criterion,
  a claim the repo contradicts);
- **forbid DB-touching test runs** — "do NOT run the data-mechanics tier or
  `npm test`; shared test-Postgres collision with the main session. Pure unit runs,
  reads, greps, git and `gh api` reads are fine";
- require file:line or a concrete inputs→wrong-outcome scenario, and a verdict:
  `BLOCKED | CLEAR-WITH-CONDITIONS | CLEAR | DECLINE`.

### The stopping rule — "a good place" made concrete

Cycle spec → Fable → fold. **Stop when a full round returns no BLOCKER and no HIGH,
*and* that round discovered no new scope.** The second half is the one that matters:
a round which finds only wording is convergence; a round which finds *another file
nobody had counted* is not, however mild its verdict.

**If three rounds do not converge, the slice is too big — split it.** That is not
defeat, it is the measured outcome: on this repo's release program the split is
exactly what unblocked a slice that had absorbed four blocking verdicts. Record the
deferred half as its own ticket, with the ordering rule that failed written into it.

---

## 4. Spec gate — AFTER the design survives, never before

```bash
set -a && . ~/Projects/chetan-workspace/.env && set +a && \
  /opt/homebrew/bin/aios spec eval docs/design/<slug>.md --tier deterministic --no-llm
```

Run it **from the repo root** — running it from the workspace resolves the spec's
repo-relative paths against the wrong tree and emits dozens of false `SR3` blockers.

Required: `verdict: SPEC_READY`, exit 0.

**Why after.** The eval is deterministic and checks SHAPE (anchors, tiers,
resolvable paths). A model reads the spec cold and attacks the DESIGN. Gating first
tidies a document that may not deserve to exist — and worse, `SPEC_READY` reads
like a green light, which makes the design review feel like the formality it is not.
Running the eval as a cheap **preflight** and handing its blocker list to the
reviewer is fine; what must not happen is `SPEC_READY` being the last word before
code.

Two gate edges worth knowing: a criterion whose FIRST line leads with a
backticked path to a file that does not exist yet is read as "existing code" and
blocks — phrase it as *"a guard asserts … (the constant lands in a new module,
`scripts/foo.mjs`)"*. And **re-run the eval after ANY amendment** — SPEC_READY is a
state, not a milestone.

---

## 5. Astra writes the code

Branch from `origin/<contribution base>` (see `scripts/branches.mjs`; today `main`).
Then hand astra the approved spec:

```bash
codex exec --model gpt-6-astra --sandbox workspace-write --skip-git-repo-check - \
  < /tmp/astra-build-prompt.md > /tmp/astra-build.out 2>&1 &
```

The prompt must carry the spec path, the criteria as the definition of done, and
this repo's non-negotiables:

- **Spec-first tests, never characterization-first** — write the assertion from what
  the product *should* do, then run it. A spec-derived test that goes red found a
  real gap. Tests that read the implementation and assert what it already does are
  green by construction and forbidden as the default.
- **The right tier** (CLAUDE.md §4): unit for parse/guards, data-mechanics for
  persistence and tier isolation, http for routing/auth.
- **Update `docs/ARCHITECTURE.md` in the same change** if routes, tables or sources
  move — the drift guard fails the build otherwise.
- **Astra must not**: run the data-mechanics tier (collides with the main session's
  Postgres), push, merge, touch Railway, or change any GitHub setting.

**Then verify yourself — do not take the build report on trust.** `npx tsc
--noEmit` · `npm run lint` · `npm test` · `npm run check:docs`. Read the diff.
An author's summary of its own work is a claim, not evidence.

### Mutation-test every guard, with the command

```bash
node scripts/mutate.mjs <target> --edit /tmp/needle.txt /tmp/replacement.txt -- <test files>
```

It refuses unless the tree is a committed checkpoint, applies the edits, runs the
tests, restores, verifies the restore, and prints `REDDENED` or `SURVIVED`. **Paste
the verdict into the PR; do not narrate it from memory.**

Confirm the **intended** test reddens — a mutation that reddens something else has
told you nothing about the guard. And treat a SURVIVED as information rather than a
nuisance: it is either a guard that is decoration, or a mutation aimed at nothing
(deleting an assertion can never redden the test containing it — re-aim it at the
shape being asserted about).

---

## 6. Fable reviews the DIFF — the round that must clear

Same subagent invocation as §3, now against `git diff origin/<base>...HEAD`.

- Name the exact diff command and what the diff IS, including the spec sections
  that govern it.
- **Say astra wrote it.** A reviewer told the code is machine-authored from a spec
  attacks the spec→code gap, which is where this loop's defects actually live.
- List what the spec rounds already found and folded, so it hunts new defects and
  attacks the folds rather than re-reporting.
- Same DB-test prohibition. Same evidence bar. Same verdict vocabulary.

**Bounding astra's write access, since §5 grants it.** After the build, confirm
astra changed only what the slice claims: `git status --short` and `git diff --stat`
against the spec's Scope. A file outside Scope is a finding, not a tidy-up — the
sibling skill has a scar from 399 lines of a *different* session's uncommitted work
being swept into one commit. Stage deliberately; never `git add -A` in a tree you
did not leave clean.

---

## 7. Fold, then astra reviews the DIFF — cold, and correlated

Fold Fable's findings with the same re-derivation discipline as §3.

Then astra's round — and **the session must be fresh**:

```bash
codex exec --model gpt-6-astra --sandbox read-only --skip-git-repo-check - \
  < /tmp/astra-review-prompt.md > /tmp/astra-review.out 2>&1 &
```

- **`--sandbox read-only`** here, not `workspace-write`. The reviewer reads.
- **A NEW invocation, never a resumed build session.** Astra reviewing its own build
  context is self-review; astra reading the diff cold is at least an independent
  *pass*, even though it is the same model.
- Tell it what Fable found and what was folded, and **task it explicitly with
  breaking the folds** — the second-order bug introduced by a fix is the defect
  class an author structurally cannot see.

**Read its verdict with the correlation in mind.** If astra clears a diff astra
wrote, that is weak evidence. If it BLOCKS, that is strong — a model finding fault
with its own output is unlikely to be a false positive. Weight them asymmetrically
and say so in the PR.

---

## 8. Fold again, push the PR — never merge

Same fold discipline. Re-run the full verification set after **every** fold, not
just the last.

`git push -u origin <branch>`, then `gh pr create --base main`. The PR body carries,
honestly:

- what the slice is, and what is deliberately NOT in it (name the next slice);
- the verification table — tier counts, mutations run and what each reddened,
  including any that SURVIVED and what that told you;
- **who wrote it**: state that astra authored the spec and the code. A reader
  weighing the review evidence needs to know the author was not the reviewer;
- the `## Review` attestation, with **at least one line parsing as**
  `Reviewed by <tool> — verdict <summary>` — the required `pr-review-gate` check
  matches that exact shape, and an unedited `<tool>` placeholder is rejected.
  Name **both** rounds and their verdicts *including the BLOCKED ones*; an
  attestation that only says CLEAR launders the process. Mark the astra round as
  the correlated one.
- deferrals with reasons, and `AIOS-Work: <ROW-KEY>`.

**Verify the body as STORED**, not by the exit code — `gh pr edit` has silently
no-opped behind a GraphQL deprecation warning here. Read it back with `gh pr view`.

Watch checks to a terminal state. Read the brain-task check's **runtime log** for
`Found work key(s): …` — it is advisory and greens on failure.

**Do not merge.** Report and stop.

---

## 9. Close the loop

After the human merges: set the row's `Status` to `done` in `3-log/tasks.md`,
`aios push` (dry-run first), and **read the status back**. The merge automation
deliberately does not close workspace-pushed rows — they resolve `linked`, not
`applied` — so closing it yourself is the only thing that closes it.

---

## What this loop's shape is defending against

| Failure | Caught by |
|---|---|
| A spec whose scope came from a count taken afterwards | §2's measured terrain + §3's stopping rule |
| A slice too big to converge | §3's three-round split rule |
| An author's summary standing in for evidence | §5's "verify yourself" |
| A guard that is decoration | §5's mutation table, on the *intended* test |
| The second-order bug inside a fix | §7's "break the folds" |
| A correlated CLEAR read as independent | §7's asymmetric weighting |
| A fabricated attestation | §8's both-rounds-including-BLOCKED rule |
| A model substituted silently for the one named | §0's two failure shapes |
