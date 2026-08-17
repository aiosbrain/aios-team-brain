# A row that names its issue must not get a second one — ADOPTDECL-1

**Status:** spec, draft 4. Drafts 1, 2 and 3 were each BLOCKED by cold reads. Both of my attempts to infer
"the human declared this" from `provider_external_id` failed — in opposite directions — so draft 3 stops
inferring and records the fact in its own column (§1a). Draft 2's §1c safeguard was worse than none: it
would have stored a fingerprint asserting a projection that never happened. The Fable leg stalled twice
on draft 1 and did not run; it ran on draft 2 and returned BLOCKED with a Critical plus four Highs. · **Date:** 2026-08-16 · **Owner:** Chetan · **Task:** `ADOPTDECL-1`
**Related:** `AIO-895` / `GH-542` (this is the symptom that report buried in a parenthetical — see §0d),
[`pm-sync-mutation-verification.md`](./pm-sync-mutation-verification.md) (`PMSUCCESS-1`, which named this
as deferred).
**Code:** `lib/pm-sync/linear.ts`, `lib/pm-sync/project.ts`, `lib/ingest/tasks.ts`.

---

## 0. What is wrong

A task row can **declare** the issue it already corresponds to: the item payload carries
`pm_provider` + `pm_external_id` (`lib/api/item-payload-schema.ts:13`), and `lib/ingest/tasks.ts:202-215`
upserts that into `task_pm_links.provider_external_id`. It cannot set `provider_resource_id`, because
Linear's UUID is not knowable from a markdown row — only the human-readable identifier (`AIO-877`) is.

**The projection path that creates issues never reads that column.** `lib/pm-sync/linear.ts:320`:

```ts
const existing = (link?.provider_resource_id ? boot.issuesById.get(link.provider_resource_id) : undefined)
  || boot.issuesByExt.get(task.row_key);
```

- `provider_resource_id` is null (ingest cannot supply it);
- `issuesByExt` is keyed on the `aios-ext:` footer, which a **human-created** issue does not carry.

Both miss, `existing` is undefined, and the create branch runs. **The row that said "I am AIO-877" gets a
brand-new AIO-878, and the two now coexist.**

### 0a. The codebase already disagrees with itself about this

Two other paths in the same file DO treat the declared key as a usable reference:

| line | path | reference used |
|---|---|---|
| `linear.ts:277` | `upsertWorkItem({statusOnly})` | `link.provider_resource_id \|\| link.provider_external_id` |
| `linear.ts:374` | `moveToDone` | `link.provider_resource_id \|\| link.provider_external_id` |
| `linear.ts:320` | `upsertWorkItem` (full projection) | **resource id or footer only — the declared key is not consulted** |

So the inconsistency is not "the field is unused"; it is that **the one path that can create a duplicate
is the one path that ignores it**. (Those two paths hand the value to `resolveIssueLite`, which queries
`issue(id: $id)`. Whether Linear's `issue(id:)` resolves a human identifier as well as a UUID is **not
verifiable from this repo** — there is no SDK or recorded schema here — so §2 does not build on that
assumption; it is recorded because it is why the field looks usable to a reader.)

### 0b. Confirmed in prod, not inferred

Run `13291` (2026-08-14 04:13, team `73409b20…`, project `406a614e…`) reported
`created: 5 · synced: 5 · ok: true` and created four issues for rows that should have resolved to
existing ones (see §0b for what this evidence does and does not witness):

| row | issue created | synced at |
|---|---|---|
| TT39 | `AIO-878` | 04:13:20 |
| TT40 | `AIO-879` | 04:13:22 |
| TT41 | `AIO-880` | 04:13:24 |
| TT42 | `AIO-881` | 04:13:26 |

Draft 1 added an inference here and **it was wrong**: it claimed that because the four link rows now
carry the NEW issue in `provider_external_id`, and nothing in `lib/pm-sync` writes that column, ingest
must have written it. There are at least three other writers — `ensureLink` (`project.ts:168`, the
`row_key` default), inbound adoption (`inbound.ts:452-466`, which writes
`provider_external_id = it.identifier` **and** `row_key = it.identifier`), and the CLI adopt path in
`scripts/brain-tasks.ts`. (`persistSuccess` genuinely does not write it — that part held.)

