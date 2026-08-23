# A forbidden grant on a system project cannot be CREATED — AUDITFIX-3

**Status:** spec, round 2 folded, **narrowed**. No code written. Four spec rounds have now BLOCKED
versions of this work (§6, §7, §8). Round 2 of this document said the slice combined nine concerns and
that its own folds had produced three independent defects, so it is **split** (§3a): this document is
the **prevention** half only.

**Build with:** opus / high — an irreversible write on the access substrate.

**Deps:** none to build. ⚠️ **Schedule BEFORE or WITH TIERRET-1** — §0c.

---

## What and why

**What:** `grantProjectToGroup` refuses to create any edge on a system project (or on the `source`
project destined to become one) except the three bootstrap itself creates, and `ensureSystemProject`
refuses to promote a `source` project that already carries a forbidden edge.

**Why:** today one sanctioned CLI command creates a **permanent, CLI-unrevokable** grant of an entire
system corpus to an arbitrary group — and a second, entirely accidental path reaches the same state
with no bad intent at all.

**What this slice deliberately does NOT do:** detect a forbidden edge that already exists, or repair
one. Those are AUDITFIX-22 and AUDITFIX-21 — §3a says why, and §3b states the consequence honestly.

## 0. Terrain, measured before designing

### 0a. The asymmetry, confirmed in today's code

| | |
|---|---|
| `grantProjectToGroup` (`lib/access/groups.ts:497-536`) | reads **no** `projects.kind`, checks **no** group class. `grant-project <anygroup> general` is legal |
| `revokeProjectFromGroup` (`lib/access/groups.ts:588`) | refuses **every** `kind='system'` revocation — *"raw SQL is the deliberate barrier"* |
| `revoke-verb.ts:47` | refuses again, **before** the writer is reached |
| `scripts/admin.ts:302` | the grant command selects only `"id, slug"` — kind is never resolved |

**So the door is one-way at both layers**, and repair requires raw SQL against `project_groups` —
which the single-writer guard exists to make an out-of-band act. **This slice closes the door; it does
not add a key** (AUDITFIX-21).

### 0b. The path that needs no bad intent — and it is the real one

`ensureSystemProject` **adopts** an existing project that holds a reserved slug, flipping
`kind: 'source' → 'system'` (`lib/access/bootstrap.ts:61-72`). It touches `projects` and the graph
pointer only: **it never reads `project_groups`.** So:

1. A team has `projects(slug='general', kind='source')` — ordinary, and correct.
2. `grant-project vendors general` is **legal**: it is not a system project yet.
3. Someone joins `vendors`.
4. The scheduler tick runs bootstrap. The row is adopted. **The grant survives the flip.**
5. Backfill fills General with the team corpus. Everyone in `vendors` reads all of it.

The adoption's own comment argues it is *"visibility-neutral"* because "a source project has no
restriction semantics". That holds for the project's **own items** and is silent about its
**inherited grants** — and nothing enforces the premise.

### 0c. TIERRET-1 makes this WORSE, not better

The **item-id primitive** has no tier conjunct — `visibleItemIdsForProjects`
(`lib/access/enforce.ts:69-89`) filters on membership alone, and the module header says so outright:
*"there is no mode, no flag, and no posture wall … the retired tier conjunct never overrides it"*
(`:9-12`). So a mis-granted group **already reads the whole General item corpus today**, through
retrieval and the item routes.

⚠️ **But "the item primitive has no tier conjunct" is NOT true of the whole module, and I checked
before a reviewer did.** `visibleProjectRows` and `visibleProjectCards` DO carry one —
`(${posture} or i.access = 'external')` at `enforce.ts:295` and `:365`, deliberately, so a member's
row-visibility cannot exceed what the container's own surfaces would list. Those are *project-row*
surfaces, not the item read, and they are in TIERRET-1's removal set too.

What still partially masks a bad grant, verified by grep rather than asserted:

| file | conjunct |
|---|---|
| `lib/query/retrieve.ts` | 2 × `audience = 'external'` (tasks + decisions) |
| `lib/query/structured-extras.ts` | 2 × `audience = 'external'` |
| `lib/query/grounding.ts:43` | `and access = 'external'` — ⚠️ *`access`, not `audience`; my first draft named the wrong column* |
| `lib/access/enforce.ts:295,365` | the project-row posture wall above |

**Retiring them widens what a bad grant yields**, so this slice is a prerequisite for that one rather
than a beneficiary of it.

