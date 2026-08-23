# A system project cannot be granted to an arbitrary group — AUDITFIX-3

**Status:** spec, round 0. No code written. Two earlier spec rounds BLOCKED an earlier version of this
slice (§6); this document is written against the re-derivation in `.context/rederive/lane-c.md`, which
corrected one of those findings and re-framed the severity.

**Build with:** opus / high — an irreversible write on the access substrate.

**Deps:** none to build. ⚠️ **Schedule BEFORE or WITH TIERRET-1** — §0c.

---

## What and why

**What:** `grantProjectToGroup` refuses to grant a **system** project to any group but its sanctioned
one, the operator verb gains a repair path for edges that already exist, and the health check reports
a forbidden edge instead of a clean bill of health.

**Why:** today one sanctioned CLI command creates a **permanent, CLI-unrevokable** grant of an entire
system corpus to an arbitrary group — and a second, entirely accidental path reaches the same state
with no bad intent at all.

## 0. Terrain, measured before designing

### 0a. The asymmetry, confirmed in today's code

| | |
|---|---|
| `grantProjectToGroup` (`lib/access/groups.ts:497-536`) | reads **no** `projects.kind`, checks **no** group class. `grant-project <anygroup> general` is legal |
| `revokeProjectFromGroup` (`lib/access/groups.ts:588`) | refuses **every** `kind='system'` revocation — *"raw SQL is the deliberate barrier"* |
| `revoke-verb.ts:47` | refuses again, **before** the writer is reached |
| `scripts/admin.ts:302` | the grant command selects only `"id, slug"` — kind is never resolved |

**So the door is one-way at both layers**, and repair requires raw SQL against `project_groups` —
which the single-writer guard exists to make an out-of-band act.

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

### 0e. Severity, stated rather than inflated

An operator who can run `scripts/admin.ts` already holds `DATABASE_URL` and could write the row
directly. **This is accident-prevention on a one-way door, not a privilege boundary.** The
irreversibility is the defect; the grant is not. That, plus §0b needing no bad intent, is the case
for fixing it — and it is a **Medium**, not a Critical. The earlier spec called it *"hands outsiders
the corpus"*, which the membership ruling has since retired.

## 1. The rule

> **A `kind='system'` project may hold a grant ONLY to its sanctioned group. Creating any other edge
> is refused at the writer; an edge that already exists is REPORTED and revocable through the
> sanctioned path; and adoption refuses to promote a project that carries an unsanctioned grant.**

The sanctioned set is exactly the three edges bootstrap itself creates
(`lib/access/bootstrap.ts:134-138`): `general→everyone`, `external-shared→external`,
`external-shared→everyone`. **Bootstrap calls the same writer**, so the guard must admit those three
and nothing else, or it breaks the thing it protects.

## 1a. How the accidental precondition arises — ordinary ingestion, verified

§0b starts from *"a team has `projects(slug='general', kind='source')`"*. That row needs **no operator
action at all**:

- `lib/ingest/index.ts:130-140` upserts `projects` with `slug: payload.project` **straight from the
  item payload**, on conflict `(team_id, slug)`.
- The payload's project is validated as `z.string().max(120)` (`lib/api/schemas.ts:468,513`) — **no
  reserved-slug check**. `isReservedSlug` (`lib/access/groups.ts:39`) guards GROUP slugs
  (`everyone`/`external`/`person-*`), never project slugs.
- `projects.kind` defaults to `'source'`
  (`postgres/migrations/20260809150000_projects_kind.sql:9`).

So pushing any item with `project: "general"` — a very plausible name — creates the row. Prod holds
**17 `source` projects and 2 `system`**, none currently squatting a reserved slug.

## 2. The design — five enforcement points

⚠️ *The audit called this "one conditional." Two earlier spec rounds found a second exploit and the
adoption bypass; round 1 of THIS document found the fifth, which also removes a race I had proposed to
accept.*

### 2a. The writer — kind AND reserved slug

`grantProjectToGroup` resolves the project and the target group, and refuses an unsanctioned pair when
**either**:

1. `projects.kind = 'system'`, **or**
2. `projects.slug ∈ {general, external-shared}` **regardless of current kind**.