So the column's present value does **not** establish who wrote it. What the prod data does support is
narrower: **four issues were created by that run for four rows, and those rows' links now point at the
new issues.** It does **not** witness what those rows declared *before* the run — the pre-run values are
gone, which is the same reason the column proves nothing about who wrote it. So the headline should be
read as "duplicates of existing issues appeared for these rows", not as "these rows demonstrably named
their own". The mechanism in §0 is established by reading `linear.ts:320`; prod supplies the damage, not
the intent.

### 0c. Why the damage is worse than an extra row

A duplicate is not a cosmetic annoyance in this system. The brain now believes the row IS the new issue,
so every subsequent projection maintains the duplicate and the issue the human actually meant drifts,
unmaintained, holding the real conversation. The two diverge silently and neither side is marked.

### 0d. What this is NOT, and the correction that belongs here

`AIO-895` / `GH-542` is titled *"pm_sync can report success while creating no issue"* and its headline
evidence — run `13291` recording `created: 5` while no issues appeared — **is a misreading**.

**Provenance, because a reviewer reading only this repo cannot check the last two bullets:** the first is
from the code; the rest are from read-only queries against the prod Postgres via the Railway public proxy
on 2026-08-16 (`select … from ingest_runs where id=13291`; `select row_key, provider_resource_id,
provider_url, last_synced_at from task_pm_links where last_synced_at between '2026-08-14 04:13:00+00' and
'2026-08-14 04:14:00+00'`; `select count(*) from task_pm_links where row_key in ('TT35'…'TT38')` → 0).
Re-run those to check me.

- `created` is `summary.synced` (`lib/pm-sync/runs.ts:80`) — a count of report statuses, never a count
  of provider objects;
- that run synced `TT39`–`TT42` and `TT50`, and every one of them produced a real issue
  (`AIO-878`–`881`, `AIO-893`);
- the rows the report names, `TT35`–`TT38`, were **not in that batch at all** — they were created
  2026-07-28 and have never had a link row.

The *code* defect that ticket named (mutations never reading `success`) was real and shipped as
`PMSUCCESS-1`. **This slice is the other half — the symptom that report described in one parenthetical
and that has the visible, uncleaned damage.** The four unlinked `TT35`–`TT38` rows are a third, separate
question (§3).

## 1. The decision

**Drafts 1 and 2 both tried to infer "the human declared this" from `provider_external_id`, and both
failed — in opposite directions.** Draft 1 fired only when the value differed from `row_key`, which
missed real declarations. Draft 2 fired whenever the value resolved to an issue, which **adopts a
stranger's issue** for any row whose `row_key` happens to look like a Linear identifier — and
`ensureLink` (`project.ts:168`) writes exactly that default into exactly that column. The column cannot
carry intent, because two writers with opposite meanings share it.

So draft 3 stops guessing and records the fact.

### 1a. A column that means what it says: `declared_external_id`

`task_pm_links` gains `declared_external_id text`. It is written by **one** writer — the task ingest,
which already knows (`lib/ingest/tasks.ts:202`) that it is looking at a human-authored
`pm_external_id` — and it is never defaulted. `ensureLink` does not touch it.

Non-null therefore means *a human named this issue on this row*, which is the predicate every section
below needs and neither earlier draft had. `provider_external_id` keeps its current meaning and its
current readers (`linear.ts:277`, `:374`, `plane.ts:174`) untouched; this slice adds a fact rather than
overloading one.

Additive migration in `postgres/migrations/` plus the mirror in `schema.sql`, per the repo's
column-adding rule.

### 1b. The rung fires on the declared column, and only there

The adopt-or-create chain in `linear.ts:319-320` gains a last rung: resolve `declared_external_id`
against an identifier index built from the issues `buildBootstrap` already loads
(`linear.ts:166` returns `identifier` on every node — no extra round-trip).

Because defaults never reach that column, the wrong-issue adoption draft 2 introduced is not merely
unlikely, it is **unreachable**: a row that declared nothing has nothing to resolve.

**This rung's witness has now been wrong three times, so it is stated carefully.** Draft 2 cited the
row inbound adoption creates (`inbound.ts:452-466`) — but that insert sets `provider_resource_id` in the
same statement, so it resolves at the first rung. Draft 3 then cited a **Linear-mirrored task before the
adopt sweep** — also wrong: `lib/ingest/sources/linear-normalize.ts` emits no `pm_provider` /
`pm_external_id`, so a mirrored task's `declared_external_id` is NULL forever and this rung can never
fire for it.

