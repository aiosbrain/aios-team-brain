# A row that names its issue must not get a second one — ADOPTDECL-1

**Status:** spec, draft 2. Draft 1 was BLOCKED by a Codex cold read (two blockers), and its §1c
protection was falsified by me while that review ran. The Fable leg **stalled twice and did not run** —
recorded here rather than papered over; it is re-attempted on this draft. · **Date:** 2026-08-16 · **Owner:** Chetan · **Task:** `ADOPTDECL-1`
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
narrower and still sufficient: **four issues were created by that run for four rows, and those rows'
links now point at the new issues.** The mechanism in §0 is established by reading `linear.ts:320`, not
by this column.

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

### 1a. The declared key joins the adopt-or-create chain, as its last rung

`buildBootstrap` (`linear.ts:155-181`) already fetches `identifier` for every issue and indexes only by
`id` and by footer. It gains `issuesByIdentifier`, which costs **zero additional API calls** — the data is
already in hand.

The chain becomes: stored resource id → footer marker → **declared identifier** → create.

### 1b. The rung fires on a RESOLVING identifier, not on a guess about intent

Draft 1 said the rung should fire only when `provider_external_id !== row_key`, on the theory that
`ensureLink` (`project.ts:168`) defaults the column to `row_key`, so anything different must have been
declared by a human. **Review broke it, and the counter-example is not exotic:** a row whose `row_key`
IS a Linear identifier — which is exactly what inbound adoption creates (`inbound.ts:452-466` writes
`row_key = it.identifier` **and** `provider_external_id = it.identifier`) — is classified as "default"
and still duplicates. Worse, draft 1's third acceptance criterion **pinned that outcome as correct**, so
all nine criteria could pass with a real declared-key row still duplicating.

So the rule stops inferring intent. **The rung fires when `provider_external_id` matches the
`identifier` of an issue the bootstrap loaded** — whatever `row_key` says. A value that names a real
issue in this team is the strongest signal available, and it is a lookup rather than a comparison
against a convention.

The residual risk is a `row_key` that coincidentally equals a real identifier in the same Linear team
while meaning something else. That is bounded and acceptable: the default only ever equals `row_key`,
row keys in this workspace look like `TT39` / `PMSUCCESS-1`, and a row deliberately named `AIO-877` in a
team where `AIO-877` exists almost certainly does mean it. It is named here rather than left implicit,
and §2 pins the non-matching case so a row whose key resolves to nothing still creates as it does today.

### 1c. Adoption is a HANDOVER, and draft 1's promise about descriptions was false

Draft 1 said adoption "takes ownership of the marker, not of the prose" — writing the footer onto the
human's existing body instead of replacing it. **I falsified that myself while the review ran, and it
matters because it reads as a safeguard.** `linearIssueMatches` (`linear.ts`) ends with:

```ts
if (stripFooter(issue.description) !== desired.body.trim()) return false;
```

After an adoption that preserved the human's body, the very next projection compares that preserved body
against the brain task's body, finds them different, and takes the update branch — writing
`withFooter(task.body, …)` over it. **The protection was exactly one run deep.**

The honest design, stated rather than implied: **declaring an issue on a task row hands that issue's
content to the brain.** From the run after adoption the brain's body is authoritative, exactly as it is
for an issue the brain created. There is no way around that short of a per-link "descriptions are not
ours" flag, which is a schema change and makes the projection non-uniform — deferred in §3, not smuggled
in here.

Two things follow, and §2 pins both:

- **First contact still preserves.** The adoption write is the human's body plus the footer, not the
  brain's body. A run that adopts should not be the run that overwrites; if the declaration was a
  mistake, there is one cycle in which the prose is still there to notice.
- **The second run is pinned as a test, not left as a surprise.** A criterion asserts that the next
  projection writes the brain's body — so nobody reads §1c and believes the prose is protected.

### 1c-bis. Two rows may not declare the same issue

Nothing stops two `row_key`s from declaring the same identifier. With the rung in place both would adopt
it, `persistSuccess` would attach both links to one `provider_resource_id`, and each projection would
overwrite the other's title, body and state in a shared issue — a silent two-writer loop.

A declared identifier that is already claimed by another row's link in the same team fails the row, with
a message naming both row keys. Refusing is right here: the projector cannot know which row is meant,
and guessing produces exactly the flapping this slice exists to prevent.

