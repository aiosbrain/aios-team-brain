---
name: adversarial-build-astra
description: >
  The adversarial build loop with the ROLES INVERTED: the WORKTREE'S SELECTED
  Codex model AUTHORS (the spec, then the code) — `gpt-6-astra` by default,
  resolved from config rather than pinned — and Fable 5.1 is the independent
  reviewer. Spine — AIOS
  task opened FIRST → astra writes the spec → fold → Fable reviews the SPEC → fold
  → cycle to convergence → spec gate (`aios spec eval` must say SPEC_READY) → post
  the spec to the task and move it to in_progress → astra writes the code → Fable
  reviews the DIFF → fold → astra reviews the DIFF cold → fold → push the PR citing
  the task key → the task goes done only when EVERY PR carrying that key is merged. Use when asked to build a slice with
  astra as the author, or /adversarial-build-astra. The sibling skill
  `adversarial-build` is the same loop with Claude authoring; prefer that one
  unless astra is specifically wanted. Never merges; the merge word belongs to
  the human.
---

# Adversarial build loop — astra authoring

The spine:

> **open the task (`todo`) → astra WRITES the spec → fold → Fable reviews the SPEC →
> fold → cycle until convergence → spec gate (`aios spec eval`) → POST the spec to the
> task and move it to `in_progress` → astra WRITES the code → Fable reviews the DIFF →
> fold → astra reviews the DIFF (fresh session) → fold → push the PR citing the task
> key → … → when EVERY PR carrying that key is merged, the task goes `done`**

**What is different from `adversarial-build`, and why it matters.** In the sibling
skill Claude authors and two models review. Here **the worktree's selected Codex
model authors both the spec and the code** — `gpt-6-astra` in this operator's
config today, but §0 resolves it rather than assuming it — which changes two things
you must not paper over:

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

## 0. Prerequisite — RESOLVE the author model, then probe it

**Do not pin a model id in this skill.** The author is whatever Codex is configured
to use in this worktree, so the same loop works when the operator changes models
without anyone editing the skill. `codex exec` **with no `--model` flag** resolves
from `~/.codex/config.toml` (or `$CODEX_HOME`, or `--profile`, or `-c model=…`) —
verified: omitting the flag ran `model: gpt-6-astra`, the configured value.

**Resolve and RECORD it, before EVERY long run — not once ever.** The config this
resolves from is global and mutable, so a stale record is a lie that §8 publishes.

```bash
# The record lives OUTSIDE the workspace on purpose: $HOME is denied to the sandbox
# and /tmp is not (see the table below) — and §6's argument is that bounds must be
# ENFORCED, not requested. A record astra can overwrite is not a record.
WT=$(basename "$(git rev-parse --show-toplevel)")
REC=~/.cache/aios-astra/author-model-$WT; mkdir -p "$(dirname "$REC")"
codex exec --sandbox read-only --skip-git-repo-check \
  "reply with exactly: OK" < /dev/null 2>&1 | tee "/tmp/astra-probe-$WT.out" | tail -3

# GATE ON THE ANSWER, NOT THE BANNER. Codex prints `model: <id>` from CONFIG *before*
# the request is sent, so a probe that 400s still shows an id. Measured: a deliberately
# bogus id printed `model: bogus-model-xyz` and THEN the 400 — a check on the extracted
# name passes happily. Only the final line proves the model actually answered.
tail -1 "/tmp/astra-probe-$WT.out" | grep -qx OK \
  || { echo "REFUSING: probe did not answer OK — the model did not run"; exit 1; }

grep -m1 '^model:'            "/tmp/astra-probe-$WT.out" | awk '{print $2}'  > "$REC"
grep -m1 '^reasoning effort:' "/tmp/astra-probe-$WT.out" | awk '{print $3}' >> "$REC"
test -s "$REC" || { echo "REFUSING: banner format changed; cannot resolve the author"; exit 1; }
cat "$REC"
```

**`$REC` is the author of record** — the id *and* the reasoning effort, because an
author at `low` effort is a materially different author from one at `high`, and the
config sets both. If the banner format ever changes, `grep` returns nothing and the
`test -s` stops the run; without it §8 would interpolate an empty string and publish
an attestation naming **no model at all** — a fabricated attestation, which this repo
treats as worse than an absent one.