Identity is **slug on both sides plus `groups.is_builtin`** — a slug-only check lets an ordinary group
squatting the `external` slug become an approved target (earlier round). Cross-team pairs are
prevented structurally by the composite FKs (`postgres/schema.sql:1073`), and a builtin/singleton
hybrid is prohibited at `:1047`, so neither needs a runtime conjunct.

⚠️ **Clause 2 is what closes the race, and it replaces §2b's accepted window.** Round 1: a
kind-keyed check leaves the interval between the adoption census and the CAS flip open. Refusing on
the reserved SLUG closes it from both sides — *before* adoption the slug rule refuses, *after*
adoption the kind rule refuses, and there is no instant in between where the grant is legal. A
`source` project holding a reserved slug is destined for adoption anyway.

*(My own independent version of this was "reserve the slugs at INGEST". Round 1's is better: the
ingest rule is a behaviour change on the push path — a wider blast radius — while this one lives in
the access writer that is already being rewritten.)*

**Fail closed on an unreadable project OR group.** A read error refuses the grant. Both reads, not
just the project one — `getMember` (`lib/access/groups.ts:54`) drops its error today and that is
exactly the mistake to not repeat.

### 2b. The kind transition (`ensureSystemProject`)

Before flipping `source → system` (`lib/access/bootstrap.ts:64-72`), read `project_groups` for that
row. Any unsanctioned edge ⇒ **refuse the adoption**, naming the edge; `kind` stays `source` and the
team stays loudly un-bootstrapped rather than silently promoted with a forbidden grant.

⚠️ **The check must FAIL CLOSED, and round 1's BLOCKER 1 was that my acceptance did not say so.** The
obvious implementation destructures `{ data }`, treats an error-derived `null` as "no grants", and
flips a row that IS granted to `vendors` — reproducing the defect under an undetermined read while
every ordinary fixture passes. A grant-read or group-resolution error refuses the adoption.

With §2a clause 2 in place the residual race is closed, so this is now defence in depth rather than
the only wall.

### 2c. The repair path — and the WRITER is the invariant owner

`revokeProjectFromGroup` says so in its own header: *"the destructive half of THE access edge, so the
invariants live HERE, not in any caller"* (`lib/access/groups.ts:555`). `lib/access/revoke-verb.ts` is a
preflight wrapper over an **injected** `revoke` (`:12-16`).

The refusal becomes **sanctioned-edge-based rather than kind-based**: a system project's *sanctioned*
edges stay unrevokable; an *unsanctioned* edge becomes revocable, so existing bad edges are repairable
through the sanctioned path.

⚠️ **Round 1's BLOCKER 2: acceptance that exercises only the verb proves nothing about the writer.**
An implementation can make the verb refuse all three sanctioned pairs while the writer protects only
`general→everyone` (the already-shipped case) and happily deletes `external-shared→external`. Every
criterion below therefore hits the **writer directly**, not through the verb.

**It must fail CLOSED**: an undetermined sanctioned-set read refuses to revoke. And it must **not
become an existence oracle** — `test/datamechanics/revoke-project.datamechanics.test.ts:154` pins
*"same refusal with or without an edge — no existence oracle"*, and the refusal's position in the
documented **D2c order** is pinned with it. Both survive.

### 2d. Detection that actually runs

⚠️ **Round 1's HIGH 4 killed my first answer.** I proposed the inverse assertion in
`assessAccessHealth`, whose only caller is the manual CLI (`scripts/admin.ts:422`) — the permission
inspector calls `explainItemVisibility`, not health (`app/api/dashboard/access/inspect/route.ts:58`).
A detector nobody asks does not detect.

So the census runs where the scheduler already goes: `ensureAccessBootstrapAllTeams` validates
**already-`system`** rows on every tick and returns an unsanctioned edge as a per-team failure, which
`runAccessBootstrap` (`lib/ingest/scheduler.ts:293`) already records as an `ingest_runs` row. The
`assessAccessHealth` assertion is added too, for the operator-asks path — but the scheduled one is
what makes it unattended.

