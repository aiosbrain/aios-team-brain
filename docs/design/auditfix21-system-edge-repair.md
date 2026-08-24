# A forbidden system-project grant can be REVOKED through the sanctioned path — AUDITFIX-21

**Status:** spec, round 0. No code written. The REPAIR half, split out of AUDITFIX-3 at its round 2.

**Build with:** opus / high — a DESTRUCTIVE write on the access substrate, and it reverses a shipped,
tested refusal.

**Deps:** AUDITFIX-3 (merged) for `isSanctionedSystemEdge`; AUDITFIX-23 (merged) for the census this
validates against. Neither is required at runtime — this is the last slice of that lane.

---

## What and why

**What:** `revokeProjectFromGroup` stops refusing on `projects.kind` and starts refusing on the
**sanctioned pair**. A system project's three sanctioned edges stay unrevokable; an **unsanctioned**
edge on a system project becomes revocable — and the `revoke-project` CLI verb agrees with the writer
instead of refusing first.

**Why:** AUDITFIX-3 made the forbidden edge uncreatable and AUDITFIX-23 made an existing one visible.
Both merged with the same sentence in their PR bodies: *"you will now be told, not it is now fixable."*
Today a detected edge is repairable only by raw SQL against `project_groups` — the exact out-of-band
act the single-writer guard exists to make deliberate — so the operator's only sanctioned move is one
the architecture calls a barrier.

## 0. Terrain, measured before designing

### 0a. Production, read-only, 2026-08-24

| | |
|---|---|
| edges on `kind='system'` projects | **3**, all sanctioned |
| forbidden edges | **0** |
| `access.project_revoked` audit rows, all time | **0** — the verb has never successfully run |
| `access.project_granted` audit rows | 3, newest 2026-08-11 |

**So this slice repairs nothing on this fleet**, and its revoke path has never been exercised in
production. That is the case for building it carefully rather than the case for skipping it: the first
real use will be an operator with a live problem, and there is no production experience to fall back on.

### 0b. Both layers refuse today, and the outer one refuses FIRST

| layer | refusal |
|---|---|
| `lib/access/revoke-verb.ts:47-50` | any `kind === "system"` project, **before** the injected writer is reached |
| `lib/access/groups.ts` (the writer) | any `kind === 'system'` project, as step (1) of the documented D2c order |

Fixing only the writer leaves `revoke-project vendors general` **permanently blocked** — the finding
AUDITFIX-3's round 1 made, and the reason every criterion below hits the **writer** directly while a
separate set pins the **verb**.

### 0c. The two shipped tests that encode the intent this reverses

- `test/admin-cli-revoke.test.ts:47-53` — *"the system-kind preflight names the substrate and never
  reaches the writer"*, asserting `revoke` was **not** called.
- `test/datamechanics/revoke-project.datamechanics.test.ts:154+` — the writer refuses a system project
  **in D2c order, with the edge INTACT**, and the principal matrix at `:178-207` pins **no existence
  oracle**: an invalid principal gets the *same* refusal whether or not the edge exists.

Both get **CONVERTED, not deleted**. The first's real content is *message quality plus "the writer is
not reached for a case the verb can decide"*; the second's is *the substrate edge survives* and *no
oracle* — all three survive this change, applied to the sanctioned pair instead of the kind.

## 1. The rule

> **A SANCTIONED edge is unrevokable through the writer, whatever the principal. An UNSANCTIONED edge
> on a system project is revocable by an authorized principal, audited. Neither layer may become an
> edge-existence oracle, and an undetermined identity read refuses.**

## 2. The design

### 2a. The writer's refusal becomes pair-based — and the D2c order has to be re-derived

The current order is `(1) project resolution + kind refusal → (2) principal validation → (3) existence
probe → (4) delete + audit`, and step (3) sits after (2) precisely so `{revoked:false}` is reachable
only by an authorized principal — an unordered writer *"turns invalid principals into an
edge-existence oracle"* (`lib/access/groups.ts`, the D2c contract).

Deciding whether a pair is sanctioned needs the **group's** identity too, which the current order never
reads. **That makes the documented order obsolete, and the replacement is a real fork:**