**Write it to a FILE, not a shell variable.** The orchestrator's shell does **not
persist between tool calls** — an `AUTHOR_MODEL=…` assignment here is gone by §7 and
§8. Verified: an exported variable set in one call reads back empty in the next. For
the same reason **every later read must re-derive the path inline**:

```bash
WT=$(basename "$(git rev-parse --show-toplevel)"); cat ~/.cache/aios-astra/author-model-$WT
```

Never describe the run as "astra" without reading it; the whole point of resolving is
that it can change. ("astra" is the name of the AUTHOR ROLE in this skill, not a
promise about which id filled it.)

**Every run must agree with the record.** §2, §5 and §7 each write a `.out` file whose
banner names the model that actually ran. After each, assert it matches:

```bash
grep -m1 '^model:' /tmp/astra-<step>.out | awk '{print $2}'   # must equal line 1 of $REC
```

A mismatch means the author changed mid-loop — stop, re-probe, and disclose it. This
is what lets §8 truthfully name the model *for the spec* and *for the code* separately;
a re-probe at §7 reports §7's state and cannot tell you what built the diff at §5.

**Per-worktree selection**, if you want two worktrees on different models: set
`CODEX_HOME` to a worktree-local directory holding its own `config.toml`, or pass
`--profile <name>`. Both are honoured by the flag-free invocation above, so nothing
else in this skill changes.

Two failure shapes to tell apart, because they have different fixes:

- `requires a newer version of Codex` → upgrade the CLI (`brew upgrade --cask
  codex`). Measured 2026-09-05: `gpt-6-astra` on `codex-cli 0.147.0` returned
  `400 … requires a newer version of Codex` **after the prompt was sent**; 0.153.4
  answered cleanly. The id was real and the account could use it — only the binary
  was stale, which is why this is not the failure below.
- `is not supported when using Codex with a ChatGPT account` → the configured id is
  wrong for this account. Fix the config rather than papering over it here. A
  probe-verified id on this account as of 2026-09-05 is **`gpt-5.6-sol`** (the sibling
  skill §4 records why guessing `gpt-5.6` cost a round trip on GRAPHSMALL-1).

**If Codex is unavailable entirely, use the sibling skill `adversarial-build`.** Do
not run *this* loop with Claude holding the pen — its whole shape (the correlation
weighting in §7, the write-access bounding in §6) assumes a Codex author and a
Claude reviewer. Swapping that silently makes the attestation a fiction.

Also inherited: `codex exec` **hangs without `< /dev/null`**, and quota exhaustion
is a real mid-loop state — when it happens, name the missing reviewer in the PR
rather than substituting a correlated round and calling it replication.

### What the sandbox actually enforces — measured, not assumed

Probed 2026-09-05 under `--sandbox workspace-write`:

| astra can | astra cannot |
|---|---|
| write files anywhere in the worktree, **with no approval prompt** (`approval_policy = "never"` is already set in `~/.codex/config.toml`) | reach the **network** — `curl https://api.github.com/zen` → `Could not resolve host` |
| **`git add` and `git commit`** — a probe commit landed | write outside the workspace (`$HOME` is denied; `/tmp` is allowed) |

Two consequences, and neither is optional:

- **"Must not push / merge / touch Railway / change a GitHub setting" is enforced by
  the sandbox**, not by asking politely. State it that way; it is a guarantee.
- **"Must not commit" is NOT enforced.** Astra committing mid-build is the one that
  bites, because it makes a post-hoc `git status` come back clean — see §6.

### The standing prohibition block — prepend to EVERY astra invocation

Not only the build one. §2 already grants `workspace-write`, so a "just measuring
the terrain" run can do all of this too:

```
Do NOT: run `git add`, `git commit`, `git stash`, `git checkout`, `git reset`, or
`git update-ref`. Do NOT run `npm test`, `npm run db:test:up`, or any
data-mechanics target — `db:test:up` is a destructive RESET of a Postgres shared
with other worktrees. Do NOT edit files outside the Scope this task names.
Leave every change UNCOMMITTED in the working tree.
```

