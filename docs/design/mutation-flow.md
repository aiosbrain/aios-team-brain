# The mutation guard is a step you can skip — make the safe path the short one — MUTFLOW-1

**Status:** spec, draft 3. Both cold reads BLOCKED draft 1; every finding is folded, including one
that showed my own justification argued for the thing it was rejecting.
**Related:** MUTGUARD-1 (`scripts/mutation-guard.mjs`, the check this builds on),
`.claude/skills/adversarial-build/SKILL.md` (the loop whose step this replaces),
`test/guards/mutation-guard.test.ts` (which pins the current wording and must migrate — §Scope).

---

## 0. What is wrong

MUTGUARD-1 shipped a check that refuses to mutate a tree with uncommitted tracked changes, and wired it
into the adversarial-build skill as a required step. **It did not stop the failure.** In the session
that followed it shipping — same operator, same skill — there were **three work-loss incidents** from
`git checkout -- <file>` on an uncommitted tree, and **two commits whose messages outrun their diffs**.

| incident | claimed | contained | how a future reader can check it |
|---|---|---|---|
| in PR #551 (squash-merged as `e228650`) | two new exports in `lib/graph/extraction-health.ts` | neither; that file was not in the diff, and the tree did not typecheck | **testimony + its repair commit only.** The offending commit was rebased away and is reachable from no ref; what survives is the repair, "restore the runtime cause enumeration a mutation revert destroyed" |
| in PR #552 (squash-merged as `85fbb2d`) | "the dead classifier term … it is gone" | only the spec `.md`; the term shipped live | **directly checkable** on the PR head ref: the commit touches one `.md` while its message says the term is gone. A reviewer then proved the consequence — with the term present, deleting the *other* condition left every test green, so the masking that commit narrates fixing was still live |

**On the citations themselves**, because this spec is about claims that do not survive checking: the
SHAs above are the **squash-merge commits on `main`**, not the offending commits — `git show e228650`
shows a perfectly good message. The offending commits were pre-squash and are not on `main`; only one
of the two is still reachable at all. Draft 2 said "both survive inside their squashed merges, so that
is what a reader can check", which over-claimed: row 1 is testimony corroborated by its repair, and it
is labelled that way rather than dressed as verifiable.

Three details worth keeping, all verified rather than assumed:

- `scripts/mutation-guard.mjs` **was present in both worktrees** at the time — this is "the guard
  existed and did not fire", not "the guard had not shipped".
- Whether it was *called* is **unknowable**: it leaves no artifact. The only consistent explanation is
  that it was skipped (a called guard refuses a dirty tree), but that is inference, and §1 fixes it.
- **Neither false message reached `main`.** Both were squash-merged away. So the durable harm is not
  repo history — it is that the operator acted on a false belief *mid-slice*, which is what left a
  masking hole for a reviewer to find.

### 0a. Why the guard did not fire

Because **a mutation is not one command.** It is a sequence — edit, test, `git checkout`, hopefully
check — and the guard covers the first step *if you remember to call it*. Every ad-hoc spelling (a
`python3` heredoc, `sed -i`, an editor keystroke) skips it. The guard's own header says a rule you have
to remember is what this repo replaces with a check that fails. It added the check **and left the rule
standing around it**.

### 0b. The second failure, which no start-of-run guard can see

The revert makes the tree look right, so the message gets written from **intent**. Both incidents are
that shape. Draft 1 answered this with "the operator quotes the report rather than narrating from
memory" — which is itself a rule you have to remember, i.e. the thing §0a condemns. Draft 2 answers it
two ways instead: **`--keep`** (§1b) removes the re-apply step entirely for the case that actually
failed, and the **existing Fable review gate is named as the backstop** — it is already the
message-versus-diff check in this loop, and it is what caught the second incident.

## 1. The decision

**No test-runner override exists in the CLI**, and that is a fix rather than an omission: an earlier
build read the test command from an environment variable so the guard test could stub it, and BOTH code
reviewers showed that shipped a verdict-forgery channel — mutate a real file, stub the report, print a
block byte-identical to a real run, and the skill tells you to paste it into a PR. The runner is a
function argument now; the CLI hard-wires the real one and only the tests inject a fake.

**One command, and it is the only path the skill documents.** Not "the only path" — draft 1 said that,
and it is not true of a shell.

```
node scripts/mutate.mjs <file> --edit <needle-file> <replacement-file> [--edit …] [--keep] -- <vitest args…>
```

