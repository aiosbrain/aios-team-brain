# A membership move that did not move must not report success — AUDITFIX-4

**Status:** spec, **round 10 — redesigned around a transaction** (§10). Five review rounds (3 spec, 2
diff) all returned BLOCKED, each on a different interleaving. §10 records why the answer is to stop
patching them individually. The branch's current implementation is superseded by §10. Round 1 BLOCKED, round 2 BLOCKED — §7, §8. This is no longer an
error-check slice: round 2 established it is a **concurrency-correctness** slice, and the honest name
for it is *make the membership transition sound*. §8 records it. Round 1's decisive finding: all
seven of my acceptance criteria were satisfied by an implementation that still lets a move silently
not-move, because capturing the SELECT error does nothing about the UPDATE. The design below is the
reviewer's, not my original.
**Build with:** opus / high — it changes the failure contract of the writer that performs the
membership MOVE, which under the ruling below is the authorization transaction itself.

**Deps:** none to build. **It is a PREREQUISITE for TIERRET-1** (§1b), which is why it is sequenced
first. AUDITFIX-1 is merged (`f94e9b2c`) and this branch is cut from it.

---

## 0. The one-line defect

`closeMembershipInto` (`lib/projects/context/memberships.ts:220-227`) destructures only `data` from a
read against an adapter that **returns** errors rather than throwing:

```ts
const { data: current } = await db.from("project_context_memberships")…   // ← no `error`
const rows = (current ?? []) as …;
const toClose = rows.filter(…);
if (toClose.length === 0) return { ok: true, closed: 0, spared };          // ← reports SUCCESS
```

A failed read yields `current = null` → `rows = []` → `toClose = []` → **`{ ok: true, closed: 0 }`**.
The function reports that it successfully closed nothing, having in fact failed to look.

## 1. Why this matters more than it looks

### 1a. The move is how content changes hands

`reconcileItemContext` (`lib/projects/context/reconcile-item.ts:84-95`) partitions an item by:
mirror the unit's audience → **ensure** the include into the target system project → **close** the
membership into the opposite one. That close is the second half of a *move*. When it silently
no-ops, the item is **current in BOTH** system projects, and the enforced read — which is built from
current include-memberships and does not inspect unit audience — serves it through either.

### 1b. Under the standing ruling, this is the authorization transaction

> *"Anyone who's part of a group gets visibility inside of it… external contractors who are members
> are treated as members."* — Chetan, 2026-08-21

TIERRET-1 retires the *remaining* tier read-filters on that ruling, and its review established that
with them gone the membership move **is** the authorization transaction. That is why this slice is
sequenced first.

⚠️ **But it is already live.** My first draft claimed "the damage is bounded — the tier filter still
catches the `external→team` direction." Round 1 refuted that: item enforcement is **already**
membership-only (`lib/access/enforce.ts:9` records PRET-6 retiring the conjunct, and
`visibleItemIdsForProjects` applies no access filter), so a membership that did not move is an access
grant **today**. TIERRET-1 widens the blast radius to the surfaces that still add their own conjunct;
it does not create the exposure.

## 3. The rule

**`closeMembershipInto` may report success only when the intended final state was established.**

Not "only when the read succeeded" — that was round 1's central correction. The read error is one way
to fail; it is not the defect this function's name describes.

Three things follow, and only the first was in my original spec:

1. **A failed READ is reported**, not absorbed: `{ok:false, error}`.
2. **The UPDATE reasserts the predicate that classified the row**, rather than trusting ids read
   earlier — `and decision = … and mode = …`, so a row that became a protected human exclusion
   between the read and the write **survives**.
3. **`closed` is MEASURED, not assumed.** The update uses `RETURNING`
   (`lib/db/pg/query-builder.ts:104` supports it after a mutation) and the count comes from affected
   rows. A zero-row update after a non-empty read is **not** success: it means the world changed, and
   the function rereads to decide whether the final state is acceptable (row absent or protected) or
   must be reported as a failure.

### 3a. Ordering: close BEFORE open when NARROWING

`reconcileItemContext` today opens the target, then closes the opposite
(`lib/projects/context/reconcile-item.ts:84-95`). For a **narrowing** move (`external → team`) that
order means a crash or failure between the two leaves the item **still externally granted**.

