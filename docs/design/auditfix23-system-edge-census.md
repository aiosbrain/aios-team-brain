# A forbidden system-project grant is FOUND without an operator asking — AUDITFIX-23

**Status:** spec, round 0. No code written. Split out of AUDITFIX-22 at its round 2; this is the
CENSUS + operator-surface half.

**Build with:** opus / high — it changes what an operator's health verdict means, and a detector that
reports green while broken is worse than none.

**Deps:** **AUDITFIX-22 (merged 909fa8d7)** — a census reported through a masked leg is invisible, which
is why the ledger shipped first. **AUDITFIX-3 (merged 3757aa4c)** — this consumes its
`isSanctionedSystemEdge` predicate. Repair is AUDITFIX-21 and is NOT required first (§3).

---

## What and why

**What:** every scheduler tick censuses each team's `kind='system'` projects for edges the writer
would refuse, reports them as that team's failure, and `assessAccessHealth` gains the same assertion
for the operator-asks path.

**Why:** AUDITFIX-3 closed the door on NEW forbidden edges. Nothing looks for one that already exists —
and `revokeProjectFromGroup` still refuses every `kind='system'` revocation, so such an edge is
invisible AND unrepairable. This slice makes it visible. It stays unrepairable until AUDITFIX-21 (§6).

## 0. Terrain, measured before designing

### 0a. Production, read-only, 2026-08-23 UTC

| | |
|---|---|
| `kind='system'` projects | **2** — `general`, `external-shared`. **Zero** non-reserved ones |
| edges on them | **3**, all sanctioned |
| forbidden edges | **0 — the defect is LATENT**, exactly as at AUDITFIX-3 |
| teams | **1** |

So this slice changes nothing on this fleet. Its value is a self-hosted instance whose state nobody
has audited, and this fleet's own future.

### 0b. ⚠️ The channel this slice depends on is deployed but NOT yet exercised

AUDITFIX-22 merged and deployed at **18:37 UTC**; the newest `access_bootstrap` row is **18:05 UTC**,
i.e. the last tick of the OLD code. No tick has yet run under the per-team ledger, so *"a per-team
failure is loud on that team's card"* is **proven in the dm tier and not yet observed in production.**

That is stated rather than assumed because this slice's SCHEDULED output flows through that channel.

⚠️ **It is a RELEASE GATE, not a recheck suggestion (round 1 HIGH 3), because ledger inserts are
deliberately swallowed (`lib/ingest/runs.ts:55-61`) — a ledger that silently did not take effect looks
exactly like one that did.** Before this merges, all three must hold on prod, read-only:

1. an `access_bootstrap` row with the **real team id**, `trigger='scheduler'`, and `finished_at`
   **after** the AUDITFIX-22 deploy;
2. **no** new ordinary instance-wide success row after that deploy;
3. `getPipelineHealth` for that team selecting **that same scoped row** as its leg;
4. **two successive scheduled scoped rows at the expected cadence, with no duplicate scoped row in
   either tick window** — round 2's HIGH 2: checks 1-3 are all satisfied by one lucky post-deploy tick
   followed by a dead scheduler, and none of them pins the one-row-per-tick property that stops a
   single failure reaching the confirmation threshold.

✅ **ALL FOUR VERIFIED on prod, read-only, 2026-08-24** (evidence:
`.context/rederive/auditfix22-release-gate-verified.md`). 40 team-scoped `trigger='scheduler'` rows
starting ten minutes after the deploy, against **zero** in the seven days before it; **no** new
instance-wide success row; `newest` selecting the scoped row, 3 minutes old; and 39 successive gaps at
min 24.3 / avg 29.9 / max 35.6 minutes with **zero** sub-minute gaps.

A successful row cannot prove the FAILURE branch live, so the two-tick card behaviour stays dm
evidence — stated, not glossed.

⚠️ *Also corrected: I wrote that the slice's "value is zero" if the ledger did not take effect. Too
broad. The **unattended** census would be worthless, but `assessAccessHealth` (§2c) is an independent
path an operator asks directly, and it keeps its value regardless.*

### 0c. What the writer already refuses, which the census must MATCH

`isProtectedProject` is `kind === 'system' || (kind === 'source' && reserved slug)` and
`isSanctionedSystemEdge` keys on the **project slug** (`lib/access/system-projects.ts`). Read together
for a `kind='system'` project with a **non-reserved** slug — say `legacy-system` — **no edge is ever
sanctioned**, so the writer refuses every grant to it. That is shipped behaviour today.

**The census must therefore report every edge on such a project**, or detection is narrower than the
prevention it exists to observe. §2b says why that is the right reading rather than a bug to work
around.

### 0d. What is NOT measured

Nothing here observes a fleet with more than one team, or a non-reserved `kind='system'` project,
because prod has neither. Both are proven in the dm tier with seeded fixtures only.

## 1. The rule

