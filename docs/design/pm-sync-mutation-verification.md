# A PM mutation is not done until the provider says it is — PMSUCCESS-1

**Status:** spec, draft 3. Drafts 1 and 2 were each BLOCKED by two independent cold reads. Draft 1's
honesty section was overstated in the direction that mattered (§0c) and missed the latch (§0d); **draft
2's own fix for the latch then got the blast radius wrong — a refused STATUS write is reverted in the
brain (§0e) — and its replacement guard did not guard what it claimed (§1b).** · **Date:** 2026-08-16 · **Owner:** Chetan · **Task:** `PMSUCCESS-1`
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
| 3 | `linear.ts:324` `UpdateIssue` | yes | **no** — `success` is not even in the TS type | keeps the old `id` but merges the DESIRED fields into the cache (`linear.ts:328`), sets `mutated = true`, reports synced — **and latches, see §0d** |
| 4 | `linear.ts:337` `CreateIssue` | yes | **no** | `{ ...null, … }` yields an object with **no `id`/`identifier`/`url`** |
| 5 | `linear.ts:374` `CompleteIssue` | yes | **no** — result discarded | the same shape. **No production caller** — grep finds only back-compat tests, so its consequence is guarded, not sold as live; the live done-path is site 2 |
| 6 | `inbound.ts:494` `AdoptFooter` | yes | **no** — result discarded | the footer that makes an issue recognisable as brain-projected is silently not written |

Site 4 is the worst, and its damage is not confined to the report:

- `providerResourceId` is `undefined`, so `project.ts:190` writes `provider_resource_id` — and
  `runUpdate` binds `undefined` as a **parameter**, which node-postgres sends as **NULL**. The link row
  therefore records `last_synced_at = now`, `last_error = null` and a **NULL resource id**.
- `boot.issuesById.set(issue.id, issue)` poisons the in-process cache with the key `undefined`, and
  `boot.issuesByExt.set(task.row_key, brokenIssue)` (`linear.ts:343`) poisons the adoption map, for the
  rest of the run.
- `opts.resolved.set(row_key, undefined)` (`project.ts:298`) hands same-run **children** a null parent —
  and they then report synced too.

### 0b. This is a fail-open, and the repo's own rules name it

CLAUDE.md §2, principle 2 (`CLAUDE.md:134`, verbatim): *"Single writer + a build-failing guard >
discipline you have to remember."* There is no single writer here — six call sites each decide for
themselves whether to look at the answer, and five chose not to.

**And a seventh already exists outside this glob.** `lib/provisioning/linear.ts:20` issues
`organizationInviteCreate` through a **hoisted const** passed as a variable — the exact shape a guard
that scans for inline mutation documents would miss. It happens to read `success` correctly, which is
also the repo's own evidence that someone working against this API believed `success: false` reachable.
§1b's guard is designed around that call site rather than around the six.

*(One reviewer reported this quote as not present in CLAUDE.md. **Refuted** — it is verbatim at
`CLAUDE.md:134`. Recorded because a fold that "fixed" a correct attribution would have been a
regression.)*

### 0c. What this slice does NOT claim — the attribution I could not confirm

`AIO-895` reports a run recording `created: 5 · synced: 5 · ok: true` while the Linear API showed no new
issues and the team's counter never advanced past `AIO-893`. That report is careful: it labels its own
root cause *"code reading — not yet reproduced against live Linear"*. I could not confirm it either.

**Draft 1 said "the prod evidence is against it". That was overstated, and both reviewers were right to
block on it.** The footprint a `success: false` create leaves — a `task_pm_links` row with a NULL
`provider_resource_id`, a fresh `last_synced_at` and no `last_error` — **does not survive**. The
fingerprint short-circuit at `project.ts:282` requires a **truthy** `provider_resource_id`, so a NULL-id
row is *retried on the next push*, and a later success overwrites the id, the timestamp and the error.
A live query therefore says nothing about history.

What the evidence does and does not support, stated at the right strength:

| observation | strength |
|---|---|
| **zero** footprint rows live today (query below) | current state only — the footprint self-erases |
| incident rows `TT35`–`TT38` have **no link rows at all** | **load-bearing, at the narrower claim.** A row that reaches its own create/update mutation has already passed `ensureLink` (`project.ts:276`), and nothing in the repo deletes a link row (`tasks` FK is `on delete set null`) — so a row that got as far as a `success: false` create cannot end with zero link rows. The broader claim draft 2 made — "`ensureLink` runs before any provider call" — is **false**: `projectRows` calls `adapter.prepare` first, which reads through `linearGraphql` (`linear.ts:113`), and `projectTask` returns early for `no_row_key` and for a missing/failed parent before reaching `ensureLink` |

