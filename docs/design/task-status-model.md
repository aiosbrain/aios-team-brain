# Task status model — canonical set, adapter precedent, and the ClickUp outlier

**Scope:** `aios-team-brain` task status, across ingest (many PM tools → brain) and projection
(brain → PM tool). Written against `origin/main` @ `62c01e0` (aios-team-brain).

**Trigger:** a measured client workspace has a nine-status default ClickUp pipeline. Five statuses
map under the current ClickUp normalizer; four do not; the normalizer is fail-closed, so the
workspace cannot be ingested at all.

---

## 1. The canonical model as it actually is today

The five-state set **is** canonical brain-wide. It is not a ClickUp-local invention.

| Layer | Evidence | What it says |
|---|---|---|
| Postgres type | `postgres/schema.sql:47` — `create type task_status as enum ('backlog','ready','in_progress','blocked','done')` | Hard constraint. `tasks.status task_status not null default 'backlog'` (`schema.sql:1187`). |
| Escape hatch | `postgres/schema.sql:1188` — `raw_status text` | The native/unmapped string, stored alongside the enum. |
| Normalizer | `lib/api/schemas.ts:468-487` — `TASK_STATUSES` + `normalizeTaskStatus()` | **Fail-open**: trims/lowercases/underscores; a match returns `{status, raw_status: null}`; **anything else returns `{status: "backlog", raw_status: raw}`**. It never throws. |
| Wire schema | `lib/api/item-payload-schema.ts:52` — `status: z.string().max(120).optional().default("")` | The task row's `status` is a **free string** on the wire. The server, not the client, decides what it means. |
| Pinned contract | `aios-workspace/docs/brain-api.md:493-494` | "Status values the client sends verbatim; the server normalizes to `backlog\|ready\|in_progress\|blocked\|done` (unknown → `backlog`, raw value preserved)." Restated for `raw_status` at `brain-api.md:689-697`. |
| Projection type | `lib/pm-sync/provider.ts:11` — `TaskStatusValue` | Same five, described in-comment as "Canonical task status values (postgres `task_status` enum)". |

So the brain already has a **two-layer model**: a five-value canonical enum for cross-tool logic,
plus `raw_status` holding the native string verbatim when it did not map. Option (d) in the brief is
not a new idea — it is the shipped design, and ClickUp is the connector that opted out of it.

### Who consumes `tasks.status`

Changing the *set* is expensive; changing what a given ClickUp status *maps to* is cheap. The
consumers of the set:

- `lib/tasks/activity-policy.ts:33-42` — `ACTIVE_STATUSES = {in_progress, blocked}`,
  `OPEN_STATUSES = ACTIVE + ready`. Declared as *the* single answer to "is this being worked on",
  with a build-failing guard (`test/guards/activity-policy-single-source.test.ts`) against any
  surface re-spelling it locally. Consumed by the work timeline, Home "on your plate", Pulse
  in-flight, and arc eligibility.
- `components/kanban/types.ts:1` — the board's columns are literally `TASK_STATUSES`.
- `lib/metrics/pulse.ts:141-147` — `FUNNEL_ORDER`, the five-stage funnel chart.
- `lib/meetings/target-status.ts:12` — `MEETING_TASK_STATUSES` (a four-value subset), gated by a
  Postgres check constraint `teams.meeting_task_status` (`schema.sql:156`).
- `lib/pm-sync/provider.ts:135-149` — `desiredStateForStatus`, the outbound mapper.
- `app/actions/tasks.ts:45`, `scripts/brain-tasks.ts:48`, `app/api/v1/tasks/route.ts:181`.

### Who consumes `raw_status`

`raw_status` is a **sync-origin echo signal**, not a display field. Every authoritative status writer
clears it — provider inbound apply (`lib/pm-sync/inbound.ts:249,476`), dashboard board move
(`app/actions/tasks.ts:64`), work-event completion (`lib/work-events/ingest.ts:140`), meetings bulk
apply (`app/t/[team]/meetings/actions.ts:379`). It is set only by the push path
(`lib/ingest/tasks.ts:145,168`). Nothing renders it; nothing filters on it.

That matters below: `raw_status` preserves the native string **only when the connector sends an
unmappable one**. A connector that does its own mapping (Linear, Plane, GitHub, ClickUp) always
sends a canonical value, so `raw_status` is always null for those rows.

---

## 2. How the other adapters solve this — and they do