> **Every tick, for every team, every edge on every `kind='system'` project that the writer would
> refuse is reported as that team's failure — and neither the census nor the health check may report
> healthy from a read it could not complete.**

## 2. The design

### 2a. The census runs in the all-teams wrapper, after each team's convergence ATTEMPT

`ensureAccessBootstrapAllTeams` (`lib/access/bootstrap.ts`) gains a per-team census after the
convergence attempt, and its result is folded into that team's `TeamBootstrapOutcome` — so
AUDITFIX-22's ledger records it as that team's `ok:false` row with no further plumbing.

⚠️ **It runs REGARDLESS of the convergence result, including the THROW path.** `ensureAccessBootstrap`
has six early returns, so a census at the END of it never runs on a wedged team: General wedged by a
reserved-slug initiative means every tick returns at the General leg, and a forbidden edge on an
already-system `external-shared` is **never named, on any tick, forever**. And a `catch … continue`
that skips the census on a throw satisfies a criterion written only against a returned failure, so the
criteria must force a throw too.

**A post-attempt census is safe on the converge-first rule** AUDITFIX-3's round 2 established —
convergence is *awaited to completion* first, so a missing sanctioned edge is restored before the
census reads.

⚠️ *Corrected (round 1 B2): my first draft said the census is safe "because it is read-only". That
argument is wrong. Read-only-ness stops the census DAMAGING convergence; it does nothing to stop the
census reading a half-converged state and reporting from it. An implementation can census early, hold
the finding, finish converging, and aggregate afterwards — the forbidden edge is still reported and the
sanctioned edge is still restored, so an outcome-only criterion cannot tell the two apart. **Safety
comes from awaiting the complete convergence attempt, and the criterion has to observe the read's
POSITION, not its result** (AC5).*

**Both errors are aggregated into one outcome**, so a convergence failure and a census finding on the
same team hide neither.

**Fails closed:** a census read error is that team's failure, never "no forbidden edges".

### 2b. Scope: every `kind='system'` project, and every edge on a non-reserved one

⚠️ **The query is EDGE-DRIVEN, not project-driven, and round 1's BLOCKER 3 is why.** My first draft
said "read every `kind='system'` row joined to its edges in one statement". That statement **cannot be
compiled**: the adapter supports a to-many embed only as `(count)`, and `project_groups` declares only
a `groups` relationship — there is no `projects → project_groups` edge in the registry
(`lib/db/pg/relationships.ts:63-67`). So the census reads **from `project_groups`**, embedding
**both** `projects(kind, slug)` and `groups(slug, is_builtin)` in one flat statement, filtered to the
team. That needs a new `projects` entry on `project_groups` in the relationship registry, which is
therefore **in scope** (§3).

A system project with **zero** edges needs no row in the result: there is no forbidden edge to report,
and its absence is not a finding. An unresolved embed on either side is **unsanctioned, never absent**.

**The read is the team's WHOLE edge set, with `kind` filtered client-side** — the adapter cannot push a
predicate into an embed. That is fine at any realistic edge count (§0a: three on prod), and it is
written down so nobody "optimises" it into a two-read form that swallows the projects lookup — the
exact shape AUDITFIX-3's per-project census documents at `lib/access/groups.ts:511-514`.

⚠️ **THE CENSUS IS IDENTIFIED BY ITS SELECT SHAPE, and round 2's BLOCKER 1 is why that has to be in the
spec.** `project_groups` is read **four times per team per converged tick**: `grantProjectToGroup`'s
existence probe fires once per sanctioned grant — **three** times (`lib/access/groups.ts:647-653`,
loop at `lib/access/bootstrap.ts:141-148`) — plus AUDITFIX-3's per-project adopt census
(`lib/access/groups.ts:530-534`). The three shapes are distinguishable and only one is new:

| read | select |
|---|---|
| the grant existence probe (×3) | `project_id` |
| AUDITFIX-3's adopt census | `group_id, groups(slug, is_builtin)` |
| **this census** | the only one embedding **`projects(`** |

Any criterion that needs to observe or fault "the census read" **keys on that embed**, never on the
table name and never on read order — §4 says so at AC5 and AC6, because both were unimplementable
without it.

⚠️ **A census that THROWS is that team's failure, and later teams still get their rows** (round 2
MEDIUM 1). The adapter can throw rather than return `{error}` — an unknown embed does
(`lib/db/pg/query-builder.ts:313`). If the census sat outside the per-team `try`, its throw would
escape the loop, abort every remaining team's outcome, and land as ONE fleet-level row through the
leg's catch — silently converting a per-team finding into a fleet outage.

⚠️ **For a non-reserved system project, EVERY edge is reported, and that is deliberate.** The
alternative — treat an unknown system slug as "anything goes" — would make the census disagree with
the writer, which refuses all of them (§0c). A detector that disagrees with the thing it observes is
worse than none.

