# One canonical reachability predicate — AUDITFIX-15A

**Status:** spec, **split out of AUDITFIX-15 after two BLOCKED rounds** (§6, §7). Round 2's verdict was
*"Split it: ship and verify the canonical predicate fix first, because the folded scheduler/UI slice
still permits both false alarms and permanently silent failures."* Accepted. This document is **Phase
A only**. No code written.

**Build with:** opus / high — it is the definition of "can anybody read this", on the access path.

**Deps:** none. **This does NOT unlock TIERRET-1** — `lib/projects/context/reconcile-item.ts:87-98`
names AUDITFIX-13 as that prerequisite, in the code itself.

---

## What and why

**What:** one canonical predicate, matching the access oracle exactly, for the question *"can any
eligible principal read this item at all?"* — owned by a single exported function that every reader
calls.

**Why:** the shipped predicate is wrong in the silent direction. It reports content as reachable when
nobody can read it, and the health check built on it therefore reports a clean bill of health over a
corpus that has gone dark. Under PRET-6 membership-only enforcement an unreachable item is invisible
to everyone including admins, so the detector being wrong means the one thing that would notice does
not.

## 0. The defect, in shipped code

`findUnpartitionedItems` decides an item is reachable when its project has **any** `project_groups`
grant (`lib/projects/context/coverage.ts:96-105`). The oracle requires more: an **eligible principal**
must hold a `group_members` row in a granted group (`lib/access/oracle.ts:74-104`), with eligibility
defined at `lib/access/eligibility.ts:28-40`.

**So a project granted only to a group nobody is in reads as covered while nobody can read it** — and
`assessAccessHealth` turns that under-report into a clean bill of health
(`lib/admin/access-health.ts:163-176`).

**Measured on production, 2026-08-22 (read-only, team `aios`):** the shape exists. `external-shared`
is granted to `external`, which has **0 eligible members**; it is harmless only because `everyone`
also holds a grant. Both the shipped predicate and the corrected one return **0 unreachable items**
today, so **this fix changes nothing on this fleet right now** — it changes what happens the first
time a group is emptied or a project is granted only to an agent-bearing custom group. Stated plainly
rather than dressed up as a live fire.

## 1. The rule, as a truth table rather than a paraphrase

⚠️ **Round 2's BLOCKER 1: my first attempt wrote this as prose — "an eligible active principal" — and
prose is how a proxy predicate gets written twice.** The oracle's rule has an asymmetry I had
flattened. Spelled out, every clause traced:

An item is **reachable** iff there EXISTS a chain:

| link | condition | source |
|---|---|---|
| unit | `unit_kind='item'` **and** `state='active'` | `lib/access/enforce.ts:54-67` |
| membership | `decision='include'` **and** `valid_to is null` | `lib/access/enforce.ts:76-87` |
| grant | a `project_groups` row for that project + group | `lib/access/oracle.ts:98-104` |
| group_members | a row joining that group to a member | `lib/access/oracle.ts:74-79` |
| **the member, if the group is CUSTOM** (`is_builtin = false`) | `status='active'` **and** `not is_connector` **and** `kind in ('human','agent')` | `lib/access/eligibility.ts:28-30` (`isPrincipal`) |
| **the member, if the group is BUILT-IN** | all of the above **and `kind = 'human'`** **and `slug in ('everyone','external')`** | `lib/access/eligibility.ts:38-40` (`isBuiltinEligible`) + `oracle.ts:84-95` |

**What is INERT** (must not make an item read as reachable): a connector; an `offroster` member; a
`disabled`/non-active member; **an agent holding a BUILT-IN membership** (agents are never
auto-admitted — planting the row grants nothing); a built-in group with an **unknown slug**
(fail-closed); a `group_members` row whose group does not resolve.

**What is NOT a serving conjunct** — asserted so nobody adds them back "for safety": `members.tier`
(the oracle never re-evaluates it; an explicit built-in row is authoritative), `projects.kind`
(`oracle.ts:98-104` does not consult it), and membership `mode`.

**Prod cross-check of the asymmetry:** `group_members` holds **10** rows for the built-in `everyone`,
all `kind='human'`, of which only **5** are eligible principals — the rest are connectors and one
disabled human, which the corrected predicate correctly treats as inert.

## 2. The design: one exported query function, two readers

⚠️ **Round 2's MEDIUM 1 killed my first mechanism.** I had proposed asserting "the predicate string has
exactly one definition site". That is a text count, not a semantic mechanism — one template can
delegate to duplicated fragments, and both readers can share one *wrong* constant.

Instead, `lib/projects/context/coverage.ts` exports **one query function** that both readers call:

```ts
/** The ONE definition of "some eligible principal can read this item". */
export async function unreachableItemIds(db, teamId, opts?): Promise<{ ids; examples; error? }>
```

- `findUnpartitionedItems` is **rebuilt on it** — its existing `CoverageResult` shape
  (`scanned`/`count`/`examples`/`truncated`) is preserved so `scripts/admin.ts:427` and
  `assessAccessHealth` are untouched at their call sites.
