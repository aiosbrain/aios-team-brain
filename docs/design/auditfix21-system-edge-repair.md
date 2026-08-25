# A forbidden system-project grant has a sanctioned repair — AUDITFIX-21

**Status:** spec, round 1 folded, **reshaped**. No code written. Round 1 returned BLOCKED and its
MEDIUM 9 offered a strictly safer design than the one I had specced; §2 takes it, and §7 records what
that replaced.

**Build with:** opus / high — a DESTRUCTIVE write on the access substrate.

**Deps:** AUDITFIX-3 (merged) for `isProtectedProject`/`isSanctionedSystemEdge`; AUDITFIX-23 (merged)
for the census whose findings this repairs. Last slice of the lane.

---

## What and why

**What:** ONE new, narrowly-named writer — `revokeUnsanctionedSystemEdge` — that deletes exactly one
edge the census would report, and a CLI verb that calls it. **`revokeProjectFromGroup` is not
touched**: its absolute `kind='system'` refusal, its documented D2c order, and both tests that pin
them stay exactly as they are.

**Why:** AUDITFIX-3 made the forbidden edge uncreatable; AUDITFIX-23 made an existing one visible.
Both shipped saying *"you will now be told, not it is now fixable."* Repair today is raw SQL against
`project_groups` — the out-of-band act the single-writer guard exists to make deliberate — so the
operator's only sanctioned move is the one the architecture calls a barrier.

## 0. Terrain, measured before designing

### 0a. Production, read-only, 2026-08-24

| | |
|---|---|
| edges on `kind='system'` projects | **3**, all sanctioned |
| forbidden edges | **0** |
| `access.project_revoked` audit rows, all time | **0** |
| `access.project_granted` audit rows | 3, newest 2026-08-11 |

⚠️ **What those zero audit rows do NOT prove** (round 1 MEDIUM 8, correcting my first draft): audit
writes are best-effort and swallow both returned errors and exceptions (`lib/api/audit.ts:16`), and a
successful **no-op** revoke deliberately writes no row (D3). So the honest statement is: **no
successful deletion is evidenced by `access.project_revoked`; actual invocations, and any unaudited
deletion, are unverified.** I had written "the verb has never successfully run."

**This slice repairs nothing on this fleet.** Its value is that the first operator to find a forbidden
edge has a sanctioned move.

### 0b. Why a NEW writer and not a reversal — the race that killed the first design

My first draft replaced `revokeProjectFromGroup`'s kind-based refusal with a pair-based one. Round 1's
BLOCKER 1 showed that shape can **delete a sanctioned edge**, which is a substrate outage for every
member of that team:

`ensureSystemProject` reads a reserved-slug **`source`** project, censuses its grants, then CAS-flips
it to `system` (`lib/access/bootstrap.ts:64-78`). An implementation that gates on
`kind === 'system'` alone classifies `general@source → everyone` as *not a system project, therefore
revocable* — and if the flip lands between that classification and the delete, the row it removes is
the now-sanctioned `general→everyone`.

The gate has to be **`isProtectedProject`**, which covers `kind='system'` **and** `kind='source'`
holding a reserved slug — the same predicate the grant writer uses, so both sides of the edge's
lifecycle agree. And the converse matters too: testing `isSanctionedSystemEdge` *without* a protection
gate would make an ordinary `kind='initiative'` project named `general` unrevokable, breaking the
legitimate creator-grant revoke that AUDITFIX-3 went out of its way to keep legal.

### 0c. A pre-existing D3 violation this slice must not inherit