⚠️ **This is a POLICY DECISION, and round 2's BLOCKER 3 is why it cannot be dressed as a derived
fact.** Round 1 rightly said *"the writer refuses it now"* does not establish that accumulated
historical state was never legitimate — the writer only ever saw NEW grants. My fold then claimed the
DATA MODEL settles it. **It does not.** The CHECK constrains only the kind ENUM, never the slug
(`postgres/migrations/20260809150000_projects_kind.sql:11`), and the graph-pointer migration
deliberately mints an ordinary per-project pointer for *"everything else"* — which INCLUDES a
non-reserved `kind='system'` row (`postgres/migrations/20260815140000_projects_graph_group_id.sql:44`).
`schema.sql:997`'s "the two §11 built-ins" is a comment, not an enforced invariant. **That is the
second time in this program I have derived a ruling from a data model that does not say it.**

So, stated as the decision it is: **the current writer owns every system-kind edge, including
historical ones**, and the census reports accordingly. The subject of the census is **edges**, not
project rows — so a non-reserved system project with ZERO edges is **not** a finding here, and this
spec makes no claim that the row itself is invalid. Both halves of that follow from the same
edge-scoped reading, which is what round 2 found inconsistent in the previous draft.

### 2b.1 What "report every edge" can actually mean — count, plus a bounded deterministic sample

⚠️ **Round 2's BLOCKER 2 found the rule and the channel contradicting each other.** §1 promises every
forbidden edge is reported; §2d clamps the census part of the error to 200 characters; and `groups.slug`
has no length constraint (`postgres/schema.sql:1035`) while persistence clamps each error string to 500
(`lib/ingest/runs.ts:51`). An unbounded set cannot be named in a bounded string — so the absolute
promise was unkeepable, and every criterion planting exactly ONE forbidden edge let
`rows.find(unsanctioned)` satisfy the entire suite while a second edge went unreported forever.

**The contract, made satisfiable:**

- the census **detects existence over the whole set** — never `find`, always a full scan;
- it reports the **exact total count**, which is unbounded-safe;
- plus a **deterministic bounded sample** — ordered by `(project slug, group slug)` so it is stable
  across runs and diffable, truncated to fit the 200 characters with an explicit `+N more`;
- and the **complete, structured** set goes in the ledger row's **`meta`** — round 2 MEDIUM 2, and it is
  strictly better than my "the complete set is the repair path's problem". `ingest_runs.meta` is
  `jsonb`, **unclamped**, already rendered by the Recent-runs panel, and **nothing reads this source's
  `meta` today** — so `{ forbiddenEdges: [{ projectSlug, groupSlug, projectId, groupId }] }` costs
  nothing and is exactly the evidence a controlled raw-SQL repair needs, and that AUDITFIX-21 will
  validate its repair against. Slugs alone suffice to write that SQL, since both tables are unique on
  `(team_id, slug)` (`postgres/schema.sql:995`, `:1047`) — but only for the edges a 200-character
  clamp did not eat, which is the whole reason the structured channel exists.

So the reported shape is `3 unsanctioned edge(s) on system projects: external-shared→contractors,
general→vendors +1 more`. A `find`-style implementation reports `1`, and the count is what the criteria
assert.

**Every multi-edge criterion asserts the EXACT PAIRS, not merely that both names appear somewhere** —
distinct project AND group names per fixture, so a report that names the right groups against the wrong
projects fails.

### 2c. The operator-asks path, and the CLI's own words

`assessAccessHealth` gains the same assertion — **by calling the SAME census function**, not by
reimplementing the predicate (round 2 MEDIUM 3). A second implementation is the divergence class
AUDITFIX-15A exists to prevent, and it is also what makes one mutation cover both surfaces: drop the
`kind` conjunct once and both the scheduled and the operator path must redden.

⚠️ **It must read `projects.kind`.** Its project read selects `id, slug` and filters to the two
reserved slugs (`lib/admin/access-health.ts:68-72`). A slug-keyed census would flag the **legitimate
creator grant** on a reserved-slug `kind='initiative'` project — reversing the exact AUDITFIX-3 ruling
that such a project stays grantable to its creator. And filtering to two slugs would miss the
non-reserved system project entirely (§0c).

⚠️ **Widening `blockers` changes what the CLI PRINTS, and leaving that alone ships false operator
output.** Today the field means lock-OUT and `printHealth` renders `health: LOCKOUTS`
(`scripts/admin.ts:99`). A team with no lockout but one forbidden edge would print `LOCKOUTS`, which is
untrue. So `blockers` becomes *"a human locked OUT, or a group let IN that the substrate never
sanctioned"*.

⚠️ **I have now miscounted this inventory TWICE — four, then eight, and it is neither.** Round 1
caught the four; round 2 caught the eight. So the number is dropped and the LOCATIONS are the contract,
because a count is exactly the kind of claim I keep getting wrong:

- `lib/admin/access-health.ts` — module header `:14`; the `healthy` / `blockers` / `warnings` interface
  docs `:26`, `:28`, `:30`; implementation comments `:113`, `:136`