---

## 1. Open the task FIRST — it is the spine everything else hangs off

The task is created **before the spec exists**, carries the spec once it does, and is
the thing every PR in the slice points at. Nothing else in this loop is allowed to
start until it has a key.

**Create it.** A task is a row in `~/Projects/chetan-workspace/3-log/tasks.md` that
`aios push` projects into Linear:

```
| KEY-1 | one-line imperative description | chetan | todo |  |  |
```

- Detect first — `grep '<KEY>' ~/Projects/chetan-workspace/3-log/tasks.md`. Update an
  existing row rather than opening a second one for the same work.
- The ID must match `[A-Z][A-Z0-9]+-\d+` — **ONE hyphen, uppercase**. `ARC-STAB-1`
  extracts as `STAB-1` and silently fails to close; `arc-stab-1` extracts nothing.
- `cd ~/Projects/chetan-workspace && set -a && . ./.env && set +a`, then
  `/opt/homebrew/bin/aios push --dry-run 3-log/tasks.md` and then without `--dry-run`.
  The bare `aios` on PATH is a shell function that fails outside a workspace — use the
  binary path.
- **Check the push landed**: `/opt/homebrew/bin/aios status` prints
  `pm projection: ok · N synced · 0 errors`. A `502` prints a `✗` line and
  `pushed 0/1 item(s)` — **read the count**, and retry; it is the platform's deploy
  cycle, not your payload.
- **`aios status` does NOT read a row's status** — it reports file sync and the
  projection, nothing per-task. Treating it as a status read-back is the proxy this
  bullet exists to forbid. To actually read the row back, query the brain:
  `GET /api/v1/tasks?mode=table&keys=<KEY>` — its rows carry `status`.
- Do **not** use `aios query "…"` either: that is an LLM answering from an index,
  which can be stale.

**Open at `backlog` or `ready` — NOT `todo`.** The file contains `todo` rows, but the
brain's canonical set is `backlog, ready, in_progress, in_review, blocked, done`
(`lib/api/schemas.ts`), and `normalizeTaskStatus("todo")` maps to `backlog` while
carrying `todo` as a non-canonical `raw_status`. Writing `todo` therefore lands the
Linear issue in Backlog anyway, just with a stray raw string attached. `in_review` is
also available if you want a "pushed, awaiting merge" state between `in_progress` and
`done`.

### Posting the spec to the task — and the cap that decides how

> ⚠️ **This subsection runs AFTER §4, not here.** It lives in §1 because it is the
> task's lifecycle, but the spec does not exist until §2 writes it, §3 converges it and
> §4 gates it. Do steps 1–3 below once `aios spec eval` says `SPEC_READY`.

