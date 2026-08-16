# A PM mutation is not done until the provider says it is — PMSUCCESS-1

**Status:** spec, draft 1 · **Date:** 2026-08-16 · **Owner:** Chetan · **Task:** `PMSUCCESS-1`
**Reported as:** `AIO-895` / `GH-542` (see §0c — this slice does **not** claim to have found that
incident's cause).
**Code:** `lib/pm-sync/linear-client.ts`, `lib/pm-sync/linear.ts`, `lib/pm-sync/inbound.ts`,
`lib/pm-sync/project.ts`.

---

## 0. What is wrong

`aios push` prints `pm projection: ok · N synced · 0 errors`. That line is the only signal anyone reads
after a push — this repo's own close gate tells you to read it back — and **the Linear adapter can print
it having changed nothing in Linear.**

`linearGraphql` (`lib/pm-sync/linear-client.ts:18-33`) treats a response as valid unless the HTTP call
failed, `errors[]` is populated, or `data` is missing. Linear's mutations return their own
`success: Boolean!` **inside `data`**, so a well-formed `200` carrying
`data.issueCreate = { success: false, issue: null }` passes all three checks and is returned as good data.

### 0a. Six mutation call sites, five of them requesting a field nobody reads

| # | site | asks for `success`? | reads it? | what a `success: false` does |
|---|---|---|---|---|
| 1 | `linear.ts:195` `issueLabelCreate` | **no** | – | `data.issueLabelCreate.issueLabel.id` **throws** on a null payload — loud, and the only loud one |
| 2 | `linear.ts:286` `SetIssueState` | yes | **no** — whole result discarded | reports `status: "synced"`; the issue keeps its old state |
| 3 | `linear.ts:324` `UpdateIssue` | yes | **no** — `success` is not even in the TS type | `{ ...issue, ...null }` leaves the OLD fields, sets `mutated = true`, reports synced |
| 4 | `linear.ts:337` `CreateIssue` | yes | **no** | `{ ...null, … }` yields an object with **no `id`/`identifier`/`url`** |
| 5 | `linear.ts:374` `CompleteIssue` | yes | **no** — result discarded | a task moved to **done** in the brain reports synced while the Linear issue stays open |
| 6 | `inbound.ts:494` `AdoptFooter` | yes | **no** — result discarded | the footer that makes an issue recognisable as brain-projected is silently not written |

Site 4 is the worst, and its damage is not confined to the report:

- `providerResourceId` is `undefined`, so `project.ts:190` writes `provider_resource_id` — and
  `runUpdate` binds `undefined` as a **parameter**, which node-postgres sends as **NULL**. The link row
  therefore records `last_synced_at = now`, `last_error = null` and a **NULL resource id**.
- `boot.issuesById.set(issue.id, issue)` poisons the in-process cache with the key `undefined` for the
  rest of the run.

### 0b. This is a fail-open, and the repo's own rules name it

CLAUDE.md §2: *"single writer + a build-failing guard > discipline you have to remember."* There is no
single writer here — six call sites each decide for themselves whether to look at the answer, and five
chose not to. A seventh mutation added tomorrow inherits the same default.

### 0c. What this slice does NOT claim — the attribution I could not confirm

`AIO-895` reports a run recording `created: 5 · synced: 5 · ok: true` while the Linear API showed no new
issues and the team's counter never advanced past `AIO-893`. That report is careful: it labels its own
root cause *"code reading — not yet reproduced against live Linear"*. **I could not confirm it either,
and the prod evidence is against it:**

- A `success: false` create leaves a `task_pm_links` row with a **NULL `provider_resource_id`, a fresh
  `last_synced_at`, and no `last_error`.** Prod has **zero** such rows out of 915. The single row with a
  NULL resource id (`TT2`) carries `last_error: "Linear GraphQL failed: duplicate label name"` — an
  error path that worked.
- The incident rows `TT35`–`TT38` have **no link rows at all**, which this mechanism does not produce.

So the defect is real and verified by reading; the *incident* is unexplained. This slice therefore has
two jobs, and only the first is a fix: **close the fail-open**, and **make the next occurrence
diagnosable**, because today the run record cannot distinguish "provider refused" from "provider was
never asked".

## 1. The decision

### 1a. One choke point, and every mutation goes through it

`linearMutation(fetchImpl, apiKey, query, variables, expect)` wraps `linearGraphql` and refuses unless
the provider says the write happened:

- the named payload key is present in `data`;
- `payload.success` is not `false` (absent is tolerated — not every Linear mutation returns it, and
  inventing a requirement the API does not make would fail closed on working calls);
- when the caller names an entity key, that entity is non-null **and carries an `id`**.

Any of those failing throws `PmSyncError` naming the mutation and the offending row, which the existing
per-row error path already records in `task_pm_links.last_error` and the run's `errors[]`.

**`success: false` becomes an error, not a silent success.** The whole point is that
`N synced · 0 errors` must mean N writes happened.

### 1b. A build-failing guard, because the default must not be "forget"

A unit guard parses `lib/pm-sync/*.ts` for GraphQL mutation documents and asserts each one is issued
through `linearMutation`, never `linearGraphql` directly. A new mutation added the old way fails the
build rather than joining the five that already did.

The guard pins the **call**, not the spelling: it is mutation-tested by re-adding a bypassing call site
and confirming the guard — not some other test — reddens.

### 1c. A create that yields no resource id is an error

Independently of `success`, `upsertWorkItem`'s create branch must not return a report whose
`providerResourceId` is empty. That is a second, cheaper net under 1a: it catches any future shape of
"the provider returned something we could not use", including shapes Linear has not shipped yet.

### 1d. Observability: the run record must be able to answer the question it could not

`AIO-895` was undiagnosable because a clean run record is indistinguishable from a real one. The
projection already records per-row errors; what is missing is that a *successful* row carries no evidence
of what the provider returned. This slice records the resource id the provider actually gave back on the
success path, so "the brain thinks it created AIO-894" and "the brain never got an id" are different rows
rather than the same clean report.

## Dependencies

**Deps: none.** `lib/pm-sync/` only. No schema change: `task_pm_links.provider_resource_id` already
exists and already receives this value; this slice stops it from receiving `undefined`.

## Build-with

**Build-with tier: Fable / high effort.** This is a fail-open in the path that reports whether outward
-facing work landed, and the reported root cause is unconfirmed — the risk is shipping a fix that
"closes" an incident it did not cause and declaring the matter settled. Two adversarial spec reviews
(Fable + Codex) before code, two on the diff.

## Tier safety

No tier surface changes: `lib/pm-sync/` is an outbound projection path. No new API route, no schema, no
change to `visibleItems`/`visibleTasks`/`visibleGroupIds`. The one outward-facing behaviour change is
that a previously-silent provider refusal now surfaces as a per-row error.

## 2. Acceptance criteria

- `test/pm-sync-mutation-verification.test.ts` — a `data.issueCreate = { success: false, issue: null }` response makes the create path THROW `PmSyncError` rather than return a report, asserted against a fake `fetch`.
- `test/pm-sync-mutation-verification.test.ts` — the same response shape for `issueUpdate`, `SetIssueState`, `CompleteIssue` and `AdoptFooter` each throw, so no mutation is left on the old default.
- `test/pm-sync-mutation-verification.test.ts` — a `success: true` payload whose `issue` is null, and one whose `issue` lacks an `id`, BOTH throw — the entity check is not satisfied by the success flag alone.
- `test/pm-sync-mutation-verification.test.ts` — a mutation whose payload omits `success` entirely still SUCCEEDS, so the choke point does not fail closed on providers that do not return the field.
- `test/pm-sync-mutation-verification.test.ts` — the create path never returns a report with an empty `providerResourceId`; a payload that would produce one throws instead.
- `test/pm-sync-mutation-verification.test.ts` — `boot.issuesById` is never written with an `undefined` key on the refusal path.
- `test/guards/pm-sync-mutation-choke-point.test.ts` — every GraphQL mutation document in `lib/pm-sync/*.ts` is issued through `linearMutation`; a call site added through `linearGraphql` fails the build, and the guard is mutation-verified to redden on exactly that.
- `lib/pm-sync/linear.ts` — `issueLabelCreate` requests `success` like the other five, so the guard's population is the whole set rather than five of six.
- `docs/design/pm-sync-mutation-verification.md` — §0c's unconfirmed attribution is stated in the PR body too, so the merge does not read as "AIO-895 fixed".

## 3. Scope

**In:** the choke point, the six call sites, the guard, the create-without-id refusal, the success-path
resource id record.

**Deferred, each with its reason:**

- **Closing `AIO-895` / `GH-542`.** Not proven caused by this, and §0c's prod evidence is against it.
  Those tickets stay open with this slice's findings attached; closing them on a fix that does not
  explain their evidence is exactly how a board stops meaning anything.
- **The duplicate-issue symptom in the same report** (`TT39`–`TT42` creating `AIO-878`–`AIO-881`
  instead of adopting existing issues). That is the adoption/footer-matching path, a different mechanism
  in the same file, and it deserves its own measurement rather than being folded in on a hunch.
- **The Plane adapter.** `plane.ts` has its own client and its own error shape; the same audit should run
  there, but generalising a choke point across two providers before either is proven is how the wrong
  abstraction ships.
- **A retry on a refused mutation.** Turning a silent success into a loud error is the fix; deciding
  whether to retry it is a policy question with a rate-limit dimension.
- **The ~2,000-character `tasks.md` description cap** discovered while filing this ticket, which fails
  with `local Brain API 1.12 payload validation failed` and names neither the field nor the limit. Real,
  unrelated, and worth its own row.

## 4. What would falsify this

Wrong if a Linear mutation that legitimately returns `success: false` exists as a NORMAL outcome — then
this converts a working path into a hard error. The mitigation is that `success` absent is tolerated and
only an explicit `false` refuses; a counter-example would be a Linear mutation documented to return
`success: false` for a condition the projector should treat as benign.

Wrong in the other direction if the guard can be satisfied without the check running — a call site that
routes through `linearMutation` but passes an `expect` naming a payload key that is always present. The
guard therefore asserts the routing, and the per-site tests assert the refusal, because neither alone is
sufficient.
