# The operative instructions stop hardcoding a branch (RELPTR-5)

Status: **round 2 folded — the reviewers now AGREE on the design and on one remaining defect.**
Round 2: Fable **CLEAR-WITH-CONDITIONS** (it independently re-derived the enumeration and found it
**exact** — 22 path + 4 refspec, every per-file count, no unenumerated form) · Codex **BLOCKED** on
what Fable rates HIGH, and it is the same finding in different words: **per-FILE presence is
existential where per-SITE is required.** Rewrite the heading and leave `rubric.md:55` grading against
`origin/main`, and every criterion stays green. The fix is the missing INVERSE (criterion 14), not
another instrument. Original status follows.

Previously: **rewritten after BOTH pre-code reviews returned BLOCKED**, and the rewrite is a change of
INSTRUMENT, not a longer list. Codex BLOCKED, Fable BLOCKED, and together they showed the thing that
matters: I have undercounted this corpus **three times** — 14, then 31, then 34 — and each miss was a
**different syntactic form of the same idea**. That is not a counting failure. **The class is not
lexically decidable**, so a negative scan cannot be the primary instrument: every version of it gives
false assurance about completeness, which is exactly what a guard must not do · Owner: chetan
· Tier build-with: unit (a pure classifier + per-site presence assertions) — no persistence, no HTTP

**Deps:** RELPTR-4 merged (`1633e438`) — `scripts/branches.mjs` exports `CONTRIBUTION_BASE`.

**Increment:** ONE PR = the enumerated sites rewritten to resolve the contribution base, per-file
**presence** assertions, one **explicitly partial** scan, and `docs/agent-handoffs.md` archived.
**No branch protection, no release actor, no `staging` fast-forward, no Dependabot change.**

---

## Problem

`git diff origin/main...HEAD` is **operative**: `CLAUDE.md` §Review gate states it,
`.claude/agents/code-reviewer.md` runs it, the attestation skill executes it, and
`scripts/pr-review-gate.mjs` renders it into the message a contributor acts on. Once features branch
elsewhere, that diff carries **every unreleased commit** — the reviewer is handed hundreds of files
and the review becomes worthless **without ever failing**.

### Why the previous two drafts were BLOCKED, and what it actually proved

| form | example | lines | seen by an `origin/main` rule? |
|---|---|---|---|
| path | `git diff origin/main...HEAD` | 34 | ✅ |
| **refspec** | `git fetch origin main` | **11** | ❌ no slash |
| **PR-base prose** | "open a PR from `feat/x` **against main**" | **7** | ❌ no ref token |
| bare prose | "Branch from `origin/main`" | 2 | ❌ no `git` token |

Three independent undercounts, three different forms. **So the design inverts:**

- **PRIMARY — an enumerated rewrite with PRESENCE assertions.** Decidable, and complete *by
  construction*, because the enumeration IS the disposition. It cannot silently miss a form.
- **SECONDARY — one narrow scan for the single cleanly-decidable form**, whose blind spots are
  written into the guard itself. It catches the common regression and **claims nothing more**.

An earlier draft said a guard would make the hardcoding "un-reintroducible". That was false for three
forms out of four, and the honest version is in Decision 3.

### Disposition — enumerated, at `1633e438`

**ARCHIVE (removes 16 of the affected lines).** `docs/agent-handoffs.md` → `docs/archive/`.
Both reviewers rejected my earlier "split" of it, and they were right for a reason I had not weighed:
the file says *"copy one verbatim into a fresh Claude Code session"*, so its eight `git worktree add …
origin/main` blocks and seven "PR … against main" lines are **directly copyable**, and a banner saying
the waves shipped does not make them non-executable. My criterion would also have reddened on them on
day one. Rewriting dead template prompts to reference a branch role is work with no consumer; the file
self-describes as shipped and superseded, so it is archived and `docs/archive/**` joins the history
exclusions. Nothing outside `docs/design/**` links to it.

**REWRITE — 12 files, 26 lines** (22 `origin/main` + 4 `fetch origin main`):

| file | path form | refspec |
|---|---:|---:|
| `.claude/skills/pr-review-attestation/SKILL.md` | 3 | 1 |
| `.claude/skills/pr-review-attestation/evals/rubric.md` | 2 | 1 |
| `.claude/skills/pr-review-attestation/evals/evals.json` | 1 | 1 |
| `.claude/skills/branch-reconciliation/SKILL.md` | 5 | — |
| `.claude/skills/test-ci-wiring-audit/SKILL.md` | 1 | — |
| `.claude/skills/adversarial-build/SKILL.md` | 1 | — |
| `.claude/agents/code-reviewer.md` | 1 | — |
| `CLAUDE.md` | 1 | — |
| `CONTRIBUTING.md` | 1 | — |
| `docs/TODO.md` | 1 | 1 |
| `docs/RELEASING.md` | 4 | — |
| `scripts/pr-review-gate.mjs` | 1 | — |