- `runSql`, because this is a five-way `NOT EXISTS`; the query builder cannot express it, which is
  the justification `lib/projects/context/backfill-candidates.ts` already carries. The module stays
  read-only, which is why it can name the substrate tables at all without tripping the
  single-writer guard's table-name net.
- **A guard pins that both readers import and call that one function** — an import/call-site check,
  not a string count.

**`truncated` keeps its meaning.** The batch guard becomes a `LIMIT` on the id query; hitting it still
reports a floor, because "the count is a floor" is the only honest thing to say and a caller deciding
what a team can see needs to know it.

## 3. Scope

**In:** `lib/projects/context/coverage.ts` (the canonical function + `findUnpartitionedItems` rebuilt
on it) · a truth-table dm test · a guard pinning the single owner · `docs/ARCHITECTURE.md`.

**Out — Phase B and C, each with the round-2 finding that sent it there:**

| deferred | why it is not here |
|---|---|
| **scheduling the check** (AUDITFIX-15B) | the settle-window semantics are unresolved: `created_at` is stamped at `lib/ingest/index.ts:129` and written at `:446`, so a slow ingest commits a brand-new row that already reads as old (round 2 B2). And `2 × poll interval` is not a demonstrated bound against measured 293-minute context-stage gaps |
| **fail-loud recording** (AUDITFIX-15B) | `recordIngestRun` swallows insert failures (`lib/ingest/runs.ts:55-81`) and `getPipelineHealth` returns healthy on its own read failure (`pipeline-health.ts:466-468`). ⚠️ **My round-1 fold made this WORSE**: `null` staleness means "never flag on age" (`pipeline-health.ts:23-27`), so a swallowed failure-row write would leave the last green row newest **forever** |
| **leg registration** (AUDITFIX-15B) | the mechanism is `lib/ingest/leg-ledger.ts` + its two guards, **not** `drift:sources`, which derives from the Python connector `_REGISTRY` (`scripts/check-docs-drift.mjs:60-67`) |
| **banner copy** (AUDITFIX-15C) | one aggregate headline and one caller-supplied link serve the whole failing set (`components/admin/pipeline-health-banner.tsx:83-110`); mixed access+ingestion failures need a defined rendering, and the old wording is embedded in regression-test prose |

**Also renamed, because the name was a claim:** what this predicate detects is **universal
unreachability** — "no eligible principal at all can read this item" — **not** access-health.
Round 2's HIGH 1: strip General's `everyone` grant but leave a custom group holding one agent, and
every human goes blind while the count stays 0. The per-human floor lives in `assessAccessHealth`'s
other arms and stays in the CLI. Naming it otherwise would be the overstatement this program keeps
correcting.

## 4. Acceptance

The criteria are the truth table, because round 2 showed a generic `status='active' and not
is_connector` join passes a prose criterion while admitting a planted agent built-in row.

- **AC1 — an empty granted group means UNREACHABLE (dm):** a project granted solely to a group with
  no members; its item is counted. *The case the shipped predicate gets wrong.*
- **AC2 — the built-in asymmetry, both directions (dm):** an **agent** in a **custom** granted group
  ⇒ reachable. The same agent in a granted **built-in** group (`everyone`) ⇒ **unreachable**. Two
  rows, one bit apart, so a predicate that ignores `is_builtin` fails one of them.
- **AC3 — an unknown built-in slug is inert (dm):** a group with `is_builtin=true` and a slug that is
  neither `everyone` nor `external`, holding an eligible human ⇒ **unreachable**. Fail-closed.
- **AC4 — inert member states (dm):** a granted group holding only a connector, only an `offroster`
  row, or only a `disabled` human ⇒ **unreachable**, one criterion per state.
- **AC5 — the serving conjuncts (dm):** a `retracted` unit, an `exclude` membership, and a closed
  (`valid_to` set) membership each ⇒ **unreachable**.
- **AC6 — the NON-conjuncts (dm):** an item reachable through a custom group is still reachable when
  the member's `tier` is `external`, when the project's `kind` is `source`, and when the membership
  `mode` is `force_include`. *Pins that nobody re-adds a filter "for safety" and silently narrows
  what counts as reachable.*
- **AC7 — the healthy control (dm):** the ordinary shape (item → active unit → current include →
  `general` → `everyone` → an active human) is **reachable**, and the corrected predicate returns
  **zero** unreachable for a normally-bootstrapped team. Without this, a predicate that flagged
  everything would satisfy AC1-AC6.
- **AC8 — one owner, by call site (unit guard):** `findUnpartitionedItems` reaches the substrate only
  through the exported canonical function — asserted on the import and call graph. Deleting the
  delegation and re-inlining a second query **fails**.