1. **Refuses on an unclean tree**, by *calling* `scripts/mutation-guard.mjs` — one owner for "is this
   tree a checkpoint", so the two cannot drift.
2. **Requires the TARGET to be tracked** (`git ls-files --error-unmatch`) — on the checkpoint-contract
   policy, not on a restore mechanism: with §1.5's in-memory restore an untracked target would be
   restorable, but a file with no committed version is not a checkpoint you can return to, which is the
   loop's contract. Draft 1 justified this by claiming `git checkout --` would error; that was the
   mechanism talking, and review corrected both the claim and the reason.
3. **Applies the `--edit` pairs as ONE simultaneous transformation of the original bytes.** Multiple
   pairs are supported because real mutations need them — the very mutation one incident narrates was
   two edits — and without that the operator's only option is the ad-hoc heredoc this slice replaces.
   The semantics are pinned, because "each matches exactly once" is undefined across pairs (does pair
   B match before or after pair A applied?) and a wrong-but-clean mutation reports a verdict that means
   nothing: **every needle is located against the ORIGINAL bytes in one pass, each must match exactly
   once there, matched spans must not overlap, no pair's needle may occur in another pair's
   replacement text, and replacements are applied by descending original offset.** Any violation exits
   1 before a single test runs.
4. **Runs the named tests**, and **refuses if zero tests executed** — the same hazard as a needle that
   matches nothing, on the axis draft 1 missed: a filter selecting no files reports "all green" ⇒
   SURVIVED, vacuously. The mechanism is pinned rather than left to output-scraping, which would break
   the day the reporter changes and would break TOWARD vacuity: the wrapper owns the vitest invocation,
   appends `--reporter=json --outputFile.json=<temp>` LAST so an operator-supplied reporter cannot
   clobber it (and refuses if one conflicts), forces `run` semantics so a TTY cannot drop it into watch
   mode, and reads `numTotalTests`. **Verified against this repo's vitest (4.1.9): a filter matching
   nothing still writes the report, with `numTotalTests: 0`.** A missing or unparseable report fails
   CLOSED as infrastructure (exit 1) — "cannot tell" must never read as "some tests ran".
5. **Restores the target from the pristine bytes it already holds** — it read them to locate the
   needles — with `git checkout --` and a byte-compare as belt-and-braces rather than as the mechanism.
   Review's point, and it is the better design: an in-memory restore is independent of index semantics
   entirely, which is the whole `git checkout -- restores from the INDEX` hazard class this slice grew
   out of. Git remains the recovery path for an abnormal exit, where the in-memory copy is gone. It
   then **verifies the TARGET is byte-identical to HEAD**, and separately reports if the TEST RUN
   dirtied the target itself (a state where the kept diff would be mutation-plus-noise, so `--keep`
   refuses it).
   Other tracked changes the test run made are *reported separately* — "the test run also dirtied X" —
   rather than conflated with a failed restore, because a check that reddens on unrelated noise trains
   the operator to ignore it. On abnormal exit (SIGINT, crash, timeout) it restores or prints
   `MUTATION STILL APPLIED` loudly — and that string is real: the restore runs in a `finally`, so any
   throw after the write still restores, and a restore that does not take says so. **No TIMEOUT is
   implemented**; a test command that never terminates leaves the mutation applied until the operator
   interrupts, which the signal handlers then restore. Stated rather than left implied — review found
   draft 2 claiming a timeout that does not exist.
6. **Prints a verdict** — `REDDENED` with the failing test names, or `SURVIVED` — and exits on whether
   the run met its **stated expectation**, not on the raw verdict. `--expect reddened` is the default
   (an ordinary mutation should be caught); `--keep` defaults to `--expect survived`, because "prove
   this term is dead, then leave it deleted" expects the tests to stay green. **Exit 0 = expectation
   met, 2 = expectation missed, 1 = usage/infrastructure**, each with a distinguishing message so a
   crashed tool is not mistaken for a refusal.

   Draft 2 pinned the raw verdict to the exit code, and review showed that INVERTS under `--keep`:
   SURVIVED would be success-but-exit-2 (aborting a `set -e` chain on the good outcome) and REDDENED
   would be a broken kept edit at exit 0 — so `mutate … --keep && git commit` would commit a change
   whose tests fail. That is a new work-corruption channel created by the fix for the last one.
7. **Appends one line to `.mutate-runs.log`** (git-ignored, best-effort — a log that cannot be written
   must never fail a run), so the next post-mortem can tell "the flow was bypassed" from "the flow
   failed" — the question that is unanswerable about the incidents above.