**The census must fail closed as well** (round 1 HIGH 5): a swallowed edge-query error returning `[]`
would certify absence from an undetermined read. Existing health reads throw
(`lib/admin/access-health.ts:68`); this one matches them.

## 3. Scope

**In:** `lib/access/groups.ts` (writer guard + the shared sanctioned-edge predicate + the revoke
change) · `lib/access/bootstrap.ts` (transition guard + the per-tick validation) ·
`lib/access/revoke-verb.ts` · `lib/admin/access-health.ts` · `docs/ARCHITECTURE.md`.

**Folded in from AUDITFIX-10:** `lib/access/groups.ts:517` — the grant existence probe swallows its
error, so a read failure re-upserts an existing edge, **re-clobbering `added_by` and minting an audit
row claiming `created:true`** — the exact damage its own comment says select-first prevents. It is
inside the function §2a rewrites.

**Out:**
- **`lib/access/groups.ts:55` (`getMember`)** — ⚠️ *round 1 M7: it affects membership REMOVAL, not
  project grants; folding it in grows the review surface without helping this invariant.* Its own
  slice. AUDITFIX-10's remaining line dies with TIERRET-1.
- Atomic adoption — unnecessary now that §2a clause 2 closes the window.
- Any automatic deletion of a bad edge: a fail-open destructive repair is worse than a reported hole.

## 4. Acceptance

- **AC1 — bootstrap's own three edges still work (dm):** a full `ensureAccessBootstrap` on a fresh
  team succeeds and produces exactly them. *It calls the same writer with a NULL actor
  (`bootstrap.ts:139`); a guard that breaks it breaks every team's access.*
- **AC2 — a system project to an ORDINARY group is REFUSED, at the WRITER (dm).**
- **AC3 — a system project to the WRONG builtin is REFUSED (dm):** `general→external`.
- **AC4 — identity is slug AND `is_builtin` (dm):** an ordinary group slugged `external` is refused a
  grant to `external-shared`.
- **AC5 — a RESERVED SLUG at `kind='source'` is REFUSED (dm):** `grantProjectToGroup(general@source,
  vendors)` fails. *Round 1 HIGH 3 — this is what closes the adoption race, and without it the
  interval between the census and the CAS stays open.*
- **AC6 — a NON-reserved, non-system project is unaffected (dm):** an initiative grants normally.
  *The guard must not become a general-purpose refusal.*
- **AC7 — an unreadable PROJECT refuses the grant (dm).**
- **AC8 — an unreadable GROUP refuses the grant (dm):** ⚠️ *round 1 M6 — §2a said "project or group"
  and my acceptance covered only the project.* Assert `ok:false`, **no upsert, and no audit row**.
- **AC9 — adoption REFUSES a row carrying an unsanctioned grant (dm):** `kind` unchanged, error names
  the edge.
- **AC10 — adoption FAILS CLOSED on an unreadable grant census (dm):** ⚠️ *round 1 BLOCKER 1.* With
  the `project_groups` read faulted, adoption refuses and **`kind` remains `source`** — asserted on
  the row, not the return value.
- **AC11 — adoption still promotes a CLEAN row (dm):** no grants, or only the sanctioned one.
- **AC12 — an unsanctioned edge on a system project is revocable AT THE WRITER (dm).**
- **AC13 — ALL THREE sanctioned edges are refused AT THE WRITER (dm):** `general→everyone`,
  `external-shared→everyone`, `external-shared→external`. ⚠️ *round 1 BLOCKER 2: exercising the verb
  only lets the writer protect one shipped case and delete the other two.*
- **AC14 — the writer's refusal is not an existence oracle, and keeps its D2c position (dm):** the
  same refusal with and without the edge present, in the documented order.
- **AC15 — an undetermined sanctioned-set read REFUSES the revoke, at the WRITER (dm):** with the
  group read faulted, no delete occurs.
- **AC16 — the SCHEDULED bootstrap surfaces an unsanctioned edge on an already-system row (dm):**
  `ensureAccessBootstrapAllTeams` returns that team as failed, so `runAccessBootstrap` records it.
  *Round 1 HIGH 4 — detection that runs without an operator asking.*