| | Native model | Ingest mapping | Fails how | Native value preserved | Write path |
|---|---|---|---|---|---|
| **Linear** | Arbitrary named workflow states per team, each with a closed `type`: `backlog\|unstarted\|started\|completed\|canceled` | `linear-normalize.ts:98-128`. **Name first** (via `normalizeTaskStatus`, so a state literally named "Blocked" wins), then `TYPE_TO_STATUS` by type. `canceled` → `done`. | **Fail-open** — `linearStatus` returns `backlog` (`:128`). A strict variant `linearStatusOrNull` returns `null` and exists only for the inbound apply, which treats unresolvable as a *conflict*, not an exception. | Yes: doc frontmatter carries `state` (native name, `:219`), `state_type` (native type, `:223`) **and** `status` (canonical, `:226`). | `desiredStateForStatus` → `{group, preferredName}` → `resolveStateByGroup` (`lib/pm-sync/linear.ts:102-110`). |
| **Plane** | Named states with a closed `group`: `backlog\|unstarted\|started\|completed\|cancelled` | `plane-normalize.ts:97-109`. Identical shape: name first, then `GROUP_TO_STATUS`. | **Fail-open** → `backlog` (`:109`). | Partially: frontmatter carries canonical `status` (`:248`) but not the native state name. | Same `desiredStateForStatus` path. |
| **GitHub** | `open`/`closed` plus free-form labels | `github-normalize.ts:69-76`. `closed` → `done`; otherwise the first label that *is* a brain status wins; else `backlog`. | **Fail-open** → `backlog`. | No. | None (ingest-only). |
| **ClickUp** | Per-list status sets; each status carries a closed `type`: `open\|custom\|closed\|done` (`lib/ingest/sources/clickup.ts:26`) | `clickup-normalize.ts:160-207`. A **required, bijective, per-list `Record<brainStatus, string>`** supplied as config; inverted and looked up **by name only**. Type is never read. | **Fail-closed** — `ClickUpNormalizationError` thrown from inside `rows.map` (`:336`) *and* from `normalizeClickUpTaskDocs` (`:424`). One unmapped status kills the task item and every per-task deliverable doc: the entire workspace import. | Yes: `native_status` in doc frontmatter (`:244`) and in the per-task JSON lines in the item body. | None (see §4). |

**The precedent is unambiguous.** Every other adapter maps a small closed set of native *state types*
to the brain's five, uses the state *name* only as an override, needs no configuration, and never
throws. ClickUp is the outlier on all four counts.

Two further facts make the ClickUp design untenable independent of the nine-status finding:

1. **`statusMaps` cannot be configured.** `lib/api/schemas.ts:663-684` allows it in the integration
   config, but `lib/integrations/build-config.ts:75-92` (the `clickup` case, which is what the Admin
   form actually writes) never reads or emits a `statusMaps` key. So `statusMaps` is `{}` for every
   list in practice, and `resolveStatus` throws on the *first* task of *any* ClickUp workspace —
   including a well-behaved five-status one. This is not "the map needs more entries"; the map has
   no way to be filled in.
2. **Nothing calls it yet.** `docs/ARCHITECTURE.md:102` states ClickUp "is CONNECTABLE but does NOT
   ingest yet" — no `runClickUpIngestion`, no scheduler leg, no Sync-now. There is no deployed
   behaviour to preserve, and no migration to write. The change is free right now and will not stay
   free.

---

## 3. The four options

### (a) Many-to-one collapse — `Record<brainStatus, string[]>`

Keeps the config-driven, name-keyed, fail-closed design and lets several ClickUp statuses map to one
brain status.

- **Changes:** the `ClickUpStatusMap` type, `invertStatusMap`, the Zod config block, plus a new
  Admin form surface that can actually author it.
- **Cost in complexity:** it adds the config surface that (b) removes. Worse, it keeps every
  brittleness: the map is per-list (the measured workspace has 31 lists across 6 distinct status
  sets), it is keyed on human-editable display names, and it still fails closed. A user renaming a
  status in ClickUp, or adding one, still stops the whole workspace importing until an admin edits
  the brain's config. That is an ongoing operational tax nothing else in the brain charges.
- **Cost in fidelity:** the same as (b) — the collapse is the collapse.
- **Round-trip:** the map is now non-invertible by construction. You would need a "preferred native
  status per brain status" field, i.e. exactly Linear's `preferredName`, reinvented as config.
