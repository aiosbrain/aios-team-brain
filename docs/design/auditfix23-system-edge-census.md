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
3. `getPipelineHealth` for that team selecting **that same scoped row** as its leg.

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

⚠️ **For a non-reserved system project, EVERY edge is reported, and that is deliberate.** The
alternative — treat an unknown system slug as "anything goes" — would make the census disagree with
the writer, which refuses all of them (§0c). A detector that disagrees with the thing it observes is
worse than none.

⚠️ *Round 1's MEDIUM 1 sharpened the justification, and the correction matters: "the writer refuses it
now" does NOT establish that accumulated historical state was never legitimate — the writer only ever
saw NEW grants. The load-bearing argument is the **data model**, which defines the kind as exactly the
two built-ins: `'system' (§11 built-ins: general/external-shared)`
(`postgres/schema.sql:997-998`, and the CHECK in
`postgres/migrations/20260809150000_projects_kind.sql`). A non-reserved `kind='system'` row is
**unsupported state**, not an operator extension the census is misreading.*

### 2c. The operator-asks path, and the CLI's own words

`assessAccessHealth` gains the same assertion.

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

⚠️ **My "four places" inventory was FALSE — round 1 MEDIUM 2 enumerated more, and this is the
grep-before-claiming-every-other failure again.** The narrow semantics live in **eight** places, all of
which move together: `lib/admin/access-health.ts` — the module header (`:14`), and the `healthy`,
`blockers` and `warnings` interface docs (`:26`, `:28`, `:30`), plus two implementation comments
(`:113`, `:136`); and `scripts/admin.ts` — the CLI help (`:83`), the formatter comment (`:96`), the
verdict literal (`:99` → **`ACCESS VIOLATIONS`**) and the command comment (`:423`). The
`docs/ARCHITECTURE.md` entry widens with them. **No external programmatic consumer of
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
convergence failure is also visible on its own through the wedge it causes. The untruncated parts are
additionally passed as later `errors[]` elements for the Recent-runs panel. **AC9 asserts both names
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
- **AC3 — the census runs when CONVERGENCE RETURNED a failure (dm):** wedge General with a
  reserved-slug initiative **and** plant a forbidden edge on an already-system `external-shared`; the
  team's single outcome names **both**.
- **AC4 — and when convergence THREW (dm):** same fixture with convergence made to throw; the outcome
  still names the census finding. *A `catch … continue` that skips the census passes AC3.*
- **AC5 — the census READ happens after all three sanctioned edges exist (dm):** with a forbidden edge
  planted and the LAST sanctioned edge removed, observe the state **at the moment the census read
  begins** — all three sanctioned edges are present — and assert the forbidden edge is reported.
  ⚠️ *Round 1 BLOCKER 2 killed the outcome-only version: an implementation that censuses early, holds
  the finding, finishes converging and aggregates afterwards reports the same edge AND restores the
  same grant, so mutations 5 and 6 could not redden it. The criterion must observe the read's POSITION.
  It is a state oracle read inside a db proxy on the census query — no timing.*
- **AC6 — the census FAILS CLOSED (dm):** with the edge read faulted, that team is reported failed; it
  never reports "no forbidden edges" from a read it could not complete.
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
- **AC9b — both errors survive PERSISTENCE when convergence ALSO failed (dm):** with a wedge **and** a
  forbidden edge, the persisted leg error names the forbidden edge **and** the convergence failure,
  with a convergence error long enough (>400 chars) to have erased the census part under naive
  concatenation. *§2d — the 500-char clamp is per error string, so this is the criterion that proves
  the independent bounding rather than assuming it.*
- **AC10 — `assessAccessHealth` reports a forbidden edge on BOTH project shapes and goes
  `healthy:false` (dm):** reserved-slug and non-reserved, each as an independent fixture, blocker
  naming project and group.
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
| 9 | drop the `kind` conjunct so reserved SLUGS are censused regardless of kind | AC7 |
| 10 | delete the census's unsanctioned-edge check | AC1 |
| 11 | hand `onOutcome` a generic error instead of the named finding | AC9 |
| 12 | concatenate the two errors without independent clamping | AC9b |
| 13 | drop `assessAccessHealth`'s new blocker | AC10 |
| 14 | make `assessAccessHealth` census only the two reserved slugs | AC10 |
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