### 1b. `--keep`: the mode that addresses the failure that actually happened

Codex's blocker: the flow protects the *experiment*, but the incident shape is a mutation that **is**
the intended change — "prove this term is dead, then leave it deleted". Restore-by-default means
re-applying it by hand afterwards, and that is the step that failed, twice.

`--keep` runs the same flow and leaves the edit applied. Three constraints review added, each closing a
hazard the mode itself created:

- **`--keep` + REDDENED restores and exits non-zero** ("the edit you asked to keep breaks tests"),
  unless `--keep-even-if-red` is passed, which prints a loud `KEPT FAILING MUTATION` banner. Keeping a
  known-broken edit silently is worse than the failure this mode fixes.
- **The printed `git diff --stat` is SCOPED TO THE TARGET.** It is printed after the test run, so an
  unscoped stat would include whatever the tests dirtied — and this stat is the artefact meant to
  replace writing a message from intent. A stat that over-claims files the mutation never touched is
  precisely the incident shape it exists to prevent. Files the test run dirtied are reported
  separately, never merged into it.
- **A forgotten kept mutation is backstopped, and the backstop is real rather than claimed:** the tree
  is now dirty, so `mutation-guard.mjs` refuses the *next* mutation run until it is committed or
  reverted.

### 1c. Why the PreToolUse hook stays cut — the honest reason this time

Draft 1 rejected a hook because "it could intercept the agent's shell, but not a human's, and the
failure was an agent following a written sequence." Review pointed out that argues *for* the hook: the
failing actor is exactly the one it intercepts, and **this repo already runs that mechanism for exactly
this purpose** (`scripts/railway-deploy-guard.sh`, wired in `.claude/settings.json`). The reasoning was
self-defeating, and a cut whose recorded reason is invalid gets re-litigated the next time work is lost.

The true reasons: `git checkout -- <path>` and `git restore` are **legitimate constantly** — this loop
uses them to revert mutations, and every other workflow uses them to discard experiments — so a hook
would have to fire only when the tree is tracked-dirty, i.e. re-implement the guard inside a shell
matcher and keep the two in step. And an over-blocking guard gets worked around, which the guard's own
header names as how it stops being a guard. A narrow hook (block the revert verbs only while
`mutation-guard` reports tracked-dirty) is a reasonable follow-up; it is not this slice, and it is
defense in depth rather than the mechanism.

## Dependencies

**Deps: none.** It calls `scripts/mutation-guard.mjs` (already shipped and guarded) and adds one script
and one guard test. No product code, no schema, no API route.

## Build-with

**Build-with tier: Fable / high effort.** The subject is a safety mechanism whose previous version
failed in practice while appearing to work — the exact failure adversarial review is for, and both
cold reads of draft 1 found blockers, including a self-defeating justification. Two review rounds on
the spec, two on the diff.

## Tier safety

No tier surface changes: a developer script, a guard test and a skill edit. No product code, no schema,
no API route, no change to `visibleItems`/`visibleTasks`/`visibleGroupIds`. No drift-block edit, so the
docs-drift guard stays green by construction — stated here rather than as an acceptance criterion,
since a non-event is not a criterion.

## 2. Acceptance criteria