- `scripts/admin.ts` — CLI help `:83`; formatter comment `:96`; the verdict literal `:99`
  (→ **`ACCESS VIOLATIONS`**); command comment `:423`
- `docs/ARCHITECTURE.md` — the access-enforcement entry (`:72`) and the operator-surface catalog
  (`:797`)

**The build greps for the narrow vocabulary before claiming the sweep is complete**, rather than
trusting this list — the list is where to start, not proof of coverage. **No external programmatic consumer of
`AccessHealth.blockers` exists** (round 1 grepped for one), so keeping the FIELD name is coherent —
its entries stay fatal to `healthy`, which is the only contract that matters. Filing it under `warnings` is not an option: warnings
are non-fatal, so `healthy` would stay `true` — the report-green-while-broken failure this slice exists
to prevent.

### 2d. Two errors, one string, and a 500-character cliff

⚠️ **"Both errors are aggregated so neither hides the other" was an assertion, not a design — round 1's
HIGH 1.** `TeamBootstrapOutcome` carries ONE optional string; the ledger stores it as one error; and
`recordIngestRun` clamps each error to **500 characters** (`lib/ingest/runs.ts:52-61`). So a long
convergence error concatenated with the census finding can push the edge identity off the end, and the
card would show a truncated bootstrap error with no mention of the forbidden grant. Widening to
`errors[]` does not fix it either: the health card renders only `firstError`
(`lib/ingest/pipeline-health.ts:334`) and the banner only `PipelineLeg.error`
(`components/admin/pipeline-health-banner.tsx:89`).

**The contract:** when both are present the outcome's error is a **labelled compound whose parts are
INDEPENDENTLY clamped** — `census: <finding, ≤200 chars> | bootstrap: <error, ≤250 chars>` — so neither
part can erase the other whatever the other's length, and the whole stays inside the 500 the ledger
allows. The census part goes **first**, because it is the fact no other surface reports; the
convergence failure is also visible on its own through the wedge it causes. The parts are additionally passed as later `errors[]`
elements for the Recent-runs panel — ⚠️ *which are themselves clamped at 500 characters each
(`lib/ingest/runs.ts:61`), so "untruncated" was wrong; the unclamped channel is `meta` (§2b.1).* **AC9 asserts both names
survive PERSISTENCE**, not just construction.

## 3. Scope

**In:** `lib/access/bootstrap.ts` (the per-team census + its placement) · `lib/access/groups.ts` (the
team-wide census read, which must live in the single-writer file for the same coarse-net reason
AUDITFIX-3 recorded) · **`lib/db/pg/relationships.ts`** (the `project_groups → projects` embed §2b
needs; round 1 B3) · `lib/admin/access-health.ts` · **a new import-safe formatter module** for the CLI
verdict (round 1 H4: `printHealth` is private and importing `scripts/admin.ts` executes `main()` at
module scope — `scripts/admin.ts:472-474` — so AC13 has no seam without one) · `scripts/admin.ts` ·
`docs/ARCHITECTURE.md`.

**Out:**
- **Repair — AUDITFIX-21.** This slice REPORTS; it never deletes. A fail-open destructive repair is
  worse than a reported hole (inherited from AUDITFIX-3 §3).
- **The staleness-beat fossil — AUDITFIX-24**, accepted and pinned by AUDITFIX-22.
- **Any change to the ledger** — AUDITFIX-22 shipped it; this slice only feeds it.

## 4. Acceptance

⚠️ **Two shapes are pre-empted rather than rediscovered:** every fixture precondition is asserted, and
every BOOTSTRAP-fault injector fails **reads only**. AUDITFIX-3 shipped five criteria that were green
while testing nothing; AUDITFIX-22 shipped two more, one of which was a **race that could pass its own
mutation by scheduling luck**. **No criterion here may depend on timing** — where a criterion needs to
observe WHEN something happened, it uses a state oracle, not a clock.

- **AC1 — a forbidden edge on a RESERVED-slug system project is reported (dm):** plant
  **`external-shared→vendors`** out of band; the team comes back failed and the error names the edge.
  ⚠️ *Round 1 HIGH 2: my draft planted this on `general`, which a census restricted to General would
  also catch — so mutation 2 could not redden its own criterion. The non-General fixture is the point.*
- **AC1b — and on `general` (dm):** `general→vendors`, as an independent fixture. *Both reserved
  projects, so neither a General-only nor an ExternalShared-only census passes.*
- **AC2 — and on a NON-reserved `kind='system'` project (dm):** `slug='legacy-system'` granted to
  `vendors`. *§0c/§2b — a two-slug census satisfies AC1 and AC1b while this stays invisible to both
  surfaces.*