```sql
-- run against the Railway public proxy, read-only, 2026-08-16
select count(*) from task_pm_links
 where provider_resource_id is null and last_error is null and last_synced_at is not null;
-- 0, of 915 linear rows; the one NULL-id row (TT2) carries last_error 'duplicate label name'
```

So: the defect is real and verified by reading, the incident is **unexplained in both directions**, and
this slice fixes the former without claiming the latter.

### 0d. The worst consequence, which draft 1 missed entirely: a refused UPDATE latches forever

Site 3 does not merely misreport one run. After the refused update, `persistSuccess` writes the
**desired** `projection_fingerprint` alongside a **real** `provider_resource_id` (the issue exists — it
just was not changed). On every subsequent run, `project.ts:282` then finds a truthy resource id and a
matching fingerprint and returns `skipped`. **The row is never retried, and Linear stays permanently
wrong under `0 errors`.**

The fix's important property is therefore not "it throws" but **"it does not write the fingerprint"**:
throwing routes to `persistError`, which leaves the fingerprint stale, so the row is retried next push.
Nothing currently pins that, so §2 pins it.

Draft 2 said "sites 2 and 5 self-heal". **Site 2 does not** — see §0e, which is worse than this.

### 0e. And a refused STATUS write is silently REVERTED in the brain

Site 2 (`statusOnly`) returns a full result whether or not the mutation took (`linear.ts:291-299`),
carrying `syncedStatus: state.name` — the **desired** state — and a real `providerResourceId`. So
`persistSuccess` writes `last_projected_status` = the state Linear was never moved to, plus a
`projection_fingerprint` computed with `parentResourceId = null` (`project.ts:277`). For a parentless
task that equals the full-path fingerprint, so the outbound path latches exactly like site 3.

Then inbound runs. `brainUnchanged` (`inbound.ts:198-203`) is true when
`last_projected_brain_status === task.status` **and** `projection_fingerprint === currentFingerprint` —
both hold after the refusal. Linear's real state still differs from what the brain recorded projecting,
so inbound sees divergence over an "unchanged" brain row and **applies Linear's OLD state back onto the
brain task.**

**A task moved to done in the brain, whose Linear write was refused, is silently moved back.** That is
the worst outcome in this slice: not a stale report, a reverted edit. The same fix cures it — a throw
means neither `last_projected_status` nor `projection_fingerprint` is ever written — but only if the
tests pin the statusOnly path too, which §2 now does.

## 1. The decision

### 1a. One choke point, and every mutation goes through it

`linearMutation(fetchImpl, apiKey, query, variables, expect)` wraps `linearGraphql` and refuses unless
the provider says the write happened:

- the named payload key is present in `data`;
- **`payload.success === true` is REQUIRED, with no escape hatch.** Draft 1 said "absent is tolerated",
  which re-opens the exact failure being fixed. Draft 2 added a `successNotReturned: true` opt-out;
  review then showed it is **dead weight** — every one of the six sites requests `success` today
  (`linear.ts:286,324,337,374`, `inbound.ts:494`, and site 1 gains it here), and `lib/provisioning`
  already reads it. Nothing needs the hatch, and an unused escape hatch is just a hole waiting for
  someone to reach for it to make a test green. A future success-less mutation edits this function and
  brings its own test;
- the named entity is non-null **and carries an `id`**. The entity key is REQUIRED, not optional: all six
  Linear mutations return one, so an `expect` naming none would be a check that checks nothing.

Any of those failing throws `PmSyncError` naming the **mutation**; the row key is attached by the
existing per-row catch at `project.ts:301`, which records it in `task_pm_links.last_error` and the run's
`errors[]`. (Draft 1 said the choke point names the row — it cannot; it never sees the row key.)

**`success: false` becomes an error, not a silent success.** The whole point is that
`N synced · 0 errors` must mean N writes happened.

### 1b. The guard is a RUNTIME term in the transport, because both static designs were breakable

Draft 1 parsed `lib/pm-sync/*.ts` for mutation documents. **Both reviewers broke it** with a hoisted
const passed as a variable — a shape `lib/provisioning/linear.ts:20` already uses — plus relocation to a
subdirectory, string concatenation, and files outside the glob.

Draft 2 replaced it with an **import allowlist** on `linearGraphql`, modelled on
`test/guards/llm-single-caller.test.ts`. **Both reviewers broke that too, and the counter-example is
fatal:** that guard skips allowlisted files wholesale (`if (ALLOWLIST.has(rel)) continue;`), and
`lib/pm-sync/linear.ts` **must** be allowlisted — it holds five read-only queries — while also being the
file that holds all five projection mutations and the natural home of a sixth. So adding
`linearGraphql(…, "mutation Archive…")` inside it introduces **no new import**, reddens nothing, and
passes all eleven acceptance criteria. An import allowlist pins where the transport is imported; it says
nothing about what is sent through it.

