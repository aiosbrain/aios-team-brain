# STAGINGMARK-2 — the wedged fleet materializes itself, from one definition

**Status:** spec, **rounds 1 and 2 folded** (Fable, both CLEAR-WITH-CONDITIONS. Round 1 refuted the
first draft's central premise and split the slice; **round 2 found a HIGH that my own round-1 fold
introduced** — I compressed D3 and dropped a step of the algorithm.) Written by
`gpt-6-astra` (reasoning effort `medium`); folded by the orchestrator. No code written.
· Task: `STAGINGMARK-2` · Owner: chetan
· **Tier build-with:** data-mechanics — this writes access rows against real Postgres. Unit only for
the call-site pin and the writer-ban narrowing.

**Deps:** PRET-4/PRET-6 (merged). STAGINGMARK-1 (merged `1807f074`) shipped the recovery command this
supersedes for the unattended case and keeps for the attended one. No new dependency to deploy.

**Increment:** **ONE PR = Slice A only** — a single SQL function defined in `postgres/schema.sql`,
called from the existing PRET-6 migration, plus the writer-ban narrowing, a call-site pin, five dm
cases and the runbook. **`lib/access/groups.ts` is NOT touched.** Slice B (the `.rpc()` wrapper) is a
separate PR, recorded in §3 and droppable.

---

## Problem

A fleet with teams that has never booted the PRET-4 release cannot deploy. The guard in
`postgres/migrations/20260818210000_pret6_retire_access_enforcement.sql` raises, `pg:schema` aborts,
preDeploy halts the release — so the app never boots, so `materializeBuiltinMembershipOnce`
(`lib/access/groups.ts:204-279`, the marker's ONE writer, reachable from `instrumentation.ts:47`,
`lib/ingest/scheduler.ts:71` and — since STAGINGMARK-1 — `lib/access/materialize-command.ts:116`)
never runs, so the marker is never stamped. Redeploying the same commit
refuses again, forever. Staging deploy `2e67246e` died in that loop on 2026-09-05.

STAGINGMARK-1 shipped the escape hatch (`npm run admin -- materialize-builtins`) and documented it.
That un-wedges an operator who **reads the runbook**; it does not make the upgrade unattended.

## 0. Terrain, measured before designing

Read-only, 2026-09-06. Attack the inferences, not the numbers.

| fact | measurement |
|---|---|
| prod teams / members / group_members | 1 / 10 / 10 — every member `tier='team'` |
| prod `pret4_builtin_materialize` | **present** |
| prod `teams.access_enforcement` | **already dropped** |
| `scripts/pg-load-schema.mjs` | pure node, **no tsx** (header, line 6) — it runs in the pruned production image |
| load order | `schema.sql` is applied and committed at `:69-70`, **then** migrations in filename order at `:74-78` |
| `members.tier` | `access_tier not null default 'team'`, enum **exactly** `('team','external')` (`schema.sql:29,233`) |
| migration writing its own marker | precedent at `20260816150000_arc_corrections_partition_scope.sql:28` |

**Consequences.** Production is **already materialized, so this change is a no-op there** — it cannot
be justified by a prod defect. The beneficiaries are wedged self-hosters and freshly-restored staging
databases, and **that population is unknown and unmeasurable from here**; this spec claims no number
for it. And "invoke the TypeScript materializer from schema replay" is not a trade-off to weigh: the
loader has no tsx by design, so it is unavailable.

### The premise the first draft got wrong

The first draft asserted that "the schema and migration **necessarily** contain two definitions of the
routine", and then proposed a text-equality guard to police the copies. **That is false**, and the
guard it motivated was the existential shape that failed three times on the previous slice — it proves
two strings match, not that either is installed or invoked. `schema.sql` is loaded and committed
before any migration runs, on every path (measured above), and the PRET-6 migration already depends on
`schema.sql`-created objects. So the routine is defined **once**, in `schema.sql`, and the migration
only **calls** it. The two-copy design, and its guard, are deleted.