- **AC2b — MULTIPLE forbidden edges are all counted, and the sample names EXACT PAIRS (dm):** plant
  three at once with distinct names — `general→vendors`, `external-shared→contractors`,
  `legacy-system→auditors` — and assert the report's **count is 3** and its sample names the exact
  project→group pairs in the documented order. ⚠️ *Round 2 BLOCKER 2: every criterion planted ONE
  edge, so `rows.find(unsanctioned)` reported the first and passed the entire suite while the rest
  went unreported forever. Distinct names on both sides, because a report that pairs the right groups
  with the wrong projects must fail.*
- **AC3 — the census runs when CONVERGENCE RETURNED a failure (dm):** wedge General with a
  reserved-slug initiative **and** plant a forbidden edge on an already-system `external-shared`; the
  team's single outcome names **both**.
- **AC4 — and when convergence THREW (dm):** same fixture with convergence made to throw; the outcome
  still names the census finding. *A `catch … continue` that skips the census passes AC3.*
- **AC5 — the census READ happens after all three sanctioned edges exist (dm):** with a forbidden edge
  planted and **ALL THREE** sanctioned edges removed, observe the state **at the moment the census read
  begins — identified by the `projects(` embed, never by table name or read order** — assert all three
  are present by then, and assert the forbidden edge is reported. ⚠️ *Round 2 BLOCKER 1: keyed on the
  table, the oracle fires on the writer's existence probe (three per team per tick) and REDS A CORRECT
  IMPLEMENTATION, because probe #1 legitimately runs before the edges are restored; keyed on the first
  read, it pins that probe and never the census, so both ordering mutations pass. Round 2 HIGH 1:
  removing only the "last" edge couples the mutation to the grant loop's order, which nothing pins —
  if the removed edge happens to be granted first, the between-grants mutant sees all three present
  and passes. Removing all three makes at least one absent at every pre-completion position.*
  ⚠️ *Round 1 BLOCKER 2 killed the outcome-only version: an implementation that censuses early, holds
  the finding, finishes converging and aggregates afterwards reports the same edge AND restores the
  same grant, so mutations 5 and 6 could not redden it. The criterion must observe the read's POSITION.
  It is a state oracle read inside a db proxy on the census query — no timing.*
- **AC6 — the census FAILS CLOSED, on a team that otherwise converges CLEANLY (dm):** fault **only the
  census read** (keyed on the `projects(` embed) on a team whose convergence succeeds, and assert the
  team is reported failed with an error attributable to the census. ⚠️ *Round 2 BLOCKER 1: faulting
  every `project_groups` read also breaks the writer's three existence probes, so convergence itself
  returns `ok:false` and the team is "reported failed" for the BOOTSTRAP reason — the swallow-the-
  census-error mutation could not redden it. Green while testing nothing, in the criterion whose whole
  job is fail-closed.*
- **AC6b — and when the census THROWS rather than returning an error (dm):** the team is reported
  failed **and every later team still gets its own outcome**. *Round 2 MEDIUM 1 — a census outside the
  per-team guard converts one team's finding into a fleet-wide outage.*
- **AC7 — a legitimate reserved-slug INITIATIVE's creator edge is never called unsanctioned (dm):**
  with the creator grant present, neither the census nor `assessAccessHealth` names **that edge** as a
  forbidden system-project grant. ⚠️ *Round 1 BLOCKER 1: `projects` is unique on `(team_id, slug)`
  (`postgres/schema.sql:995`), so a `kind='initiative', slug='general'` row makes a
  `kind='system', slug='general'` row impossible — and a kind-aware health check MUST then report
  "General system project missing" (`lib/admin/access-health.ts:77`). My draft demanded the initiative
  not be flagged **at all**, which is unsatisfiable against that shipped invariant. The criterion
  asserts the narrow thing: the creator edge is not the finding. The missing-system-project blocker is
  expected and asserted PRESENT, so the two cannot be confused.*
- **AC8 — a clean team is not reported (dm):** returned unfailed. *Without it, a census that always
  failed would pass AC1-AC6.*
- **AC9 — the finding reaches the TEAM'S CARD, NAMED (dm):** with a forbidden edge planted, two ticks
  of the real AUDITFIX-22 leg put `access_bootstrap` in `failing` with `failureClass` `confirmed` and
  `healthy === false` for that team, another team stays green, **the leg's `error` names the project
  AND the group**, and **exactly one failed ledger row exists per team per tick**. ⚠️ *Round 1
  BLOCKER 4: without the naming clause a mutant can return a correct error from the wrapper and hand
  `onOutcome` `{ok:false, error:"unknown"}` — two ticks still go confirmed and the criterion passes
  while the card says nothing useful. The banner renders `PipelineLeg.error` and nothing else.*
- **AC9b — both errors survive PERSISTENCE, with the PART BOUNDARIES pinned (dm):** with a wedge
  **and** a forbidden edge, and a convergence error carrying a **sentinel beyond character 250**,
  assert on the PERSISTED row: the census part names the edge; the bootstrap part is present; the
  sentinel is **absent from `errors[0]`** but **present in the later untruncated `errors[]` element**;
  and `errors[0]` is within the documented compound length.
