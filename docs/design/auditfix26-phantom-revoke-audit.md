# A revoke that revoked nothing must not claim it did — AUDITFIX-26

**Status:** BUILT — spec rounds 1 (Codex, BLOCKED) and the diff reviews below are folded; the code is in
`lib/access/groups.ts` with criteria in `test/datamechanics/phantom-revoke-audit.datamechanics.test.ts`.
The "nothing is built" lines further down are preserved as the state each SECTION was written in — a
diff review caught them reading as current. Found by AUDITFIX-21's spec round 1 (HIGH 5) on a function
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

**The measured database contains no persisted phantom evidence**, and the race needs two concurrent
operator CLI invocations against the same edge — so this is latent, not live. ⚠️ *Round 1 MEDIUM 3
caught me writing "no phantom has ever been written" and then, two sentences later, the correct weaker
claim. Only the weaker one is supportable: audit writes are best-effort and swallow their errors
(`lib/api/audit.ts:16`), so zero rows cannot prove no raced invocation occurred — though a failed audit
insert writes no phantom either, so the failure mode does not hide one. The prod counts themselves are
measured; the inference from them is what needed narrowing.*

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

- it is **step (3) of the documented D2c order**. ⚠️ *Round 1 MEDIUM 1 corrected my reason: the shipped
  dm test does NOT pin the probe as a step. It proves an unauthorized principal gets the same refusal
  with and without an edge, and deleting directly with `RETURNING` after authorization preserves that
  outcome exactly. So the probe is retained for **scope stability** — it keeps the documented sequence
  and the probe-read-error behaviour unchanged — not because a test requires it;*
- this slice's job is to stop the trail lying, and removing a documented step is a separate
  question from that;
- this lane has been blocked twice for widening a slice past the defect it named.

⚠️ **Mutation 5 demonstrated that the SHORT-CIRCUIT is redundant** (§4) — deleting it alone changes no
observable. It did **not** demonstrate that the whole probe is: the probe's error-abort runs before the
destructive statement, and removing it would let a transient read failure proceed to a DELETE that
currently cannot happen. So the open question is narrower than I posed it, and its answer leans the
other way.

⚠️ **If a reviewer thinks the probe should go, say so** — the properties all survive its removal
(refusals still precede any edge read, so no oracle appears), and I would rather take that argument
here than discover it in a diff review. It is recorded as an open choice, not a settled one.

### 2c. What must NOT change

- **The check order** — refusal, principal, probe, delete. The *refusal-before-principal* and
  *principal-before-any-edge-read* halves are tested contracts; the probe's presence as a distinct step
  is documented rather than pinned (§2b).
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

- **AC1 — a row removed between the probe and the delete is NOT audited, for BOTH actor kinds (dm):**
  with a concurrent delete interleaved after the probe, the call returns `{ok:true, revoked:false}` and
  writes **zero** new `access.project_revoked` rows — asserted separately for an **operator** actor and
  a **member** actor. ⚠️ *Round 1's BLOCKER: with a single actor kind, this implementation satisfies
  all five criteria while still lying —*

  ```ts
  if (actor.kind === "operator") { if (!deleted) return { ok: true, revoked: false }; await auditOperator(); }
  else { await auditMember(); }            // unconditional, after a probe hit
  return { ok: true, revoked: deleted };
  ```

  *raced operator revokes come out clean, real deletions pass AC2/AC3, genuine no-ops exit at the probe
  and pass AC4, the shipped tests pass — and a raced MEMBER revoke still writes a phantom. The sibling
  fixture I was copying uses only an operator actor, which is how the gap travelled.*
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
| 1 | delete without `RETURNING` and audit unconditionally (the shape BEFORE this slice) | AC1 |
| 2 | audit on the PROBE's result instead of the delete's | AC1 |
| 3 | move only the operator branch inside the guard | AC1 (the MEMBER arm) |
| 4 | launder the authorizer into the actor field | AC2 |
| 5 | drop BOTH the probe short-circuit and the delete guard | AC4 |

⚠️ **Mutation 5 as first written was a semantic NO-OP, and what it demonstrated is NARROWER than I
first wrote.** It removed only the probe's `if (!existing) return` — and SURVIVED, because a genuine
no-op then falls through to the delete, which affects zero rows, so the guard returns exactly the same
`{ok:true, revoked:false}` with no audit.

