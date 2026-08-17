# A row that names its issue must not get a second one — ADOPTDECL-1

**Status:** spec, draft 3. Drafts 1 and 2 were each BLOCKED. Both of my attempts to infer
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
`created: 5 · synced: 5 · ok: true` and created four issues alongside rows that already named their own:

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

**The witness draft 2 cited for this was wrong, and it mattered.** It named the row inbound adoption
creates (`inbound.ts:452-466`) as the shape that would duplicate — but that insert sets
`provider_resource_id` in the same statement (`$5 = it.id`), so such a row resolves at the first rung
and never needed this one. The genuinely vulnerable shape is a **Linear-mirrored task before the adopt
sweep reaches it**: the task exists with no link row at all, and `projectAllTasks` filters only on
`row_key not null` (`project.ts:387-393`), so it is swept into a duplicate.

### 1c. Adoption is the handover — the brain's body is written immediately

Draft 2 said the adoption run preserves the human's prose and the next run overwrites it. **Both halves
were wrong, and the second is the dangerous one.** After adoption the link has a `provider_resource_id`
and `persistSuccess` stores a fingerprint computed from the **brain** shape, so the next run hits the
short-circuit at `project.ts:281` and makes **zero provider calls**. The "one-run grace" is actually
indefinite, and it ends at the first fingerprint-visible change — a status flip weeks later — replacing
a colleague's write-up at a moment disconnected from the declaration, when nobody is looking.

Worse, the stored fingerprint would be a **recorded falsehood**: it asserts the brain shape was
projected while Linear holds the human's body, and nothing heals it (inbound never reconciles bodies,
`inbound.ts:432-434`). That is the same "report success for an outcome that did not happen" class
`PMSUCCESS-1` closed one layer down, re-introduced by this slice's own safeguard.

So the adoption write is an ordinary update: **brain body plus footer, immediately.** Declaring an issue
on a task row hands that issue's content to the brain, in one step, visibly. There is no grace, because a
grace that cannot be honestly persisted is worse than none.

### 1d. Refuse to adopt an issue that already belongs to another row

Draft 2 guarded only against two rows declaring the *same string*. That misses the shape that actually
produces a two-writer loop: row A created `AIO-900` through normal projection, and a human then declares
`AIO-900` on row B. No two rows "declared" it, so draft 2's check never fires — and each run alternates
A's and B's content into one issue.

The check is therefore **ownership, by any means**: the resolved issue is refused if another link in the
team already carries it as `provider_resource_id`, or if its description carries a *different* row's
`aios-ext:` footer. Two rows declaring the same key is one instance of that, not the rule.

Ownership is read from persisted state, not from an in-run set: `projectTask` is callable standalone on
the reactive path, so an in-run set would let two separate runs both adopt. And the winner is
**arbitrary but sticky** — `projectAllTasks` applies no `ORDER BY` (`project.ts:387-393`), so which row
wins first is not deterministic, but once it holds the `provider_resource_id` the loser fails
consistently rather than flapping. Stated plainly rather than implying a deterministic "second".

### 1e. A withdrawn declaration must actually clear

Today ingest writes the link row only when **both** `pm_provider` and `pm_external_id` are present
(`lib/ingest/tasks.ts:202`). So a human who fixes a typo'd declaration by deleting the field leaves the
old value in place forever — and under §1f that row then fails on every run with no remedy short of
manual SQL. This slice makes a stale value load-bearing, so it must also make it clearable: ingest
writes `declared_external_id` whenever `pm_provider` is present, setting it to NULL when
`pm_external_id` is absent. Withdrawing the declaration returns the row to ordinary create-or-adopt.

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

### 1g. An adoption is reported as an adoption

Adopting a pre-existing issue is not the same event as creating one, and a run that says `synced` for
both hides the moment a human's issue changed hands. The report status for this rung is `adopted`, which
the run summary counts separately — so a wrong adoption is visible in the same place the duplicate
damage was invisible.

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

No tier surface changes: an outbound projection path. No new API route, no schema, no change to
`visibleItems`/`visibleTasks`/`visibleGroupIds`. The outward-facing behaviour changes are deliberate and
named: a declared key now adopts instead of duplicating, and an unresolvable declared key now errors
instead of creating.

## 2. Acceptance criteria

- `postgres/migrations/` — an additive migration adds `task_pm_links.declared_external_id`, mirrored into `postgres/schema.sql`, so a from-zero load and a live DB agree.
- `test/pm-sync-declared-adoption.test.ts` — a row whose link carries a non-null `declared_external_id` matching a bootstrapped issue's `identifier` ADOPTS it: `issueUpdate` for that issue, no `issueCreate`, driven through `upsertWorkItem` against a fake `fetch`.
- `test/pm-sync-declared-adoption.test.ts` — the adoption fixture makes the resource-id and footer rungs BOTH miss (no `provider_resource_id`, no `aios-ext:` footer on the issue), so only the new rung can produce the adopt — one condition per fixture.
- `test/pm-sync-declared-adoption.test.ts` — a row with `declared_external_id` NULL never adopts, even when its `row_key` exactly equals a bootstrapped identifier; it creates. This is the wrong-issue adoption draft 2 would have shipped.
- `test/pm-sync-declared-adoption.test.ts` — the adoption write sends the BRAIN's body plus the footer, not the issue's prior prose; no test asserts preservation, because §1c establishes there is none.
- `test/pm-sync-declared-adoption.test.ts` — a declared key resolving to an issue already carried as another link's `provider_resource_id` FAILS, naming both rows; likewise when the issue's description carries a different row's `aios-ext:` footer.
- `test/pm-sync-declared-adoption.test.ts` — a declared key matching no bootstrapped issue THROWS `PmSyncError` naming the key; when the key's prefix differs from `team.key` the message says "probably another team", and when it matches it does not.
- `test/pm-sync-declared-adoption.test.ts` — the adopting row's report status is `adopted`, not `synced`, and the run summary counts it separately.
- `test/pm-sync-declared-adoption.test.ts` — `buildBootstrap` adds no additional GraphQL round-trip: `team { key }` and the identifier index come from queries already issued, asserted by the fake `fetch`'s query count.
- `test/ingest-tasks-declared-id.test.ts` — ingest writes `declared_external_id` when `pm_external_id` is present and sets it to NULL when the field is removed while `pm_provider` remains, so a withdrawn declaration is recoverable.
- `test/guards/declared-external-id-single-writer.test.ts` — `lib/ingest/tasks.ts` is the only writer of `declared_external_id`; `ensureLink` and every `lib/pm-sync` path must not write it, and the guard is mutation-verified to redden on a bypassing write.
- `test/datamechanics/pm-sync-declared-adoption.datamechanics.test.ts` — after adoption the link row's `provider_resource_id` is the ADOPTED issue's id with `last_error` null, and a SECOND projection run short-circuits without re-writing the issue; after an unresolvable declared key the row records `last_error` and no `provider_resource_id`.
- `docs/design/pm-sync-declared-issue-adoption.md` — §0d's correction to `AIO-895`'s headline evidence is repeated in the PR body, so the merge does not read as a second fix for the same misread report.

## 3. Scope

**In:** the identifier index, the declared-key rung, the declared-vs-default distinction, the
description-preserving adoption write, the unresolvable-key error, and their tests.

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

Wrong in the more dangerous direction if adoption ever rewrites an issue's description with the brain's
body on first contact. That is the failure this slice can cause and today's code cannot, so it is the one
the tests must pin hardest — a criterion asserting only "it adopted" would pass while a colleague's
write-up was being replaced.