**The true witness is the shape this ticket was filed for:** a workspace markdown row that carries
`pm_external_id` (the `TT39`–`TT42` shape), whose link therefore has a non-null `declared_external_id`
and no `provider_resource_id`.

The mirrored-task duplicate is **real but out of scope** — see §3. It is a different fix (teach
`linear-normalize` to emit the identifier so mirrors route through this column legitimately), and
pretending this rung addresses it is how the wrong witness survived two drafts.

### 1c. Adoption seeds the brain from the issue when the brain has nothing to say

Draft 2 said the adoption run preserves the human's prose and the next run overwrites it. Draft 3 said
the brain's body is written immediately. **Both were wrong, and the repo already knew why.**

Draft 2's version was incoherent: after adoption the link has a `provider_resource_id` and
`persistSuccess` stores a fingerprint computed from the **brain** shape, so the next run hits the
short-circuit at `project.ts:281` and makes **zero provider calls**. The grace was indefinite, ending at
some unrelated status flip weeks later — and the stored fingerprint was a **recorded falsehood**,
asserting a projection that never happened. That is the class `PMSUCCESS-1` closed one layer down.

Draft 3's version was destructive, and this is the fact neither earlier draft checked: **a sync-pushed
task has no body.** `materializeTasks` never writes `body` (`lib/ingest/tasks.ts:161-193`), and the
schema says so outright — *"body is dashboard/DB-only — it never round-trips through the sync push"*
(`postgres/schema.sql:1195`), default `''`. So for the canonical declaring shape — a markdown row
carrying `pm_external_id: AIO-877` — "write the brain's body" means `withFooter("", …)`: **the human's
entire issue description erased to a footer, every time.**

The repo solves this one file over. Inbound adoption seeds an empty brain body **from the issue**
(`inbound.ts:434`), and its comment names precisely the hazard draft 3 was about to re-introduce:
*"without it, the first outbound projection after a brain-side edit would overwrite the Linear-native
description with the mirror task's empty body."*

So adoption follows that precedent:

> **The adoption write sends `task.body` when the brain has one, and the issue's own stripped
> description when it does not** — `body.trim() ? body : stripFooter(issue.description)`, plus the
> footer. Immediately, in one step.

That is honest on every axis at once: the write happens now (no grace that cannot be persisted), the
fingerprint describes what was actually sent, and a human's write-up is inherited rather than destroyed.
Declaring an issue still hands it to the brain — the brain simply starts from what was already there.

**What this does NOT promise.** Once the brain has a body, the brain's body wins, exactly as for an
issue the brain created. Preservation here is *seeding*, not permanent protection.

### 1d. Refuse to adopt an issue that already belongs to another row

Draft 2 guarded only against two rows declaring the *same string*. That misses the shape that actually
produces a two-writer loop: row A created `AIO-900` through normal projection, and a human then declares
`AIO-900` on row B. No two rows "declared" it, so draft 2's check never fires — and each run alternates
A's and B's content into one issue.

The check is therefore **ownership, by any means**: the resolved issue is refused if another link in the
team already carries it as `provider_resource_id`, or if its description carries a *different* row's
`aios-ext:` footer. Two rows declaring the same key is one instance of that, not the rule.

Ownership is read from persisted state, not from an in-run set: `projectTask` is callable standalone on
the reactive path, so an in-run set would let two separate runs both adopt. The winner is **arbitrary
but sticky** — `projectAllTasks` applies no `ORDER BY` (`project.ts:387-393`), so which row wins first is
not deterministic, but once it holds the `provider_resource_id` the loser fails consistently rather than
flapping.

**And a read-then-write check is not enough, which both reviewers found independently.** It is
check-then-act: a reactive `after()` projection (`after-write.ts:45`) overlapping a manual board push can
have both rows read "no owner", both `issueUpdate` the same issue, and both persist the same
`provider_resource_id` — the two-writer loop, now silent, and afterwards **both** rows fail forever. The
only unique constraint today is `(team_id, project_id, row_key, provider)` (`schema.sql:1271`), so the DB
offers no backstop.