*I recorded that as "the probe is redundant, demonstrated rather than argued". The diff review
narrowed it, correctly: the mutant still ran the probe QUERY and its `probeErr → {ok:false}` return.
So what is demonstrated is that **the short-circuit** is redundant — not the probe. **Full probe
removal has a divergence the mutant never exercised:** a probe SELECT that errors currently aborts
**before** the destructive statement, whereas without it the same transient condition proceeds to
DELETE the row and audit. That is the probe's remaining behavioural content, and §2b already named it
as a retention reason — my §4 claim contradicted my own §2b. And epistemically, SURVIVED means the
criteria cannot distinguish the mutant, not that no observable differs: the mutant also issues a
zero-row DELETE on every genuine no-op.*

The real detector for AC4 is removing both, which reddens it.

## 5. Risks

| risk | direction | mitigation |
|---|---|---|
| The fix suppresses a REAL audit | a destructive act goes unrecorded — worse than the defect | AC2 + AC3, both actor branches; mutations 3, 4 |
| `revoked` starts lying the other way | a caller believes nothing happened when it did | AC2 asserts `revoked:true` on a real deletion |
| The check order or no-oracle property drifts | a tested contract broken | AC5 — the shipped tests, unmodified |
| Someone reads this as fixing a live problem | wasted expectation | §0a: zero audit rows, one caller, needs two concurrent CLI runs |

## 6. What this slice does NOT prove

It does not make the whole operation atomic. **The deletion itself already is**: `project_groups` is
keyed on `(project_id, group_id)` (`postgres/schema.sql:1072`), so of two concurrent
`DELETE … RETURNING` statements exactly one returns the row — "at most one claims the deletion" is a
consequence of that, not of a lock.

⚠️ *Round 1 MEDIUM 2 corrected me: I had written that serializability "would need a conditional delete
this adapter cannot express". It can express one — that is precisely what this slice uses. What remains
non-atomic is the **preceding snapshot**: the project's kind and the principal's authority are read
before the delete and could change in between. That is the same snapshot boundary AUDITFIX-21 named,
and it is not what this slice is about.*

**Nothing was built at the time this section was written** (the slice is now built — see Status).

## 7. Round 1 — BLOCKED on the mutation table, for the twentieth time in this lane

| # | finding | re-derived | outcome |
|---|---|---|---|
| **B1** | mutation 3 cannot redden AC3: with a single actor kind in AC1, a per-branch fix satisfies all five criteria while a raced MEMBER revoke still writes a phantom | **CONFIRMED** — the reviewer wrote the passing-but-lying implementation out, and noted the sibling fixture I was copying uses only an operator actor, which is how the gap travelled | **ADOPTED** — AC1 is parameterised over both actor kinds; mutation 3 targets the member arm |
| **M1** | the shipped dm test does NOT pin the probe as a step — it pins the no-oracle OUTCOME, which survives deleting the probe | **CONFIRMED** | **ADOPTED** — §2b keeps the probe for scope stability and says so, instead of claiming a test requires it |
| **M2** | §6 misidentified what is non-atomic: the adapter CAN express a conditional `DELETE … RETURNING`, and against the PK edge exactly one of two concurrent deletes returns the row | **CONFIRMED** | **ADOPTED** — the remaining non-atomicity is the preceding snapshot, not deletion ownership |
| **M3** | §0a said "no phantom has ever been written" and then, correctly, "no phantom is evidenced" | **CONFIRMED** | **ADOPTED** — only the supportable claim survives |
| — | the adapter semantics this rests on: `.select()` after `.delete()` sets `RETURNING`; zero rows → `data: []`; failure → `data:null` + error; so error-first then `(removed ?? []).length > 0` cannot suppress a real deletion. Both shipped tests statically compatible unmodified | **CLEARED with evidence** | recorded so the build does not re-derive them |

⚠️ **Twenty.** That is how many times a mutation in this lane has pointed at a criterion it could not
redden, and the shape has never varied: the mutation's observable is identical to the correct
implementation's, usually because the fixture exercises one branch of something that has two.

**Nothing was built at the time this section was written** (the slice is now built — see Status).