**So the primary term is not static at all.** `linearGraphql` refuses any document whose operation is a
`mutation` unless it was invoked through `linearMutation`, which sets a module-private flag the transport
reads. That check sees the **post-concatenation string actually being sent**, so const-hoisting,
concatenation, re-export, namespace import, `await import()` and `require` all fail at once — none of
them can change what the document says.

The import allowlist is **kept as a second layer with a distinct property**: it bounds who may reach the
raw transport at all, which the runtime term does not. Two layers, two different properties — and each is
mutation-tested separately, because a sibling layer that catches the same outcome is how a mutation
survives while looking caught.

**The provisioning exemption, stated rather than laundered.** `lib/provisioning/linear.ts:53` issues
`organizationInviteCreate` through the raw transport and reads `success` correctly today. Routing it
through `linearMutation` means requesting `organizationInvite { id }` — a real behaviour change, which
contradicts draft 2's §3 claim that it "needs no behaviour change". This slice **migrates it**, because
an exemption in the one guard that defines "every write is checked" is the hole the guard exists to
close; the entity request is additive and the site already checks the flag it would keep checking.

### 1c. A create that yields no resource id is an error

Independently of `success`, `upsertWorkItem`'s create branch must not return a report whose
`providerResourceId` is empty. That is a second, cheaper net under 1a: it catches any future shape of
"the provider returned something we could not use", including shapes Linear has not shipped yet.

### 1d. The observability section is CUT, because it was a no-op

Draft 1 promised to "record the resource id the provider actually gave back on the success path". Both
reviewers pointed out that `project.ts:190` already does exactly that, and this spec's own Dependencies
section admitted it — so the section described the existing write as if it were a change. It is cut
rather than rewritten: after §1a and §1c, "the brain never got an id" **is** already a distinguishable
row, because it is an `errors[]` line naming the row key instead of a silent success. A real
observability slice (per-row outcomes into `ingest_runs.meta`) is named as deferred work in §3 rather
than half-promised here.

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

**Unit tier** (`vitest.config.ts`) — the refusal logic and the guards, against a fake `fetch`:

- `test/pm-sync-mutation-verification.test.ts` — each projection call site driven through its ADAPTER ENTRY POINT (`upsertWorkItem` create, `upsertWorkItem` update, `upsertWorkItem({statusOnly})`, `moveToDone`) throws `PmSyncError` on a `{ success: false, issue: null }` payload rather than returning a report.
- `test/pm-sync-mutation-verification.test.ts` — `issueLabelCreate` (`linear.ts:195`) has its own refusal test driven through `upsertWorkItem` with a label-bearing task, so the one site that does not currently request `success` is not the site nobody covers.
- `test/pm-sync-mutation-verification.test.ts` — a `success: true` payload whose entity is null, and one whose entity lacks an `id`, BOTH throw; and a payload omitting `success` throws — there is no opt-out to assert around.
- `test/pm-sync-mutation-verification.test.ts` — the create path never returns a report with an empty `providerResourceId`, and neither `boot.issuesById`, `boot.issuesByExt` nor `opts.resolved` is written on the refusal path.
- `test/pm-sync-mutation-verification.test.ts` — `adoptInbound`'s footer write is covered AT THE CHOKE POINT, because `inbound.ts:498-501` converts any throw into a `skipped` note by design; that catch is left alone and the reason is written at the site.
- `test/guards/pm-sync-linear-transport.test.ts` — a `mutation` document sent through `linearGraphql` outside `linearMutation` is REFUSED AT RUNTIME; the test constructs the document by concatenation so the guard cannot be satisfied by a source-text parser.
- `test/guards/pm-sync-linear-transport.test.ts` — the import allowlist is a SECOND layer with its own property (who may reach the raw transport); it is asserted non-empty and every allowlisted path must resolve, so a rename cannot silently empty it. The two layers are mutation-tested SEPARATELY, and each mutation must redden its own layer's test rather than being caught by the sibling.
- `test/guards/pm-sync-linear-transport.test.ts` — the mutation-test that matters: adding a new mutation INSIDE an already-allowlisted file (`lib/pm-sync/linear.ts`) reddens the runtime guard. Draft 2's import allowlist passed this case, which is why it was replaced.
- `lib/pm-sync/linear.ts` — `issueLabelCreate` requests `success` and its entity, so no site depends on tolerated absence.
- `lib/provisioning/linear.ts` — `organizationInviteCreate` is migrated to `linearMutation` (requesting `organizationInvite { id }`), so the guard has no exemption to launder.

