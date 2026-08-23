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

## 2. The design — four enforcement points, because it is not one conditional

⚠️ *The audit called this "one conditional." An earlier spec round found a second exploit through an
ordinary group, and a third round found the adoption bypass. It is four places.*

### 2a. The writer (`grantProjectToGroup`)

Resolve `projects.kind`; if `system`, admit only the sanctioned `(project.slug, group.slug)` pair.
Identity is by **slug on both sides plus `groups.is_builtin`** — an earlier round found that a
slug-only check lets an ordinary group squatting the `external` slug become an approved target.

**Fail closed on an unreadable kind or group:** a read error must refuse the grant, not permit it.

### 2b. The kind TRANSITION (`ensureSystemProject`)

Before flipping `source → system`, read `project_groups` for that row. If any edge is not sanctioned,
**refuse the adoption** and return an error naming the edge — the team stays un-bootstrapped and loud
rather than silently promoted with a forbidden grant.

⚠️ **The residual race, named:** a grant that lands between the check and the CAS flip survives. The
flip is already a compare-and-set on `kind='source'`, so it cannot be made atomic with the grant read
through this adapter (the transaction surface is AUDITFIX-12/13). The window is one scheduler tick
wide and the narrowing is deliberate: **§2d detects what §2b cannot prevent**, and no automatic
deletion is added, because a fail-open destructive repair is worse than a reported hole.

### 2c. The repair path (`revoke-verb.ts` + `revokeProjectFromGroup`)

The refusal becomes **sanctioned-edge-based rather than kind-based**: a system project's *sanctioned*
edges stay unrevokable; an *unsanctioned* edge on a system project becomes revokable through the
verb. Without this, fixing the writer leaves every existing bad edge permanent.

⚠️ **This must fail CLOSED.** An earlier spec round's finding — *"revocable iff not sanctioned" fails
open destructively if the canonical-group query errors, classifying `general→everyone` as forbidden
and blinding every member* — is **not a defect in today's code** (lane C verified: there is no such
query on the revoke path, and the kind read already fails closed). It is a **design constraint on
this change**: an undetermined sanctioned-set read must refuse to revoke.

### 2d. The census (`assessAccessHealth`)

`lib/admin/access-health.ts` detects members who are **blind**; it has no inverse assertion, so a
forbidden edge reports green. Add one: enumerate every `project_groups` edge whose project is
`kind='system'` and whose pair is not sanctioned, and report it as a **blocker** with the edge named.

## 3. Scope

**In:** `lib/access/groups.ts` (the writer guard + the sanctioned-edge predicate) ·
`lib/access/bootstrap.ts` (the transition guard) · `lib/access/revoke-verb.ts` ·
`lib/admin/access-health.ts` · `docs/ARCHITECTURE.md`.