Since this slice already carries a migration, it adds one: a **partial unique index on
`(team_id, provider, provider_resource_id) where provider_resource_id is not null`**, so the second
writer loses at the database rather than in a race. **With a prod pre-check first** — a constraint
narrower than live data is this repo's own replay-incident class (#251), and duplicate resource ids may
already exist from the very damage this slice is about. If the pre-check finds any, the index ships in a
follow-up after they are reconciled, and the race is stated as accepted in the meantime.

### 1e. A withdrawn declaration must actually clear

Today ingest writes the link row only when **both** `pm_provider` and `pm_external_id` are present
(`lib/ingest/tasks.ts:202`). So a human who fixes a typo'd declaration by deleting the field leaves the
old value in place forever — and under §1f that row then fails on every run with no remedy short of
manual SQL. This slice makes a stale value load-bearing, so it must also make it clearable — and the obvious
trigger is wrong twice over:

- **The natural withdrawal deletes BOTH fields**, not just `pm_external_id`. A trigger conditioned on
  `pm_provider` being present never fires for it, and the stale value would persist exactly when the
  human thought they had removed it.
- **Clearing must never INSERT.** `provider_external_id` is `text not null` with no default
  (`schema.sql:1253`), so an insert leg for a row with no existing link has no legal value to supply —
  it would either throw inside `materializeTasks` (a shape silently ignored today) or force ingest to
  invent a default in the very column family this draft exists to de-ambiguate.

So: **clearing is an UPDATE of existing links only, and it fires whenever a row's `pm_external_id` is
absent** — including when `pm_provider` is absent too, in which case every provider's link for that
`row_key` is cleared. A row that never had a link stays as it is. Withdrawing the declaration returns the
row to ordinary create-or-adopt.

### 1f. A declared key that resolves to nothing is an ERROR, not a new issue

If the declared identifier names no issue the bootstrap loaded, the row fails with a message naming it,
which `persistError` records and the run's `errors[]` surfaces. Creating an issue is reasonable when the
row said nothing; it is not reasonable when the row said something we could not honour.

**The tradeoff, named rather than discovered.** "Unresolvable" means *absent from the bootstrap*, which
is wider than typos: another Linear team, an archived or deleted issue, or one beyond what `team.issues`
paginates (`linear.ts:156-181`). Those rows create silently today and fail per-row after this slice.
That is the intended direction, and §1e is what keeps it recoverable.

To tell a foreign key from a typo the bootstrap query fetches `team { key }` — the same query, no extra
round-trip, and a real source rather than the prefix-guessing draft 2 implied. **Residual ambiguity,
stated:** a *same-prefix* miss (archived, deleted, past the pagination cap) is indistinguishable from a
typo, so the message can rule a foreign team **in**, never rule the other causes **out**.

### 1g. An adoption is reported as an adoption — and four consumers must learn the word

Adopting a pre-existing issue is not the same event as creating one, and a run that says `synced` for
both hides the moment a human's issue changed hands. The report status for this rung is `adopted`.

**No exhaustive switch exists over `ProjectionReport.status`, so widening the union is silently green
everywhere.** Both reviewers enumerated the consumers; all four are part of this slice, because a new
status that nothing handles is worse than no new status:

1. **The throttle** — `project.ts:368` sleeps only on `synced`. A first board push adopting N declared
   rows would issue N back-to-back `issueUpdate`s at zero throttle. This is a live rate-limit risk, not
   a cosmetic one.
2. **The meetings action** — `app/t/[team]/meetings/actions.ts:418` maps anything that is not
   `synced`/`skipped` to **`"failed"`**, so a successful adoption would surface as a failed push.
   `PushTaskResult.status` (`:303`) needs the value too.
3. **The run summary** — `summarizeProjectionReports` (`runs.ts:39-55`) would fold `adopted` into
   `unchanged`. It must count adoptions in their own right; `meta: counts` already carries the raw
   tally, but the named field is what the CLI prints.
4. **The types** — `provider.ts:38` (`status: "synced" | "skipped"`) and `ProjectionStatus`
   (`project.ts:41-49`).

**A no-op adopt** — the issue already matches the desired fields, so `linearIssueMatches` is true and no
mutation is sent — reports `adopted` as well, not `skipped`: the row DID change hands, and the footer
write is what makes that durable.

