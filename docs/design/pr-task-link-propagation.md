# PR → task linkage: fix the project-scope resolution bug, then propagate the link to commits

**Status:** design (Fable-reviewed → revised). **Grounds:** the Timeline nests a commit under the task it
references, but in prod only **1 of 118** recent commits nests. My first read ("the team uses its own
V1/M1/C1 work-key scheme, so we must model it") was **WRONG** — those are `extractWorkKeys` regex
false-positives (`V1`, `GPT-5`, `C1`; confirmed by Fable against `KEY_RE`). The measured reality is two
concrete, fixable gaps.

## Measured reality (prod, AIOS team, read-only)

Commit → `work_events` (the PR that merged it) joins **fine**: **104 of 118 commits (88%)** match a
`work_event` via `merged_sha`. The failure is downstream. Of those 104:

| | count | why |
|---|---|---|
| PR carried **no key** → `unresolved:<sha>` fallback | 67 (64%) | genuinely nothing to link (out of scope) |
| **issue-shaped key** (`AIO-494`) | 24 (23%) | **19 of these tasks EXIST** but only **1** resolved ← the bug |
| junk key (`V1`, `GPT-5`) | 13 (12%) | correctly unresolved |

**The bug (`lib/work-events/ingest.ts:55-63`):** the task lookup is scoped to the pushed project —
`.eq("project_id", projectId)` from `payload.project` (the **repo's** project). Linear-mirrored tasks live
in the **`linear-<teamKey>`** project:

```
AIO-* tasks by project:   linear-aio 318   ·   aios-team-brain 29
work_events by project:   aios-workspace 576   ·   aios-team-brain 397
```

A PR citing `AIO-494` can never find its task — it searches the wrong project.

**Two prod measurements that shape the design (Fable asked for both):**
- **Ambiguity: none today.** All **365** issue-shaped task keys exist in exactly **1** project → the
  team-wide fallback is unambiguous in practice.
- **Duplicate-issue hazard: real but narrow.** `linear-aio` **318/318** and `aios-team-brain` **33/33** have
  a `task_pm_links` row, but the **14 `GH-*`** GitHub-mirror tasks (`github-aiosbrain-*` projects) have
  **none** — projecting one would `issueCreate` a **duplicate in Linear** (`lib/pm-sync/linear.ts:313`
  adopt-or-create keys off `provider_resource_id` / the `aios-ext` footer, never the identifier).

## Design

### Part 1 — resolve the task TEAM-wide, but **LINK-ONLY** (the bug fix)

A Linear issue key identifies one issue **within a team**; which brain project mirrors it is an ingestion
detail the PR pusher can't know. Widen the lookup, without becoming ambiguous **and without mutating Linear**:

**Lookup order** (fallback restricted to **issue-shaped** keys — `ISSUE_KEY_SHAPE` from `issue-ref.ts`; the
pushed-project scope was accidentally protecting precision for junk keys like `V1`):
1. **Pushed project** exact `(team, project, row_key)` hit → resolve (today's behavior; pure widening, so
   every currently-resolving event behaves identically).
2. Else **team-wide** `row_key` match. `tasks` is `unique (team_id, project_id, row_key)`, so >1 is possible:
   - exactly 1 → resolve;
   - >1 → prefer the row in the **canonical mirror project** (`linear-<prefix>`, computable via
     `linear-normalize.linearMirrorProject`) — deterministic by construction, not a guess;
   - still ambiguous → **DROP** (`unresolved`, `error: "ambiguous row_key across projects"`).
   *(Prod has zero ambiguity today, so this is a forward safety net, not the common path.)*
3. No match → unchanged: `unresolved` + the existing `work_event.unresolved` audit.

**BLAST RADIUS — the corrected decision.** Resolving an event today has side effects: it sets the task
`status:"done"` **and** runs a FULL `projectTask` write-back to Linear (`ingest.ts:108-139`). My original
"ship as-is" recommendation was **wrong** (Fable): widening the lookup would, on the very next PR,
(a) `issueCreate` **duplicate Linear issues** for any unlinked mirror task (the 14 `GH-*` rows), (b) clobber
Linear-native description/title edits (full projection is brain-wins and never re-reads post-adopt), and
(c) auto-complete issues merely *mentioned* in a PR body/branch — `extractWorkKeys` matches "see AIO-100",
with none of GitHub's `Fixes:`-keyword gating.

**So: a fallback match LINKS ONLY.** Concretely:
- Set `work_events.task_id` + a new status **`linked`**, and **do NOT** set the task to `done`, and **do NOT**
  call `projectTask`.
- Emit an audit **`work_event.would_complete`** `{row_key, task_id, repo, merged_sha}` recording what the
  done-transition *would* have done — so we can review a week of real data and then enable completion
  deliberately.
- **Pushed-project matches keep today's full behavior** (done + projection) — no regression, no new surface.
- Graduating fallback matches to auto-complete is a **separate, later decision**, gated on: every
  issue-shaped mirror task having a `task_pm_links` row, completion requiring an **explicit** key
  (payload `work_keys` or an `AIOS-Work:` trailer — not the loose regex sweep), and any write-back using
  **`statusOnly`** projection (which hard-requires an existing link → a safe throw instead of a duplicate).

**Schema:** `work_events.status` is `check (status in ('applied','unresolved'))`. Adding `'linked'` needs a
`postgres/migrations/` delta **mirrored into `schema.sql`** (per the column-change convention). ⚠️ Per the
`migration-replay-constraint-narrowing` incident (#251): the migration must `drop` then re-add the
constraint with the **FULL** value set (`applied`, `unresolved`, `linked`), never a narrower re-add.

### Part 2 — propagate the PR's task to its COMMITS (the coverage win)

Today the Timeline links a commit only when the commit's **own text** cites a key
(`issue-ref.computeTaskLinks`). The key usually lives on the **PR**. Since 88% of commits match a
work_event by sha, a commit inherits its PR's resolved task:

- **Join:** `left(work_events.merged_sha, 10) = items.frontmatter->>'sha'` (merged_sha is 40 chars;
  `frontmatter.sha` is 10 chars for all 448 prod rows). Scope the join to `(team_id, repo)` where the item
  carries repo, to avoid cross-repo prefix accidents. 10 hex chars = 40 bits → collision risk ~1e-7 at this
  scale (acceptable). **Follow-up:** store the full 40-char sha at ingest going forward and keep the prefix
  join only for historical rows.
- **Coverage limit (known, not a bug):** squash-merge makes this 1 commit ↔ 1 PR (why 88% match). A
  merge-commit PR's individual commits won't inherit.
- **Precedence:** the commit's OWN cited key wins (most specific). The PR link is used **only** when
  `computeTaskLinks` yields nothing for that item.
- **≥2 tasks per PR:** one `merged_sha` can have several work_events rows (one per key). If >1 distinct
  resolved `task_id`, **link the commit to ALL of them** — the evidence model already supports one item under
  multiple tasks (`work-timeline.ts`), and the PR genuinely touched both.
- **Provenance:** mark the link `via: "pr"` vs `via: "commit-text"`, so an inherited link is distinguishable
  and a wrong inheritance is diagnosable.
- **Tier (the mechanism, not just the requirement):** an inherited `task_id` is resolved ONLY against the
  task maps the builder already fetched through **`visibleTasks`** (the active-task map for nesting;
  `chipInfo`/all-tasks for the #373 done-chip). An id not in those maps → **no link, silently**. We never
  fetch an inherited task by id outside the §5 choke-point.
- **Error handling:** the work_events read is **enrichment** → **WARN, don't throw** (consistent with the
  Slack/chips legs; a failure must not blank the WORK ledger).
- **Cache:** inherited links change the persisted ledger content → **bump `work_timeline_cache`
  `PAYLOAD_VERSION`** so stale rows rebuild instead of serving link-less data for a TTL.

### Backfill — IN SCOPE, link-only
Existing `work_events` are stuck `unresolved` with `task_id = null`. A **link-only** backfill (re-run the
fixed lookup for `status='unresolved'` + issue-shaped `row_key`, writing ONLY `task_id` + `status='linked'`)
has **zero Linear writes**, so the objection in my first draft doesn't apply — it's the same code path as
Part 1's fallback. This recovers the ~19 historical links that Part 2's 7-day window needs.

## Scope
**In:** Part 1 (link-only team-wide resolution + the `linked` status migration), the link-only backfill,
Part 2 (commit inherits its PR's task).
**Out:** the 67 no-key PRs (64%) → the separate LLM content-assignment follow-up; auto-completing fallback
matches (a later, gated decision); modelling `V1`/`M1` as work entities (**rejected** — regex noise);
tightening `KEY_RE` to stop emitting junk keys (worthwhile follow-up: 13/104 junk events/week).

## Verification
- **unit:** the resolution rule — pushed-project hit wins; team-wide single hit → `linked`; multi-hit prefers
  the canonical mirror; still-ambiguous → dropped; non-issue-shaped key never uses the fallback; no match →
  unresolved. Pure over an injected lookup.
- **unit:** commit→task precedence — own-text key wins; PR link only as fallback; multi-task PR links all;
  `via` provenance correct.
- **data-mechanics (real Postgres):** a work_event citing a task in a DIFFERENT project resolves to the
  stored `task_id` with status `linked` **and the task is NOT marked done** (the blast-radius guarantee —
  this is the assertion that keeps a future refactor from re-arming the Linear write-back); an ambiguous
  cross-project key stays unresolved; a commit with no key in its text nests under its PR's task;
  **tier isolation** — an inherited link never surfaces a task an external viewer can't see.

## Build-loop checklist (§1)
- `docs/ARCHITECTURE.md`: the work-events resolution + Timeline linkage prose, same PR.
- `postgres/migrations/` + `schema.sql` mirror for the `linked` status (full-set CHECK re-add).
