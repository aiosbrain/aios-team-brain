# PR → task linkage: fix the project-scope bug, then propagate the link to commits

**Status:** design (Fable review before build). **Grounds:** the Timeline nests a commit under the task it
references, but in prod only **1 of 118** recent commits nests. My first read of this ("the team uses its
own V1/M1/C1 work-key scheme, so we must model it") was **WRONG** — those are regex false-positives
(`V1`, `GPT-5`, `C1`). The measured reality is two concrete, fixable gaps.

## Measured reality (prod, AIOS team, last 7 days)

Commit → `work_events` (the PR that merged it) joins **fine**: **104 of 118 commits (88%)** match a
`work_event` via `merged_sha`. The failure is downstream. Of those 104 work_events:

| | count | why |
|---|---|---|
| PR carried **no key** → `unresolved:<sha>` fallback | 67 (64%) | genuinely nothing to link (out of scope) |
| **issue-shaped key** (`AIO-494`) | 24 (23%) | **19 of these tasks EXIST** but only **1** resolved ← the bug |
| junk key (`V1`, `GPT-5`) | 13 (12%) | correctly unresolved |

**The bug (`lib/work-events/ingest.ts:55-63`):** the task lookup is scoped to the pushed project —
`.eq("project_id", projectId)` where `projectId` comes from `payload.project` (the **repo's** project,
`aios-team-brain` / `aios-workspace`). But Linear-mirrored tasks live in the **`linear-<teamKey>`** project:

```
AIO-* tasks by project:   linear-aio 318   ·   aios-team-brain 29
work_events by project:   aios-workspace 576   ·   aios-team-brain 397
```

So a PR citing `AIO-494` can never find its task — the lookup searches the wrong project. Only the 29
AIO tasks that happen to live in the repo project were ever resolvable.

## Design

### Part 1 — resolve the task TEAM-wide, not project-scoped (the bug fix)

A Linear issue key (`AIO-494`) identifies one issue **within a team**; which brain project mirrors it is an
ingestion detail the PR pusher can't know. So widen the lookup, without becoming ambiguous:

1. **Prefer the pushed project** (today's behavior — an exact `(team, project, row_key)` hit wins). This
   keeps every currently-resolving event resolving identically; pure widening, no behavior change for them.
2. **Else fall back to a TEAM-wide `row_key` match.** `tasks` is `unique (team_id, project_id, row_key)`, so
   a team-wide match can return >1 row across projects.
   - exactly 1 → resolve to it;
   - **>1 → DROP (leave unresolved)**, never guess — consistent with the drop-never-guess rule used for
     decisions/attribution. Record `error: "ambiguous row_key across projects"` so it's diagnosable.
3. Unchanged: no match → `status:"unresolved"` + the existing `work_event.unresolved` audit.

**Blast-radius caution (call out for review):** resolving an event has a SIDE EFFECT — `ingest.ts:108-113`
sets the matched task to **`status:"done"`** and then PROJECTS it back to the PM tool (`projectTask`). So
widening the lookup means PRs that were silently unresolved will now mark Linear issues Done and write back.
That is the intended semantic of `event_kind:"merged"`, but it makes this a **behavior-affecting** fix, not a
cosmetic one. Mitigations to decide in review: (a) ship as-is (correct semantics, the feature finally works);
(b) gate the done-transition to the pushed-project match only, letting the team-wide match link but not
complete. **Recommendation: (a)** — a merged PR citing `AIO-494` genuinely means AIO-494 shipped, and the
write-back is the product's whole point; the current behavior is just the bug suppressing it.

### Part 2 — propagate the PR's task to its COMMITS (the actual coverage win)

Today the Timeline links a commit only when the commit's **own text** cites an issue key
(`lib/dashboard/issue-ref.computeTaskLinks`). But the key usually lives on the **PR**, not each commit. Since
88% of commits match a work_event by sha, a commit can inherit its PR's resolved task:

- **Join:** `work_events.merged_sha` is a full 40-char sha; `items.frontmatter.sha` is **10 chars** (all 448
  prod rows). So match on `left(merged_sha, 10) = frontmatter->>'sha'`. (Both are recorded by our own
  pipeline; the prefix is stable. Note the truncation asymmetry as a fragility to comment.)
- **Precedence:** a commit's OWN cited key still wins (most specific). Only when `computeTaskLinks` yields
  nothing do we fall back to the PR's `work_events.task_id`.
- **Provenance:** the resulting link is marked `via: "pr"` vs `via: "commit-text"` so the UI (and any future
  consumer) can tell a direct citation from an inherited one, and so a wrong inheritance is diagnosable.
- **Tier:** the task must still pass `visibleTasks` — an inherited link may never surface a task the viewer
  can't see. Required data-mechanics assertion.
- Applies to the existing **nesting** path (active tasks) AND the **chip** path (done/backlog tasks, #373).

### Scope
**In:** Part 1 (the resolution fix, incl. backfill consideration) + Part 2 (commit inherits its PR's task).
**Out:** the 67 no-key PRs (a genuine "nothing to link" — the LLM content-based assignment is the separate
follow-up B); modelling `V1`/`M1` as work entities (rejected — they're regex noise, not a real scheme).

### Backfill
Existing `work_events` rows are stuck `unresolved` with `task_id = null`; the fix only affects new pushes.
A one-off **re-resolve** pass (re-run the lookup for `status='unresolved'` rows whose `row_key` is
issue-shaped) would recover the ~19 historical links. **Proposal:** ship the fix first WITHOUT the
backfill-write (a backfill also triggers the done-transition + PM write-back on historical PRs — a large,
surprising side effect). Revisit as an explicit, admin-triggered action. Flag for review.

## Verification
- **unit:** the resolution rule — pushed-project hit wins; team-wide single hit resolves; team-wide multi
  hit DROPS (unresolved, ambiguity error); no match → unresolved. Pure over an injected lookup.
- **unit:** commit→task precedence — own-text key wins over the PR link; PR link used only as a fallback;
  `via` provenance correct.
- **data-mechanics (real Postgres):** a work_event citing a task in a DIFFERENT project resolves (the bug
  fix, proven to the stored `task_id`); an ambiguous cross-project key stays unresolved; a commit with no
  key in its text nests under its PR's task; **tier isolation** — an inherited PR link never surfaces a
  task an external viewer can't see.

## Build-loop checklist (§1)
- Update `docs/ARCHITECTURE.md` (the work-events + Timeline linkage prose) in the same PR.