- **Narrowing (`external → team`): close first, then open.** A failure leaves temporary *denial* —
  the item is in neither project until the sweep repairs it. Denial is the safe direction.
- **Widening (`team → external`): open first, then close.** Unchanged; a failure leaves the item
  visible to fewer people, which is also safe.

This is the direction-aware transition round 1 asked for, and it is the part that actually removes
the exposure rather than reporting on it.

### 3a2. A COMPARE-AND-SET on the unit's audience — round 2's BLOCKER

Direction-aware ordering does not help against a **stale reconciler that arrives late**:

1. Stale reconciler **S** reads `items.access = 'external'`.
2. The item flips to `team`; reconciler **N** reads `team`.
3. N writes the unit's audience `team`.
4. **S overwrites it back to `external`** — the update at `lib/projects/context/units.ts:59-68` is
   keyed `.eq("id").eq("team_id")` with **no predicate on `audience`**.
5. N closes external-shared, rereads it absent, reports success. N opens General.
6. S calls `ensureIncludeMembership(external-shared)`; the gate rereads the unit, sees S's stale
   `external`, and **permits** the write.

Final state: current includes in **both** system projects, both reconciles reporting success — the
exact exposure §4 claims the gate prevents, reached without any read failing.

**Fix:** the unit-audience update becomes a CAS — `.eq("audience", <the value this reconciler read>)`
— so a stale writer's overwrite matches zero rows and fails instead of winning. Expressible with the
current adapter; no transaction surface needed. A zero-row CAS means the world moved: the reconciler
must **re-read and restart**, never proceed on the audience it thought it had.

This is the "bind the placement to the audience version that authorized it" requirement, and it is
the part that makes the rest sound. Without it, every other guarantee here holds only in the absence
of a concurrent reconciler.

### 3a3. Preflight the gate BEFORE the destructive close

Round 2's second-order finding on §3a: with close-first ordering, a `project_groups` read failure
*after* a successful close leaves the item in **neither** project — a metadata-read outage turned into
destructive denial. And a persistent failure pins the backfill cursor
(`lib/projects/context/backfill.ts:78,301`), making it a team-wide head-of-line block.

So on a narrowing move, the target's reachability is **determined before** the close is issued.
Preflight is still TOCTOU on its own — §3a2's CAS is what makes the sequence sound; the preflight is
what stops a pure outage from being destructive.

### 3b. The return type is a discriminated union

`{ ok: true; closed: number; spared: number } | { ok: false; error: string }`. On failure the counts
are **absent**, not zero — "not measured" and "measured zero" must not be spellable the same way. The
sole production caller already branches on `!ok` (`lib/projects/context/reconcile-item.ts:95`).

## 4. Scope — corrected

Round 1 refused my one-site scope, and both reasons held on re-derivation:

- **The stale-placement race.** `projectIsExternalVisible` failing open lets a *stale* reconciler
  write an external-shared membership after another reconciler already moved the unit to `team`. The
  ruling authorizes *"a member granted a project may see its contents"* — it does **not** authorize
  *"this automatic reconciler may place this item into that project erroneously."* I collapsed those
  two, and that was the error in my §2.
- **My sequencing premise was stale.** Item enforcement is **already** membership-only in this
  checkout — `lib/access/enforce.ts:9` records PRET-6 retiring the tier conjunct, and
  `visibleItemIdsForProjects` applies no access filter. So a stale external-shared membership is an
  access grant **today**, not only after TIERRET-1. (Several *consumers* still add their own tier
  conjunct — that redundancy is what TIERRET-1 removes — but the membership primitive itself is
  already tier-free.)

**So `projectIsExternalVisible` is back in scope**, with the narrower fix round 1 named: while the
gate exists, its read must distinguish *"not external-visible"* from *"could not determine"*, and the
gate must refuse on the latter. Deleting the gate is TIERRET-1's job and must happen atomically with
that slice's semantic change — not here, and not by leaving a fail-open in place as a proxy for it.

**Still out of scope**, each with where it goes:

- deleting the gate → **TIERRET-1**; the slug-vs-audience predicate dies with it.
- the remaining ~24 swallowed reads on the access path → **AUDITFIX-10**.
- **transactional** reconcile (a crash between the two writes) → still deferred; §3a makes the crash
  window fail toward denial rather than exposure, which is the affordable half. The sweep remains
  **eventual repair and observability — not proof that the transition is atomic**, and this spec no
  longer implies otherwise.

## 5. Acceptance

Round 1 demonstrated one implementation defeating all seven previous criteria — *capture the SELECT
error, leave the unverified id-based UPDATE alone* — so the criteria below are rebuilt around the
**final state**, not around the read.

- **AC1 — the A→B replacement race (dm):** read classifies row A as closable; a concurrent actor
  closes A and installs current row B for the same (unit, project); the update matches **zero** rows.
  The reread finds B **still closable**, and `closeMembershipInto` must return **`ok:false`**.
  ⚠️ *Round 2 caught that my first version of this criterion said only "must not return
  `{ok:true, closed:1}`" — which `{ok:true, closed:0}` satisfies while B stays current and the caller
  proceeds as though the move succeeded. The criterion was literally weaker than the rule it was
  meant to enforce. Stated as the outcome now.*
- **AC2 — the protected-exclusion race (dm):** a row that is closable at read time becomes
  `exclude`/non-auto before the write. It **survives**, and is reported as `spared` — because the
  UPDATE reasserts the predicate rather than matching by id.
- **AC3 — measured, not assumed (dm):** `closed` equals the number of rows the UPDATE actually
  affected, proven by a fixture where that differs from the number read.
- **AC4 — fault-injected read (dm):** with the SELECT stubbed to error, the call returns `ok:false`
  with a non-empty error and **no counts**, and `reconcileItemContext` propagates `ok:false`.
- **AC5 — narrowing fails toward DENIAL (dm):** on `external → team` with the *second* write faulted,
  the item is **not** externally visible afterwards. Asserted through `visibleItemIds` for a member
  whose only path is the external-shared grant — the outcome, not the row.
- **AC6 — the gate refuses on an undetermined read (dm):** with the `project_groups` read stubbed to
  error, `ensureIncludeMembership` **refuses** rather than writing. The fail-open round 1 found.
- **AC7 — the sweep's behaviour under a persistent failure is PINNED (dm):** a `close` that keeps
  failing yields a failed backfill outcome with the cursor **unchanged**, so the item is retried and
  later candidates for that team are delayed. My original spec claimed the contract was "absorbed";
  `lib/projects/context/backfill.ts:76-82,298-303` shows it is a deliberate retry-not-skip that this
  change converts a silent success into. It is a correctness-over-throughput trade, and it is
  asserted rather than assumed.
- **AC8 — the happy path is untouched (dm):** a normal move closes the opposite membership, reports
  `closed: 1`, and set-equality holds on the resulting current memberships.
- **AC9 — CLOSEMODE-1 (dm):** an uncontended human non-auto exclude is still spared and still agrees
  with `backfill-candidates`' SQL. *Stated narrowly:* this pins the STATIC agreement of the two
  predicates. Round 1 was right that it cannot pin agreement across the two-statement race, and AC2 is
  what covers the race.
- **AC9b — the stale-writer interleaving (dm):** two reconcilers, one holding a stale
  `items.access`. The stale one's unit-audience write must **fail the CAS** and must not produce a
  current include in the opposite system project. Asserted on the final membership set, and this is
  the case no read-error test reaches.