### 1d. A declared key that resolves to nothing is an ERROR, not a new issue

If the identifier names no issue in the configured team — a typo, or an issue in another Linear team the
bootstrap never loaded — today's behaviour is to create a duplicate silently. That is the same fail-open
class `PMSUCCESS-1` just closed one layer down: the run reports `synced` for an outcome nobody asked for.

The row fails with a message naming the unresolved key, which `persistError` records and the run's
`errors[]` surfaces. Creating an issue is a reasonable thing to do when the row says nothing; it is not a
reasonable thing to do when the row said something and we could not honour it.

**The tradeoff, named rather than discovered.** "Unresolvable" here means *absent from the bootstrap*,
and that set is larger than typos. An identifier can be perfectly valid and still miss: an issue in
another Linear team, an archived or deleted issue, or one beyond what `team.issues` paginates
(`linear.ts:156-181`). Those rows sync fine today — by creating a local issue — and after this slice they
fail per-row instead. That is the intended direction (a row that names something we cannot find should
say so, not invent a substitute), but it is a real behaviour change for rows nobody thought were broken,
so the message has to distinguish the cases it can: an identifier that does not match this team's key
prefix is reported as *probably another team*, not as a typo. §2 pins that wording, because "not found"
alone sends someone hunting for a spelling mistake that isn't there.

## Dependencies

**Deps: none.** `lib/pm-sync/linear.ts` plus tests. No schema change — `provider_external_id` exists and
is already populated. No new API call.

## Build-with

**Build-with tier: Fable / high effort.** This changes what an outward-facing projector does with a
human's existing issue — the failure mode is overwriting someone's writing, or adopting the wrong issue,
neither of which a test suite notices unless it is written to. Two adversarial spec reviews (Fable +
Codex) before code, two on the diff.

## Tier safety

No tier surface changes: an outbound projection path. No new API route, no schema, no change to
`visibleItems`/`visibleTasks`/`visibleGroupIds`. The outward-facing behaviour changes are deliberate and
named: a declared key now adopts instead of duplicating, and an unresolvable declared key now errors
instead of creating.

## 2. Acceptance criteria

- `test/pm-sync-declared-adoption.test.ts` — a row whose link carries a `provider_external_id` matching a bootstrapped issue's `identifier` ADOPTS it: the run sends `issueUpdate` for that issue and NO `issueCreate`, driven through `upsertWorkItem` against a fake `fetch`.
- `test/pm-sync-declared-adoption.test.ts` — the same input on a build without the identifier index CREATES, so the test cannot pass on a build that still duplicates; this is asserted by mutation, not by assertion alone.
- `test/pm-sync-declared-adoption.test.ts` — a row whose `row_key` IS a Linear identifier (the shape `inbound.ts:452-466` creates, where `row_key` and `provider_external_id` are both the identifier) ADOPTS rather than creating. Draft 1's criterion pinned the opposite and would have shipped the duplicate for exactly this row.
- `test/pm-sync-declared-adoption.test.ts` — a `provider_external_id` matching NO bootstrapped identifier creates as today, so the rung cannot fire on a row that names nothing real.
- `test/pm-sync-declared-adoption.test.ts` — the adoption write PRESERVES the issue's prior body and adds only the footer: a fixture whose issue body is human prose must still contain that prose in the mutation variables.
- `test/pm-sync-declared-adoption.test.ts` — the SECOND projection after adoption writes the BRAIN's body over that prose. This pins the handover §1c describes rather than the protection draft 1 promised; a test asserting preservation on run two would be asserting a falsehood.
- `test/pm-sync-declared-adoption.test.ts` — two rows declaring the SAME identifier: the second row fails with a message naming both row keys, and does not attach a second link to that issue.
- `test/pm-sync-declared-adoption.test.ts` — a declared key that matches no issue THROWS `PmSyncError` naming the key; when the key's prefix does not match the team's, the message says so instead of implying a typo.
- `test/pm-sync-declared-adoption.test.ts` — `buildBootstrap` adds no additional GraphQL round-trip for the identifier index: the fake `fetch` records the same query count as before.
- `test/datamechanics/pm-sync-declared-adoption.datamechanics.test.ts` — after adoption the link row's `provider_resource_id` is the ADOPTED issue's id with `last_error` null; after an unresolvable declared key the row records `last_error` and no `provider_resource_id`.
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
