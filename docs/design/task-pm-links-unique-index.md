# The DB backstop for one-issue-one-row: a partial unique index on `task_pm_links` (ADOPTUNIQ-1)

Status: **pre-code, revised through TWO rounds of two independent design reviews — four reviews, three
of them BLOCKED.** Round 1: Codex **BLOCKED** (the guard was itself a check-then-act race) · Fable
**CLEAR-WITH-CONDITIONS** (found a third writer this spec claimed did not exist; ruled the open question
OPPOSITE to Codex). Round 2, attacking the fold: Codex **BLOCKED** (the `last_error` signal reintroduced
an abort path; the error-class discrimination was invalid on the merits) · Fable **BLOCKED** (the handler
caught the WRONG EXCEPTION SET — a lock wait aborts the release with ZERO dirty data; and its own round-1
`last_error` proposal is erased by `project.ts:200` within one push cycle).

Round 3, attacking that fold: Codex **CLEAR-WITH-CONDITIONS** · Fable **CLEAR-WITH-CONDITIONS** — and
they CONTRADICTED each other on `deadlock_detected` (Codex: do not catch it; Fable: catch it, with a
mechanism). **Settled empirically, not by argument: a staged deadlock aborted the release.** Fable was
right.

**Every mechanism below is empirically verified against real Postgres 16** before any code exists — the
catch, the transaction survival, the lock case, the deadlock case, self-heal, idempotence, and the
predicate. Results are in §Verified mechanics. Everything else is the fold.
· Owner: chetan
· Tier build-with: **data-mechanics** (real Postgres — the index, both migration branches, and both
containment paths are persistence outcomes a stubbed DB cannot observe) + **unit** for the
replay/shape guards.