## Dependencies

**Deps: none**, but the shape changed: this now carries a **schema change** (`declared_external_id` on
`task_pm_links`, additive migration plus the `schema.sql` mirror), a change to `lib/ingest/tasks.ts`, and
a single-writer guard — alongside `lib/pm-sync/linear.ts` and the tests. No new API call: `team { key }`
and the identifier index both come from queries `buildBootstrap` already issues.

## Build-with

**Build-with tier: Fable / high effort — and it is now SCHEMA-TOUCHING**, which raises the bar: a
column, a migration, a `schema.sql` mirror, and a single-writer guard. Drafts 1 and 2 tried to avoid the
column and both produced a wrong rule, so the schema change is the finding, not scope creep. This changes
what an outward-facing projector does with a
human's existing issue — the failure mode is overwriting someone's writing, or adopting the wrong issue,
neither of which a test suite notices unless it is written to. Two adversarial spec reviews (Fable +
Codex) before code, two on the diff.

## Tier safety

No tier surface changes: an outbound projection path. It DOES carry a schema change (§1a) — that line
said "no schema" through draft 3 and was stale. No new API route, no change to
`visibleItems`/`visibleTasks`/`visibleGroupIds`. The outward-facing behaviour changes are deliberate and
named: a declared key now adopts instead of duplicating, and an unresolvable declared key now errors
instead of creating.

## 2. Acceptance criteria

- `postgres/migrations/` — an additive migration adds `task_pm_links.declared_external_id`, mirrored into `postgres/schema.sql`, so a from-zero load and a live DB agree.
- `test/pm-sync-declared-adoption.test.ts` — a row whose link carries a non-null `declared_external_id` matching a bootstrapped issue's `identifier` ADOPTS it: `issueUpdate` for that issue, no `issueCreate`, driven through `upsertWorkItem` against a fake `fetch`.
- `test/pm-sync-declared-adoption.test.ts` — the adoption fixture makes the resource-id and footer rungs BOTH miss (no `provider_resource_id`, no `aios-ext:` footer on the issue), so only the new rung can produce the adopt — one condition per fixture.
- `test/pm-sync-declared-adoption.test.ts` — a row with `declared_external_id` NULL never adopts, even when its `row_key` exactly equals a bootstrapped identifier; it creates. This is the wrong-issue adoption draft 2 would have shipped.
- `test/pm-sync-declared-adoption.test.ts` — when the brain task's `body` is EMPTY (the canonical sync-pushed shape) the adoption write sends the ISSUE's own stripped description plus the footer, NOT an empty body; a fixture whose issue holds multi-paragraph prose must still contain that prose in the mutation variables.
- `test/pm-sync-declared-adoption.test.ts` — when the brain task HAS a body, the adoption write sends the BRAIN's body plus the footer, so seeding is scoped to the empty case and is not permanent protection.
- `test/pm-sync-declared-adoption.test.ts` — a declared key resolving to an issue already carried as another link's `provider_resource_id` FAILS, naming both rows; likewise when the issue's description carries a different row's `aios-ext:` footer.
- `test/pm-sync-declared-adoption.test.ts` — a declared key matching no bootstrapped issue THROWS `PmSyncError` naming the key; when the key's prefix differs from `team.key` the message says "probably another team", and when it matches it does not.
- `test/pm-sync-declared-adoption.test.ts` — the adopting row's report status is `adopted`, not `synced`, and the run summary counts it separately.
- `test/pm-sync-declared-adoption.test.ts` — `buildBootstrap` adds no additional GraphQL round-trip: `team { key }` and the identifier index come from queries already issued, asserted by the fake `fetch`'s query count.
- `test/ingest-tasks-declared-id.test.ts` — ingest writes `declared_external_id` when `pm_external_id` is present and sets it to NULL when the field is removed while `pm_provider` remains, so a withdrawn declaration is recoverable.
- `test/guards/declared-external-id-single-writer.test.ts` — `lib/ingest/tasks.ts` is the only writer of `declared_external_id`, asserted REPO-WIDE rather than over `lib/pm-sync` alone: `scripts/brain-tasks.ts`, `lib/meetings/extract-todos.ts`, `scripts/backfill-meeting-todo-rowkeys.ts` and `test/datamechanics/setup.ts` all write `task_pm_links` and must not write this column. Mutation-verified to redden on a bypassing write.
- `test/pm-sync-declared-adoption.test.ts` — an adopting report's status is `adopted` AND the throttle is paid for it (`project.ts:368`), so a bulk adoption does not issue back-to-back provider writes unthrottled.
- `test/pm-sync-declared-adoption.test.ts` — `summarizeProjectionReports` counts `adopted` separately rather than folding it into `unchanged`, and `app/t/[team]/meetings/actions.ts` maps `adopted` to a SUCCESS, not to `"failed"`.
- `test/ingest-tasks-declared-id.test.ts` — clearing updates links already present and never INSERTS one; a row with `pm_provider` and no `pm_external_id`, and a row with NEITHER field, both clear `declared_external_id` on every link for that `row_key`, while a row with no link at all is untouched.
- `postgres/migrations/` — if the partial unique index on `(team_id, provider, provider_resource_id)` ships, a prod pre-check for existing duplicate resource ids is recorded in the PR; if duplicates exist the index is deferred and the accepted race is stated.
- `test/datamechanics/pm-sync-declared-adoption.datamechanics.test.ts` — after adoption the link row's `provider_resource_id` is the ADOPTED issue's id with `last_error` null, and a SECOND projection run short-circuits without re-writing the issue; after an unresolvable declared key the row records `last_error` and no `provider_resource_id`.
- `docs/design/pm-sync-declared-issue-adoption.md` — §0d's correction to `AIO-895`'s headline evidence is repeated in the PR body, so the merge does not read as a second fix for the same misread report.