### 0d. Production state (read-only, 2026-08-23)

| | |
|---|---|
| `project_groups` edges | **exactly 3**, all sanctioned: `general→everyone`, `external-shared→everyone`, `external-shared→external` |
| projects holding a reserved slug but not yet `kind='system'` | **0** |
| **forbidden edges present** | **none — the defect is LATENT** |

Prevention is therefore the whole of the value on this fleet: there is nothing here to detect and
nothing to repair. That is the argument for shipping prevention alone first, not an argument that the
other halves do not matter on a self-hosted fleet where they might.

### 0e. Severity, stated rather than inflated

An operator who can run `scripts/admin.ts` already holds `DATABASE_URL` and could write the row
directly. **This is accident-prevention on a one-way door, not a privilege boundary.** The
irreversibility is the defect; the grant is not. That, plus §0b needing no bad intent, is the case
for fixing it — and it is a **Medium**, not a Critical. The earlier spec called it *"hands outsiders
the corpus"*, which the membership ruling has since retired.

## 1. The rule

> **An edge on a `kind='system'` project — or on a `kind='source'` project holding a reserved project
> slug — may exist ONLY if it is one of the three bootstrap creates. Creating any other is refused at
> the writer, and adoption refuses to promote a `source` row that already carries one.**

The sanctioned set is exactly the three edges bootstrap itself creates
(`lib/access/bootstrap.ts:134-138`): `general→everyone`, `external-shared→external`,
`external-shared→everyone`. **Bootstrap calls the same writer** (`bootstrap.ts:139`, with a NULL
actor), so the guard must admit those three and nothing else, or it breaks the thing it protects.

## 1a. How the accidental precondition arises — ordinary ingestion, verified

§0b starts from *"a team has `projects(slug='general', kind='source')`"*. That row needs **no operator
action at all**:

- `lib/ingest/index.ts:130-140` upserts `projects` with `slug: payload.project` **straight from the
  item payload**, on conflict `(team_id, slug)`.
- The item payload's project is validated as `z.string().min(1).max(120)`
  (`lib/api/item-payload-schema.ts:112`) — **no reserved-slug check**. ⚠️ *Round 2 M: my previous
  citation (`lib/api/schemas.ts:468,513`) was wrong — those are the **llm_usage** and **work_event**
  payloads, not the item payload. The behaviour claim survives; the evidence for it did not.*
  `isReservedSlug` (`lib/access/groups.ts:39`) guards GROUP slugs (`everyone`/`external`/`person-*`),
  never project slugs.
- `projects.kind` defaults to `'source'`
  (`postgres/migrations/20260809150000_projects_kind.sql:9`).

So pushing any item with `project: "general"` — a very plausible name — creates the row. Prod holds
**17 `source` projects and 2 `system`**, none currently squatting a reserved slug.

## 2. The design — two enforcement points

⚠️ *The audit called this "one conditional." Four spec rounds have found: a second exploit, the
adoption bypass, the race clause 2 closes, and (round 2) that clause 2 as written broke a legitimate
dashboard flow.*

### 2a. The writer — refuse an unsanctioned pair on a system OR pre-adoption project

`grantProjectToGroup` resolves the project (`id, kind, slug`) and the target group
(`id, slug, is_builtin`), and **refuses** when the pair is not sanctioned and **either**:

1. `projects.kind = 'system'`, **or**
2. `projects.kind = 'source'` **and** `projects.slug ∈ {general, external-shared}`.

⚠️ **Clause 2 is restricted to `kind='source'`, and round 2's BLOCKER 1 is why.** My round-1 version
said *"regardless of current kind"*, justified by the claim that a reserved-slug project *"is destined
for adoption anyway."* **That claim is false for `kind='initiative'`, and the break is severe:**

- `createProjectAction` slugifies the typed name — `slugify("General") === "general"`, verified
  (`lib/ids.ts:24-31`) — and inserts `kind:'initiative'` (`app/actions/projects.ts:39`).
- It then **must** grant the creator's person singleton or the project is invisible to its own
  creator; the code says so and treats grant failure as loud
  (`app/actions/projects.ts:74-82`, `grantProjectToCreator` at `:92-102`).
- `ensureSystemProject` **explicitly refuses to adopt an initiative** (`lib/access/bootstrap.ts:57-60`)
  — so a reserved-slug initiative is *never* destined for adoption.