**A spec does not fit in a task description. The cap is exactly 2000 characters** on
the description field, enforced at both ends — CLI-side in the workspace parser's
`stringWithin(row.title, 0, 2000)` and brain-side by `lib/api/item-payload-schema.ts`'s
`z.string().max(2000)`. Exceeding it fails with `local Brain API 1.12 payload
validation failed`, which names neither the field nor the limit. A real spec is five to
ten times that. (An earlier draft cited "the longest row is 2001" — that counted the
table cell's padding spaces; the longest real description is 1999.)

So the spec goes to the brain **as its own document**, and the task carries a pointer:

1. Write the spec to **`~/Projects/chetan-workspace/2-work/specs/<slug>.md`** with
   `access: team` frontmatter — without it nothing syncs (default-deny). The repo copy
   in `docs/design/<slug>.md` is what the spec gate and the PR reference; the workspace
   copy is what the brain can retrieve. Keep them the same document.
2. Push it — **naming both paths explicitly**, never bare:
   `aios push --dry-run 2-work/specs/<slug>.md 3-log/tasks.md`, then without
   `--dry-run`. A bare `aios push` sends every dirty eligible file in the workspace
   (`0-context`, `2-work`, `4-shared`, `.claude/memory`), so an unrelated draft or a
   memory file rides out with your spec — and this is outward-facing.
3. **Update the task row in the same push**: rewrite its description to the spec's
   one-paragraph summary plus the spec path, and move the status to **`in_progress`**.
4. **Re-push the spec after the final fold in §8.** The repo copy at
   `docs/design/<slug>.md` is CANONICAL — it is what the spec gate reads and what the
   PR cites. The workspace copy exists so the brain can retrieve it, and it goes stale
   every time §3, §6 or §7 amends the spec. One refresh at §8, after the last fold, is
   the honest minimum; without it the brain serves a spec that no longer matches the
   merged work.

That is what "post the spec to the task" means here — a retrievable document plus a
pointer that fits, rather than a truncated paste that fails validation.

### Where the task ends when the loop does NOT reach a PR

Two exits are reachable before any code, and leaving the row at its opening status is
how a board fills with work nobody is doing:

- **DECLINE at §3** — the design should not be built. Set the row to `blocked` with the
  reason in the description, or delete it if the work was never real. Take the decline
  back to the operator; do not spend rounds arguing with it.
- **Split at §3** — the original row keeps the narrowed slice and stays `in_progress`;
  the deferred half gets its own row at `backlog` carrying the ordering rule that
  failed. Do not close the original as `done` — it did not ship what it described.

### Every PR in the slice cites the SAME key

`AIOS-Work: <KEY>` in the PR body, on its own line. **The brain row key, never the
Linear `AIO-*` key** — a trailer citing the Linear key resolves to nothing, and a real
but unrelated key files your work under a stranger's name. Both have happened here.

A slice that takes three PRs uses one key three times. That is what makes §9's
completion check possible.

---

## 2. Astra writes the spec

**Measure the terrain first and put the numbers IN the prompt.** The most expensive
failures in this repo's history were specs whose scope came from a count taken
afterwards — one slice absorbed four blocking verdicts across two models, three of
them for exactly that, and the count was wrong three times running. Give astra the measured facts and tell
it to attack the *inferences*, not the numbers.

```bash
codex exec --sandbox workspace-write --skip-git-repo-check - \
  < /tmp/astra-spec-prompt.md > /tmp/astra-spec.out 2>&1; echo "EXIT=$?" >> /tmp/astra-spec.out
```

Run it with the Bash tool's **`run_in_background`**, not a trailing `&` — the shell
does not persist between calls, so a bare `&` leaves you no completion signal and
you will read a half-written file and fold a partial spec. Wait for the `EXIT=`
sentinel before reading.

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

**Optional, and cheap: an astra cold read of the SPEC too.** The diff gets two
reviewers; the spec gets one. The sibling skill's evidence is that pre-code rounds
are where designs actually die. If you run it, it carries the same correlation
caveat as §7 — astra reading a spec astra wrote is a weaker signal than Fable's.

### The stopping rule — "a good place" made concrete

**Who folds: the ORCHESTRATOR, not astra.** Astra authored the thing under review;
handing it its own findings makes §7's correlation label meaningless. State this in
the PR, because it changes what the attestation means.

Cycle spec → Fable → fold. **A round has converged iff BOTH hold:**

1. the verdict carries no BLOCKER and no HIGH; **and**
2. the fold changed **none** of the spec's `Scope`, `Deps`, or `Decision` sections
   — diff those three sections before and after the fold and check it is empty.

Condition 2 is the operational definition of "no new scope", and it is deliberately
mechanical rather than a judgement call: a round that finds only wording is
convergence; a round that moves a file into Scope is not, however mild its verdict.
Two agents can disagree about "is this scope?" — they cannot disagree about whether
a section diff is empty.

**If three rounds do not converge, the slice is too big — split it.** That is not
defeat, it is the measured outcome: on this repo's release program the split is
exactly what unblocked RELPTR-4 after four blocking verdicts. Record the deferred
half as its own ticket, with the ordering rule that failed written into it.

Two edges, so the counter is unambiguous: **a `DECLINE` ends the loop** (take it back
to the operator; do not spend rounds arguing with it), and **the counter resets after
a split**, because the narrowed slice is a different design.

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

**`SR3/minor` for a path that does not exist yet is EXPECTED and does not block** —
"fine if it is a new file to create" is the gate's own wording, and a spec full of
new modules will emit a screenful of them while still returning `SPEC_READY`. Do not
contort criteria to silence minors. (An earlier draft of this skill claimed a
backticked non-existent path on a criterion's first line *blocks*; that was measured
FALSE — both that phrasing and the same path in `Scope` return `SPEC_READY` with a
minor.) If you *do* hit an `SR3/blocker` saying a path "is named as existing code",
rephrase that one reference to make the newness explicit — but treat the blocker as
the signal, not the phrasing superstition.

**Re-run the eval after ANY amendment** — SPEC_READY is a state, not a milestone.

---

## 5. Astra writes the code

Branch from `origin/<contribution base>` (see `scripts/branches.mjs`; today `staging`).
Then hand astra the approved spec:

```bash
codex exec --sandbox workspace-write --skip-git-repo-check - \
  < /tmp/astra-build-prompt.md > /tmp/astra-build.out 2>&1; echo "EXIT=$?" >> /tmp/astra-build.out
```

`run_in_background`, and wait for the `EXIT=` sentinel — see §2.

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

**Then verify yourself — do not take the build report on trust.** An author's
summary of its own work is a claim, not evidence. Read the diff, then run:

- `npx tsc --noEmit` — note `test/` is excluded from tsconfig, so this says nothing
  about the tests astra just wrote;
- `npm run lint` · `npm test` · `npm run check:docs`;
- **`npm run test:datamechanics:iso`** whenever the slice touches persistence or
  access. Astra is forbidden from running this tier (§0) — that prohibition assigns
  the tier to YOU, it does not excuse skipping it. `:iso` rather than `:local`
  because other worktrees share the `:5434` container. CLAUDE.md §4 makes this tier
  authoritative for persistence and tier isolation; unit green proves nothing there.
- `npm run test:neo4j` if the slice touches the graph tier.

**Commit a checkpoint before mutation-testing.** `scripts/mutate.mjs` refuses a dirty
tree — and after §0's prohibition astra will have committed nothing, so this is
always your step.

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

### Bounding astra's write access — a precondition, not just a post-check

An earlier draft bounded this with `git status --short` after the build. **That is
checked at the wrong layer**, and Fable's review measured why: astra **can `git
commit`** under `workspace-write`. If it commits mid-build — agents do this
routinely — `git status` comes back clean and the post-check certifies a sweep it
never saw. In a tree like a Conductor worktree, which often carries another slice's
uncommitted work, that is precisely how a foreign change rides into a commit under
your message.

So bound it at both ends:

**Before launching astra**

1. The tree must be a **clean committed checkpoint** — the same rule
   `scripts/mutate.mjs` enforces, for the same reason. If another slice's work is in
   the tree, commit it on its own branch or stop; do not build over it.
2. Record the starting point: `BEFORE=$(git rev-parse HEAD)`.
3. Include §0's standing prohibition block, which forbids `git add`/`commit`/`stash`
   /`checkout`/`reset`.

**After astra returns**

```bash
test "$(git rev-parse HEAD)" = "$BEFORE"   # astra must NOT have committed
git status --short --ignored               # --ignored: .env.local, node_modules are invisible without it
git diff --stat                            # the working-tree change set
```

A moved `HEAD` means astra committed despite the prohibition: **inspect that commit
before anything else**, because every other check below is now blind. A file outside
the spec's Scope is a finding, not a tidy-up. Stage deliberately; never `git add -A`
in a tree you did not leave clean — an operator lost 399 lines of a *different*
session's work to exactly that.

Two things this still cannot see, stated rather than implied: writes to `/tmp`
(including the prompt and output files this loop reads), and anything astra did
inside a path git ignores. The network is closed, so nothing leaves the machine.

---

## 7. Fold, then astra reviews the DIFF — cold, and correlated

Fold Fable's findings with the same re-derivation discipline as §3.

Then astra's round — and **the session must be fresh**:

```bash
codex exec --sandbox read-only --skip-git-repo-check - \
  < /tmp/astra-review-prompt.md > /tmp/astra-review.out 2>&1; echo "EXIT=$?" >> /tmp/astra-review.out
```

- **`--sandbox read-only`** here, not `workspace-write`. The reviewer reads.
- **No `--model`, same as every other invocation** — this round must run the SAME
  model recorded by §0 that built the diff — read it with
  `WT=$(basename "$(git rev-parse --show-toplevel)"); cat ~/.cache/aios-astra/author-model-$WT`,
  re-deriving `WT` inline because the shell does not persist. That is what makes it
  the *correlated* round,
  and the weighting below depends on it. If the config changed mid-loop so a
  different model answers, you no longer have the round this section describes:
  re-probe, and say in the PR which model reviewed.
- **A NEW invocation, never a resumed build session.** The author reviewing its own
  build context is self-review; reading the diff cold is at least an independent
  *pass*, even though it is the same model.
- Tell it what Fable found and what was folded, and **task it explicitly with
  breaking the folds** — the second-order bug introduced by a fix is the defect
  class an author structurally cannot see.

**Read its verdict with the correlation in mind: an astra CLEAR on a diff astra
wrote is weak evidence.** Same model, same blind spots.

Do **not** invert that into "an astra BLOCK is strong". An earlier draft said so and
it is wrong: a model hallucinating a defect in its own output is no rarer than in
anyone else's, and this repo has a recorded case of a reviewer's confident
regex-match claim refuted by a one-line `node -e`. **Every finding stays a
hypothesis**, whoever raised it, and gets re-derived before it is folded.

### The independent reviewer must see what actually ships

This ordering — Fable, fold, astra, fold, push — leaves the **last fold reviewed by
nobody**, and the first fold reviewed only by the correlated model. That is the
second-order-bug class CLAUDE.md names as the one an author structurally cannot see,
walking straight out the door.

**So: if either fold changes non-trivial code — not comments, not prose — re-run
Fable on the post-fold diff and require it to clear before pushing.** A doc-only or
comment-only fold does not need it. If you skip the re-clear, say so in the PR and
say why; do not let the attestation imply Fable read a diff it never saw.

---

## 8. Fold again, push the PR — never merge

Same fold discipline. Re-run the full verification set after **every** fold, not
just the last.

`git push -u origin <branch>`, then open the PR against the **contribution base**,
resolved rather than hardcoded:

```bash
gh pr create --base "$(node scripts/branches.mjs --print contribution)"
```

`staging` since the option-B cutover (2026-09-06). Hardcoding `main` here would
both contradict §5's "branch from the contribution base" and quietly open the PR
against the release branch on cutover day. (`gh pr create --base` is itself listed
in `docs/RELEASING.md` §3.1c as a cutover-day edit — resolving it is how that edit
stops being needed.)

The PR body carries, honestly:

- what the slice is, and what is deliberately NOT in it (name the next slice);
- the verification table — tier counts, mutations run and what each reddened,
  including any that SURVIVED and what that told you;
- **who wrote it**: name the model §0 recorded — read it with
  `WT=$(basename "$(git rev-parse --show-toplevel)"); cat ~/.cache/aios-astra/author-model-$WT`
  (re-derive `WT` inline; the shell does not persist) — the actual id, not the word
  "astra", and the id each `.out` banner confirms for the spec and for the code — for the spec and for the code. A reader weighing the review
  evidence needs to know the author was not the reviewer, and needs to know *which*
  model, because the skill no longer pins one;
- the `## Review` attestation, with **at least one line parsing as**
  `Reviewed by <tool> — verdict <summary>` — the required `pr-review-gate` check
  matches that exact shape, and an unedited `<tool>` placeholder is rejected.
  Name **both** rounds and their verdicts *including the BLOCKED ones*; an
  attestation that only says CLEAR launders the process. Name the reviewing model
  by its resolved id and mark that round as the correlated one.
- deferrals with reasons, and `AIOS-Work: <ROW-KEY>`.

**Verify the body as STORED**, not by the exit code, and read it back with
`gh pr view --json body`. The documented hazard is that `gh pr edit --body`
**replaces** the whole body rather than appending (see `pr-review-attestation`), so
an edit that "succeeded" can have dropped everything else in it.

Watch checks to a terminal state. Read the brain-task check's **runtime log** for
`Found work key(s): …` — it is advisory and greens on failure.

**Do not merge.** Report and stop.

---

## 9. Close the task — only when EVERY PR carrying its key is merged

The task closes when the **work** is done, not when *a* PR is. A slice that took three
PRs is not done because the third merged; it is done because all three did.

**Enumerate them exactly.** The obvious search is wrong — measured: `gh pr list
--search "RELPTR-6 in:body"` returned PRs for RELPTR-4, RELPTR-5, RELPTR-2 and
SKILLASTRA-1, because GitHub tokenizes the key and matches loosely. A close driven by
that would fire early or never. Use a quoted phrase, or filter locally on the exact
trailer:

```bash
KEY=RELPTR-6
gh pr list --state all --limit 1000 --json number,state,body \
  | jq -r --arg k "$KEY" '.[] | select(.body // "" | test("AIOS-Work:[ ]*[*`]*" + $k + "\\b")) | "#\(.number) \(.state)"'