## 3. Scope

**In:** the `declared_external_id` column and its migration, the identifier index, the declared-key
rung, the seed-from-issue adoption write (§1c), the ownership refusal plus its uniqueness backstop, the
clearing path, the `adopted` status and its four consumers, the unresolvable-key error, the single-writer
guard, and their tests.

**Deferred, each with its reason:**

- **Cleaning up `AIO-878`–`AIO-881`.** Four real duplicate issues exist in Linear. Deciding which of each
  pair survives is a human call about content, not a projector change, and deleting issues from a script
  is exactly the outward-facing action this repo requires confirmation for.
- **`TT35`–`TT38`, the four rows with no link row at all.** They are the only 4 unlinked tasks of 59 in
  that project and have never been projected. That is a "rows the projector never sees" question —
  a different failure class, which reports nothing at all rather than reporting the wrong thing.
- **The Plane adapter — and draft 1's reason for deferring it was wrong.** Draft 1 cited
  `plane.ts:171-177` as already doing the analogous thing. That is `patchStateOnly` only; Plane's full
  adopt-or-create path resolves by `task.row_key` (`plane.ts:217-222`) and so has **the same defect**.
  It is still deferred — Plane is not the provider that duplicated, and one provider's fix should be
  proven before it is generalised — but it is deferred as known-broken, not as already-handled.
- **Verifying whether Linear's `issue(id:)` accepts a human identifier.** It would let `statusOnly`/
  `moveToDone` (`linear.ts:277`, `:374`) be described accurately. It needs a call to the real API; this
  slice neither relies on it nor asserts it.

## 4. What would falsify this

Wrong if a row declaring an existing issue still creates a second one after this ships — that would mean
the rung is not in the chain where §1a puts it, and the prod evidence in §0b would be describing a
different mechanism than the one being fixed.

Wrong in the more dangerous direction if adoption ever **erases** an issue's description — which is
exactly what "write the brain's body" means for the canonical declaring shape, because a sync-pushed task
has no body (`lib/ingest/tasks.ts:161-193`, `schema.sql:1195`). §1c seeds from the issue instead,
following `inbound.ts:434`. This is the failure this slice can cause and today's code cannot, so it is
the one the tests must pin hardest: a criterion asserting only "it adopted" would pass while a
colleague's write-up was replaced by a footer.

*(Drafts 2 and 3 both had this section contradicting §1c — draft 2 by promising permanent preservation,
draft 3 by mandating immediate overwrite while §3 still listed a "description-preserving adoption write".
A builder reading either pair would have been ordered to test opposite behaviours. That is the SR19 class
that blocked draft 2, and it survived one more draft by hiding in the scope list.)*