"Regardless of kind" would therefore have rejected that grant and left a created-but-ungranted project
its creator cannot see, with the suggested admin repair (`admin.ts grant-project`) calling **the same
refusing writer**. Restricting clause 2 to `source` costs nothing: `ensureSystemProject` promotes
`source` and only `source` (`bootstrap.ts:57-72`), and `.update({ kind: … })` appears exactly once in
the repo (`bootstrap.ts:68`, verified by grep), so `source` is the only kind that can become `system`.
The census→CAS window stays closed from both sides — before the flip the slug rule refuses, after it
the kind rule does.

*(My own independent version of clause 2 was "reserve the slugs at INGEST". Round 1's is better: the
ingest rule is a behaviour change on the push path — a wider blast radius — while this one lives in
the access writer that is already being rewritten.)*

**Identity is slug on both sides plus `groups.is_builtin`** — a slug-only check lets an ordinary group
squatting the `external` slug become an approved target (earlier round). Cross-team pairs are
prevented structurally by the composite FKs (`postgres/schema.sql:1073-1074`), and a builtin/singleton
hybrid is prohibited at `:1047-1048`, so neither needs a runtime conjunct. *(Round 2 re-verified all
three of these structural claims and found no production project-rename path.)*

**Fail closed on an unreadable project OR group.** A read error refuses the grant. Both reads, not
just the project one — `getMember` (`lib/access/groups.ts:54`) drops its error today and that is
exactly the mistake to not repeat.

**The predicate is shared, and it is the only definition.** `isSanctionedSystemEdge(projectSlug,
{slug, is_builtin})` plus `RESERVED_PROJECT_SLUGS` live in one new module that neither
`lib/access/groups.ts` nor `lib/access/bootstrap.ts` can duplicate (bootstrap already imports from
groups, so the constants cannot live in bootstrap without a cycle). §2b and, later, AUDITFIX-21 and
-22 all consume that one predicate.

### 2b. The kind transition (`ensureSystemProject`)

Before flipping `source → system` (`lib/access/bootstrap.ts:64-72`), census `project_groups` for that
row. Any unsanctioned edge ⇒ **refuse the adoption**, naming the edge; `kind` stays `source` and the
team stays loudly un-bootstrapped rather than silently promoted with a forbidden grant.

⚠️ **The check must FAIL CLOSED, and round 1's BLOCKER 1 was that my acceptance did not say so.** The
obvious implementation destructures `{ data }`, treats an error-derived `null` as "no grants", and
flips a row that IS granted to `vendors` — reproducing the defect under an undetermined read while
every ordinary fixture passes.

⚠️ **The census is ONE joined read, and round 2's HIGH 3 is why.** Deciding whether an edge is
sanctioned needs the group's `slug` and `is_builtin`, not just its id. A two-read implementation can
fail closed on `project_groups` and still swallow the *group* lookup's error, discard the unresolved
edge, and promote. So: `.select("group_id, groups(slug, is_builtin)")` — the embedded form already
used at `lib/access/groups.ts:307` and `lib/access/oracle.ts:76` — with **the error captured**, and a
row whose group failed to resolve treated as **unsanctioned**, never as absent.

The adapter compiles that embed into a correlated `row_to_json` scalar subquery inside the **same**
statement (`lib/db/pg/query-builder.ts:299-325`), so a query failure fails the whole census (AC13)
and a missing group would surface as `groups: null` with **no error**. Today's composite FK makes that
second case unreachable (`postgres/schema.sql:1066-1074`) — the branch exists so a future left-join or
two-read form cannot fail open, and AC14 pins it against an injected result rather than pretending it
is seedable.

With §2a clause 2 in place a *new* forbidden edge cannot appear on a pre-adoption row at all, so §2b
is defence in depth against an edge that predates this slice or was written out of band.

## 3. Scope

**In:** `lib/access/groups.ts` (the writer guard + the fail-closed reads + the folded-in probe fix) ·
one new module for the shared sanctioned-edge predicate · `lib/access/bootstrap.ts` (the transition
guard) · `docs/ARCHITECTURE.md` · one **comment correction** in `lib/ingest/scheduler.ts:299-303`
(§3b).

**Folded in from AUDITFIX-10:** `lib/access/groups.ts:517` — the grant existence probe swallows its
error, so a read failure re-upserts an existing edge, **re-clobbering `added_by` and minting an audit
row claiming `created:true`** — the exact damage its own comment says select-first prevents. It is
inside the function §2a rewrites.