- **Verdict: reject.** It pays (b)'s fidelity cost *and* keeps the maintenance cost.

### (b) Map by ClickUp's `type`, mirroring Linear

`open → ready`, `custom → in_progress`, `done → done`, `closed → done`, with a **name-first**
override via `normalizeTaskStatus` exactly as `linearStatus`/`planeStatus` do, and fail-open to
`backlog`.

Applied to the measured nine-status pipeline:

| ClickUp status | type | Resolves via | Brain status |
|---|---|---|---|
| `to do` | open | type | `ready` |
| `in progress` | custom | **name** | `in_progress` |
| `blocked` | custom | **name** | `blocked` |
| `team approval` | custom | type | `in_progress` |
| `client approval` | custom | type | `in_progress` |
| `corrections` | custom | type | `in_progress` |
| `client approved` | custom | type | `in_progress` |
| `done` | done | **name** | `done` |
| `Closed` | closed | type | `done` |

- Five of nine `custom` statuses is not a problem — it is the *expected* shape, and it is exactly
  what Linear's `started` type does to a team with "In Progress", "In Review", "Blocked" and "QA".
  The name-first rule already rescues the two that have canonical names (`in progress`, `blocked`);
  the four review-loop statuses collapse to `in_progress`, which is **semantically correct at this
  altitude** — they are all work in flight, none is done, none is queued.
- The one genuine judgement call is `open → ready` rather than `backlog`. ClickUp has a single
  not-started type and no separate backlog concept, so mapping it to `backlog` would put every
  ClickUp workspace's entire not-started column *outside* `OPEN_STATUSES`
  (`activity-policy.ts:39-42`) and therefore invisible to Home, Pulse in-flight and the timeline.
  `ready` is right, and a list that genuinely has a backlog column gets it from the name-first rule
  (a status named "Backlog" resolves by name).
- **Changes:** delete `ClickUpStatusMap`, `invertStatusMap`, `BRAIN_STATUSES`,
  `ClickUpNormalizationError`'s status branches and the `statusMaps` input; replace `resolveStatus`
  with a ~6-line `clickUpStatus(name, type)` mirroring `linearStatus`. Drop `statusMaps` from
  `lib/api/schemas.ts`. Roughly a 60-line net deletion.
- **Blast radius:** the ClickUp normalizer, its config schema, and its tests. Nothing else — no
  other module imports `ClickUpStatusMap` or `ClickUpBrainStatus`.
- **Cost in fidelity:** the four review-loop statuses are no longer distinguishable *in the
  `tasks` table*. See (d).

### (c) Extend the brain's status set with review/approval states

- **Changes:** `postgres/schema.sql:47` (an `ALTER TYPE ... ADD VALUE` migration — the idempotent
  `pg:schema` runner cannot do this, so a hand-written file in `postgres/migrations/`);
  `lib/api/schemas.ts:468`; `lib/pm-sync/provider.ts:11` **and `desiredStateForStatus`** — which has
  no honest answer, because neither Linear nor Plane has a review state *group* to project into;
  `lib/tasks/activity-policy.ts` and its single-source guard; `components/kanban/types.ts:1` (a new
  board column for every team, including those with no approval loop); `lib/metrics/pulse.ts:141`;
  `lib/meetings/target-status.ts`; `scripts/brain-tasks.ts:48`; the work timeline; **and a
  `brain-api.md` version bump** (`brain-api.md:493-494` states the set normatively), which every
  `aios` CLI client parses.
- Linear, Plane and GitHub could never *produce* the new values. It would be a ClickUp-only enum
  member, visible on every team's board.
- **Verdict: reject, explicitly on the stated constraint.** This is the definition of making the
  brain structurally more complex to cater for one integration.

### (d) Two-layer model — canonical status + native status as metadata

The brain already does this. `tasks.raw_status` exists (`schema.sql:1188`), Linear stamps
`state`/`state_type`/`status` side by side in doc frontmatter (`linear-normalize.ts:219-226`), and
**ClickUp already stamps `native_status` next to the canonical `status`**
(`clickup-normalize.ts:244`, `:424`) plus the full native record in the per-task JSON lines in the
item body.

So under (b), `client approval` is *not* destroyed. It survives verbatim in the per-task deliverable
frontmatter and the item body, which means it is searchable (`items.search`) and answerable by the
natural-language query surface.