## 1. The rule

**A fleet that has teams and no marker must complete the PRET-4 materialization as part of applying
the PRET-6 migration, from a single definition, or fail the deploy — never stamp without
reconciling.**

## 2. The design

**D1 — one SQL function, defined once.** `materialize_builtin_membership_once()` — no arguments,
`SECURITY INVOKER`, returns `boolean` (`true` = this call reconciled and stamped, `false` = the marker
already existed; errors raise). Defined **only** in `postgres/schema.sql`, near the end, after every
table it references. `SECURITY INVOKER` is right and not a shortcut: the loader and the app share one
role (`pool.ts` and `pg-load-schema.mjs` both read `DATABASE_URL`), `schema.sql` contains no `GRANT`,
and every existing function assumes this — `DEFINER` would add a `search_path` surface for no
privilege boundary.

**Body constraint, and it is load-bearing:** on the wedged path the function *executes* inside the
PRET-6 migration, i.e. **before every migration lexically after `20260818210000_`**. The precise rule
(round 2 M1 — the first wording named the path that *cannot* fail): every column the body references
must have been in that table's CREATE body **when the table first appeared in `schema.sql`**, or be
added by a migration sorting **before** `20260818210000_`. *Round 3 F2: an earlier wording said
"first-commit body", which would wrongly REJECT `groups.is_builtin` — `groups` first appears at
`ba58d82f`, not the initial commit, yet is fine because a whole new table is created wholesale by
`create table if not exists`. It would also wrongly PASS the real hazard: a column added by editing an
EXISTING table's create body has no migration either, and is absent on every fleet that already had
the table. The check is git first-appearance, not "has no add-column migration".* `create table if not exists` is a no-op on an existing table, so on the old wedged
fleet a column that only a later migration adds is simply absent — the from-zero replay would never
catch it. All the objects it needs qualify (verified: `groups`, `group_members` and
`migration_markers` have no `alter table … add column` migration at all):
`members.tier` (`access_tier`), `groups.is_builtin`, `group_members`, `migration_markers`, and
`audit_log` (whose `audit_protect` trigger blocks UPDATE/DELETE only, not INSERT).

**D2 — the migration calls it; it does not define it.** The existing PRET-6 `DO` block gains one call,
ordered: (1) the existing permissive scan and refusal, unchanged, **before** any membership mutation;
(2) `perform materialize_builtin_membership_once();`; (3) the existing existence-gated column drops.
One statement, one transaction — no internal commit, no `EXCEPTION WHEN OTHERS` around the reconcile.
A failed drop rolls back the access rows and the marker with it.

*Not a new migration file:* a September-dated migration would replay **after** the August refusal and
never be reached. Editing the historical file is this repo's normal pattern — migrations replay on
every deploy with no applied-ledger — but the file's header currently promises "COMMENT ONLY — the
guard below is byte-for-byte what shipped", and that sentence must be rewritten, not appended to.

**D3 — the predicate is FROZEN, and that is why the TypeScript stays.** **Step one is to CREATE the
absent builtins**, exactly as `ensureBuiltins` does (`lib/access/groups.ts:217` calls it *before*
computing `want`): insert-if-absent with `is_builtin=true` and the names Everyone/External, and refuse
a non-builtin holder of the slug. *Round 2 HIGH, and it was mine — my round-1 compression of this
paragraph kept the refusal half and dropped the creation half. The consequence is not cosmetic: a
pre-flag-era team with no `groups` rows would join to nothing, add nothing, and **stamp the marker**.
The next tick then creates the builtins EMPTY, the marker blocks any later repair, and
`resolveViewerPosture` resolves every member to `external` because no `everyone` row exists — H-VANISH,
the exact hazard the refusal exists to prevent, delivered silently by the change meant to remove it.*