- **AC9b-inverse — the SAME, with the long part on the CENSUS side (dm):** enough planted forbidden
  edges that the census part alone would exceed the compound budget, plus a short convergence error;
  assert the convergence failure's name STILL survives persistence. ⚠️ *Round 2 BLOCKER 2: the ledger
  clamps from the FRONT, so naive census-first concatenation loses only its TAIL — with a short census
  part and a long bootstrap part both names survive anyway and the no-clamping mutant passes. Only the
  inverse arm catches it. This is the criteria-need-their-inverse class, again.* ⚠️ *Round 2 HIGH 1: asserting only that
  both names appear lets naive census-first concatenation pass — a 70-char census part plus a 450-char
  bootstrap part survives a single 500-char clamp with both names intact, so independent clamping could
  be deleted with the criterion still green. The sentinel is what makes the boundary observable.*
- **AC9c — the ledger row's `meta` carries the COMPLETE structured edge list (dm):** with more
  forbidden edges than the sample can name, `meta.forbiddenEdges` contains every one with its project
  and group slugs and ids, while the error string carries the count and the bounded sample. *§2b.1 —
  the bounded string is for a human; this is what a repair reads.*
- **AC10 — `assessAccessHealth` reports a forbidden edge on `general` (dm):** blocker names project
  and group, `healthy:false`.
- **AC10b — and on `external-shared` (dm):** independent fixture. ⚠️ *Round 2 BLOCKER 1: with one
  reserved fixture, a health implementation that scans `general` plus every non-reserved system
  project — and skips `external-shared` — passes AC10 through AC13 while `external-shared→vendors`
  stays invisible to the operator who asks. The inverse implementation passes the mirror image. The
  scheduled path already had this split; the operator path did not.*
- **AC10c — and on a NON-reserved `kind='system'` project (dm):** independent fixture.
- **AC11 — `assessAccessHealth` stays healthy on a clean team (dm):** the inverse control.
- **AC12 — `assessAccessHealth` FAILS CLOSED (dm):** with its edge read faulted, it does not certify
  `healthy:true`.
- **AC13 — the formatter PRINTS the widened meaning (unit):** the new import-safe formatter, given a
  health object whose only blocker is an over-exposure, renders **`ACCESS VIOLATIONS`**, not
  `LOCKOUTS`. ⚠️ *Round 1 HIGH 4: `printHealth` is private and importing `scripts/admin.ts` runs
  `main()` at module scope, so the criterion had no callable seam. The formatter module (§3) is that
  seam, and `scripts/admin.ts` consumes it rather than duplicating it.*

**Mutation coverage, one per enforcement point, each reddening ITS OWN criterion:**

| # | mutation | must redden |
|---|---|---|
| 1 | census only the two reserved slugs | AC2 |
| 2 | census only `general` | AC1 |
| 3 | census only `external-shared` | AC1b |
| 4 | skip the census when that team's convergence returned a failure | AC3 |
| 5 | skip the census on the throw path | AC4 |
| 6 | move the census read BEFORE the three sanctioned grants | AC5 |
| 7 | move the census read BETWEEN the first and second grant | AC5 |
| 8 | swallow the census read error | AC6 |
| 8b | let a census throw escape the per-team guard | AC6b |
| 8c | drop `meta.forbiddenEdges` | AC9c |
| 9 | drop the `kind` conjunct so reserved SLUGS are censused regardless of kind | AC7 |
| 10 | delete the census's unsanctioned-edge check | AC1 |
| 11 | hand `onOutcome` a generic error instead of the named finding | AC9 |
| 13 | drop `assessAccessHealth`'s new blocker | AC10 |
| 14 | make `assessAccessHealth` census only the two reserved slugs | AC10c |
| 14b | make `assessAccessHealth` census only `general` | AC10b |
| 14c | make `assessAccessHealth` census only `external-shared` | AC10 |
| 14d | report only the FIRST forbidden edge (`find`, not a full scan) | AC2b |
| 14e | drop the independent clamps and concatenate census-first | AC9b-inverse |
| 14f | drop the independent clamps and concatenate bootstrap-first | AC9b |
| 15 | swallow `assessAccessHealth`'s edge-read error | AC12 |
| 16 | keep the CLI verdict text as `LOCKOUTS` | AC13 |
| 17 | report the census finding without failing the outcome | AC9 |

*Mutations 2 and 3 are separate because a single-project census is the shape that passed my first
acceptance suite; 6 and 7 are separate because "before" and "between" are different placements and
only a positional oracle sees either.*

## 5. Risks