```

Three things in that line are load-bearing, and I got two of them wrong first:

- **`--limit 1000`, not 100.** Measured: the repo has **673 PRs**, and `--limit 100`
  reaches back only to **#579**. A slice whose first PR is older than that lists only
  its recent PRs, sees them all `MERGED`, and closes the task while an earlier one is
  still open — failing open in exactly the direction this check exists to prevent.
- **Do NOT anchor the trailer to its own line.** Measured over the last 100 PRs: 73
  bodies carry `AIOS-Work:`, and a `(?m)^…$` anchor matches only **68**. The five it
  drops are real trailers written `**AIOS-Work: AUDITFIX-4**` or with backticks — and
  the repo's own extractor (`scripts/pr-work-keys.mjs`, `lib/pm-sync/work-keys.ts`)
  links all five, so they ARE part of their tasks. Anchoring would close a task early
  because one author bolded a line. `[*\`]*` absorbs the decoration; `\b` stops
  `AUDITFIX-1` matching `AUDITFIX-1x`.
- **Do not substitute a `--search`.** `gh pr list --search "$KEY in:body"` over-matches
  badly (it returned RELPTR-4/5/2 and SKILLASTRA-1 when asked for RELPTR-6), and the
  quoted-phrase form `'"AIOS-Work: RELPTR-2" in:body'` also over-matches — it returns
  #665, which merely *mentions* RELPTR-2 in prose. (An earlier draft of this section
  credited line-anchoring for excluding #665. That was wrong: #665 is excluded because
  its own trailer names RELPTR-3. The label requirement is what does the work.)