Then, per team, per builtin slug:
`want = members WHERE tier = ('team' for everyone, 'external' for external)`. No `kind`, `status` or
`is_connector` filtering. Because `members.tier` is a non-null two-value enum, the two equalities
**partition every member exhaustively** — there is no third bucket to leak into. Add exactly the
missing rows, delete exactly the refuted ones, preserve timestamps on rows that already match, do not
touch ordinary or singleton memberships or project grants, never write `members.tier`. Refuse a
non-builtin occupant of a reserved slug before mutating. One best-effort
`access.builtin_materialized` audit per **changed** group (its own exception subtransaction; a failed
audit emits a notice and continues — never wrap the reconcile DML in that block). Stamp the marker
**last**, `on conflict do nothing`. A zero-team fleet stamps.

This is a **one-time historical** operation whose semantics must never change again. That is the whole
argument for leaving `lib/access/groups.ts` alone: a frozen algorithm existing in two places has no
drift pressure, and the shared fixture matrix (D5) catches a translation mistake once, at build time.

**D4 — locks, with the premise stated rather than assumed.** On a marker miss, take transaction-held
`SHARE ROW EXCLUSIVE` on `teams, members, groups, group_members, migration_markers` in that fixed
order, then **re-read the marker** (a caller that waited behind a completed one returns `false`).
`SHARE ROW EXCLUSIVE` conflicts with all DML and not with reads, which is the intent.

**The deadlock-freedom premise, which must be written down because it can silently stop being true:**
no application transaction today spans two of those five tables — member creation is autocommit
statements, and the only `withTransaction` users are pm-sync and gateway, none of which touch these
tables. If a future transaction does `members` → `group_members`, this becomes a deadlock-detector
victim during the deploy window. Also stated: `lock_timeout` is bounded **per statement**, not in total — the waiting statement count is data-dependent (the
pre-lock marker read and the permissive scan can wait too, and an audit insert's timeout is swallowed
by the best-effort handler). It covers the five `LOCK`s and the `alter table … drop column`, which upgrades to
`ACCESS EXCLUSIVE` and waits on readers under the same GUC. No fleet-size or runtime guarantee is claimed; the
reconcile is set-based and prod is a no-op.

**D5 — detection is a shared fixture matrix, not a text guard.** Independently specified fixtures
assert the exact expected sets **and their inverse**, across every member kind, both connector flags,
both tiers, multiple teams, **and a team with ZERO `groups` rows** — with explicit seed assertions proving invite-time defaults have not
already made the "missing rows" case green. *That last axis is not optional: `seedTeam` →
`placeMemberByTier` → `ensureBuiltins` (`test/datamechanics/helpers.ts:44,59`) means **every existing
dm fixture already has builtins**, so a parity run would have passed while the two algorithms differ
on exactly the input H1 describes.* The SQL is run against those fixtures; the shipped
TypeScript is run against the same fixtures **once, during implementation**, to expose a translation
mistake. No frozen TypeScript copy is retained as a second production implementation, and its output
is never the only expected result.

**D6 — the tests must observe the FILE, not the container.** `npm run test:datamechanics` is a bare
`vitest run` (`package.json:41`) and `scripts/dm-isolated.sh:79` loads the schema only on container
creation or `AIOS_DM_RESET=1`. So the dm tier executes whatever function body was last installed —
a mutation to the body in the tree could report **SURVIVED having never been installed**, which is
indistinguishable from a guard that works. The dm file therefore extracts the
`create or replace function materialize_builtin_membership_once … $$;` block from
`postgres/schema.sql` and executes it in `beforeAll`. Capture the dollar tag from `as (\$\w*\$)`
and terminate on that same tag, so the extraction matches AC7's strip. It is idempotent **only while
the return type is unchanged**: a stale `:iso` container holding an earlier iteration fails with
"cannot change return type of existing function", so `beforeAll` issues
`drop function if exists materialize_builtin_membership_once()` first — **in the test database only,
never in `schema.sql`**, where the same hazard is a §5 falsifier rather than a fixture concern.