| risk | direction | mitigation |
|---|---|---|
| The census never runs on the team that most needs it | the loudest case is the silent one | AC3 + AC4, mutations 4 and 5 |
| Detection narrower than the prevention it observes | an edge the writer refuses stays invisible | AC1 / AC1b / AC2 / AC10, mutations 1-3 and 14 |
| A kind-blind census flags a legitimate initiative grant | AUDITFIX-3's ruling reversed, a creator stranded | AC7, mutation 9 |
| The census reads a half-converged state | reports from a state the tick was about to fix | AC5's **positional** oracle, mutations 6 and 7 |
| The finding reaches the card unnamed | a red banner an operator cannot act on | AC9's naming clause, mutation 11 |
| Two errors, one 500-char string | the edge identity truncated away by a long convergence error | §2d's independent clamps; AC9b, mutation 12 |
| The CLI keeps printing `LOCKOUTS` for an exposure | false operator output | AC13, mutation 16 |
| The scheduled channel never took effect on prod | an unattended detector nobody hears | **§0b is a release gate**, three checks, all read-only |
| Someone reads the merge as making the edge repairable | wasted expectation | §6 |

## 6. What this slice does NOT prove

A detected edge is still **not repairable through the sanctioned path** — the qualifier matters, and
round 1's MEDIUM 3 confirmed the slice order is right anyway: detection supplies the evidence a
controlled raw-SQL repair needs, and gives AUDITFIX-21 a detector to validate against. Concretely: `revokeProjectFromGroup`
refuses every `kind='system'` revocation, and `lib/access/revoke-verb.ts` refuses again before the writer is
reached. Until **AUDITFIX-21**, repair is raw SQL. A merge here means *"you will now be told"*, not
*"it is now fixable"*.

**Nothing is built. No code exists for this slice.**

## 7. Round 1 — BLOCKED, and four of its findings land in the acceptance suite

| # | finding | re-derived | outcome |
|---|---|---|---|
| **B1** | AC7 was UNSATISFIABLE: `projects` is unique on `(team_id, slug)`, so a reserved-slug initiative makes the system project impossible — and a kind-aware health check must then report it missing | **CONFIRMED** (`postgres/schema.sql:995`, `lib/admin/access-health.ts:77`) | **ADOPTED** — AC7 asserts the narrow thing (the creator EDGE is not the finding) and asserts the missing-system-project blocker is PRESENT |
| **B2** | AC5 could not redden its own ordering mutations — census early, hold, converge, aggregate reports the same edge and restores the same grant | **CONFIRMED** | **ADOPTED** — AC5 observes the read's POSITION via a state oracle; §2a's "read-only makes it safe" reasoning is retracted |
| **B3** | the one-statement query cannot be compiled: no `projects → project_groups` relationship, and to-many embeds are `(count)` only | **CONFIRMED** (`lib/db/pg/relationships.ts:63-67`, `lib/db/pg/query-builder.ts:299`) | **ADOPTED** — edge-driven flat statement from `project_groups`; the registry entry and `lib/db/pg/relationships.ts` are in scope |
| **B4** | AC9 proved only that SOME failure reached the card; a mutant can pass `{ok:false, error:"unknown"}` | **CONFIRMED** — the banner renders `PipelineLeg.error` alone | **ADOPTED** — AC9 asserts the error NAMES project and group, plus one failed row per team per tick; mutation 11 |
| **H1** | "both errors hide neither" was an assertion: one string, clamped at 500 chars, and health exposes only `firstError` | **CONFIRMED** (`lib/ingest/runs.ts:52-61`, `lib/ingest/pipeline-health.ts:334`) | **ADOPTED** — §2d's labelled, independently clamped compound; **AC9b** proves it after PERSISTENCE |
| **H2** | mutation 2 could not redden AC1, because AC1 planted on the very project the mutation keeps | **CONFIRMED** | **ADOPTED** — AC1 moves to `external-shared`, **AC1b** adds `general`; mutations 2 and 3 |
| **H3** | the live dependency needed a GATE, not a recheck — ledger inserts are swallowed, so a no-op looks identical to success | **CONFIRMED** | **ADOPTED** — §0b is three concrete read-only checks; and my "value is zero" was too broad, since `assessAccessHealth` is an independent path |
| **H4** | AC13 had no seam: `printHealth` is private and importing `scripts/admin.ts` executes `main()` | **CONFIRMED** (`scripts/admin.ts:472-474`) | **ADOPTED** — an import-safe formatter module, in scope |
| **M1** | the non-reserved reading is right but "the writer refuses it now" does not prove historical state was never legitimate | **CONFIRMED** | **ADOPTED** — §2b now rests on the DATA MODEL (`schema.sql:997-998`) |
| **M2** | the "four lockout spellings" inventory was FALSE — there are eight | **CONFIRMED** | **ADOPTED** — enumerated in §2c. *This is the grep-before-claiming-every-other failure again.* |
| **M3** | detection need not wait for AUDITFIX-21 | **CONFIRMED** | slice order unchanged; §6 qualified |

**Nothing is built. No code exists for this slice.**