What is genuinely lost is **row-level queryability**: `tasks` holds only the enum, and `raw_status`
will be null because the connector sends a canonical value. "How many tasks are sitting in client
approval, and for how long" becomes a search question rather than a board filter or a SQL
aggregation, and it cannot drive a dashboard column.

If that is commercially load-bearing, the fix is **one additive, provider-agnostic field** — let a
task row carry the native status verbatim and persist it into the *existing* `raw_status` column,
decoupling that column from "the pushed status was unmappable". Concretely: add
`native_status: z.string().max(120).optional()` to `taskRowSchema`
(`lib/api/item-payload-schema.ts:48`, a `strictObject`, so this is a brain-api additive change of
the same shape as `worked_at`), and in `lib/ingest/tasks.ts:145` prefer it over the
`normalizeTaskStatus` fallback. Linear gets it free (`state.name`), Plane gets it free
(`st?.name`), GitHub has nothing to send. No new enum value, no new board column, no consumer
changes. **This is justified generally, not for ClickUp** — "what does the source system actually
call this" is a question every connector's users ask.

---

## 4. Round-trip integrity

**There is no ClickUp write path today, and this is not a hypothetical gap in the analysis — it is a
fact of the codebase.** `PmProvider = "plane" | "linear"` (`lib/pm-sync/provider.ts:7`);
`taskRowSchema.pm_provider` is `z.enum(["plane","linear"])` (`item-payload-schema.ts:58`); there is
no `lib/pm-sync/clickup.ts`; `task_pm_links.provider` only ever holds those two. ClickUp is a
one-directional mirror. Nothing the normalizer does can currently move a ClickUp task.

So invertibility is a constraint on a *future* adapter, and the precedent already answers it:

- `desiredStateForStatus(status)` returns `{group, preferredName}` (`provider.ts:135-149`) — a
  coarse group plus a name hint, never a single state id.
- `resolveStateByGroup(states, desired)` (`lib/pm-sync/linear.ts:102-110`) filters the team's states
  to that group's type, prefers one whose name matches `preferredName`, else takes the first of the
  type. The collapse is resolved at write time from the *live* board, not from stored config.
- The disambiguator for a lossy collapse already exists in the schema:
  `task_pm_links.provider_seen_status` and `last_projected_brain_status` (`schema.sql:1263,1268`;
  `provider.ts:29-33`). The comment at `provider.ts:30-32` is explicit that the fingerprint hashes
  the *group* and therefore cannot separate same-group statuses, which is why the exact brain status
  is stored separately.

**The trap to avoid, stated plainly.** Linear's `statusOnly` path decides whether to write with
`const changed = issue.state?.id !== state.id` (`lib/pm-sync/linear.ts:283`) — a raw **state-id**
comparison. Projecting `in_progress` onto a Linear issue currently sitting in a different
`started`-type state moves it. Ported naively to ClickUp, that would drag a task out of
`client approval` and into `in progress` on the client's real board every projection cycle —
turning a lossy *read* into a destructive *write* on a commercially meaningful workflow. A ClickUp
adapter must gate on **mapped brain status**, not native state id: if the current native status
already maps to the desired brain status, write nothing. That rule is worth applying to Linear too,
but it is optional there and mandatory for any board with a review loop.

---

## 5. Recommendation

**Adopt (b) for the coarse status and (d) for fidelity. Reject (a) and (c). Delete `statusMaps`
entirely.**

1. Replace `resolveStatus`/`invertStatusMap`/`ClickUpStatusMap` with
   `clickUpStatus(name, type)` — name-first via `normalizeTaskStatus`, then
   `{open: "ready", custom: "in_progress", done: "done", closed: "done"}`, fail-open to `backlog`.
   Mirror `linearStatus` line for line, including the exported strict `…OrNull` variant so a future
   inbound apply has the same conflict semantics.
2. Remove `statusMaps` from `lib/api/schemas.ts:670-683` and the `NormalizeClickUpTasksInput` type.
   It has no writer, so nothing is orphaned.