**D7 — the SUBSTRATE GATE, and the option not taken.** Added after the diff review found that
removing the unconditional refusal removed something else with it: it was also the gate for the
pre-flag-era fleet, whose `teams.access_enforcement` column never existed and which therefore cannot
be caught by the migration's permissive check either, because that check is column-gated. Repairing
membership is **not** repairing visibility — enforcement fails closed for an item with no context
unit, and the only partitioner is the budgeted scheduler stage — so that fleet would have received a
deploy reporting success over a corpus dark for many ticks.

So the function refuses when `items` exist and `project_context_memberships` is empty, keyed on the
**invariant** (has this fleet been through the substrate?) rather than on the deleted column: both
earlier PRET-6 near-misses were checks keyed on a retired artifact. The gate sits **before the
locks** — it reads two tables that are not in the lock set, so the locks buy it no consistency, and a
fleet about to be refused should not first queue behind DML on five tables.

Stated precisely, and deliberately weaker than "the corpus is partitioned": the predicate is "at
least one partition row exists", so a fleet **mid-backfill** is admitted (it went through the
substrate release; the scheduler will finish). It is also **fleet-global**, not per-team. A per-team
form would be strictly stronger but would refuse a deploy for a team created inside the last backfill
window — and a false refusal is exactly the failure this slice exists to remove.

**The option NOT taken** was to accept the jump and document the blackout, rewriting
`docs/RELEASING.md` to say the corpus is dark until backfill converges. Rejected by the operator: the
slice's whole benefit is an unattended upgrade, and an upgrade that silently hides your content is
not one.

**The same predicate is enforced in the attended CLI** (`lib/access/materialize-command.ts`). Without
it the gate was trivially bypassable: `materialize-builtins` stamps the same marker, and the SQL gate
sits *after* the marker short-circuit, so a stamp from the CLI cleared the migration's refusal and the
next deploy proceeded over the dark corpus. A documentation sentence would not have closed that.

## 3. Scope