## 8. Round 2 — BLOCKED by BOTH models, run in parallel, and they found different things

Round 1 was Codex. Round 2 ran **Codex against the fold** and **Fable cold** at the same time. They
overlapped on almost nothing, which is the case for two models stated plainly.

### Codex — attacking its own round-1 fold

| # | finding | re-derived | outcome |
|---|---|---|---|
| **B1** | AC10 tested "reserved and non-reserved", so a health implementation scanning `general` + all non-reserved but skipping `external-shared` passed everything while that project stayed invisible to an operator | **CONFIRMED** | **ADOPTED** — AC10 / AC10b / AC10c are three independent fixtures; mutations 14b/14c |
| **B2** | every criterion planted ONE forbidden edge, so `rows.find(unsanctioned)` satisfied the whole suite; and a 200-char part cannot name an unbounded set, making §1's promise unkeepable | **CONFIRMED** — `groups.slug` is unconstrained `text`, errors clamp at 500 | **ADOPTED** — the contract is count + deterministic bounded sample (§2b.1); **AC2b** asserts exact pairs on three edges; mutation 14d |
| **B3** | my "the data model says a non-reserved system project is unsupported" is FALSE — the CHECK constrains only the kind enum, and the graph-pointer migration mints an ordinary pointer for exactly such a row | **CONFIRMED** (`…projects_kind.sql:11`, `…projects_graph_group_id.sql:44`) | **ADOPTED** — restated as a POLICY decision; the census's subject is EDGES, so a zero-edge row is not a finding and no claim is made about the row's validity |
| **H1** | mutation 12 could not redden AC9b | **CONFIRMED** | **ADOPTED** — see Fable B2, which found the same hole from the other side |
| **H2** | the release gate proved one callback, not a continuing channel or one-row-per-tick | **CONFIRMED** | **ADOPTED** — a fourth check, and **all four are now VERIFIED on prod** (§0b) |
| **M1** | the "eight places" inventory is ten code locations plus two docs | **CONFIRMED** | **ADOPTED** — the number is gone; locations listed, and the build greps rather than trusting the list |

### Fable — cold, and it found the axis neither Codex round named

| # | finding | re-derived | outcome |
|---|---|---|---|
| **B1** | `project_groups` is read **FOUR times per team per tick** — the writer's existence probe once per sanctioned grant, plus AUDITFIX-3's adopt census — and my criteria said "the census read" with no discriminator. Keyed on the table, AC5's oracle **reds a correct implementation**; keyed on first-read it pins the probe; and AC6's injector breaks the probes so convergence fails and the fail-closed mutation cannot redden | **CONFIRMED** — `groups.ts:647-653` × 3 via `bootstrap.ts:141-148`, plus `groups.ts:530-534` | **ADOPTED** — §2b makes the `projects(` embed the census's IDENTITY; AC5 and AC6 key on it; AC6's fixture converges cleanly |
| **B2** | mutation 12 cannot redden AC9b in its CENSUS-FIRST form: the ledger clamps from the FRONT, so naive concatenation loses only its tail and both names survive | **CONFIRMED** | **ADOPTED** — **AC9b-inverse**, with the long part on the census side; mutations 14e and 14f, one per concat order |
| **H1** | "remove the LAST sanctioned edge" couples mutation 7 to the grant loop's order, which nothing pins | **CONFIRMED** | **ADOPTED** — AC5 removes all three |
| **M1** | the census's own THROW path was uncovered, and outside the per-team guard it aborts every remaining team | **CONFIRMED** — the adapter throws on an unknown embed | **ADOPTED** — §2b; **AC6b**; mutation 8b |
| **M2** | put the complete structured edge list in the row's `meta` — jsonb, unclamped, already rendered, nothing reads this source's meta today | **CONFIRMED** | **ADOPTED, and it is better than what it replaced** — §2b.1; **AC9c**; mutation 8c |
| **M3** | the spec never said `assessAccessHealth` must consume the SAME census — a reimplemented predicate is the divergence AUDITFIX-15A exists to prevent | **CONFIRMED** | **ADOPTED** — §2c |
| **LOW** | "eight places" is ten; the extra `errors[]` elements are 500-clamped too, so "untruncated" is wrong | **CONFIRMED** | **ADOPTED** — both corrected |
| — | census cost per tick (indexed, three edges on prod, no single-flight or staleness interaction); census-first precedence (arithmetic 472 ≤ 500, and a wedged team also reds its `context_backfill` leg); no ninth `blockers` consumer; the slice order | **CLEARED with evidence** | recorded so the build does not re-litigate them |

⚠️ **The pattern across both rounds: my criteria kept naming a thing the test could not identify.**
"The census read" (four candidates), "the last sanctioned edge" (order-dependent), "both names appear"
(passes under one concat order). Each was a criterion written from the DESIGN's vocabulary rather than
from what a test can actually observe — and each would have shipped green.

**Nothing is built. No code exists for this slice.**