**REGENERATE** `.agents/**`, `.opencode/**`, `.cursor/**` via `scripts/sync-skill-runtimes.sh` — never
hand-edited; `test/guards/skill-runtime-sync.test.ts` already guards drift, so this slice adds no new
mirror criterion.

**EXCLUDE — history:** `docs/design/**`, `docs/archive/**`.
**EXCLUDE — a deliberate permanent hardcode:** `test/guards/branch-roles.test.ts` constructs
`refs/remotes/origin/main` as the fixed RELEASE ref for RELPTR-4's identity fixture. It **must** stay
`main`; changing it would weaken that pin. Both reviewers flagged that a `\bgit\b` rule reddens on it.

---

## Decision

**1. The eval fixture is a correctness bug, not a rename.** `evals.json` requires *"Runs `git fetch
origin main` before diffing"*. After the cutover an agent that correctly fetches the contribution base
would be graded as having **missed the fetch** — the rubric would punish the right behaviour. Fable
found this; it is the strongest single reason the refspec form cannot be left out.

**2. The shell form resolves the repo root, not just the base.** Codex: `node
scripts/branches.mjs --print contribution` fails from any non-root cwd — and these instructions run
from skills, a `.mdc` rule, and JSON fixtures. The sanctioned sequence:

```bash
root="$(git rev-parse --show-toplevel)"
base="$(node "$root/scripts/branches.mjs" --print contribution)"
git -C "$root" fetch origin "$base"
git -C "$root" diff "origin/$base...HEAD"
```

Fetch and diff use the **same** `$base`, which is the bug Decision 1 describes, fixed structurally.

**3. The scan is explicitly PARTIAL, and says so in its own failure message.** It matches any
**hardcoded role branch** — `origin/main` or `origin/staging`, the literals — **not** the resolved
base. Both reviewers caught why that distinction is load-bearing: keyed on `origin/${CONTRIBUTION_BASE}`
the scan would, after the cutover, look for `origin/staging` and **stop seeing a reintroduced
`git diff origin/main...HEAD`** — the single most likely muscle-memory regression. It covers that
literal adjacent to a `git <subcommand>` token — the one form that is cleanly
decidable — with the declared predicate `/\bgit\s+[a-z-]+\b/` on the same line. It does **not** cover
the refspec form, PR-base prose, or bare prose; those are held by the presence assertions instead.
Writing the limits into the guard is the point: a guard that implies completeness it does not have is
worse than one that states its scope.

**4. Prose keeps the branch name where naming it is clearer.** The sanctioned pattern is *the
contribution base (currently `main`, declared in `scripts/branches.mjs`)* — executable today, and one
enumerated cutover-day edit in `docs/RELEASING.md` §3.1c.

**5. `docs/RELEASING.md` needs more than constraint 4.** §3.1d still carries the **superseded
`31 lines across 19 files`** count — a number this document re-derives as wrong. Constraint 4 is
paraphrased so the literal disappears (past-tensing it does not help; past-tenseness is invisible to a
matcher), and §3.1c/d are corrected in the same change.

**6. `adversarial-build`'s PR-base line IS in scope; the `gh pr create --base` POLICY is not.**
Codex found the cut was unexplained and overlapping. `.claude/skills/adversarial-build/SKILL.md`'s
"`gh pr create` — base `main`" is an operative instruction in an enumerated file, so it is rewritten
like the rest. What stays cut is the general question of what `gh pr create` should default to
repo-wide — that is a cutover-day decision in §3.1c, not a line in a skill.

**7. NOT in this slice:** any branch-protection change, the release actor, the `refs/tags/v*` ruleset,
the `staging` fast-forward, Dependabot's `target-branch`.

---

## Scope

**In:** the 26 enumerated lines across the 12 files in the disposition table; the regenerated mirrors;
`scripts/instruction-base.mjs` (the classifier + inventory) and its guard; per-file presence
assertions; `docs/agent-handoffs.md` archived to `docs/archive/`; `docs/RELEASING.md` constraint 4
paraphrased and §3.1c/d corrected.

**Cut, each with the reason:**

- **Any branch-protection change, the release actor, the `refs/tags/v*` ruleset, the `staging`
  fast-forward, Dependabot's `target-branch`, `gh pr create --base`** — outward-facing configuration
  or a different correct answer either side of the cutover; all recorded in `docs/RELEASING.md` §3.1c.
- **Rewriting the archived handoff prompts** — dead template text with no consumer; archiving is the
  disposition, not a deferral.
- **A scan covering the refspec, PR-base or bare-prose forms** — not lexically decidable (Decision 3);
  those are held by presence assertions, deliberately, and the guard says so.
- **`test/guards/branch-roles.test.ts`'s `origin/main`** — a deliberate permanent hardcode of the
  RELEASE ref; changing it would weaken RELPTR-4's identity fixture.

---

## Acceptance criteria

1. **unit** — a pure `isOperativeLine(line)` implements the DECLARED predicate exactly
   (`/\bgit\s+[a-z-]+\b/` on the same line as `origin/<base>`), with fixtures from the real corpus in
   both directions: `git branch -r --no-merged origin/main` is operative;
   `lib/graph/extraction-health.ts`'s "`origin/main` kept that state loud" is not.
2. **unit** — `isOperativeLine` is asserted NOT to fire on the two lines a looser `\bgit\b` rule would
   falsely catch — `docs/RELEASING.md`'s sentence discussing the "`git` token", and
   `test/guards/branch-roles.test.ts`'s `git(dir, "update-ref", "refs/remotes/origin/main", …)` — so
   the predicate's precision is pinned, not assumed.
3. **unit** — a separate `scanInventory(records)` takes an INJECTED list of `{path, content}`, so
   coverage is provable with fixtures; production obtains its inventory from `git ls-files`.
4. **unit** — the production inventory is asserted EQUAL to `git ls-files` minus the documented
   exclusions — path-set equality, not "contains a known file from each root", which an inventory that
   silently dropped everything else would still satisfy.
5. **unit** — the scan finds NO operative path-form line outside the exclusions.
6. **unit** — PRESENCE, per rewritten file, for all 12: each still contains a base-resolved
   instruction. This is the primary instrument, so it is asserted per file rather than in aggregate —
   deleting an instruction must not satisfy criterion 5.
7. **unit** — the REFSPEC form is pinned by presence too: the attestation SKILL, its rubric, its
   `evals.json`, and `docs/TODO.md` are asserted to fetch the RESOLVED base, and asserted NOT to
   contain the literal `fetch origin main` — the form the scan cannot see.
8. **unit** — `evals.json`'s required behaviour is asserted to describe fetching the resolved base, so
   the rubric cannot grade a correct post-cutover run as a miss (Decision 1).
9. **unit** — the bare-prose sites are pinned by name: `adversarial-build/SKILL.md` (both the
   "Branch from" line and the "retarget to" line) and the attestation SKILL's prose headings carry the
   sanctioned phrasing, because the scan provably cannot see them.
10. **unit** — the guard's own failure message states what it does NOT cover, so a reader cannot infer
    completeness from a green run.
11. **unit** — the full shell sequence from Decision 2 is EXECUTED in a temporary git fixture from a
    NESTED cwd, under both a `main` and a `staging` base, and produces a valid diff range — criterion
    10 of the previous draft tested only the CLI's stdout and inferred the rest.
12. **unit** — `docs/agent-handoffs.md` is absent from its old path, present under `docs/archive/`,
    and `docs/archive/**` is in the guard's exclusions; the archived copy is NOT required to be
    rewritten.
13. **unit** — `docs/RELEASING.md` constraint 4 is paraphrased without the literal AND retains the
    failure it names, the invariant, its PREPARED status, and what remains human; **§3.1c AND §3.1d**
    no longer carry the superseded `31 lines across 19 files` count.
14. **unit — THE INVERSE, and the one both reviewers converged on.** Each of the rewritten files
    contains **NO** `origin/main` literal afterwards, asserted per file. Without it, per-file presence
    is existential: rewriting `SKILL.md`'s heading while leaving line 62 ("a stale `origin/main` ref
    produces a diff carrying other people's commits") and `rubric.md:55` ("the diff is taken against
    `origin/main`") passes criteria 5–9 — both are scan-blind, and criterion 9 names only the
    headings. Named exceptions, and only these: `docs/RELEASING.md`'s meta-prose ABOUT the guard
    (§3.1d describes the predicate and its false negative, so it must quote them).
15. **unit** — criterion 11's fixture carries a **stub `scripts/branches.mjs`** (because
    `git rev-parse --show-toplevel` resolves to the FIXTURE root, where the real module does not
    exist) and a **path remote** (a unit test must not reach the network), and the remote base is
    **advanced after checkout** so a stale `origin/$base` cannot produce a valid range without the
    fetch having refreshed it — a false green Codex named specifically.
16. **unit** — criterion 4's expected set is derived from its OWN `git ls-files` call and its OWN
    exclusion literals, never from the module under test, which would make the equality
    green-by-construction.

---

## What would falsify this

- **A reviewer handed every unreleased commit after the cutover** — a site was missed *and* its
  presence assertion did not exist, which is now two independent failures rather than one.
- **The rubric grading a correct run as a miss** — Decision 1 was not carried into `evals.json`.
- **The scan reddening on history or on the deliberate fixture** — the exclusions are wrong, and the
  pressure will be to weaken the guard rather than fix the paths.
- **Someone reading the scan as complete** — criterion 10's message failed to say otherwise.
- **The shell sequence failing from a skill's cwd** — criterion 11 did not actually execute it.
- **A rewritten file still containing `origin/main`** — criterion 14's inverse was dropped, and
  per-file presence went back to being satisfiable by one line out of three.
