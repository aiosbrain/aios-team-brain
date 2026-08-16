# A row that names its issue must not get a second one — ADOPTDECL-1

**Status:** spec, draft 1 · **Date:** 2026-08-16 · **Owner:** Chetan · **Task:** `ADOPTDECL-1`
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

All four link rows now carry the **new** issue in `provider_external_id`, which is itself evidence for
the mechanism: nothing in `lib/pm-sync` writes that column (`persistSuccess` writes
`provider_external_source`, not `_external_id`; `ensureLink` defaults it to `row_key`), so the only
writer is ingest — i.e. the markdown was rewritten with the duplicate's key after the fact.

### 0c. Why the damage is worse than an extra row

A duplicate is not a cosmetic annoyance in this system. The brain now believes the row IS the new issue,
so every subsequent projection maintains the duplicate and the issue the human actually meant drifts,
unmaintained, holding the real conversation. The two diverge silently and neither side is marked.

### 0d. What this is NOT, and the correction that belongs here

`AIO-895` / `GH-542` is titled *"pm_sync can report success while creating no issue"* and its headline
evidence — run `13291` recording `created: 5` while no issues appeared — **is a misreading**, which I
checked before writing this:

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

### 1b. A DECLARED key is not the same as the default, and the difference must be structural

`ensureLink` (`project.ts:168`) defaults `provider_external_id` to `row_key`. So the column holds either
"the human said this issue" or "nobody said anything". Adopting on the second would let a row whose
`row_key` happens to look like a Linear identifier adopt a stranger's issue.

The rung therefore fires only when the value is **not** the row key. That is a comparison the code can
make locally and a test can redden, rather than a convention to remember.

### 1c. Adoption must not clobber the human's issue description

This is the part that would be easy to get wrong quietly. Adopting today's way rewrites the issue body
with `withFooter(task.body, …)`, so adopting a human-authored issue would **overwrite prose nobody asked
us to touch** — the first run would silently replace a colleague's write-up with a task row's one-liner.

**Decision: on the adoption run only, the description is written as the human's existing body plus the
footer** (the same `stripFooter`/`withFooter` shape `inbound.ts:490-497` already uses when it adopts).
The brain takes ownership of the marker, not of the prose. Subsequent runs are ordinary projections and
behave exactly as they do for an issue the brain created — the divergence, if any, surfaces then rather
than as a silent first-contact overwrite.

### 1d. A declared key that resolves to nothing is an ERROR, not a new issue

If the identifier names no issue in the configured team — a typo, or an issue in another Linear team the
bootstrap never loaded — today's behaviour is to create a duplicate silently. That is the same fail-open
class `PMSUCCESS-1` just closed one layer down: the run reports `synced` for an outcome nobody asked for.

The row fails with a message naming the unresolved key, which `persistError` records and the run's
`errors[]` surfaces. Creating an issue is a reasonable thing to do when the row says nothing; it is not a
reasonable thing to do when the row said something and we could not honour it.

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

- `test/pm-sync-declared-adoption.test.ts` — a row whose link carries a DECLARED `provider_external_id` matching a bootstrapped issue's `identifier` ADOPTS it: the run sends `issueUpdate` for that issue and sends NO `issueCreate`, asserted against a fake `fetch` driven through `upsertWorkItem`.
- `test/pm-sync-declared-adoption.test.ts` — the pre-fix behaviour is pinned as the thing that changed: with the identifier index removed the same input creates an issue, so the test cannot pass on a build that still duplicates.
- `test/pm-sync-declared-adoption.test.ts` — a link whose `provider_external_id` EQUALS its `row_key` (the `ensureLink` default) does NOT adopt, even when an issue's identifier coincidentally equals that row key; it creates, as today.
- `test/pm-sync-declared-adoption.test.ts` — the adoption run sends a description that PRESERVES the issue's prior body and adds only the footer; a fixture whose issue body is human prose must still contain that prose in the mutation variables.
- `test/pm-sync-declared-adoption.test.ts` — the SECOND projection after adoption is an ordinary update (resolved by footer or resource id), so adoption is a one-time rung and not a permanent special case.
- `test/pm-sync-declared-adoption.test.ts` — a declared key that matches no issue in the bootstrap THROWS `PmSyncError` naming the key, and does NOT create an issue.
- `test/pm-sync-declared-adoption.test.ts` — `buildBootstrap` adds no additional GraphQL round-trip for the identifier index: the fake `fetch` records the same query count as before.
- `test/datamechanics/pm-sync-declared-adoption.datamechanics.test.ts` — after adoption the link row's `provider_resource_id` is the ADOPTED issue's id and `last_error` is null; after an unresolvable declared key the row records `last_error` and no `provider_resource_id`.
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
- **The Plane adapter.** `plane.ts:171-177` already resolves by `provider_external_id` and throws when it
  misses, which is close to what this slice gives Linear. Whether the two should share a shape is a
  refactor with its own risk, and Plane is not the provider that duplicated.
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