| option | order | what it costs |
|---|---|---|
| **A** | resolve project **and group** identity → refuse a sanctioned pair → principal → probe → delete | an unauthorized principal can learn whether a GROUP exists ("no group for team"), which today it cannot |
| **B** | principal validation → resolve identity → refuse a sanctioned pair → probe → delete | the substrate refusal becomes conditional on authorization, so an unauthorized operator gets "principal rejected" where today it gets the substrate sentence |

**Recommendation: B.** The D2c contract exists to stop an unauthorized principal learning ANYTHING it
could not learn otherwise, and A adds a new leak in the same family it was written to close. B leaks
strictly less. The cost is only message ORDERING for a caller who was going to be refused either way,
and the substrate is still absolutely unrevokable — a sanctioned pair is refused for every principal
that gets that far. ⚠️ **This reverses the documented "(1) … kind refusal" position deliberately**, so
the spec states it as the decision it is, and §4 pins the resulting order.

**Fail closed:** an undetermined project OR group read refuses the revoke — never "not sanctioned,
proceed". A missing project or group is a refusal, not a deletion.

**Unsanctioned system edges become deletable, and that IS the point** — but nothing else changes: the
sanctioned three are refused for every principal, and a non-system project behaves exactly as today.

### 2b. The verb agrees with the writer instead of refusing first

`runRevokeProjectVerb`'s preflight is documented as *"message quality only — the writer refuses
independently"*. It currently refuses on `kind === "system"`, which is now WRONG for an unsanctioned
edge. It must classify by the **same sanctioned-pair predicate**, which means its `RevokeVerbDeps` need
the group's identity, not just its id: `resolveGroupId` becomes `resolveGroup` returning
`{ id, slug, is_builtin }`.

**One predicate, both layers** — the AUDITFIX-23 lesson applied in advance: the verb and the writer must
not carry two copies of the sanctioned decision, and a structural guard asserts it.

### 2c. What this slice must NOT become

- **No automatic repair.** The census reports; the operator revokes. A fail-open destructive sweep is
  worse than a reported hole — inherited from AUDITFIX-3 §3 and unchanged.
- **No new authority.** The revoke still requires a named ACTIVE ADMIN authorizer, still audits as
  `system` with `meta.authorizedByMemberId`, and still never writes the authorizer into the actor field
  or `added_by`.

## 3. Scope