**Deps:** none. ADOPTDECL-1 (#581) and ADOPTFOOT-1 (#588) shipped the app-code half; this is the DB
half they deferred.

**Increment:** ONE PR = the guarded index (mirrored into `schema.sql` and `postgres/migrations/`),
the two containment fixes the index makes load-bearing, and the restructuring of the existing
uniqueness tests that the index would otherwise make green-by-construction. **No data is reconciled,
no link row is deleted, and no Railway setting is touched.**

---

## Problem

`task_pm_links` has no constraint stopping two rows from claiming the same provider issue. The unique
constraint it does have — `(team_id, project_id, row_key, provider)` — is about *rows*, not *issues*:
three different projects can each hold a `TT1` row and each point at the same Linear issue, which is
exactly what happened. `lib/pm-sync/project.ts` guards this in app code (`ownedResourceIds`, extended
by ADOPTFOOT-1 to key on `(project_id, row_key)` rather than `row_key` alone), but that is a
check-then-act read followed by a write, and its own comment says the race is accepted.

ADOPTDECL-1 specced the DB backstop and deliberately did not ship it.
`postgres/migrations/20260817164500_task_pm_links_declared_external_id.sql:12-16` records why: prod
held three links on `AIO-444`, so the index would have aborted the release (the #251 replay class).

### The blocker is gone — measured 2026-08-26, read-only against prod

| Fact | AIO-958 asserted (2026-08-18) | Measured 2026-08-26 |
|---|---|---|
| Violating groups on `(team_id, provider, provider_resource_id)` | 1 — three links on `AIO-444` | **0** |
| `TT1` links | 3, in 3 projects | **1** (`john-workspace` → `AIO-444`) |
| Total link rows | 960 | **1,067** |
| Rows with a non-null `provider_resource_id` | — | **1,066** |
| Rows with a NULL `provider_resource_id` | 1 (orphan `chetan`/`TT2`) | **1**, same row |
| Teams holding links | — | **1** (`aios`) |
| By provider | — | `linear` 1,066 · `plane` 1 |

The human reconciliation call the ticket was waiting on **no longer exists**, and the index applies
clean today. The orphan (`chetan`/`TT2`, null `provider_resource_id`, null `task_id`, stranded by a
2026-08-03 `duplicate label name` error) is **excluded by the partial predicate by construction** —
hygiene, not a blocker, and deliberately left alone.

**Not measured, and stated as such:** whether any OTHER self-hosted install holds a violation. This
repo is public and self-hosted (CLAUDE.md §5), so the migration must be safe on a fleet whose data
nobody here can read. That is the whole reason for the guard, and it is not a hypothetical dressed
up — it is why the clean-prod measurement is insufficient on its own.

### What adding the index does TODAY — two wrong containment paths, in opposite directions

**(1) OUTBOUND — the violation is SWALLOWED.** `lib/db/pg/query-builder.ts:221-224` catches the driver
exception and **returns** `{ data: null, error }` rather than throwing. `persistSuccess`
(`lib/pm-sync/project.ts:188-203`) awaits that update and **never reads `error`**. So a `23505` would
be logged to the console and dropped: `projectTask` returns `status: result.status` — a SUCCESS —
while the Linear issue has already been mutated and the link keeps no `provider_resource_id`. The next
push therefore misses rung 1 and takes the adopt path again. Containment exists, but only because
nothing is checked; the cost is silence, which is worse than an abort. **This is not a new defect —
every other failure of that update is silent today too.** The index makes it reachable where it matters.

**(2) INBOUND — the violation ABORTS the whole pass.** `adoptInbound`
(`lib/pm-sync/inbound.ts:451-457`) inserts inside `withTransaction` with
`on conflict (team_id, project_id, row_key, provider) do nothing` — the **other** unique constraint.
Postgres allows one inference clause, so a violation of the new index is not caught by it; it throws
inside the transaction, escapes the candidate loop, and escapes `runInboundForTeam`
(`lib/pm-sync/inbound.ts:554`, awaited bare) **before `return result`** — discarding Phase A's applies
along with every remaining candidate. That IS the "aborts a whole board push" the ticket forbids, on
the leg the ticket did not name.

### The deploy trap: `schema.sql` runs BEFORE the migrations, as ONE transaction

`scripts/pg-load-schema.mjs` loads `schema.sql` first (`:69`), then every migration in lexical order
(`:72-78`). A column inside `create table if not exists` is a no-op on an existing DB — the rule
`postgres/migrations/README.md` exists to state — but a bare `create unique index if not exists` is a
**top-level statement that does apply to an existing database**.

**Worse than round 1 of this spec stated (Fable):** `schema.sql` is sent as a single multi-statement
`client.query(sql)`, i.e. one implicit transaction, so a violation there aborts the **entire schema
load** before any migration guard could run.

**Therefore the guard must be the only creator, in BOTH files**, and in `schema.sql` it must sit
*after* the `create table if not exists task_pm_links` region (~`postgres/schema.sql:1286`) or a
from-zero load errors on a missing table. This is the constraint most likely to be undone by a later
"tidy the schema" edit, which is why criterion 10 exists.

---

## Verified mechanics — run against real Postgres 16 before any code was written

Each row is a design claim that had to hold. These were executed in a throwaway container, touching no
shared test database.

| Claim | Result |
|---|---|
| `create unique index` over duplicate data raises a CATCHABLE `unique_violation` | ✅ caught by the handler |
| After the catch: index absent, both rows intact | ✅ 0 indexes, 4 rows |
| A caught exception does NOT poison the single implicit transaction `pg:schema` sends | ✅ the later statement ran; the txn committed |
| The handler can perform writes | ✅ (recorded, then made moot — see decision 4) |
| Self-heal: replay after the duplicate is removed creates the index | ✅ created |
| Idempotent replay on a clean DB | ✅ no-op (`already exists, skipping`) |
| Partial predicate: NULLs duplicate freely; a non-null duplicate is rejected | ✅ 3 NULLs coexist; `23505` on the duplicate |
| **A lock wait with a `unique_violation`-only handler, on a CLEAN table** | 🔴 **`lock_timeout` escapes the handler, poisons the txn, later statement never runs — release aborts** |
| The same case with `lock_not_available` also caught | ✅ warning, later statement ran, txn committed, index correctly absent |
| Lock case self-heals on the next deploy once the lock clears | ✅ created on retry |
| **A real staged DEADLOCK with a `unique_violation`+`lock_not_available` handler** | 🔴 **`40P01` escapes, poisons the txn, later statement never runs — release aborts, zero dirty data** |
| The same deadlock with `deadlock_detected` also caught | ✅ warning, later statement ran, txn committed, index absent |

**One honest gap in this table:** deadlock self-heal was NOT isolated — the retry hit the
duplicate-data branch because the staging session had dirtied the fixture. It is inferred from the lock
case's identical profile (subtransaction rollback, no data change, index absent), not separately
observed. Recorded as inference rather than measurement.

The two red-then-green rows are Fable's round-2 HIGH. It is the reason decision 3 exists in its current
form, and it was reachable **with zero dirty data** — the guard as specced through round 2 would have
aborted a release on any sufficiently busy fleet.

---

## Decision

1. **One guarded `do $$ … $$` block, used verbatim in `postgres/schema.sql` and in
   `postgres/migrations/`.** Neither file gets a bare `create unique index`. Index name:
   `task_pm_links_provider_resource_uq`. In `schema.sql` the block must sit **after** the
   `create table if not exists task_pm_links` region (~`postgres/schema.sql:1286`), or a from-zero load
   errors on a missing table.

2. **The guard is EXCEPTION-CONTAINED, not check-then-act.** *(Round 1 Codex BLOCKER.)* The original
   design counted violations and then created the index — itself a race, because `pg:schema` is the
   Railway preDeployCommand and runs **while the old app version is still serving and still projecting**
   (`pg-load-schema.mjs:8`). A writer could insert a duplicate between the count and the `create`, and
   the release would abort. Correctness must not depend on a pre-count, and now does not: there is no
   count at all.

3. **The handler catches `unique_violation`, `lock_not_available` AND `deadlock_detected` — and
   NOTHING else.** *(Round 2 Fable HIGH + round 3 Fable HIGH, both empirically confirmed above.)* `pg-load-schema.mjs:66-67` sets `lock_timeout` (default 15s).
   A non-concurrent `create unique index` takes a SHARE lock and must wait out any in-flight write from
   the old app version. A wait past the timeout raises **`55P03 lock_not_available`, not `23505`** —
   which escapes a `unique_violation`-only handler and, inside `schema.sql`'s single implicit
   transaction, aborts the entire schema load. **Zero dirty data required.**

   ```sql
   do $$
   begin
     create unique index if not exists task_pm_links_provider_resource_uq
       on task_pm_links (team_id, provider, provider_resource_id)
       where provider_resource_id is not null;
   exception
     when unique_violation then
       raise warning 'ADOPTUNIQ-1: duplicate provider_resource_id present — DB backstop NOT installed';
     when lock_not_available then
       raise warning 'ADOPTUNIQ-1: could not acquire the lock — DB backstop NOT installed; next deploy retries';
     when deadlock_detected then
       raise warning 'ADOPTUNIQ-1: deadlock while creating the index — DB backstop NOT installed; next deploy retries';
   end $$;
   ```

   **Why `deadlock_detected` belongs here, against Codex's round-3 ruling.** Codex argued a deadlock
   signals broader lock interaction where abort-and-retry is safer. Fable argued it is reachable
   *earlier* than the timeout — `deadlock_timeout` defaults to **1s**, so the detector examines a
   waiting `create index` ~14s before `lock_timeout` (15s) can fire — and that `schema.sql`'s single
   implicit transaction has already taken `ACCESS EXCLUSIVE` locks from earlier `alter table … if not
   exists` no-ops while the old app version is still serving, so a genuine cycle is ordinary rather
   than exotic. **The disagreement was settled by staging one**, not by preferring an argument: our
   transaction was chosen victim, `40P01` escaped the two-exception handler, poisoned the transaction,
   and the later statement never ran. Same class as the round-2 HIGH, third SQLSTATE.

   **Never `when others`, and this is load-bearing.** The strongest silent-skip-worse-than-abort case
   is `undefined_table`: if a later "tidy the schema" edit moves the block ABOVE the
   `create table if not exists task_pm_links` region — the exact regression decision 1 predicts — a
   `when others` handler would convert that ordering bug into a warning and a fleet-wide missing
   backstop. The narrow list is what keeps decision 1's failure loud. `query_canceled` (57014) is not
   plausible on this path (nothing sets `statement_timeout`) and is deliberately excluded.

   **The claim is narrow, and round 2 was right that the earlier wording was false.** "Never refuses to
   deploy" is NOT true — disk, catalog and other errors still abort, as they should. What is true and
   what this design guarantees: **neither duplicate data, nor expiry of the configured `lock_timeout`,
   nor a deadlock can abort a release.** Inside the block the only statement is the `create index`, so
   `23505` can only mean duplicate data and the two lock codes can only mean contention — no aliasing,
   and every caught branch leaves zero data change.

   The two skips are not equivalent, and the spec says so rather than blurring them: the **lock** skip
   genuinely self-heals on the next deploy (verified above); the **duplicate-data** skip does not,
   because nothing cleans the data (see decision 4).

4. **The skip signal is READ-side, not write-side.** *(Round 2 killed the round-1 `last_error` stamp —
   and Fable killed its own proposal, which is the strongest form of the finding.)*

   Why the stamp is dead, three independent ways:
   - **It is erased within one push cycle.** `persistSuccess` sets `last_error: null` unconditionally on
     every successful projection (`project.ts:200`). On exactly the fleet the stamp exists for, BOTH
     rows of a duplicate group still resolve via rung 1 and project "successfully", nulling it.
   - **The stamp write is itself an abort vector.** The handler's `UPDATE` sits OUTSIDE the protected
     `create index`, on precisely the hot rows the live old app is writing — a row-lock wait raises
     `55P03` from a statement no handler covers, and the schema load aborts. The "safe skip" would have
     reacquired an abort path through its own reporting mechanism.
   - It clobbers real `persistError` messages, churns `updated_at` every deploy, double-stamps (the
     block is in both files), and goes stale forever after remediation.

   **Instead: a catalog read at app runtime.** A `task_pm_links` backstop check on the pm-sync health
   surface (`lib/pm-sync/runs.ts`, alongside `getProjectionHealth`) reports whether the index is
   present **and correctly defined**. No writes, no abort path, no clobber, no churn, and it self-clears
   the moment the index appears because it reflects live catalog state.

   It also closes a hole Codex round 2 raised that the textual guards cannot: `if not exists` accepts
   **any** existing relation with that name regardless of its columns, predicate, uniqueness or
   validity — so a wrongly-defined same-named index would read as a successful deploy. The catalog read
   validates the definition, not just the name: schema+table binding, exact ORDERED key columns, no
   expression/include columns, uniqueness, validity, and the normalized predicate.

   **It must be WIRED, not merely exported.** *(Round 3, both reviewers — and this repo has shipped the
   failure before: an exported `describe*` function no surface rendered.)* A criterion testing the
   function alone would stay green while no human ever sees the result, which is exactly how the
   deleted stamp failed. So: the backstop is a **separate field** on what `computeProjectionHealth`
   returns — not an overload of the last-run `ProjectionHealthStatus`, whose meaning is unrelated — and
   both of its real consumers must emit it: `app/t/[team]/admin/pm-sync/page.tsx` (the surface a human
   is expected to look at) and `app/api/v1/pm-sync/health/route.ts`.

   **Fail-closed:** a catalog-read error resolves to `unknown`/`unhealthy`, NEVER `healthy`. A probe
   that reports green when it cannot see is the null-view fail-open this repo has already been bitten by.

   **Implementation route, named so it is not discovered:** `DbClient` cannot express the required
   `pg_index`/`pg_get_indexdef` joins; use raw SQL via `withTransaction` (`lib/db/pg/tx.ts`), as
   `lib/pm-sync/inbound.ts` already does. Compare against Postgres's **normalized** indexdef rendering
   (`WHERE (provider_resource_id IS NOT NULL)`) captured from the real DB — decision 9's
   "textually identical predicate" rule governs violation-reporting queries and must NOT be misread as
   string-matching source DDL against the catalog.

5. **Outbound containment: deliberate and LOUD.** `persistSuccess` reads the returned `error`; on error
   `projectTask` records it via `persistError` and reports that row `failed`. Contained to the row, no
   longer silent. This widens beyond `23505` to every failure of that update — a deliberate behaviour
   change, called out as one.

   Stated plainly, because the index's value is easy to overclaim: by the time a `23505` fires the
   adapter has **already mutated the other row's issue** (`linear.ts:423-431`). The index contains the
   *propagation* — children, re-invocation, a second brain row believing it owns the issue — not the
   provider write itself.

6. **THE CONTRADICTION, DISSOLVED — and the whole discrimination is withdrawn.**

   Round 1 left this open and the reviewers ruled it opposite ways. Codex: do NOT set `resolved` (on a
   `23505` the id belongs to another row; children would attach beneath a stranger's issue). Fable: DO
   set it (otherwise the child misses the map, takes the inline path at `project.ts:260-275`, re-invokes
   the parent's adapter, and can mint a duplicate provider issue).

   Round 2 of this spec tried to discriminate by DB error class. **Both reviewers then killed that**, on
   two independent grounds, and both were right:
   - **Invalid on the merits (Codex):** a non-`23505` failure does NOT prove the id is ours — an *adopt*
     can succeed at the provider and then hit a lock timeout.
   - **Unimplementable (both):** `query-builder.ts:221-224` flattens the driver error to `{ message }`,
     discarding `code` and `constraint`; and matching message text fails in the *dangerous* direction —
     under non-English `lc_messages` a real `23505` would classify as "other", set `resolved`, and
     parent children beneath a stranger's issue.

   **The discrimination was a red herring.** It existed only to decide whether to set `resolved`. Give
   the "don't re-invoke the adapter" job to its own channel and the question disappears:

   > On **any** `persistSuccess` failure: report `failed`, record via `persistError`, do **NOT** set
   > `resolved`, and add the row key to a separate **`contested: Set<string>`** in
   > `ProjectTaskOptions`. A child checks `contested` **before** the inline fallback and returns
   > `failed` naming the parent, **without invoking its adapter**.

   This satisfies Codex (never parent beneath an unpersisted id) and Fable (never re-invoke the adapter)
   simultaneously, and needs **no SQLSTATE, no adapter provenance, and no error-shape widening** — the
   `{code, constraint}` change round 2 was going to pull into scope is no longer needed at all.

   **The guarantee is INVOCATION-LOCAL, and round 3 was right that the earlier wording overclaimed.**
   `resolved` is constructed fresh inside `projectRows` (`project.ts:410`), so `contested` is too. Both
   reviewers walked the paths and agree it closes both harms *within one invocation*: `topoOrder` marks
   an in-batch parent before its child; an out-of-batch parent is reached through the inline fallback,
   which shares the set via the opts spread, so it is invoked once and every later child hits
   `contested`; a grandchild recurses into its contested-failing parent and exits before any adapter
   runs. What it does NOT give is a cross-invocation guarantee — a standalone `projectTask` in a later
   cycle can invoke that parent's adapter again. **That is normal retry semantics, not the
   batch-internal double-mutation this channel exists to stop**, and it is stated here rather than
   implied away. Durable state would materially reopen the design and is not taken.

   **HOW the failure is detected is part of the decision, because the obvious implementation breaks the
   fence.** *(Round 3 Fable MEDIUM.)* `persistSuccess` must check the **returned error inline on the
   success path**. It must NOT throw — a throw lands in the shared catch at `project.ts:354-358`, which
   also catches adapter throws, and adding the `contested` insert there would sweep adapter-throw
   parents in, which is precisely the over-correction criterion 14 exists to catch.

   Four standalone call sites pass no map at all (`work-events/ingest.ts:166`, `after-write.ts:45`,
   `after-write.ts:86`, `pm-sync/index.ts:79`). **Correction to an earlier draft of this spec, which
   claimed `after-write.ts:86` was a gap needing a shared set:** it is not. That loop is the
   `primary.integration === null` branch, which returns `missing_integration` from `projectTask`
   without ever reaching the adapter or `persistSuccess` — nothing there can become contested. The
   other three are single-row calls with no sibling to protect. So the invocation-local scope needs no
   widening at all, and the claimed one-argument change is withdrawn as unnecessary.

   Two further scope fences, both from Fable's over-correction sweep:
   - The set keys on **persist-failure parents only**. An adapter *throw* already re-projects inline per
     child today; that behaviour is shipped, no test pins it, and sweeping it in would be the
     over-correction. Untouched.
   - A standalone `projectTask` call (no `resolved`/`contested` map) is out of the channel's reach by
     construction. Said outright rather than discovered.

   `resolved` stays `Map<string, string>` — round 2's "negative sentinel" was unimplementable inside it
   (`""` leaks through `project.ts:259` and `linear.ts:324` as a real `parentResourceId`) and made
   criterion 11's clauses jointly unsatisfiable.

7. **Inbound containment: per-candidate.** Wrap the per-candidate `withTransaction` in `try/catch`; on
   throw record the candidate in `result.skipped` **with a message shape naming the identifier and the
   cause**, and `continue`. Phase A's result and the remaining candidates survive.

8. **The existing uniqueness tests must keep a DISTINCT pinned property.** *(Codex round 1 Q2.)*
   `test/datamechanics/pm-link-uniqueness.datamechanics.test.ts` asserts the invariant via an app-level
   query (`duplicateGroups(...) === []`) and its header calls itself "the only thing enforcing the
   invariant" until this index ships. Once the DB enforces it, those assertions go **green by
   construction**. Containment makes it worse: a rejected insert becomes `skipped`, leaving
   `duplicateGroups`, `adopted` and the row count exactly as expected. Split the layers:
   - **DB layer** — raw duplicate writes assert `23505`, plus predicate and scope behaviour.
   - **App layer** — assert the **pre-write decision**: for Linear, that the adapter performed **no
     mutation call** on the injected `fetchImpl`; for inbound, that **no insert was attempted**, via an
     ownership-specific skip reason.

   The inverse control at `:294-320` (which deliberately inserts a duplicate and asserts the insert
   **succeeds**) becomes the raw `23505` DB test. **Merely flipping `toBeFalsy()` to expect failure is
   wrong** — it would stop validating `duplicateGroups`, which is what makes every other `toEqual([])`
   in the file mean anything.

   **Plane is not covered by the app layer, and that is a finding, not an omission.** `plane.ts:196`
   never destructures `ownedResourceIds`, and its adopt-by-external-id (`plane.ts:218-222`) has no
   ownership pre-check — so on Plane **the index is the only guard**. Criterion 15 is scoped to Linear
   explicitly and this fact is recorded rather than fixed here.

9. **One predicate, stated once and reused.** The index predicate `is not null` includes `''`;
   `ownedResourceIds` filters falsy (`project.ts:320`), so two rows persisting `''` are permitted by
   the app check and rejected by the index. Prod is safe (zero violating groups measured) and erring
   strict is right — but any query that reports on violations must use the **textually identical**
   predicate, or it and the index can disagree about what "violating" means.

---

## Scope

**In:** the guarded index in `schema.sql` + one migration · the two containment fixes · the `contested`
channel · the read-side backstop health check · restructuring the existing uniqueness tests per
decision 8 · the replay/shape guards · the ARCHITECTURE.md drift blocks.

**Out, deliberately:**

- **The orphan `chetan`/`TT2` link.** Excluded by the predicate, dormant.
- **Any reconciliation of link rows.** Nothing left to reconcile in this install.
- **The app-code `ownedResourceIds` check.** Unchanged; the index is a backstop *behind* it.
- **The `{code, constraint}` error-shape widening.** Needed by round 2's design; decision 6 removed the
  need. Explicitly NOT in scope.
- **Plane's missing ownership pre-check.** Recorded in decision 8; its own ticket.
- **The adapter-throw parent's inline re-projection.** Shipped behaviour, deliberately untouched.
- **ADOPTINV-1.** Separate ticket.

**Correction carried from round 1:** this spec claimed "only two writers of `provider_resource_id`
exist, verified by grep". **That was FALSE** — `scripts/brain-tasks.ts:357` (the operator `adopt`
command) is a third, on both an update and an insert path. The claim came from a `head -30`-truncated
grep read as a complete enumeration. Both reviewers independently re-ran the census without
line-anchoring and confirm **three** writers and no fourth. Note the irony Fable flagged:
`brain-tasks adopt` is the operator's tool for repairing a collision, and under the index a re-point to
an owned id now dies with a raw `23505`. A friendlier message is in scope; changing its behaviour is not.

---

## Acceptance criteria

1. **data-mechanics** — with the index applied, a second row inserted with the same
   `(team_id, provider, provider_resource_id)` as an existing row is REJECTED with SQLSTATE `23505`.
2. **data-mechanics** — two rows sharing `(team_id, provider)` with `provider_resource_id` NULL both
   persist, proving the partial predicate excludes NULLs and the live orphan cannot be broken.
3. **data-mechanics** — rows differing only by `team_id`, or only by `provider`, both persist, so the
   index keys on all three columns and not on `provider_resource_id` alone.
4. **data-mechanics** — the guarded block applied to a database ALREADY HOLDING a duplicate pair
   completes WITHOUT raising, leaves the index absent, and leaves both rows intact. Executed against
   the **actual bytes of the migration file** read from `postgres/migrations/`, never a paraphrase.
5. **data-mechanics** — a duplicate committed by a SECOND connection before the block runs produces the
   same contained outcome as criterion 4. *(Round 2 rewrote this: the old wording named an interval —
   "after the count, before the create" — that the exception-contained design no longer has, and the
   `do $$` block executes as one atomic statement, so no harness can interleave a writer mid-block. A
   criterion naming an unstageable window invites a builder to fake it.)*
6. **data-mechanics** — **the lock case**: with a concurrent transaction holding a conflicting lock and
   a short `lock_timeout`, the block completes WITHOUT raising, the schema load continues (a statement
   after the block still executes), and the index is correctly absent. A `unique_violation`-only
   handler fails this on a CLEAN table — that is the round-2 HIGH, and this is its regression test.
7. **data-mechanics** — **the deadlock case**: a staged lock cycle in which this transaction is the
   victim is contained the same way, on a CLEAN table. A two-exception handler fails this — the round-3
   HIGH, confirmed by staging one. Criteria 4, 6 and 7 must each fail for a DIFFERENT missing `when`
   clause, so one fixture cannot satisfy two of them.
8. **data-mechanics** — the contention skips SELF-HEAL: once contention clears, replaying the block
   creates the index. The duplicate-data skip is asserted NOT to self-heal, so the two are never
   conflated. *(The pre-code experiment isolated this for the lock case only; the deadlock case is
   inferred. This criterion is where it stops being inferred.)*
9. **data-mechanics** — criteria 4, 6 and 7 execute through the REAL loader: `scripts/pg-load-schema.mjs`
   exports `loadSchema` with injectable `createClient`/`readFile`/`cwd`, so the test runs the actual
   single-implicit-transaction load over a dirty scratch DB and asserts a later statement still ran.
   A synthetic wrapper that sends the block as its own query has DIFFERENT transaction semantics from
   the thing that runs in prod, and would prove the wrong property.
8. **data-mechanics** — the guarded block is idempotent: replayed on a clean DB the index exists exactly
   once; on a dirty DB it stays a clean no-op; once the duplicate is removed it CREATES the index.
9. **data-mechanics** — each `raise warning` fires on its own branch with a message distinguishing
   duplicate-data from lock, captured via the pg client's `notice` event (`pg-load-schema.mjs:57` proves
   the path). The weakest point of the design does not go untested.
10. **data-mechanics** — the read-side backstop check reports HEALTHY when the index exists, and
    UNHEALTHY when it is absent — **and also when a same-named index exists with the wrong columns,
    wrong column ORDER, wrong predicate, no uniqueness, or is INVALID, or is bound to a different
    schema/table**. Without those clauses `if not exists` lets a wrong index read as a successful
    deploy. A catalog-read failure resolves UNKNOWN/UNHEALTHY, never HEALTHY.
10b. **unit/http** — the backstop status is WIRED: it is present on what `computeProjectionHealth`
    returns, and emitted by BOTH `app/t/[team]/admin/pm-sync/page.tsx` and
    `app/api/v1/pm-sync/health/route.ts`. Without this the replacement for the deleted stamp can ship
    where no human sees it — the failure that killed the stamp in the first place.
11. **data-mechanics** — outbound: a projection whose `persistSuccess` update violates the index reports
    that row `failed` with a non-null `last_error`, does not throw, and a sibling row in the same
    `projectRows` batch still projects. Asserted on the batch. Pre-change code reports `synced` with
    `last_error` null, so this distinguishes.
12. **data-mechanics** — outbound inverse: after criterion 11's failure the failing link's
    `provider_resource_id` is still NULL — nothing partially persisted.
13. **data-mechanics** — the `contested` channel: one batch, the parent's persist fails, a child is
    present → the parent's provider is mutated **exactly once** (counted as mutation calls on the
    injected `fetchImpl`, which is observable; the private `resolved` map is NOT inspected), the child
    reports `failed` naming the parent, and the child is NOT parented to the contested id.
    *(Round 2: the old criteria 11/12 required inspecting a private map and asserted "adapter invoked
    exactly once" with no observable behind it, and their clauses were jointly unsatisfiable.)*
14. **data-mechanics** — the adapter-*throw* parent path is asserted UNCHANGED, pinning the scope fence
    in decision 6 so a future widening of `contested` is caught as the over-correction it would be.
15. **data-mechanics** — inbound: a candidate whose insert violates the index is recorded in
    `result.skipped` with a message naming the identifier and the cause, and the pass CONTINUES, with a
    later candidate still adopted and Phase A's accumulated result preserved.
16. **data-mechanics** — inbound rollback inverse: that rejected candidate's `tasks` row is UNTOUCHED
    (`origin`, `status`, `body` unchanged) and no link row exists. The adopt transaction carries the
    tasks update alongside the insert (`inbound.ts:451-473`), so a builder who wraps only the insert
    half-adopts the task and passes every other criterion.
17. **data-mechanics** — the app-layer decision is pinned independently of the DB (decision 8):
    **for Linear**, deleting `ownedResourceIds` must redden an assertion that the adapter made **no
    mutation call** on the injected `fetchImpl`, even though the index keeps `duplicateGroups` empty.
    For INBOUND the observable is NOT a string: inbound's ownership exclusion is the SILENT candidate
    filter at `lib/pm-sync/inbound.ts:414` (`!ownedIds.has(it.id)`), which produces no record at all. So the
    assertion is: an owned issue yields **no insert attempt AND no `skipped` entry**, whereas the
    deleted-filter mutant yields a `skipped` entry carrying the DB-rejection message. *(Round 3 Fable
    MEDIUM: the earlier wording named a string that does not exist — criteria must name observables.)*
18. **unit** — a guard asserts that in BOTH `postgres/schema.sql` and every file in
    `postgres/migrations/`, any `create unique index` naming `task_pm_links` appears INSIDE a
    `do $$ … $$` body that also catches ALL THREE of `unique_violation`, `lock_not_available` and
    `deadlock_detected` (this list must grow with decision 3 or the guard and the decision drift on day
    one), and that no
    `alter table task_pm_links add constraint … unique` exists anywhere. Written as a ∀ over both files
    — an existential is satisfied by the sibling the regression did not touch.
19. **unit** — criterion 18 carries a POSITIVE assertion: **exactly one** guarded creator in EACH of the
    two target files (`postgres/schema.sql` and the new migration), and **zero** in every other
    migration file. "Exactly one per file" alone was ambiguous once criterion 18 quantified over all
    migrations.
    A rejection-only matcher stays green forever if someone deletes the index entirely, and was green
    against the pre-change tree where no such index exists at all.
20. **unit** — the matcher is **comment-aware**. `20260817164500_task_pm_links_declared_external_id.sql:12-16`
    already describes this index in prose without the literal DDL; a future comment quoting the DDL
    would otherwise satisfy criterion 19's count spuriously. Pinned with a fixture.
21. **unit** — the guard is proven non-vacuous by running the matcher against independently mutated
    IN-MEMORY fixtures (the tests must not modify repository files), one per target file, so neither can
    be the only one carrying the property — plus an injected bare-`create unique index` fixture.
22. **unit** — `docs/ARCHITECTURE.md`'s drift blocks still resolve (`npm run check:docs`).
23. **migrate-from-existing** — the catalog fingerprint of an upgraded existing DB equals a from-zero
    load. Scoped honestly: those scratch DBs are EMPTY, so this proves only the CLEAN branch and never
    exercises a skip. Criteria 4-8 cover the skip branches.

**Harness hazards the build must respect:**

- Criteria 4-8 do DDL (drop index, replay the block) and the dm harness truncates **rows, not DDL**. A
  mid-test failure would strand the shared test DB without the index and redden later criteria
  phantomly. Run them against a scratch database/schema, or restore in `finally`.
- Criterion 11 needs a persist failure against real Postgres with no mocks. The legitimate lever is the
  index itself (a genuine `23505`). Do NOT stub `db.update` — that silently demotes the test out of the
  tier it was put in.
- Use `npm run test:datamechanics:iso`, not the shared `:5434` container: four other worktrees were
  active during this spec's authoring.

## What would falsify this

- **A deploy aborting on this index.** Criteria 4-8 did not hold, or a later edit reintroduced a bare
  `create unique index` and criterion 18 missed it. Note this falsifier has now fired TWICE in review
  (the count-then-create race; the lock wait) — both times on a mechanism intended to make the guard
  safe, which is the pattern to watch.
- **A fleet silently running without the backstop** — the read-side check was not surfaced anywhere a
  human looks, and decision 4 bought nothing over a log line.
- **A board push still aborting wholesale** — inbound containment wrapped at the wrong level, or there
  is a FOURTH writer of `provider_resource_id`. Three are known; round 1 of this spec confidently
  claimed two, so the correct posture is that the list is what was found, not a proof of completeness.
- **A duplicate provider issue minted in a batch** — the `contested` channel was not implemented, or
  criterion 13 was written too weakly to see it.
- **The outbound fix converting silence into noise** — every pre-existing failure of that update now
  reports `failed`. Not observed in prod; the first thing to watch after merge.
- **The uniqueness tests going quietly vacuous** — decision 8's split was not carried through and the
  index is masking the app-code regressions those tests exist to catch.