- **AC9 — the CLI contract holds, and the FLOOR is tested at its boundary (dm + unit):**
  `findUnpartitionedItems` still returns `scanned`/`count`/`examples`/`truncated`, and a non-zero
  count is still a blocker. ⚠️ Two corrections a review forced. (1) I wrote "the blocker text is
  unchanged"; this branch **deliberately changes it**, because the old text named a cause that is
  false for the case the fix exists to surface — what must not change is that a non-zero count
  BLOCKS. (2) Asserting `truncated === false` on a small fixture pins nothing: a mutation forcing
  `truncated = false` passes it. The bounded shaping is now a pure function (`shapeCoverage`) tested
  at **exactly `max` (exact) vs `max + 1` (floor)**, which is unreachable in the dm tier without
  planting 5,001 rows.
- **AC10 — a read failure is not zero (dm):** with the query faulted, the caller sees an error rather
  than a clean bill of health. `countUnrepairable`'s rule: "could not read" must never be spelled the
  same as "there are none".

**What no criterion claims:** that any of this runs unattended. It does not — that is Phase B, and
saying otherwise is the failure this document's own §3 table exists to record.

## 5. Risks

| risk | direction | mitigation |
|---|---|---|
| The corrected predicate reports items the old one called fine | a CLI run goes red where it was green | intended, and it is the point; measured **0 → 0** on prod today, so no fleet is surprised on day one |
| A five-way `NOT EXISTS` scans the corpus | slow CLI command | **MEASURED, not deferred — `EXPLAIN (analyze)` on prod, 2026-08-22, 2,903 items: 56 ms.** Plan is a Merge Anti Join. ⚠️ **The inner side is `memberships x eligible principals`**, not just corpus: 2,903 memberships against 5 eligible members already materialises **14,515 rows**, and it is sorted. So this scales with HEADCOUNT as well as corpus. At the CLI's on-demand cadence that is fine at any plausible size; **Phase B must re-measure before putting it on a tick**, which is what §3 defers |
| The truth table drifts from the oracle | the detector disagrees with enforcement again | every row cites the oracle line it encodes, and the whole table is one dm matrix |

---

## 6. Round 1 (of AUDITFIX-15) — BLOCKED: the detector itself was wrong

4 BLOCKER, 6 HIGH, 2 MEDIUM against a spec that proposed *scheduling* this function. Its headline
became this document's §0: the predicate accepts any grant while the oracle requires a principal.
Verified on prod. Also killed a "steady state is 0" sequencing argument — my own just-shipped writer
inventory disproved it — and three claims of mine: that truncation/deferral were already alarmed
(nothing reports them), that `drift:sources` was the registration mechanism (it is the Python
connector registry), and that this unlocks TIERRET-1 (AUDITFIX-13 does).

## 7. Round 2 — BLOCKED, "split it", and the fold had made silence worse

| # | finding | outcome |
|---|---|---|
| **B1** | "oracle-exact" was prose, and AC2 could pass with a generic principal join while admitting a planted agent built-in row | **CONFIRMED.** §1 is a truth table with every clause traced; AC2/AC3 are the two-rows-one-bit-apart cases. *I had derived the built-in asymmetry independently before this round landed, which is why it is in §1 rather than only in this table* |
| **B2** | `created_at` is stamped at `index.ts:129` and written at `:446`, so a slow ingest commits a row that already reads as settled; and `2 × poll interval` is not a bound against measured 293-minute gaps | **CONFIRMED**, and it **removes the settle window from this slice** — Phase B. It also **refuted** my own worry that a writer could backdate `created_at`: no caller can supply it through `ItemPayload` |
| **B3** | `null` staleness means "never flag on age", so a swallowed failure-row write leaves the last green row newest **forever** | **CONFIRMED, and this is the fold re-creating the bug it was fixing.** I chose `null` in round 1 *to avoid a fitted threshold* and thereby made the silence permanent. Phase B, with the adjacent sibling's finite threshold and an observable `recordIngestRun` |
| **B4** | `AllTeamsResult` does carry `deferred`, but a team created after the enumeration read is in neither list, and an enumeration failure returns zero teams; AC9 permitted skipping both | **CONFIRMED.** Phase B, renamed to SNAPSHOT-TOTAL with a global failure arm |
| **H1** | "reachable by SOME principal" masks "readable by no HUMAN" — one agent in a custom group keeps the count at 0 while every human is blind | **CONFIRMED.** The predicate is renamed to **universal unreachability** and §3 says what it does not detect |
| **H2/H3** | the banner is one headline + one link for the whole failing set, with mixed failures undefined; AC12 permitted an unindexed corpus-scale anti-join | **CONFIRMED**, both deferred with the index/`EXPLAIN` requirement attached to Phase B |
| **H4** | the prod figures are not reproducible from repository files | **CONFIRMED**, labelled as operational evidence with its date, not as code-derived fact |
| **H5** | the slice is too large; the predicate repair is independently valuable | **CONFIRMED. This document is the split.** |
| **M1** | "exactly one definition site" is a text count, satisfiable vacuously | **CONFIRMED.** One exported function, pinned by import/call site (§2, AC8) |
| **M2** | `drift:sources` is right to exclude, but the real mechanism is `lib/ingest/leg-ledger.ts` | **CONFIRMED**, recorded in §3 |

**Nothing is built. No code exists for this slice.**