**Out:**
- **`lib/access/groups.ts:55` (`getMember`)** — ⚠️ *round 1 M7: it affects membership REMOVAL, not
  project grants.* Its own slice. AUDITFIX-10's remaining line dies with TIERRET-1.
- Atomic adoption — unnecessary now that §2a clause 2 closes the window.
- Any automatic deletion of a bad edge: a fail-open destructive repair is worse than a reported hole.

### 3a. The split, and why it goes one step further than the review asked

Round 2's MEDIUM 2 recommended splitting **repair** out from **prevention + detection**. AUDITFIX-21
already carries the repair half. I am splitting **detection** out as well, and the reason is a
dependency the review itself established:

- Round 2's HIGH 1 proves the detection channel **does not currently work**. `runAccessBootstrap`
  writes each per-team failure and then an instance-wide `access_bootstrap` heartbeat whose `ok`
  ignores them (`lib/ingest/scheduler.ts:304-325`). `STREAK_SQL`'s `newest` CTE is
  `distinct on (source)` over rows where `team_id = $1 or team_id is null`, ordered
  `finished_at desc, id desc` (`lib/ingest/pipeline-health.ts:296-325`) — so the later global
  `ok=true` row **wins over the affected team's failure**. The comment at `scheduler.ts:299-303`
  claiming a per-team failure *"reds only THAT team's health card"* is **false**.
