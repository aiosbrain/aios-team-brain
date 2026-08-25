# A revoke that revoked nothing must not claim it did — AUDITFIX-26

**Status:** spec, round 0. No code written. Found by AUDITFIX-21's spec round 1 (HIGH 5) on a function
that slice deliberately did not touch.

**Build with:** opus / high — it changes a destructive writer's trail, and the trail is the only
record of who removed access from whom.

**Deps:** none. AUDITFIX-21 (merged) already ships the fix's exact shape and its criterion, in the
sibling writer; this applies both to the older one.

---

## What and why

**What:** `revokeProjectFromGroup` probes for the edge, deletes **without `RETURNING`**, then audits
and returns `revoked: true` **unconditionally**. A concurrent revoke that removes the row between the
probe and the delete leaves this call having deleted **nothing** — while it writes an
`access.project_revoked` row and tells its caller the revocation happened.

**Why it matters more than a double-count:** D3 is explicit — *"no-op revokes do NOT audit (a trail
recording revocations that revoked nothing over-reports)"*. The writer's own header calls the race
*"two audits for one act"*, which understates it: the second audit is not a duplicate of a real act,
it is a record of an act that **never occurred**. On a destructive access change, the trail is the
only thing that says who removed whose access, so a fabricated entry is worse than a missing one.

## 0. Terrain, measured before designing

### 0a. Production, read-only, 2026-08-25

| | |
|---|---|
| `access.project_revoked` audit rows, all time | **0** |
| `access.project_granted` audit rows | 3 |
| production callers of `revokeProjectFromGroup` | **one** — `scripts/admin.ts`'s `revoke-project` |

**No phantom has ever been written**, and the race needs two concurrent operator CLI invocations
against the same edge — so this is latent, not live. ⚠️ *And "zero rows" proves less than it looks:
audit writes are best-effort and swallow both returned errors and exceptions (`lib/api/audit.ts:16`),
and a successful no-op deliberately writes none. The honest statement is that **no phantom is
evidenced**, not that none occurred.*

### 0b. The sibling already has the fix, and its criterion

AUDITFIX-21's `revokeUnsanctionedSystemEdge` deletes with `RETURNING` and audits only a row that came
back, pinned by a criterion that removes the row **after classification** and asserts `revoked:false`
with zero new audit rows — and by a mutation that restores exactly this probe-then-blind-delete shape.
**So the pattern, the criterion and the mutation all exist**; this slice applies them to the older
writer.

## 1. The rule

> **`revokeProjectFromGroup` audits, and reports `revoked: true`, only for a row it actually removed.**

## 2. The design

### 2a. Delete with `RETURNING`; audit on the returned row

`.delete()…​.select("project_id")` — the adapter appends a `RETURNING` clause when a returning spec is
present (`lib/db/pg/query-builder.ts:416-420`), so a 0-row delete yields `data: []`. `revoked` becomes
"a row came back", and both audit branches move inside that.

### 2b. The probe STAYS, and that is a deliberate choice worth arguing

With `RETURNING` the probe is redundant for correctness — the delete alone distinguishes removed from
absent. Removing it would be simpler and would save a round trip.

**It stays anyway**, for now:

- it is **step (3) of the documented D2c order**, whose whole point is that `{revoked:false}` is
  reachable only by an authorized principal — the shipped dm test pins that order and the
  no-existence-oracle property against it;
- this slice's job is to stop the trail lying, and removing a documented step is a separate
  question from that;
- this lane has been blocked twice for widening a slice past the defect it named.

⚠️ **If a reviewer thinks the probe should go, say so** — the properties all survive its removal
(refusals still precede any edge read, so no oracle appears), and I would rather take that argument
here than discover it in a diff review. It is recorded as an open choice, not a settled one.

### 2c. What must NOT change

- **The check order** — refusal, principal, probe, delete — is a tested contract.
- **The actor discipline** — an operator act audits as `system` with `meta.authorizedByMemberId`,
  never in the actor field, never in `added_by`.
- **`{ok:true, revoked:false}` on a genuine no-op**, with no audit. That is D3 and it is already right;
  this slice makes the *raced* case behave like the plain one.

## 3. Scope

**In:** `lib/access/groups.ts` (`revokeProjectFromGroup` only) · one dm criterion · one mutation ·
`docs/ARCHITECTURE.md`.

**Out:**
- **The new repair writer** — already correct.
- **Removing the probe** — §2b; open for the review to argue, not assumed.
- **Any change to the check order, the actor discipline, or the refusals.**

## 4. Acceptance

- **AC1 — a row removed between the probe and the delete is NOT audited (dm):** with a concurrent
  delete interleaved after the probe, the call returns `{ok:true, revoked:false}` and writes **zero**
  new `access.project_revoked` rows. *The defect, stated as an outcome.*
- **AC2 — a real deletion still audits, and still names the authorizer (dm):** `revoked:true`, one new
  audit row, `actor_kind='system'`, `member_id` NULL, `meta.authorizedByMemberId` set, `meta.via`
  carried from the ACTOR. *Counting rows leaves the anti-laundering discipline unprotected — the same
  gap both diff reviews found in the sibling slice.*
- **AC3 — a member-actor deletion audits AS THE MEMBER (dm):** `actor_kind='member'`, `member_id` set.
  *The other branch; a fix that moved only one branch inside the guard would pass AC2.*
- **AC4 — a genuine no-op is unchanged (dm):** revoking an absent edge returns `{ok:true,
  revoked:false}` and writes no audit row.
- **AC5 — the shipped revoke tests pass UNMODIFIED (unit + dm):** `test/admin-cli-revoke.test.ts` and
  `test/datamechanics/revoke-project.datamechanics.test.ts` are not edited. *They pin the check order,
  the principal matrix, the no-existence-oracle property and D3; this slice must preserve all of it.*

| # | mutation | must redden |
|---|---|---|
| 1 | delete without `RETURNING` and audit unconditionally (the current shape) | AC1 |
| 2 | audit on the PROBE's result instead of the delete's | AC1 |
| 3 | move only the operator branch inside the guard | AC3 |
| 4 | launder the authorizer into the actor field | AC2 |
| 5 | audit on a genuine no-op | AC4 |

## 5. Risks

| risk | direction | mitigation |
|---|---|---|
| The fix suppresses a REAL audit | a destructive act goes unrecorded — worse than the defect | AC2 + AC3, both actor branches; mutations 3, 4 |
| `revoked` starts lying the other way | a caller believes nothing happened when it did | AC2 asserts `revoked:true` on a real deletion |
| The check order or no-oracle property drifts | a tested contract broken | AC5 — the shipped tests, unmodified |
| Someone reads this as fixing a live problem | wasted expectation | §0a: zero audit rows, one caller, needs two concurrent CLI runs |

## 6. What this slice does NOT prove

It does not make the revoke atomic. Two concurrent revokes of the same edge still race; what changes is
that **at most one of them claims the deletion**, and the other reports the truth. Serializability would
need a lock or a conditional delete this adapter cannot express — the same boundary AUDITFIX-21 drew.

**Nothing is built. No code exists for this slice.**