**Data-mechanics tier** (`vitest.datamechanics.config.ts`, real Postgres) — the STORED-STATE outcomes, which a unit-tier payload assertion can green while the real short-circuit still skips:

- `test/datamechanics/pm-sync-refusal.datamechanics.test.ts` — a refused UPDATE writes `last_error` and leaves `projection_fingerprint` UNCHANGED, and a SECOND projection run then retries the row instead of returning `skipped` — the two-run property that proves §0d's latch is broken.
- `test/datamechanics/pm-sync-refusal.datamechanics.test.ts` — a refused `statusOnly` write leaves BOTH `projection_fingerprint` and `last_projected_status` unwritten, and a subsequent inbound apply does NOT revert the brain task's status — §0e's reversion, pinned end to end.

## 3. Scope

**In:** the choke point, the six call sites, the runtime mutation term plus the import allowlist, the
create-without-id refusal, and the `lib/provisioning/linear.ts` migration. (Draft 2 still listed "the
success-path resource id record" here after §1d was cut — a deliverable that does not exist, which a
builder would have hunted for.)

**Deferred, each with its reason:**

- **Closing `AIO-895` / `GH-542`.** Not proven caused by this, and §0c's prod evidence is against it.
  §0c is explicit that the incident is **unexplained in both directions** — draft 2's bullet still
  carried the retracted "the prod evidence is against it", the stronger phrase §0c itself withdrew, in
  the very section that decides whether AIO-895 closes. What the evidence supports is narrower: the
  no-link-rows observation argues against THIS mechanism for THAT incident. Those tickets stay open with
  this slice's findings attached; closing them on a fix that does not explain their evidence is exactly
  how a board stops meaning anything.
- **The duplicate-issue symptom in the same report** (`TT39`–`TT42` creating `AIO-878`–`AIO-881`
  instead of adopting existing issues). That is the adoption/footer-matching path, a different mechanism
  in the same file, and it deserves its own measurement rather than being folded in on a hunch.
- **The Plane adapter.** `plane.ts` has its own client and its own error shape; the same audit should run
  there, but generalising a choke point across two providers before either is proven is how the wrong
  abstraction ships.
- **Per-row provider outcomes in `ingest_runs.meta`.** The real observability slice §1d gestured at.
  It needs a decision about run-record size and a consumer that reads it; guessing at both while fixing
  a fail-open is how the wrong abstraction ships.
- **`lib/provisioning/linear.ts`.** Its `organizationInviteCreate` already reads `success` correctly, so
  it is inside the guard's allowlist reasoning but needs no behaviour change. Named because it is the
  seventh mutation and the reason the guard is an import allowlist rather than a document parser.
- **A retry on a refused mutation.** Turning a silent success into a loud error is the fix; deciding
  whether to retry it is a policy question with a rate-limit dimension.
- **The ~2,000-character `tasks.md` description cap** discovered while filing this ticket, which fails
  with `local Brain API 1.12 payload validation failed` and names neither the field nor the limit. Real,
  unrelated, and worth its own row.

## 4. What would falsify this

Wrong — in the direction that costs the most — if `success: false` on a well-formed 200 is **not
reachable** at all, and every real Linear failure arrives as `errors[]` (which `linearGraphql` already
catches). The repo's only fixtures are `success: true`, and both observed Linear failures in its history
arrived as thrown errors, so this is unproven. If it is unreachable, the slice's value rests entirely on
§1c and the entity-null check — which catch *any* "200 with no usable entity", including whatever shape
sits behind AIO-895. That is still worth shipping, but the claim must be "verified fail-open **if** Linear
returns this documented payload shape", not "verified live behaviour".

Wrong, in the other direction, if a Linear mutation that legitimately returns `success: false` exists as a
NORMAL outcome — then this converts a working path into a hard error. A counter-example would be a Linear
mutation documented to return `success: false` for a condition the projector should treat as benign.

*(Draft 2 left the DRAFT-1 mitigation standing here — "`success` absent is tolerated and only an explicit
`false` refuses" — while §1a had already been folded to require it. Two incompatible specs in one
document, created by my own fold and caught in review. The mitigation is now what §1a actually says: an
absent `success` throws unless the call site writes `successNotReturned: true`.)*

Wrong in the other direction if the guard can be satisfied without the check running — a call site that
routes through `linearMutation` but passes an `expect` naming a payload key that is always present. The
guard therefore asserts the routing, and the per-site tests assert the refusal, because neither alone is
sufficient.