- **AC17 — the census FAILS CLOSED (dm):** with the edge query faulted, the check throws or reports
  `healthy:false`; it never certifies absence from an undetermined read. *Round 1 HIGH 5.*
- **AC18 — a clean team stays healthy (dm):** without it, a check that always blocked would pass AC16
  and AC17.
- **AC19 — the swallowed grant probe is captured (dm):** with the existence read faulted, the writer
  returns `ok:false` rather than re-upserting and minting a false `created:true` audit row.

## 5. Risks

| risk | direction | mitigation |
|---|---|---|
| The guard refuses bootstrap's own three edges | **every team loses access** | AC1 runs the real bootstrap, not a fixture |
| The revoke change makes a sanctioned edge deletable | a member goes blind | AC13 + AC15, both at the **writer** |
| The revoke refusal becomes an existence oracle | information leak, and a tested contract broken | AC14 |
| Adoption refusal wedges a team's bootstrap | the team stays un-bootstrapped | deliberate and LOUD; the alternative is silent promotion with a forbidden grant |
| The reserved-slug rule breaks a legitimate grant | an ordinary project named `general` cannot be granted | intended — it is destined for adoption. AC6 pins that every other project is unaffected |
| Someone reads the merge as fixing a live leak | wasted expectation | §0d: zero forbidden edges on prod; §0e: Medium, accident-prevention |

## 6. What the earlier spec rounds found

| # | finding | status |
|---|---|---|
| R1 | a second exploit through an **ordinary** group | **CONFIRMED** — AC2 |
| R1 | the repair path was **unreachable** — the verb refuses before the writer | **CONFIRMED** — §2c |
| R2 | a kind-keyed guard is bypassed by adoption flipping kind later | **CONFIRMED** — §2b, and §2a clause 2 closes the window it left |
| R2 | *"revocable iff not sanctioned" fails open destructively if the canonical-group query errors* | **REFUTED as a defect** (no such query exists on today's revoke path; the kind read fails closed) — carried as a **design constraint**, AC15 |
| — | the audit's severity, *"hands outsiders the corpus"* | **RE-FRAMED** — §0e |

## 7. Round 1 of THIS document — BLOCKED, and it removed a race I had proposed to accept

| # | finding | outcome |
|---|---|---|
| **B1** | AC7/AC8 let the adoption check itself fail open — destructure `{ data }`, treat an error as "no grants", flip anyway; ordinary fixtures still pass | **CONFIRMED.** §2b fails closed; **AC10** faults the read and asserts `kind` is still `source` |
| **B2** | AC9-AC11 exercised only the VERB, while `groups.ts:555` says the **writer** owns the invariant and the verb takes an injected `revoke` | **CONFIRMED.** Every revoke criterion now hits the writer directly; **AC13** covers all three sanctioned edges, not the one already shipped |
| **H3** | the accepted adoption race is avoidable without transactions — refuse on the reserved **SLUG** regardless of kind | **CONFIRMED and adopted** (§2a clause 2, AC5). *I had independently reached "reserve the slugs at ingest"; this is the better version — the access writer is already being rewritten, the push path is not.* Also corrected: the window is the census→CAS interval, not "one scheduler tick" |
| **H4** | §2d's detector is only reachable by an operator asking — `assessAccessHealth`'s single caller is the CLI, and the inspector route calls something else | **CONFIRMED.** Validation moves into the **scheduled** bootstrap, whose failures already become `ingest_runs` rows (**AC16**) |
| **H5** | the new census had no fail-closed criterion — a swallowed error returning `[]` certifies `healthy:true` | **CONFIRMED** — **AC17** |
| **M6** | §2a promised "project OR group" and acceptance covered only the project | **CONFIRMED** — **AC8** |
| **M7** | the `getMember` fix belongs to membership removal, not project grants | **CONFIRMED. Split out** (§3); AC19 stays because it is inside the rewritten grant path |
| — | slug+builtin identity is adequate; cross-team and hybrid cases are prevented structurally; no rename path found | **CLEARED** |

**Nothing is built. No code exists for this slice.**