- **AC9c — the reread's OWN error (dm):** with the zero-update **reread** stubbed to error
  (distinct from AC4's initial-read injection), the call returns `ok:false` with no counts — it must
  not absorb the error as "row absent". Round 2: AC4 said "the SELECT" and an implementation can
  handle the first read while ignoring the one this design newly introduces.
- **AC9d — preflight, not destructive denial (dm):** on a narrowing move with the `project_groups`
  read faulted, the item is **not** left in neither project — the close is not issued, because
  reachability was undetermined before it.
- **AC10 — mutation:** reverting the UPDATE's predicate reassertion reddens AC2; reverting the
  RETURNING-based count reddens AC1/AC3; reverting the error capture reddens AC4; **reverting the
  unit-audience CAS reddens AC9b**; reverting the reread's error check reddens AC9c; reverting the
  preflight reddens AC9d — and none of them reddens AC8. Each mutation must redden its own criterion
  only.
- **AC11:** `npx tsc --noEmit`, `npm run lint`, `npm test`, the dm tier, `npm run check:docs` green.

**Falsifier:** if `closeMembershipInto` can return success when the intended final state was not
established — read failed, update matched nothing, or a protected row was erased — the rule is not
implemented, whatever the tests say. *(Round 1: my previous falsifier forbade only the read case.)*

## 7. Round 1 — BLOCKED, and the fix did not fix the defect

**The decisive finding:** one implementation satisfied **all seven** of my criteria —

> capture and propagate the SELECT error exactly as specced, and leave the unverified id-based UPDATE
> unchanged

— while the A→B replacement race still returned `{ok:true, closed:1}` with row B left current. My
spec was named *"a membership move that did not move must not report success"* and **its fix did not
achieve that**, because the defect lives in the UPDATE, not the SELECT. Folded as §3.2/§3.3 and AC1.

Also folded:

- **The one-site scope was not defensible** (§4) — the stale-placement race, plus the fact that item
  enforcement is *already* membership-only, so the exposure is live today rather than post-TIERRET-1.
- **Ordering** (§3a): closing before opening on a narrowing move is what actually removes the
  exposure; my spec only reported on it.
- **`ok:false` stalls the sweep** (`backfill.ts:76-82,298-303`). I claimed the contract was "absorbed"
  having checked only the reclassification caller. It is a real correctness-over-throughput trade —
  now AC7, asserted rather than assumed.
- **The CLOSEMODE-1 agreement claim was too strong** — static agreement is pinnable, cross-race
  agreement is not. AC9 narrowed, AC2 added.
- **The return type** becomes a discriminated union so "not measured" cannot be spelled as zero.

**What round 1 confirmed rather than changed:** `closed` has no production consumer today
(`lib/projects/context/reconcile-item.ts` ignores it), and `spared` is only read after `ok`, so the counts do not currently
contaminate a caller — the type change is hygiene, not a live bug.


## 8. Round 2 — BLOCKED, and the slice's real name changed

**2 BLOCKER, 2 HIGH.** Attacking the round-1 fold found that the fold was still not sufficient.

- **BLOCKER — a stale reconciler recreates the external grant even when everything succeeds.** The
  unit-audience write has no compare-and-set, so a late writer overwrites a newer audience and the
  gate then permits a placement against it. Direction-aware ordering cannot fix a *later* stale open.
  Folded as §3a2 (CAS + restart-on-zero-rows) and AC9b. **This is what turns the slice from an
  error-check into a concurrency-correctness change**, and the spec's status line now says so.
- **BLOCKER — AC1 was literally weaker than the rule it enforced.** It forbade `{ok:true, closed:1}`;
  `{ok:true, closed:0}` passed it while the replacement row stayed current. **This is the fifth time
  in this program that an acceptance criterion of mine blessed the implementation the rule forbids** —
  the pattern is now the most reliable defect generator in my own work, and the mitigation that
  actually works is stating criteria as *outcomes* rather than as return shapes.
- **HIGH — the reread introduced an unspecified failure path** (AC9c). A design that adds a read must
  fault-inject *that* read, not only the one it inherited.
- **HIGH — close-first turned a metadata outage into destructive denial** (§3a3, AC9d).

**What round 2 checked and CLEARED**, which is worth as much as what it found:

- **No shipped invariant requires target-before-close.** The partial unique index is per
  `(team, project, unit)` so the two system projects cannot conflict (`postgres/schema.sql:1204`);
  ARM 2 repairs a missing target and ARM 3 an opposite survivor; graph homing already defines the
  neither-project case (`lib/graph/project.ts:867`). CLOSEMODE-1's target-before-close is load-bearing
  only for the protected-exclusion **return**, which is a *widening* move and stays open-first.
- **The predicate reassertion is not a semantic change.** `decision`/`mode` are non-null
  (`postgres/schema.sql:1189`) and the predicate matches `PROTECTED_EXCLUDE_SQL`
  (`lib/projects/context/backfill-candidates.ts:10`). A closable→closable race may fail the equality
  and retry — conservative availability loss, not a CLOSEMODE semantic change.
- **The reread cannot promise durable state**, only an observation at one snapshot. Success is
  therefore defined at that linearization point, and §3a2's CAS — not more rereading — is what owns
  concurrent stale writers. Repeated rereading would livelock.

**Nothing is built. No code exists for this slice.**


## 9. Fable's diff review — BLOCKED, and the CAS was bound to the wrong version

**3 HIGH, 2 MEDIUM, 3 LOW.** Every finding re-derived before folding; two were verified by mutation.

- **HIGH — the CAS bound to the MIRROR, not the authorizing version.** §3a2 said "bind the placement
  to the audience version that authorized it", and the code bound it to the unit's own audience while
  the value written came from an `items` read one statement earlier. A reconciler holding a stale
  `items.access` still won: it sees the FRESH unit audience, its CAS passes, it writes the stale value
  back and routes on it. **Replaced by a single-statement mirror** — the update reads `items` inside
  itself and returns the audience the caller routes on. §3a2's own words named `items.access`; the
  code named the mirror.
- **HIGH — the ordering flip was pinned by NOTHING.** Deleting the entire `if (narrowing)` block left
  the whole suite green — **verified: mutation SURVIVED**. Every other test drives a writer directly
  or asserts an order-insensitive final state. AC5 was the spec's pin for it and was unimplemented.
  Now implemented and asserted through `visibleItemIds`; the same mutation now **REDDENS**.
- **HIGH — six acceptance criteria were absent**, with two unkilled mutations named precisely: the
  reread's own error check (AC9c) and the gate at the WRITER's own call site (AC6 — AC9d only ever
  exercised the preflight). Both implemented; both mutations now redden their own criterion.
  **AC3, AC7-dm and AC9 are WITHDRAWN rather than left implied**: AC3's "closed differs from rows
  read" is unreachable given `pcm_current_idx` (≤1 current row); AC7's backfill-stall behaviour is
  asserted by the existing cursor suite; AC9's static predicate agreement is covered by
  `closemode-flip`.
- **MEDIUM — a false claim in my own comment.** "in neither project … which ARM 2 repairs" is false
  when the open is refused by a standing explicit exclude: `lib/projects/context/backfill-candidates.ts` carves that item
  out of the candidate set entirely ("we skip the whole item"), so the denial is **permanent** until
  an operator acts. Close-first converts a pre-existing KNOWN EDGE into that. Accepted deliberately —
  denial is the safe direction and `countUnrepairable` reports it — and the comment now says so.
- **MEDIUM — the file header denied the diff below it**, still citing the F3 transaction deferral for
  a CAS this change ships without a transaction. Corrected.
- **LOWs folded:** the preflight fixes destructiveness only and does *not* relieve cursor pinning
  (the doc implied otherwise); AC2 now asserts the survivor is **reported** as `spared`, not merely
  left alone; and `skipped` advancing the backfill cursor weakens `drainTeamContext`'s stated
  contract for one tick — deferred as **AUDITFIX-11** with the reason recorded at the site.

**What the review verified sound**, which is worth recording: the reread's paths are exhaustive
(`pcm_current_idx` bounds both reads to ≤1 row, so "more rows on reread" and "partial success" are
unreachable); `spared` recomputed from the final snapshot is the right semantics; the proxies in the
dm suite intercept the reads they claim to; a lost mirror cannot livelock; and the neither-project
downstreams hold (graph homing's carve-out, CLOSEMODE-1's widening return staying open-first).


## 10. Codex's diff review, and the redesign it forces

**BLOCKED: 2 BLOCKER, 2 HIGH, 2 MEDIUM.** It broke the folds from §9, and the pattern across all five
rounds is now the finding.

### 10a. What it found

- **BLOCKER — the "single-statement mirror" is CONDITIONAL, so the bypass survives.** The atomic SQL
  runs only inside `if (drift)`. When a stale reader sees item and unit *agreeing* (both `external`,
  while `items.access` has since flipped to `team`), no mirror runs and `units.ts` returns the stale
  `item.access`. The insert-race loser path returns it too.
- **BLOCKER — an unconditional mirror would still not bind the MEMBERSHIP writes.** The audience picks
  `target` once, but neither write is conditional on it, so two reconcilers still interleave into both
  projects current, both reporting success. My comments claiming the placement is "bound to the item
  version" and that AUDITFIX-4 "CLOSED" concurrent reconciliation are therefore **false**.
- **HIGH — `runSql` THROWS where the adapter RETURNED.** `lib/db/pg/pool.ts:94` awaits
  `pool.query` directly; my new call has no `try/catch`, and `lib/projects/context/backfill.ts:87`
  does not catch — so a statement timeout now rejects the whole backfill instead of returning its
  structured failure with the last-good cursor. A regression I introduced.
- **HIGH — close-first still has unpreflighted destructive failures**, and my "a failure from here
  leaves the item in NEITHER project" is too broad: a close failure leaves the old membership intact.
- **MEDIUM — AC6 and AC9d assert weaker outcomes than their prose** (AC6's fixture already has the
  target include so it never observes an insert; AC9d passes an implementation that improperly opens
  General). **AC9b is green by construction for the FIFTH time** — its fake item carries a fake hash
  and epoch timestamp, *guaranteeing* the drift branch and so never testing the bypass.
- **MEDIUM — the single-writer guard does not recognise `runSql("update project_context_units …")`**,
  so the "single writers, guarded" claim is no longer fully true for that table.

**It cleared the reread branch** — `pcm_current_idx` bounds the key to one current row, so protected
and closable rows cannot coexist and `after.rows.length` is exactly the final protected count.

### 10b. The premise I had been quoting is FALSE

Every round of this slice patched one interleaving, and the next round found another. The reason is
in the file header I inherited and repeated: *"the compare-and-set needed to close it fully wants the
transaction surface the adapter does not expose yet (the standing F3 deferral)."*

**`lib/db/pg/tx.ts` exports `withTransaction`, and four modules already use it** — including
`lib/pm-sync/inbound.ts`, whose comment says it exists precisely because "loop-prevention requires
`tasks.status` and the `task_pm_links` bookkeeping to move atomically." That is the same shape as this
problem. The deferral was stale, and I spent five rounds honouring it.

### 10c. The design: serialize the move per item, and read the authoritative pair atomically

Two changes, both small, that retire the interleaving class instead of its instances:

1. **The whole move runs inside `withTransaction`, opening with a `SELECT … FOR UPDATE` on the ITEM
   row.** Two reconcilers for the same item can no longer interleave: the second blocks until the
   first commits and then re-reads fresh state. Every BLOCKER from rounds 2, 9 and 10 requires an
   interleaving, and none survives this.
2. **That same statement reads the authoritative `(items.access, unit.audience)` pair in one shot**,
   and the move routes on the `items.access` it returns. This is what closes BLOCKER 10a-1: the
   staleness there is between a reconciler's *own* item read and the item's current value — changed
   by ingest, not by another reconciler — so a lock alone does not fix it, and reading the pair
   atomically does.

**Deliberately NOT atomicity of the writes.** The adapter's queries run on other pooled connections
(`lib/db/pg/tx.ts`'s own doc says so), so the existing writers stay exactly as they are and keep their
EXCLSHADOW-1 and CLOSEMODE-1 logic untouched. What the transaction buys is **mutual exclusion**; a
crash mid-move still leaves partial state and the sweep still repairs it — which is the position this
codebase already documents and accepts. Rewriting all ~293 lines of writer logic as raw SQL to gain
true atomicity is a bigger slice that would put the exclude-shadow repair at risk, and is **AUDITFIX-12**.

**Costs, stated:** the move holds a pooled connection for its duration (~6-10 queries) — noted because
a wedged pooled connection caused the 2026-07-13 outage — and a single lock taken first with no other
lock acquired means no deadlock ordering to reason about.

### 10d. Also folded from 10a

`runSql`'s throw contract wrapped so the structured `{ok:false}` return survives; the false comments
corrected; AC6/AC9d strengthened to assert the rows rather than the return; AC9b rewritten to test the
no-drift bypass rather than a fixture that guarantees the drift branch; and the single-writer guard
taught to recognise raw-SQL writes.