**In:** `lib/access/groups.ts` (the writer's refusal + the new order) · `lib/access/revoke-verb.ts`
(the preflight + `RevokeVerbDeps`) · `scripts/admin.ts` (the verb's wiring for the richer group
resolution) · the two converted tests · a structural guard · `docs/ARCHITECTURE.md`.

**Out:**
- **Automatic deletion of a detected edge** — §2c.
- **A UI for revoke** — the CLI is the sanctioned surface; unchanged.
- **The evidence channel** (AUDITFIX-25) and **the staleness beat** (AUDITFIX-24).

## 4. Acceptance

⚠️ **Every criterion hits the WRITER directly unless it names the verb**, because the writer owns the
invariant and the verb takes an *injected* revoke — an implementation can make the verb behave while the
writer deletes a sanctioned edge. And every fixture precondition is asserted; across this lane, ten
criteria have shipped green while testing nothing.

- **AC1 — an UNSANCTIONED edge on a system project is REVOCABLE at the writer (dm):** planted
  `general→vendors`; an authorized admin revokes it, `revoked:true`, the row is gone, and an
  `access.project_revoked` audit row exists naming the authorizer in meta.
- **AC2 — ALL THREE sanctioned edges are REFUSED at the writer (dm):** `general→everyone`,
  `external-shared→everyone`, `external-shared→external`, each with a valid admin; each edge SURVIVES.
  *AUDITFIX-3 round 1's blocker: exercising the verb only lets the writer protect the one shipped case
  and delete the other two.*
- **AC3 — a sanctioned edge is refused for EVERY principal shape (dm):** member-actor and
  operator-actor, admin and non-admin; the edge survives each.
- **AC4 — a NON-system project is unaffected (dm):** revoke behaves exactly as before.
- **AC5 — NO EXISTENCE ORACLE survives the reorder (dm):** an invalid principal gets the SAME refusal
  against a present edge and an absent one, on a non-system project. *The tested contract at
  `revoke-project.datamechanics.test.ts:178-207`, re-pinned against the new order.*
- **AC6 — and no oracle for the SANCTIONED case either (dm):** an invalid principal gets the same
  refusal whether the sanctioned edge is present or absent.
- **AC7 — the NEW D2c order is pinned (dm):** with an invalid principal AND an unsanctioned system
  edge present, the refusal names the PRINCIPAL, not the substrate — proving principal validation
  precedes the pair test (option B). *If the team takes option A instead, this criterion inverts and
  the spec must say so.*
- **AC8 — an undetermined GROUP read refuses (dm):** with the group read faulted, `ok:false`, no
  delete, and the edge survives.
- **AC9 — an undetermined PROJECT read refuses (dm):** same.
- **AC10 — the VERB reaches the writer for an unsanctioned edge (unit):** `revoke-project vendors
  general` calls the injected revoke exactly once with the resolved ids. *Converted from
  `admin-cli-revoke.test.ts:47` — the preflight must no longer refuse it.*
- **AC11 — the VERB still refuses all three sanctioned pairs BEFORE the writer (unit):** `revoke` not
  called, and the message still names the substrate. *The other half of the converted test — message
  quality was its real content.*
- **AC12 — verb and writer AGREE (unit + dm):** for each of the three sanctioned pairs and for one
  unsanctioned edge, the verb's decision and the writer's decision match. *An implementation can fix
  one layer and leave the other inverted.*
- **AC13 — one predicate, both layers (unit, structural):** neither `lib/access/revoke-verb.ts` nor the verb's
  wiring reimplements the sanctioned decision; both consume `isSanctionedSystemEdge`.
- **AC14 — the converted dm test keeps its other contracts (dm):** the principal matrix, the D3
  no-audit-on-no-op rule, and the grant-meta laundering assertions at
  `revoke-project.datamechanics.test.ts:178-230` all still pass.

**Mutation coverage, one per enforcement point, each reddening ITS OWN criterion:**

| # | mutation | must redden |
|---|---|---|
| 1 | refuse on `kind === 'system'` again (the pre-slice shape) | AC1 |
| 2 | allow ALL system edges (drop the sanctioned test) | AC2 |
| 3 | protect only `general→everyone` (the already-shipped case) | AC2 |
| 4 | drop the `is_builtin` conjunct from the pair test | AC2 |
| 5 | move the pair test BEFORE principal validation | AC7 |
| 6 | move the existence probe BEFORE principal validation | AC5 |
| 7 | swallow the group read error | AC8 |
| 8 | swallow the project read error | AC9 |
| 9 | leave the verb's `kind === 'system'` preflight in place | AC10 |
| 10 | make the verb refuse NOTHING (drop its preflight entirely) | AC11 |
| 11 | reimplement the pair decision in the verb | AC13 |

## 5. Risks

| risk | direction | mitigation |
|---|---|---|
| A sanctioned edge becomes deletable | **a substrate outage — every member of that team goes blind** | AC2 + AC3 at the WRITER; mutations 2, 3, 4 |
| The reorder creates an existence oracle | information leak, and a tested contract broken | AC5 + AC6; mutations 5, 6 |
| The verb and the writer disagree | the operator command stays blocked, or refuses what the writer allows | AC12, mutations 9, 10 |
| An undetermined read deletes | a destructive fail-open | AC8 + AC9; mutations 7, 8 |
| The converted tests lose what they protected | a silent hole where a green test used to be | AC14 names the surviving assertions |
| Option B's reordering surprises an operator | a different refusal message than before | §2a states it as a decision; AC7 pins it |

## 6. What this slice does NOT prove

It does not repair anything automatically, and it gives the census no new authority. On this fleet it
changes nothing observable (§0a: zero forbidden edges) — its value is that the first operator to find
one has a sanctioned move.

**Nothing is built. No code exists for this slice.**