**In (Slice A):** the function in `postgres/schema.sql`; the call + header rewrite in the PRET-6
migration; narrowing `test/guards/access-single-writer.test.ts`'s SQL write ban to exempt **exactly
that one function body** and re-scan the rest of the file; a call-site pin that the migration invokes
it; `test/datamechanics/stagingmark2-self-materialize.datamechanics.test.ts` **(new)**; runbook +
release-notes updates; and the three places this PR makes FALSE, which CLAUDE.md §1 requires to move
in the same change:
`docs/ARCHITECTURE.md:82` (the precondition "aborts UNCONDITIONALLY", and the materializer's two slots
called "the self-heal"); `docs/ARCHITECTURE.md:86` (**`lib/access/groups.ts` only (single-writer…)** —
the prose mirror of the AC7 guard narrowing, false the moment a `schema.sql` function writes
`groups`/`group_members`); and `lib/access/materialize-command.ts:11-12` ("exactly ONE writer …
exactly TWO call sites"), which is **already false today** — `:116` in that same file is a third call
site — and becomes doubly false with a second marker writer.

**Cut, each with a home:**
- **Slice B — the `.rpc()` wrapper** (`materializeBuiltinMembershipOnce` becomes a thin RPC call, plus
  the `lib/db/pg/client.ts` allowlist entry). **Deferred to its own PR, and dropping it is
  acceptable**, because D3 freezes the algorithm. It is also the riskiest edit available here — it
  rewrites a function every fleet runs at every boot — and it introduces a real regression the first
  draft understated: today the TS loop is N short autocommit statements, none of which can hit the
  pool's 30 s `statement_timeout`; as one RPC it is a single statement, so on a large markerless fleet
  every boot and tick would cancel identically and never converge. Recorded as **STAGINGMARK-5** when
  opened; not filed yet.
- **A broader mixed-version repair protocol.** Locks serialize new callers; they cannot retroactively
  serialize an *old* release's multi-statement TypeScript materializer, which may read before the lock
  and write after it commits. That is a pre-existing materializer race, not one this creates, and the
  never-booted case has no such writer. Stated, not solved.
- **Marker-loss semantics.** A missing marker does not distinguish "never materialized" from "marker
  deleted after deliberate membership edits"; automatic replay would regrant a deliberately removed
  membership in the latter case. Boot and tick already have that consequence — this moves it earlier.
  Never delete the marker as a repair recipe.
- **The permissive-team readiness/flip path** is untouched and still required; this closes marker
  repair only.

## 4. Acceptance criteria

- **AC1 — a wedged fleet now deploys (dm):** a real Postgres with a team, builtin groups and **no**
  marker; execute the PRET-6 migration text verbatim from the file. It **completes**, the marker is
  present after, and the expected `group_members` rows exist. *Red-before witness, already in the
  repo: `test/datamechanics/pret6-precondition.datamechanics.test.ts:57,66` and
  `stagingmark-materialize.datamechanics.test.ts:74-80` currently assert the migration REFUSES exactly
  this fleet. Those assertions must be updated by this PR, and their going red first is the
  non-vacuity proof.*
- **AC1b — a team with NO builtin groups is repaired, not stamped over (dm):** a team with members
  and **zero `groups` rows** → the migration completes, both builtins exist with `is_builtin=true`
  and the shipped names, every member is placed per tier, **and in ONLY that builtin** (the inverse —
  the same shape AC2 asserts). *The H1 case. No existing dm fixture
  can reach it (`helpers.ts:44,59` gives every seeded team builtins), so this criterion must build
  its team without `seedTeam`'s bootstrap. Its red is the natural-but-wrong implementation: a join
  to `groups where is_builtin` yields nothing, adds nothing, and stamps.*
- **AC2 — it reconciles exactly, both directions (dm):** seed a team with members of BOTH tiers, a
  missing `everyone` row, and a `group_members` row whose member's tier **refutes** it. After: every
  `tier='team'` member is in `everyone`, every `tier='external'` member is in `external`, **the
  refuted row is GONE**, and a pre-existing correct row keeps its original timestamp. *Seed
  assertions first, proving the missing row was actually missing before.*
- **AC3 — a reserved-slug squatter refuses before mutating (dm):** a non-builtin group holding
  `external` → the migration raises, **and** `group_members` is byte-identical to before, and the
  marker is absent. *The inverse of AC1, and it must not half-apply.*
- **AC4 — it never stamps without reconciling (dm):** with the reconcile forced to fail (a squatter),
  `migration_markers` holds no `pret4_builtin_materialize` row. *This is the criterion that rejects
  the cheap shortcut of stamping the marker to silence the guard.*
- **AC5 — the whole statement rolls back together (dm):** make the **column drop** fail (a view
  depending on `teams.access_enforcement` on a fleet that still has the column; **drop the view in
  `finally` — the dm harness truncates rows, not DDL**) → the migration raises, and the marker AND the
  membership rows are both absent afterwards. *The reachable reds are
  a swallowed reconcile error and a marker stamped before the DML; "an early COMMIT" is NOT one — a
  plpgsql FUNCTION invoked from SELECT cannot commit, so naming it would be an unreachable red.*
- **AC6 — an already-materialized fleet is untouched (dm):** marker present, membership deliberately
  disagreeing with the tier predicate → the migration completes, `group_members` is **byte-identical**
  before and after, and no audit row is written. *This is what makes the change a no-op on prod, and
  it is asserted rather than assumed. **Its mutation must delete BOTH the pre-lock marker read and
  the post-lock re-read** — deleting either alone leaves this green, because the other still returns
  `false`. The pre-lock read is kept deliberately: without it every production deploy takes five
  `SHARE ROW EXCLUSIVE` locks to do nothing, and can fail on `lock_timeout` behind any in-flight DML
  on `members`.*
- **AC7 — the migration invokes the function, and the writer ban still bites (unit guard):** the ban
  is the whole-file `SQL_DML` regex (`test/guards/access-single-writer.test.ts:89-93,140-143`) — **not**
  `READ_EXEMPT`/`mentionsWithWrites`, which scan TS only — so the exemption is a SOURCE TRANSFORM:
  strip the one body anchored on the function name **and its dollar tag**, then apply `SQL_DML` to the
  remainder. Three controls, all required: (a) a write injected **outside** the body in `schema.sql`
  reddens; (b) a write injected inside a **different** `$$` body (e.g. `audit_protect`) reddens —
  this is the one proving the strip keys on the NAME, not on any `$$`; (c) a write in the migration
  file reddens. The call-site pin matches `perform\s+materialize_builtin_membership_once\s*\(\s*\)`
  **after stripping `--` comments**, because the rewritten header names the function in prose and a
  bare-name match would be satisfied by that comment with the call deleted.
- **AC7b — the existing from-zero guard is a witness, and its intent is retargeted (unit):**
  `test/guards/db-test-up-from-zero.test.ts:70` currently pins the literal string
  `"PRET-6 refused: the PRET-4 builtin materialization has not completed"`. It reddens on this PR —
  **and the cheap green is leaving that sentence in the rewritten header comment**, which is why it
  is named here rather than discovered later. Its neighbouring rule (`:74-78`: a refusal must not be
  conditioned on an env/test signal) is extended to cover the `perform`, since an env-gated reconcile
  is the same hazard shape.
- **AC8 — the function is defined exactly once (unit guard):** `materialize_builtin_membership_once`
  appears as a definition in `postgres/schema.sql` and **nowhere else** under `postgres/`, matched
  after stripping `--` comments. *Replaces
  the first draft's text-equality guard between two copies, which existed only because of a premise
  that measurement refuted.*

- **AC9 — the substrate gate, in all three directions (dm + unit):** with content and **zero**
  `project_context_memberships`, the migration **raises** and `group_members`, `groups` and the
  marker are all unchanged; the **same fleet repairs** once one partition row exists; a fleet with
  **no content at all** repairs (there is nothing to darken). And at the CLI: `readState` reporting
  `contentWithoutSubstrate` makes `runMaterializeCommand` refuse with a non-zero exit **before
  `--confirm` is considered**, never reaching the materializer, while a partitioned fleet is
  unaffected. *Reds: deleting the gate reddens the refusal case; dropping either term of the
  predicate reddens one of the two repair cases; deleting the CLI check lets the materializer be
  called.*

## 5. What would falsify this

- The marker stamped on a fleet whose membership does not satisfy the predicate (AC2, AC4).
- Any half-applied state after a refusal — rows written with the marker absent, or vice versa (AC3, AC5).
- A change in `group_members` on an already-marked fleet (AC6): the no-op claim would be false.
- The function referencing a column added by a migration sorting AFTER `20260818210000_`: the wedged
  path executes before those, so it would fail exactly where it must not — and a from-zero replay
  could not detect it.
- **The marker stamped on a team that lacks a builtin group** (AC1b): that is H-VANISH, and it is the
  single worst outcome this slice could produce.
- A `create or replace` that changes the function's RETURN TYPE: Postgres refuses it, so the "frozen
  signature" would need an explicit `drop function if exists` — silently, on every deploy.
- **The marker stamped on a fleet with content and no context substrate** — by the migration, by
  boot/tick, or by the CLI. That is the H-VANISH-shaped outcome in visibility rather than membership,
  and it is the single worst thing this slice could produce.
- Evidence that an app transaction spans two of the five locked tables: D4's deadlock-freedom premise
  would no longer hold and the lock order would need revisiting.