`revokeProjectFromGroup` probes for the edge, deletes **without `RETURNING`**, then audits and reports
`revoked:true` unconditionally (`lib/access/groups.ts:805-825`). If a concurrent revoke removes the row
between probe and delete, **this call deleted nothing and audits success** — which contradicts D3 (*"no-op
revokes do NOT audit"*). The adapter supports `RETURNING` on a delete
(`lib/db/pg/query-builder.ts:416-420`), so the new writer uses it from the start.

⚠️ **The existing writer's copy of that bug is NOT fixed here** — it is a separate defect on a
function this slice deliberately does not touch, and widening is what round 2 blocked twice on the
previous slices. **AUDITFIX-26** carries it.

### 0d. What the shipped tests actually pin

Round 1's HIGH 6 corrected my §0c: `test/datamechanics/revoke-project.datamechanics.test.ts`'s **system-project arm uses
only a valid admin** (`:162`), and the principal matrix plus the present/absent oracle comparison run
against a **separate initiative project** (`:172`, `:197`). So the suite does *not* today pin
"system refusal before principal" or a sanctioned-pair oracle.

**Because this slice adds a writer instead of changing one, both shipped tests keep passing unmodified
— no conversion, no reversal, no re-derived D2c order.** That is the single biggest thing the reshape
buys.

## 1. The rule

> **`revokeUnsanctionedSystemEdge` deletes exactly one edge, and only if — at the moment of the
> delete — the project is protected, the pair is unsanctioned, and the caller is an active admin. It
> audits only a row it actually removed. Every other revoke path is unchanged.**

## 2. The design

### 2a. One narrow writer, authority first, identity revalidated at the delete

Signature (in `lib/access/groups.ts`, the single-writer file):

```
revokeUnsanctionedSystemEdge(db, teamId, { projectId, groupId }, actor: RevokeActor)
```

Order, and each step is a refusal that leaves the edge intact:

1. **Authority.** The same `activeAdminError` predicate the existing writer uses — role AND status AND
   posture. Nothing is read about the edge before this, so no unauthorized caller learns anything.
   *(Round 1 MEDIUM 7 narrowed my rationale: D2c's contract is specifically that an invalid principal
   must not learn EDGE EXISTENCE, not "anything at all". The guarantee this order buys is the plain
   one — **no delete can occur before authorization** — and an invalid principal gets a principal
   rejection rather than an observable sanctioned-pair refusal.)*
2. **Identity, fail closed.** Read the project (`kind, slug`) and group (`slug, is_builtin`). A read
   ERROR refuses with an **attributed** message, distinguishable from not-found — round 1's HIGH 3:
   a swallowed error yields `null`, takes the not-found branch, and produces an identical
   `ok:false`/edge-survives observable, so the mutation could not redden.
3. **Classify.** Refuse unless `isProtectedProject(project) && !isSanctionedSystemEdge(project.slug,
   group)`. Protected-and-sanctioned is the substrate: refused. Not protected at all: refused too —
   this writer is *only* for the forbidden-system-edge case, and an ordinary project's revoke keeps
   going through `revokeProjectFromGroup` unchanged.
4. **Delete with `RETURNING`,** scoped to `(team_id, project_id, group_id)`.
5. **Audit only if a row came back** — `access.project_revoked`, operator actor audits as `system`
   with `meta.authorizedByMemberId`, never in the actor field or `added_by`. No row returned ⇒
   `{ok:true, revoked:false}` and **no audit**, which is D3.

**The race is closed by construction:** classification reads and the delete are the same statement's
neighbours, and the delete is keyed on the ids — but the *decision* is re-made from the project's
CURRENT kind. A flip landing before step 2 makes the row protected-and-sanctioned and it is refused; a
flip landing after step 4 cannot un-delete a row that was unsanctioned when read. What is NOT claimed:
serializability. If identity could change between step 3 and step 4, the classification could be
stale — so §4 pins the interleaving that matters (`source → system` mid-call) rather than asserting it
away.

### 2b. A NEW CLI verb, so `revoke-project` keeps its meaning

`repair-system-edge <group-slug> <project-slug> --actor <admin-email>` — a separate command whose name
says what it does. `revoke-project` continues to refuse system projects with the same sentence it
prints today.

⚠️ **The wiring itself must be pinned, not just the pure layer** (round 1 BLOCKER 2). The existing
verb's dependency resolution is inline in `scripts/admin.ts` and today selects only `id`, swallowing
its error (`:341-343`). A type-correct `resolveGroup: async () => null` would satisfy every behavioural
criterion while leaving the command permanently broken. So the resolution moves into an **import-safe
factory** that §4 tests with the real dependency shape.

## 3. Scope

**In:** `lib/access/groups.ts` (the new writer) · a new verb module + its import-safe wiring factory ·
`scripts/admin.ts` (the command) · a structural guard · `docs/ARCHITECTURE.md`.

**Out:**
- **`revokeProjectFromGroup`** — untouched, including its D2c order and its `kind='system'` refusal.
- **The probe/delete/audit race in that existing writer** — **AUDITFIX-26** (§0c).
- **Any automatic repair.** The census reports; a human runs the command. A fail-open destructive
  sweep is worse than a reported hole (inherited from AUDITFIX-3 §3).
- **A UI.** The CLI is the sanctioned surface.

## 4. Acceptance

⚠️ Every criterion hits the **writer** unless it names the verb. Every fixture precondition is
asserted. Across this lane, ten criteria shipped green while testing nothing.

- **AC1 — an unsanctioned edge on a `kind='system'` project is revoked (dm):** `general→vendors`;
  `revoked:true`, the row is gone, one `access.project_revoked` audit row names the authorizer in meta.
- **AC2 — ALL THREE sanctioned pairs are REFUSED, for BOTH actor kinds (dm):** `general→everyone`,
  `external-shared→everyone`, `external-shared→external` × `{member, operator}` actors, each with a
  VALID admin; each edge survives. ⚠️ *Round 1 HIGH 4: "a sanctioned edge across actor shapes" is not
  the same matrix — a writer can refuse all three for operator actors and protect only
  `general→everyone` for member actors, and both my old criteria passed while an authorized member
  deleted either `external-shared` edge.*
- **AC3 — a SQUATTER group carrying a sanctioned slug does not inherit the exemption (dm):** an
  ordinary (`is_builtin:false`) group slugged `everyone`, granted `general`; the edge IS revocable.
  ⚠️ *Round 1 HIGH 3: every AC2 group is a real builtin, so dropping the `is_builtin` conjunct changes
  nothing there and its mutation could not redden.*
- **AC4 — a reserved-slug `kind='source'` project is PROTECTED (dm):** `general@source→everyone` is
  refused. *§0b — the gate is `isProtectedProject`, not `kind==='system'`.*
- **AC5 — and its unsanctioned edge is still revocable (dm):** `general@source→vendors` is revoked.
- **AC6 — a reserved-slug `kind='initiative'` is NOT protected (dm):** its creator grant is revocable
  through this writer's refusal path — i.e. the writer refuses it as *not its case*, and
  `revokeProjectFromGroup` still handles it. *§0b's converse: gating on the pair alone would make a
  legitimate initiative unrevokable.*
- **AC7 — the `source → system` FLIP mid-call cannot delete a sanctioned edge (dm):** with the flip
  interleaved between the identity read and the delete, `general→everyone` **survives**. ⚠️ *Round 1
  BLOCKER 1 — the whole reason this is a new writer.*
- **AC8 — an undetermined GROUP read refuses, ATTRIBUTED (dm):** the error names a read failure,
  distinguishable from "group not found"; no delete; edge survives.
- **AC9 — an undetermined PROJECT read refuses, ATTRIBUTED (dm):** same.
- **AC10 — an unauthorized principal is refused BEFORE anything is read about the edge (dm):**
  non-admin, inactive, external-posture and unknown principals each get a principal rejection, the
  edge survives, and no audit row is written.
- **AC11 — no edge-existence oracle (dm):** an invalid principal gets the SAME refusal whether the
  edge exists or not.
- **AC12 — a no-op revoke does NOT audit (dm):** an authorized admin against an absent (but otherwise
  valid, unsanctioned) pair gets `{ok:true, revoked:false}` and **zero** new audit rows. *D3.*
- **AC13 — a concurrent delete between read and delete does not audit a phantom (dm):** with the row
  removed after classification, the call reports `revoked:false` and writes no audit row. *§0c — this
  is what `RETURNING` buys, and the existing writer's copy of the bug is AUDITFIX-26.*
- **AC14 — the VERB reaches the writer for an unsanctioned edge (unit):** `repair-system-edge` calls
  the injected writer once with the resolved ids.
- **AC15 — the VERB's REAL wiring resolves the identity it needs (unit):** the import-safe factory,
  driven by a fake db, returns a group carrying `id`, `slug` and `is_builtin` and a project carrying
  `kind` and `slug`, and surfaces a read error rather than `null`. ⚠️ *Round 1 BLOCKER 2 — a
  type-correct `resolveGroup: async () => null` passes every behavioural criterion while the command
  stays permanently broken.*
- **AC16 — `revoke-project` is UNCHANGED (unit + dm):** it still refuses `kind='system'` before the
  writer, with the same message, and `revokeProjectFromGroup` still refuses every system edge. *The
  shipped tests are the criterion; they must pass unmodified.*

**Mutation coverage, one per enforcement point, each reddening ITS OWN criterion:**

| # | mutation | must redden |
|---|---|---|
| 1 | gate on `kind === 'system'` instead of `isProtectedProject` | AC4 |
| 2 | drop the protection gate (classify by pair alone) | AC6 |
| 3 | drop the sanctioned test entirely | AC2 |
| 4 | protect only `general→everyone` | AC2 |
| 5 | protect only for operator actors | AC2 |
| 6 | drop the `is_builtin` conjunct | AC3 |
| 7 | re-read identity BEFORE authority | AC10 |
| 8 | swallow the group read error into not-found | AC8 |
| 9 | swallow the project read error into not-found | AC9 |
| 10 | delete without `RETURNING` and audit unconditionally | AC13 |
| 11 | audit on a no-op | AC12 |
| 12 | classify once, before the authority check, and reuse it | AC7 |
| 13 | have the wiring factory select only `id` | AC15 |
| 14 | make `revoke-project` route to the new writer | AC16 |

## 5. Risks

| risk | direction | mitigation |
|---|---|---|
| A sanctioned edge is deleted | **substrate outage — every member of that team goes blind** | AC2 (3 pairs × 2 actor kinds), AC4, AC7; mutations 1-5, 12 |
| The adoption flip races the delete | the same outage, intermittently | AC7, mutation 12 |
| A legitimate initiative becomes unrevokable | a creator stranded, reversing AUDITFIX-3's ruling | AC6, mutation 2 |
| An undetermined read deletes | destructive fail-open | AC8/AC9 with ATTRIBUTED errors; mutations 8, 9 |
| A phantom audit claims a deletion that did not happen | the trail lies | AC12/AC13; mutations 10, 11 |
| The command is wired to nothing | ships broken, every test green | AC15, mutation 13 |
| `revoke-project`'s meaning drifts | a shipped contract reversed by accident | AC16, mutation 14 |

## 6. What this slice does NOT prove

Nothing is repaired automatically, and the census gains no authority. On this fleet it changes nothing
observable (§0a: zero forbidden edges). It also does not fix the existing writer's phantom-audit race
(§0c, AUDITFIX-26).

## 7. Round 1 — BLOCKED, and it replaced my design with a smaller one

| # | finding | re-derived | outcome |
|---|---|---|---|
| **B1** | the pair-based reversal can DELETE A SANCTIONED EDGE: gate on `kind==='system'` alone and the `source→system` CAS flip lands between classification and delete | **CONFIRMED** (`lib/access/bootstrap.ts:64-78`) | **RESHAPED** — `isProtectedProject` is the gate, and §2a/AC7 pin the interleaving |
| **B2** | nothing proved the REAL CLI wiring works — it selects only `id` and swallows its error, so `resolveGroup: async () => null` passes everything | **CONFIRMED** (`scripts/admin.ts:341-343`) | **ADOPTED** — an import-safe factory, **AC15**, mutation 13 |
| **H3** | three mutations could not redden: `is_builtin` (every fixture was a real builtin) and the two swallowed-read ones (identical observable) | **CONFIRMED** | **ADOPTED** — **AC3**'s squatter, and ATTRIBUTED errors in AC8/AC9 |
| **H4** | AC3 was not the Cartesian matrix its wording implied | **CONFIRMED** | **ADOPTED** — **AC2** is 3 pairs × 2 actor kinds |
| **H5** | the EXISTING writer probes, deletes without `RETURNING`, then audits unconditionally — a phantom audit under a concurrent delete, contradicting D3 | **CONFIRMED** (`lib/access/groups.ts:805-825`) | **ADOPTED for the new writer** (AC13); the existing one is **AUDITFIX-26**, not widened into here |
| **H6** | §0c overstated the shipped dm test: its system arm uses only a valid admin, and the matrix runs on a separate initiative project | **CONFIRMED** | **ADOPTED** — §0d, and the reshape means those tests need no conversion at all |
| **M7** | Option B is right but my rationale was too broad; D2c is about EDGE existence specifically | **CONFIRMED** | **ADOPTED** — §2a states the guarantee as "no delete before authorization" |
| **M8** | zero audit rows do not prove the verb never ran — audit is best-effort and a no-op writes none | **CONFIRMED** (`lib/api/audit.ts:16`) | **ADOPTED** — §0a restated |
| **M9** | the safer scope is a dedicated `revokeUnsanctionedSystemEdge`, not a general reversal | **CONFIRMED and ADOPTED WHOLESALE** | this document |

⚠️ **What the reshape bought, stated plainly:** the first design **reversed a deliberate, tested
decision** — the writer's absolute system refusal — and needed two shipped tests converted and the
documented D2c order re-derived. This one adds a writer and touches neither. When a review offers a
design that removes a reversal, that is worth more than the criteria it also fixes.

**Nothing is built. No code exists for this slice.**