- The two repairs I first reached for are both wrong. Making the global row red on any team failure
  reverses a deliberate shipped decision (that comment's *"would have turned every team's admin banner
  red"*). Preferring the team-scoped row in `newest` pins a **healed** team red forever, because
  `runAccessBootstrap` writes a per-team row **only on failure** — there is no per-team success row to
  supersede it.
- ⚠️ **But my round-2 fold then asserted "neither cheap fix works", and that is wrong — I did not look
  for a third, and the reviewer CONFIRMED the claim rather than catching it.** The same file already
  solves this exact problem for a different leg: `runContextBackfill` writes a per-team `context_backfill`
  row **on success as well as failure** (`lib/ingest/scheduler.ts:377-409`) and puts its instance-wide
  heartbeat under a **distinct source**, `context_backfill_all`, with a comment naming the reason —
  *"a teamId=null 'context_backfill' row would mask per-team rows under distinct-on"*
  (`lib/ingest/scheduler.ts:427-436,459-460`). So the fix for `access_bootstrap` is per-team success
  rows plus `access_bootstrap_all`, and it touches **one leg**, not every health card. That is smaller
  than I said and it belongs to AUDITFIX-22, whose ticket now carries it — but the split stands on
  slice size (four concerns), not on the fix being expensive. **A reviewer agreeing with a claim is not
  evidence for it.**

So a scheduled census landed here would be a detector whose output is invisible, and round 2's HIGH 2
(census placement can stop sanctioned grants converging) is a defect that only exists once that census
does. Both go to **AUDITFIX-22** together with the `assessAccessHealth` inverse assertion and the
health-ledger fix they depend on.

### 3b. The consequence of the split, stated rather than buried

§2b's refusal **wedges that team's bootstrap** — `ensureAccessBootstrap` returns early on the general
leg (`bootstrap.ts:117-118`), so the sanctioned grants stop converging for that team.

⚠️ **Round 3's HIGH 1: the wedge reaches further than "bootstrap does not converge", and I had not
traced it.** `backfillTeamContext` calls `ensureAccessBootstrap` again and **returns before processing
a single item** when it fails (`lib/projects/context/backfill.ts:45-47`), and the scheduler runs
backfill straight after bootstrap (`lib/ingest/scheduler.ts:41-46`). So a wedged team's **context
backfill stops entirely** — new items are never partitioned into their units and memberships.

What IS and IS NOT visible, traced rather than assumed:

| | |
|---|---|
| the `access_bootstrap` failure itself | **masked** — §3a |
| the downstream `context_backfill` failure | **VISIBLE** — per-team rows on success and failure, heartbeat under the distinct `context_backfill_all` source (`scheduler.ts:377-409,427-436`) |
| later scheduler stages | **not blocked** — `runAccessBootstrap` catches internally before the tick continues |
| a new member's builtin rows | **not blocked** — `ensureBuiltins` runs before the General adoption (`bootstrap.ts:113-117`) and member creation writes the invite-default membership independently (`lib/admin/members.ts:108-143`) |
| a forbidden edge that ALREADY exists on an already-`system` project | **undetected here, and CLI-unrevokable** — AUDITFIX-22 and -21 |

Four things make this acceptable rather than a silent regression, and the fourth is the condition:

1. **This wedge already ships.** `ensureSystemProject` has refused reserved-slug *initiatives* since
   slice 3 (`bootstrap.ts:57-60`) — same masked row, same downstream backfill stop. AUDITFIX-3 adds a
   second trigger for a state prod does not have (§0d) and that §2a makes newly unreachable.
2. **The false comment is corrected in this slice** (`scheduler.ts:299-303`), pointing at AUDITFIX-22.
3. **This document says detection is not fixed here** rather than letting a merge imply it works.
4. ⚠️ **A PRE-DEPLOY CENSUS IS REQUIRED, and it is a release condition, not a nicety** (round 3 HIGH
   1: on a self-hosted fleet with unknown state, prevention alone is not a complete mitigation). Before
   the guard is enabled on any instance, run the read-only census and record the result:

   ```sql
   select p.slug as project, g.slug as "group", g.is_builtin, pg.team_id
     from project_groups pg
     join projects p on p.id = pg.project_id
     join groups   g on g.id = pg.group_id
    where (p.kind = 'system' or (p.kind = 'source' and p.slug in ('general','external-shared')))
      and not (
            (p.slug = 'general'         and g.slug = 'everyone' and g.is_builtin)
         or (p.slug = 'external-shared' and g.slug in ('everyone','external') and g.is_builtin)
      );
   ```

   **Zero rows = safe to enable.** Any row means that instance would wedge the moment adoption next
   runs, with no in-product way to see or repair it until -21 and -22 land. **This fleet: run
   2026-08-23, zero rows** (§0d). The PR must carry the output, and the release note must carry the
   query for self-hosters.

## 4. Acceptance

⚠️ **Every refusal criterion names its `actorMemberId`, and round 3's BLOCKER 1 is why.** The real
exploit is the CLI, which passes **`null`** (`scripts/admin.ts:319-320`), while the dashboard passes the
creator's id (`app/actions/projects.ts:98-102`). Criteria that leave the actor unspecified admit
`if (actorMemberId !== null && unsanctioned && protectedProject) refuse()` — AC1 still passes because
bootstrap's own edges are sanctioned, every refusal criterion passes with a member actor, and
`admin.ts grant-project vendors general` **still creates the forbidden edge**. The invariant is
**actor-independent**, so the criteria must say so.

- **AC1 — bootstrap's own three edges still work (dm):** a full `ensureAccessBootstrap` on a fresh
  team succeeds and produces exactly them. *It calls the same writer with a NULL actor
  (`bootstrap.ts:139`); a guard that breaks it breaks every team's access.*
- **AC2 — a system project to an ORDINARY group is REFUSED, at the WRITER, with the OPERATOR's actor
  shape (dm):** `actorMemberId = null` and the operator opts `{authorizedByMemberId, via:"cli"}` — the
  exact tuple `scripts/admin.ts:319-320` builds. No edge row, no audit row.
- **AC3 — a system project to the WRONG builtin is REFUSED (dm):** `general→external`,
  `actorMemberId = null`.
- **AC4 — identity is slug AND `is_builtin` (dm):** an ordinary group slugged `external` is refused a
  grant to `external-shared`, `actorMemberId = null`.
- **AC5 — a RESERVED SLUG at `kind='source'` is REFUSED (dm):** `grantProjectToGroup(general@source,
  vendors, null)` fails. *Round 1 HIGH 3 — this is what closes the adoption race; without it the
  interval between the census and the CAS stays open.*
- **AC6 — the refusal is ACTOR-INDEPENDENT (dm):** the AC2 pair repeated with a **member**
  `actorMemberId` and with bare `opts = {}` is refused identically. ⚠️ *Round 3 BLOCKER 1 — AC2–AC5
  alone admit an actor-keyed bypass that leaves the CLI exploit open.*
- **AC7 — a reserved-slug INITIATIVE grants NORMALLY, through the dashboard's own tuple (dm):**
  build it exactly as `grantProjectToCreator` does — `ensurePersonSingleton(db, teamId, creatorId,
  creatorId)`, then `grantProjectToGroup(db, teamId, generalInitiativeId, singleton.groupId,
  creatorId, {})` — and assert `ok:true` with the edge present. ⚠️ *Round 2 BLOCKER 1 is the defect;
  round 3 HIGH 3 corrected my justification: I wrote that "nothing between `createProjectAction` and
  the writer is conditional", which is **false** — `grantProjectToCreator` calls `ensurePersonSingleton`
  first and returns without reaching the writer if it fails (`app/actions/projects.ts:92-102`). So the
  criterion reproduces the helper's whole body instead of asserting the path is unconditional; what it
  does NOT cover is `createProjectAction`'s session-dependent prologue, which is unrelated to this
  guard.*
- **AC8 — bootstrap still REFUSES to adopt that initiative (dm):** `ensureSystemProject` leaves
  `kind='initiative'` and errors. *The shipped `bootstrap.ts:57-60` behaviour AC7 depends on — if it
  ever relaxed, AC7's row would become adoptable while granted.*
- **AC9 — a NON-reserved, non-system project is unaffected (dm):** an ordinary initiative grants
  normally, with a NULL actor and with a member actor. *The guard must not become a general-purpose
  refusal.*
- **AC10 — an unreadable PROJECT refuses the grant (dm):** `ok:false`, no edge row, no audit row.
- **AC11 — an unreadable GROUP refuses the grant (dm):** ⚠️ *round 1 M6 — §2a said "project or group"
  and my acceptance covered only the project.* `ok:false`, no edge row, and no audit row.
- **AC12 — adoption REFUSES a `source` row carrying an unsanctioned grant (dm):** `kind` unchanged on
  the row, error names the edge, and no `access.project_adopted` audit row.
- **AC13 — adoption FAILS CLOSED on an unreadable grant census (dm):** ⚠️ *round 1 BLOCKER 1.* Seed
  the `source` row and verify it is present FIRST, then fault the `project_groups` census
  specifically; adoption returns an error attributable to that census and **`kind` is still `source`
  when re-read on the row**. *Round 2 HIGH 3's second half: asserting only "refused" lets the
  criterion pass because some unrelated read claimed the row did not exist.*
- **AC14 — an edge whose group does not resolve is UNSANCTIONED, never absent (dm):** with a faulted
  `DbClient` returning `{ data: [{ group_id, groups: null }], error: null }` for the census, adoption
  refuses and `kind` stays `source`. ⚠️ *Round 3 HIGH 2 — this cannot be seeded against real Postgres
  and I should have checked before writing a criterion: `project_groups.group_id` is `not null` under
  a composite FK with cascade delete (`postgres/schema.sql:1066-1074`), and the embed compiles to a
  correlated `row_to_json` scalar subquery inside the SAME statement
  (`lib/db/pg/query-builder.ts:299-325`), so a single snapshot can never show an edge whose group is
  gone. A **query** failure fails the whole census and is AC13. This criterion pins the classifier's
  treatment of a null embed, which is the branch a future left-join or two-read form would need.*
- **AC15 — adoption still promotes a CLEAN row (dm):** no grants, or only the sanctioned one, flips to
  `system` and audits.
- **AC16 — the swallowed grant probe is captured, with BOTH damages pinned (dm):** seed an existing
  edge with a **distinctive `added_by`**, fault the existence read, then assert all three: `ok:false`,
  `added_by` **unchanged**, and the count of `access.project_granted` audit rows **unchanged**.
  ⚠️ *Round 3 MEDIUM 1: `ok:false` alone does not prove neither write happened — an implementation can
  upsert, audit, and only then return failure.*

**Mutation coverage is per ENFORCEMENT POINT, not per file**, and each must redden **its own**
criterion, not merely some criterion. One mutation each for:

| # | mutation | must redden |
|---|---|---|
| 1 | delete the `kind='system'` clause | AC2 |
| 2 | delete the reserved-slug/`source` clause | AC5 |
| 3 | drop the `is_builtin` conjunct from edge identity | AC4 |
| 4 | make the refusal actor-dependent (`actorMemberId !== null &&`) | AC6 |
| 5 | swallow the writer's PROJECT read error | AC10 |
| 6 | swallow the writer's GROUP read error | AC11 |
| 7 | delete the adoption census refusal | AC12 |
| 8 | swallow the census read error | AC13 |
| 9 | treat a null `groups` embed as sanctioned/absent | AC14 |
| 10 | swallow the grant existence-probe error | AC16 |

*Mutations 4 and 9 exist because round 3 found each enforcement point unobservable through the
criteria as written — an omitted mutation is how the last slice shipped a guard two SQL owners shared
one fixture for.*

## 5. Risks

| risk | direction | mitigation |
|---|---|---|
| The guard refuses bootstrap's own three edges | **every team loses access** | AC1 runs the real bootstrap, not a fixture |
| The guard is keyed on the ACTOR, so the CLI exploit survives | the whole slice is decorative | **round 3 BLOCKER 1** — AC2–AC5 use the operator's NULL actor; AC6 pins actor-independence; mutation 4 |
| The reserved-slug rule breaks a legitimate grant | a creator cannot see the project they just made | **round 2 BLOCKER 1** — clause 2 is `source`-only; AC7 + AC8 pin both halves |
| Adoption refusal wedges a team's bootstrap AND its context backfill | the team stops partitioning new items; the `access_bootstrap` failure is masked | §3b — deliberate, pre-existing, surfaced via `context_backfill`, and gated on the pre-deploy census |
| An instance already holds a forbidden edge | it wedges on first adoption with no in-product repair | **the pre-deploy census is a release condition** (§3b.4), not advice |
| The census reads two relations and swallows one | a forbidden edge is promoted under an undetermined read | one joined read, error captured; a null embed is unsanctioned (AC14) |
| Someone reads the merge as fixing a live leak, or as adding detection | wasted expectation | §0d: zero forbidden edges on prod; §3a/§3b: detection and repair are separate tickets |

## 6. What the earlier spec rounds found (pre-round-1)

| # | finding | status |
|---|---|---|
| R1 | a second exploit through an **ordinary** group | **CONFIRMED** — AC2 |
| R1 | the repair path was **unreachable** — the verb refuses before the writer | **CONFIRMED** — split to AUDITFIX-21 |
| R2 | a kind-keyed guard is bypassed by adoption flipping kind later | **CONFIRMED** — §2b, and §2a clause 2 closes the window it left |
| R2 | *"revocable iff not sanctioned" fails open destructively if the canonical-group query errors* | **REFUTED as a defect** (no such query exists on today's revoke path; the kind read fails closed) — carried into AUDITFIX-21 as a design constraint |
| — | the audit's severity, *"hands outsiders the corpus"* | **RE-FRAMED** — §0e |

## 7. Round 1 of this document — BLOCKED

| # | finding | outcome |
|---|---|---|
| **B1** | acceptance let the adoption check itself fail open — destructure `{ data }`, treat an error as "no grants", flip anyway | **CONFIRMED.** §2b fails closed; **AC12** faults the read and asserts `kind` is still `source` |
| **B2** | revoke criteria exercised only the VERB while `groups.ts:555` says the **writer** owns the invariant | **CONFIRMED.** Carried whole into AUDITFIX-21 |
| **H3** | the accepted adoption race is avoidable — refuse on the reserved **SLUG** regardless of kind | **CONFIRMED and adopted**, then **narrowed by round 2** (§2a: `source`-only). Also corrected: the window is the census→CAS interval, not "one scheduler tick" |
| **H4** | the detector is only reachable by an operator asking | **CONFIRMED.** Split to AUDITFIX-22 |
| **H5** | the census had no fail-closed criterion | **CONFIRMED.** Split to AUDITFIX-22 with the census |
| **M6** | §2a promised "project OR group" and acceptance covered only the project | **CONFIRMED** — **AC10** |
| **M7** | the `getMember` fix belongs to membership removal | **CONFIRMED. Split out** (§3) |

## 8. Round 2 of this document — BLOCKED, and it found my fold breaking a live dashboard flow

| # | finding | re-derived | outcome |
|---|---|---|---|
| **B1** | clause 2's "regardless of kind" rejects the creator grant for a dashboard-created initiative named "General", leaving a project its creator cannot see — and the suggested admin repair calls the same writer. The spec's *"destined for adoption"* premise is false for `initiative` | **CONFIRMED.** `slugify("General")==="general"` (`lib/ids.ts:24-31`, re-run); `app/actions/projects.ts:39` inserts `kind:'initiative'`; `:74-82` treats grant failure as fatal; `bootstrap.ts:57-60` refuses to adopt an initiative | **ADOPTED** — §2a clause 2 is `source`-only; **AC6** + **AC7** |
| **B2** | the writer can be repaired while `revoke-project` stays permanently blocked — `revoke-verb.ts:47` refuses every `kind='system'` before the injected writer is reached | **CONFIRMED**, verbatim at `lib/access/revoke-verb.ts:47-50` | **Belongs to AUDITFIX-21**, and its ticket now carries the verb/writer agreement requirement |
| **H1** | a per-team scheduled failure is masked by the global heartbeat in the real health reader; the code comment claiming otherwise is false | **CONFIRMED.** `lib/ingest/scheduler.ts:304-325` writes the global row last; `lib/ingest/pipeline-health.ts` `newest` is `distinct on (source)` ordered `finished_at desc, id desc` | **Drives the split** (§3a). Comment corrected here; the fix is AUDITFIX-22 |
| **H2** | a census placed before convergence returns the required failure while a missing sanctioned edge is never restored | **CONFIRMED.** `ensureAccessBootstrap` grants the three edges last (`bootstrap.ts:112-142`) and returns early on the general leg | **Moves to AUDITFIX-22** with the census; converge-then-census is written into that ticket |
| **H3** | adoption's fail-closed promise covers `project_groups` but not group identity resolution; AC10 could also pass for the wrong reason | **CONFIRMED** — sanctioned-ness needs `slug` + `is_builtin` | **ADOPTED** — one joined census (§2b); **AC12** rewritten, **AC13** added |
| **M1** | the revised D2c order is invoked but never defined; the documented one (`groups.ts:559-564`) is obsolete once group identity is needed | **CONFIRMED** | **Belongs to AUDITFIX-21**; its ticket now names the proposed order |
| **M2** | the slice is too broad for one review unit | **CONFIRMED** | **ADOPTED, and taken further** — §3a |
| — | §1a's schema citations are stale | **CONFIRMED** — `schemas.ts:468/513` are the llm_usage and work_event payloads; the item payload is `item-payload-schema.ts:112` | **CORRECTED** — §1a |
| — | the structural claims (composite FKs, builtin/singleton hybrid, no rename path) | **CLEARED by the reviewer**, citations updated | §2a |

**Nothing is built. No code exists for this slice.**

## 9. Round 3 of this document — BLOCKED, on acceptance rather than design

No design defect this round: clause 2's narrowing, the joined census, and the split all survived. What
did not survive was the acceptance suite.

| # | finding | re-derived | outcome |
|---|---|---|---|
| **B1** | no refusal criterion names `actorMemberId`, so `if (actorMemberId !== null && …) refuse()` passes all fifteen while `admin.ts grant-project vendors general` still creates the edge | **CONFIRMED.** `scripts/admin.ts:319-320` passes `null`; `app/actions/projects.ts:98-102` passes the creator id | **ADOPTED** — AC2–AC5 use the operator tuple, **AC6** pins actor-independence, mutation 4 added |
| **H1** | §3b understates the wedge: `backfillTeamContext` re-runs bootstrap and returns before any item, so the team's context backfill stops; that failure IS visible under `context_backfill`, unlike `access_bootstrap` | **CONFIRMED.** `lib/projects/context/backfill.ts:45-47`; `lib/ingest/scheduler.ts:41-46,377-409` | **ADOPTED** — §3b traces what is and is not visible, and adds the **pre-deploy census as a release condition** |
| **H2** | AC13 (old) was not mechanically satisfiable — a null embed cannot be seeded under the FK, and a query error fails the whole census | **CONFIRMED**, and I had independently reached the same conclusion checking the adapter before the review returned | **ADOPTED** — split into AC13 (query error) and **AC14** (injected null embed), with mutation 9 |
| **H3** | AC6 (old) claimed "nothing between `createProjectAction` and the writer is conditional" — false; `ensurePersonSingleton` can return first | **CONFIRMED** at `app/actions/projects.ts:92-102` | **ADOPTED** — **AC7** reproduces `grantProjectToCreator`'s whole body and the false claim is deleted |
| **M1** | AC15 (old) asserted only `ok:false`, which does not prove the upsert and the false audit did not happen | **CONFIRMED** — `lib/access/groups.ts:517-535` | **ADOPTED** — **AC16** pins `added_by` unchanged and the audit count unchanged |
| — | the §2a grep claim, the corrected §1a citation, and §3a's ledger analysis | **CLEARED by the reviewer** | but see below |

⚠️ **The reviewer cleared a claim of mine that is wrong, and I caught it by following its own evidence.**
§3a asserted that *"neither cheap fix works"* for the masked health row. Round 3 confirmed that
reasoning. It is still wrong: the same file already solves this for another leg — per-team success rows
plus a distinct `context_backfill_all` heartbeat source, with a comment naming the distinct-on masking
(`lib/ingest/scheduler.ts:427-436,459-460`). The fix for `access_bootstrap` is the same shape and
touches one leg. §3a is corrected and AUDITFIX-22 carries it. **A reviewer agreeing is not evidence.**