**Folded in from AUDITFIX-10** (re-derivation: it is 2 fail-opens + 1 provenance bug, not 24, and both
of its surviving lines live in this slice's edit surface):
- `lib/access/groups.ts:55` — `getMember` swallows its read error, so `removeMemberFromGroup`'s
  non-human refusal does not fire. Direction is narrowing, not widening; closed on principle.
- `lib/access/groups.ts:517` — the grant existence probe swallows its error, so a read failure
  re-upserts an existing edge, **re-clobbering `added_by` and minting an audit row claiming
  `created:true`** — precisely the damage its own comment says select-first exists to prevent. It sits
  inside the function §2a rewrites.

**Out:** the `units.ts:53` fail-open (AUDITFIX-10's third — it exists only because `noWideningGate`
reads a stored audience, and **TIERRET-1 deletes the gate**) · atomic adoption (§2b — needs the
transaction surface, AUDITFIX-12/13) · any automatic deletion of a bad edge.

## 4. Acceptance

- **AC1 — the three sanctioned edges are still creatable (dm):** a full `ensureAccessBootstrap` on a
  fresh team succeeds and produces exactly those three. *Bootstrap calls the same writer; a guard that
  breaks it breaks every team's access.*
- **AC2 — a system project to an ORDINARY group is REFUSED (dm):** `grantProjectToGroup(general,
  vendors)` returns `ok:false` and writes no row. *The exploit an earlier round found; the audit's
  version only named the builtin `external` group.*
- **AC3 — a system project to the WRONG builtin is REFUSED (dm):** `general→external` — the forbidden
  fourth edge the audit named.
- **AC4 — identity is slug AND `is_builtin` (dm):** an ordinary group whose slug is `external` is
  refused a grant to `external-shared`, so slug-squatting does not become an approved target.
- **AC5 — a NON-system project is unaffected (dm):** granting an initiative to any group still works.
  *The guard must not become a general-purpose refusal.*
- **AC6 — an unreadable kind REFUSES (dm):** with the `projects` read faulted, the grant is refused
  rather than permitted.
- **AC7 — adoption REFUSES a row carrying an unsanctioned grant (dm):** a `kind='source'` project
  slugged `general` with a `vendors` grant is not promoted; the error names the edge; `kind` is
  unchanged. *§0b's accidental path, closed.*
- **AC8 — adoption still promotes a CLEAN row (dm):** the same shape with no grants, or with only the
  sanctioned one, is adopted normally.
- **AC9 — an unsanctioned edge on a system project is REVOCABLE through the verb (dm):** planted with
  raw SQL, then removed by `revoke-project`. **AC10 is what stops this from being a hole.**
- **AC10 — a SANCTIONED edge is still refused by the verb (dm):** `general→everyone` cannot be revoked.
  *Without this, AC9 is satisfied by deleting the refusal entirely.*
- **AC11 — an undetermined sanctioned-set read REFUSES the revoke (dm):** with the group read faulted,
  the verb refuses rather than classifying a sanctioned edge as forbidden and deleting it.
- **AC12 — the health check reports a forbidden edge as a BLOCKER (dm):** planted edge ⇒ `healthy:false`
  with the edge named. And a clean team stays healthy — *without that half, a check that always
  blocked would pass.*
- **AC13 — the swallowed grant probe is captured (dm):** with the existence read faulted,
  `grantProjectToGroup` returns `ok:false` rather than re-upserting and minting a false
  `created:true` audit row.
- **AC14 — the swallowed member read is captured (unit/dm):** with `getMember` faulted,
  `removeMemberFromGroup` refuses rather than skipping its non-human check.

## 5. Risks

| risk | direction | mitigation |
|---|---|---|
| The guard refuses bootstrap's own three edges | **every team loses access** | AC1 runs the real bootstrap, not a fixture |
| The revoke change makes a sanctioned edge deletable | a member goes blind | AC10 + AC11, both directions |
| Adoption refusal wedges a team's bootstrap | the team stays un-bootstrapped | deliberate and LOUD (§2b); the alternative is silent promotion with a forbidden grant |
| The transition race (§2b) | a bad edge survives adoption | detected by §2d; not silently accepted |
| Someone reads the merge as fixing a live leak | wasted expectation | §0d: zero forbidden edges on prod; §0e: Medium, accident-prevention |

## 6. What the two earlier spec rounds found

Recorded because this document is written *after* them, and one of their findings was refuted by the
re-derivation.

| # | finding | status |
|---|---|---|
| R1 | a second exploit through an **ordinary** group, which all eight of the then-criteria passed | **CONFIRMED** — AC2 |
| R1 | the repair path was **unreachable**: `revoke-verb.ts:47` refuses before the writer, so fixing the writer alone leaves the command refusing | **CONFIRMED** — §2c |
| R2 | a guard keyed on kind **at grant time** is bypassed by adoption flipping kind later | **CONFIRMED** — §2b, AC7 |
| R2 | *"revocable iff not sanctioned" fails open destructively if the canonical-group query errors* | **REFUTED as a defect** — lane C verified there is no such query on today's revoke path, and the kind read fails closed. Carried as a **design constraint** instead — AC11 |
| — | the audit's severity (*"hands outsiders the corpus"*) | **RE-FRAMED** — §0e |