- `test/guards/mutation-flow.test.ts` — BEHAVIOURAL refusal: in a scratch git repo with a dirty tracked file, the flow exits non-zero, the target file is byte-unchanged, and no test command runs. Draft 1 asserted only that the source *mentions* the guard, which a dead call satisfies — the pin-the-call-site failure this repo has a scar from.
- `test/guards/mutation-flow.test.ts` — source inspection additionally shows the tracked-changes logic is not reimplemented, so the two scripts cannot drift on what counts as a checkpoint.
- `test/guards/mutation-flow.test.ts` — a needle matching ZERO times, and a needle matching MORE than once, each exit non-zero before any test runs, since a mutation that touched nothing or an unknown site reports a survivor that means nothing.
- `test/guards/mutation-flow.test.ts` — a run whose test filter executes ZERO tests exits non-zero with "no tests ran", never `SURVIVED`.
- `test/guards/mutation-flow.test.ts` — an UNTRACKED target is refused before mutation, because `git checkout --` cannot restore it and the guard alone does not prove a checkpoint for that file.
- `test/guards/mutation-flow.test.ts` — after a normal run the target is byte-identical to HEAD; when the restore is prevented the flow exits non-zero rather than reporting a clean result.
- `test/guards/mutation-flow.test.ts` — a tracked file dirtied by the TEST RUN is reported as such and does not fail the restore check, so unrelated noise cannot train the operator to ignore a real failure.
- `test/guards/mutation-flow.test.ts` — multiple `--edit` pairs apply together and are restored together, with the exactly-once rule enforced per pair.
- `test/guards/mutation-flow.test.ts` — `--keep` leaves the mutation applied and prints the resulting diff stat, and its exit code still distinguishes reddened from survived.
- `test/guards/mutation-flow.test.ts` — exit codes are pinned to the EXPECTATION, not the raw verdict: expectation met `0`, missed `2`, usage/infrastructure `1` — asserted for both `--expect reddened` (the default) and `--keep`'s implied `--expect survived`, so the polarity cannot invert under `--keep`.
- `test/guards/mutation-flow.test.ts` — every exit-1 path prints a distinguishing message, since node exits 1 on any uncaught crash and a crashed tool must not be indistinguishable from a refusal (the sibling guard pins `REFUSING` for this reason).
- `test/guards/mutation-flow.test.ts` — `--keep` + REDDENED restores and exits non-zero unless `--keep-even-if-red`, which prints a `KEPT FAILING MUTATION` banner; and the printed diff stat is scoped to the target, so test-run dirt cannot make it over-claim files the mutation never touched.
- `test/guards/mutation-flow.test.ts` — multi-edit semantics: needles are located against the ORIGINAL bytes, and a run is refused when two spans overlap or one pair's needle appears in another pair's replacement — before any test runs.
- `test/guards/mutation-flow.test.ts` — needle matching is byte-exact after stripping exactly one trailing newline from the needle and replacement files, with a mid-line needle exercised, so an editor-added newline cannot silently mean "no match".
- `.claude/skills/adversarial-build/SKILL.md` — the mutation step names this one command, and **all three** stale sites are rewritten: the guard-invocation line, the "break the thing / revert / confirm the tree is clean" paragraph, and the failure-modes row that still attributes lost work to a "process rule" (false once a tool catches it). Otherwise the skill documents two paths and this slice's central claim is false on day one.
- `test/guards/mutation-guard.test.ts` — its existing pin on the skill's old wording is migrated in the same change rather than left red.

## Scope

**In:** `scripts/mutate.mjs`, its guard test, the adversarial-build skill's mutation step (both sites),
and the migration of the existing guard test's skill-wording pin.

**Cut / deferred, each with its reason:**

- **The PreToolUse hook** — §1c. Rejected on the real grounds (the revert verbs are legitimate
  constantly; a hook narrow enough to be correct would re-implement the guard inside a shell matcher),
  not on draft 1's self-defeating one. Reasonable as later defense in depth.
- **A commit-message linter** (message claims vs diff). Cut, but review corrected the recorded reason,
  which is the part that matters — a cut justified by something false gets re-litigated the next time
  work is lost. The measurement (the mechanical version, conventional-commit type versus diff shape,
  flags **3 of 369** commits on `main`) is evidence of a **low false-positive rate only**: that
  population EXCLUDES the target class by construction, since both offending messages were squashed
  away before reaching `main`. And "the harm is in-session belief rather than history" is an argument
  *for* a commit-time check, since commit time IS in-session. The honest reasons to cut it: **`--keep`
  removes the generator** — the re-apply-from-memory step that produced both messages — and the
  **existing Fable review gate is the message-versus-diff check**, which is what actually caught the
  second incident. A linter would police a symptom whose cause this slice removes.
- **`--checkpoint` (commit for the operator on a dirty tree).** It would make the safe path shorter
  still, which is this spec's own theory of change — but committing on someone's behalf mid-slice
  writes history they did not choose. A `git stash` auto-checkpoint is the middle ground that writes no
  history at all (review's suggestion); worth revisiting if refusal proves to be the friction.
- **Auto-generating mutations.** Choosing what to mutate is the judgement the loop exists to exercise.
- **A mutation-coverage score.** It would invite optimising the number.

## 3. What would falsify this

If an operator can still lose work while following the skill as written, the flow is not the shortest
path and this slice failed. The honest residual, stated rather than discovered: **§0b is only partly
mechanised.** `--keep` removes the re-apply step for mutations that are the intended change, but a
message can still be written from intent for any other edit, and the backstop for that is the Fable
review gate — which caught the second incident and is named here so it is not mistaken for something
this script does. The run log (§1.7) is what would let the next post-mortem tell a bypass from a
failure, which is the question this one could not answer.