Verified verbatim: the command above returns exactly `#662 #660` for `RELPTR-2` and
`#678` for `RELPTR-6`.

**Then, and only then:**

1. every listed PR reads `MERGED`. If any is `OPEN`, the task stays `in_progress`. If
   any is `CLOSED` **unmerged**, decide explicitly and record it in the row: either the
   task waits for a replacement PR carrying the same key, or that PR's scope is
   formally dropped from the slice. "Say so" is not a decision, and an abandoned PR
   silently counted as done is how a task closes over work that never shipped;
2. set `Status` to `done` in the row, `aios push` (dry-run first);
3. **read the status back** and check the pushed count — a 502 reports `pushed 0/1`
   while looking otherwise unremarkable.

**Why you close it yourself.** The merge automation deliberately does **not** close a
workspace-pushed row. `aios-work-sync` fires on the trailer and writes a `work_events`
row, but a row pushed from `3-log/tasks.md` resolves through the team-wide fallback and
lands **`linked`**, not `applied` — recorded, and deliberately left open, because
completing on a team-wide match would create duplicate Linear issues. Six tasks once sat
open with correct trailers for exactly this reason. Closing it yourself is not
belt-and-braces; it is the only thing that closes it.

And note the direction of travel: `lib/ingest/tasks` writes status straight from the
file row, so if a task ever IS auto-closed while your local row still says
`in_progress`, the next `aios push` clobbers it back open. Fix the row before pushing.

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
| A model substituted silently for the one named | §0's recorded author + the per-run banner assertion + §8's naming rule |