3. Keep `native_status` in the doc frontmatter, and add the native ClickUp status *type* beside it
   (mirroring Linear's `state_type`) so downstream gates never have to regex a display name.
4. **Decision for a human, called out rather than absorbed:** whether the client-review loop needs
   to be queryable at the *row* level. Under (1)-(3) it is preserved and searchable but not
   filterable on the board or countable in SQL. If it must be filterable, ship the additive
   `native_status` task-row field described in §3(d) — one brain-api minor bump, no enum change, and
   Linear/Plane inherit it. Do not answer this by adding enum values.

**Why this and not the alternatives:** the brain already decided that a small canonical set plus a
preserved native string is the right shape, and enforced it three times over (`normalizeTaskStatus`,
`raw_status`, Linear's `state`/`state_type`/`status` triple). The ClickUp normalizer is the only
place that departed from it, and every symptom — the nine-status failure, the whole-workspace blast
radius, the unauthorable config — traces to that departure rather than to anything about ClickUp.
Bringing it back in line is a net deletion.

---

## 6. What this costs

- **Brain-wide blast radius of the recommendation: effectively zero.** `ClickUpStatusMap` and
  `ClickUpBrainStatus` are imported only by `lib/ingest/sources/clickup-normalize.ts` and two test
  files (`test/ingest-clickup-normalize.test.ts`,
  `test/datamechanics/clickup-attribution.datamechanics.test.ts`). No Postgres change, no
  `brain-api.md` change, no consumer change, no migration. ClickUp does not ingest yet, so there is
  no deployed data to reconcile.
- **Cost if the optional `native_status` row field is taken:** one additive field on a
  `strictObject` wire schema, one `brain-api.md` minor version bump plus its conformance doc, one
  line in `lib/ingest/tasks.ts`. It changes the meaning of `raw_status` from "unmappable" to "native"
  — `brain-api.md:689-697` and the client echo guard that depends on it
  (`app/api/v1/tasks/route.ts:243-252`) must be re-read carefully before doing this, because the
  guard's whole premise is "non-null `raw_status` means no authoritative writer has touched this
  row". Prefer a **separate** column over overloading `raw_status` if that guard proves load-bearing.
- **Cost in fidelity, stated honestly:** four distinct client-facing review stages become one
  `in_progress` in the `tasks` table. Cycle time through the approval loop, "stuck awaiting client"
  counts, and any approval-stage board column are not available from `tasks` without step (4). The
  information is not deleted — it is in the deliverable frontmatter and the item body — but it moves
  from structured to searchable. If the engagement's value story depends on measuring that loop,
  take step (4) before the connector ships, not after.
- **Cost of doing nothing:** ClickUp cannot ingest at all — not this workspace, not any workspace,
  because `statusMaps` has no authoring path.

---

## 7. Addendum — what was actually shipped, and where it departs from §5

Written after implementation. §1–§6 above are left exactly as they were: the value of a spec is that
it records the decision made *before* the code, including the parts that were later overruled.

**Shipped: (b) + (d) as recommended, AND (c), which §3 rejects.** The canonical set gained
`in_review` (`backlog|ready|in_progress|in_review|blocked|done`).

**Landed in two pieces, deliberately recorded here so the history reads straight.** The CONTRACT
half — `in_review` in `TASK_STATUSES`, the `task_status` enum widening, `ACTIVE_STATUSES`,
`desiredStateForStatus`, the board column, the Pulse funnel, brain-api 1.20 → 1.21 — shipped first
and independently as **PR #618**. The ClickUp NORMALIZER half — everything in §3(b)/§5(1)-(3)
below — is **PR #579's** work, rebased onto #618 and landed after it. Where this section says
"shipped", check the table in "The §3(c) cost list" for which PR carried it; the design decision is
the same in either case.

### Why (c) was taken despite the rejection

§3(c) rejects extending the set on the stated constraint — "making the brain structurally more
complex to cater for one integration" — and argues that "Linear, Plane and GitHub could never
*produce* the new values. It would be a ClickUp-only enum member."

**That premise is false, and it is the load-bearing one.** The AIOS team's own Linear board (team
AIO) has a workflow state named **"In Review"** of type `started`. `linearStatus` is name-first, so
before `in_review` existed the name resolved to nothing and the state fell through to
`TYPE_TO_STATUS.started` → `in_progress`. The brain was losing review-state fidelity **on its own
primary PM tool, in production, today** — not prospectively, and not because of ClickUp. Linear
produces the value the moment the value exists; Plane does too (a named state in the `started`
group); the mechanism is the one §2 already documents as the house pattern.

So `in_review` is not a ClickUp accommodation that the other adapters merely tolerate. It is a
provider-agnostic gap that ClickUp made visible. The rest of §3(c)'s cost list stands and was paid
in full (see below) — what changed is the justification, not the price.

### The §3(c) cost list, item by item

| §3(c) said | What shipped |
|---|---|
| `ALTER TYPE … ADD VALUE` migration, since `pg:schema` cannot express it | `postgres/migrations/20260819180000_task_status_in_review.sql` (#618), `add value if not exists … before 'blocked'`. Idempotence and enum sort order are pinned against real Postgres by `test/datamechanics/task-status-in-review.datamechanics.test.ts`, and the schema.sql/migration pairing statically by `test/guards/task-status-vocabulary.test.ts`. |
| `desiredStateForStatus` "has no honest answer" | It has the *same* answer `blocked` has always had: `{group: "started", preferredName: "In Review"}`. `resolveStateByGroup` prefers a name match within the group, so a board with a real "In Review" state gets it exactly and one without degrades to the first `started` state. `blocked` proves this shape is acceptable — it is not a new compromise. |
| `activity-policy.ts` and its guard | `in_review` added to `ACTIVE_STATUSES` (#618); the guard's own hand-copied status regex is now checked against `TASK_STATUSES` so it cannot go stale the next time the set grows. This is not optional: those tasks were already counted as active (as `in_progress`), so omitting it would have removed every awaiting-review task from Home, Pulse in-flight and the timeline — a regression disguised as a fidelity gain. |
| a new board column for every team | Accepted. `components/kanban/types.ts` + `column.tsx` (#618). |
| `pulse.ts` FUNNEL_ORDER, `scripts/brain-tasks.ts` | Both updated (`pulse.ts` in #618); `brain-tasks.ts` now *imports* `TASK_STATUSES` rather than keeping a fourth hand-maintained copy. |
| `meetings/target-status.ts` | **Not** changed. `MEETING_TASK_STATUSES` is a deliberate four-value subset gated by a Postgres CHECK; "in review" is not a meeting-extraction target. |
| a `brain-api.md` version bump | 1.20 → **1.21** (#618). See `lib/api/version.ts` for the full note, including the one observable break (a row an old client read as `in_progress` now reads as `in_review`). |

### Correction to §3(b): the name-first rule does NOT rescue a "Backlog" column

§3(b) claims "a list that genuinely has a backlog column gets it from the name-first rule (a status
named 'Backlog' resolves by name)". **Not if `clickUpStatus` mirrors `linearStatus` line for line,
which §5(1) instructs.** `linearStatusOrNull` guards its name branch with
`byName.status !== "backlog"`, deferring a "Backlog"-named state to its type. That is harmless for
Linear, which *has* a `backlog` state type to land in. ClickUp has no such type — its only
not-started type is `open`, which §3(b) maps to `ready` — so a literal "Backlog" column resolved to
`ready`, and naming the column is the only way a ClickUp List can express intake at all.

`clickUpStatus` therefore diverges deliberately: it trusts any exact name match, keyed on
`raw_status === null`, which already discriminates a real "Backlog" from `normalizeTaskStatus`'s
unknown-value fallback exactly. The divergence is commented at the call site. A unit test
(`clickUpStatus("Backlog", "open") === "backlog"`) pins it — it was written from this document's
claim, went red against the mirrored implementation, and is the reason the bug was found.

### The §5(4) decision, answered: "team approval" / "client approval"

§5(4) leaves for a human whether the client-review loop needs row-level queryability. With
`in_review` in the set, the cheap half of that is now available without the additive `native_status`
task-row field: `clickUpStatus` applies one small heuristic — a status name matching
`/\b(review|approval)\b/` resolves to `in_review` — *after* the exact-name match and *before* the
type fallback.

- **Why a heuristic at all:** ClickUp collapses everything between "not started" and "finished" into
  the single `custom` type, so unlike Linear the type carries no review signal whatsoever. The
  display name is the only information there is.
- **Why it is defensible:** it is fail-soft by construction. The worst case is a row on `in_review`
  instead of `in_progress` — both active, both open, both on the same surfaces. It can never fail an
  import.
- **Word boundaries are load-bearing:** "client approved" and "reviewed" are past tense — the work
  has come *back* from review — and must not match. They fall to the type and land on `in_progress`.
- **Still not answered:** counting *how long* something sat in "client approval" specifically. Both
  approval stages collapse into one `in_review`. The native pair survives verbatim in the per-task
  document frontmatter (`native_status`, and now `native_status_type` per §5(3)), so it stays
  searchable, but it is not a SQL aggregation. If that becomes commercially load-bearing, take
  §3(d)'s additive task-row field — do not add more enum values.
