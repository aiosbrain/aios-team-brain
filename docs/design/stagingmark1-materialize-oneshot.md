# A wedged fleet can stamp the PRET-4 marker without booting — STAGINGMARK-1

**Status:** spec, **rounds 1 and 2 folded** (Codex `gpt-5.6-sol`: round 1 CLEAR-WITH-CONDITIONS, round 2 **BLOCKED** on the rewrite — 2 HIGH + 2 MEDIUM + 1 LOW accepted, and round 2's proposed remedy for its own HIGH-1 REFUTED by measurement). No code written.

**Build with:** unit (an import-safe command handler with injected dependencies + one call-site pin)
and data-mechanics (the real migration guard against a real Postgres) — the materialization itself is
shipped and dm-pinned by PRET-4; this slice adds an entry point, not an algorithm.

**Deps:** PRET-4 (marker live on prod), PRET-6 (the refusing guard). No schema change, no migration.

---

## What and why

**What:** deploys run `npm run pg:schema` as Railway's `preDeployCommand`. That replays
`postgres/migrations/20260818210000_pret6_retire_access_enforcement.sql`, whose guard raises when a
database has teams but no `pret4_builtin_materialize` marker:

```sql
if exists (select 1 from teams)
   and not exists (select 1 from migration_markers where name = 'pret4_builtin_materialize') then
  raise exception 'PRET-6 refused: the PRET-4 builtin materialization has not completed on this fleet …';
```

The marker has exactly **one writer** — `lib/access/groups.ts:274-276`, inside
`materializeBuiltinMembershipOnce`. Verified by enumeration: no migration and no bootstrap path writes
it (`pparc3_g_wipe` and `pret3_post_activation_sweep` are written elsewhere; this one is not). That
function has exactly **two** invokers, `instrumentation.ts:45-53` (boot) and
`lib/ingest/scheduler.ts:66-80` (tick). Both are downstream of a deploy that succeeded. So:

> teams + no marker → preDeploy refuses → the new code never boots → the marker is never stamped → refuses forever

**Why now:** staging deployment `2e67246e` failed **2026-09-05 16:05** with exactly that message. The
staging database was the July demo-seed instance: it had a team and had never run the PRET-4 release.
It was unwedged only by restoring a full production dump.

**Why the refusal stays:** it protects the fleet from the H-VANISH hazard, and a refused deploy is
safe — it raises before the column drop and the running version keeps serving. This slice does not
touch it. The gap is that the documented recovery, "boot the prior release once"
(`docs/RELEASE-NOTES-pret6.md:40-43`), means a Railway dashboard rollback, or for a self-hoster
hunting an older image. No command simply does the thing.

## 0. Terrain, measured before designing

Read-only, 2026-09-05.

| fact | measurement |
|---|---|
| prod marker | `pret4_builtin_materialize \| 2026-08-18 22:29:17.371595+00` |
| staging marker | same row, **byte-identical timestamp** |
| prod teams / staging teams | 1 / 1 |
| `migration_markers` in the dump exclusion list? | **No** |
| staging `INGEST_POLL_ENABLED` | **UNSET** — not `false` as `docs/OPS.md:702` expects |
| `scripts/` entries invoking the materialization | **none** |
| writers of `pret4_builtin_materialize` | **one** (`lib/access/groups.ts:276`) |

**What is NOT measured:** how many self-hosted installs are currently wedged. The class is reachable
by construction; its population is unknown and this spec claims no number for it.

### Why the originally-proposed refresh assertion is NOT built (round-1 correction)

The first draft proposed asserting the marker inside `scripts/staging-refresh.sh` between the restore
and the schema replay, justified by "it could never fire." **That justification was too strong and is
withdrawn** — it generalised from one populated production to an invariant. The precise position:

- **Populated source (today's prod):** the marker travels in the dump, so after a refresh it is
  present. And in the case where it were absent, `pg:schema` at `staging-refresh.sh:208` **already
  refuses** — the assertion would only move the same failure five lines earlier. Diagnostic, not
  protective.
- **Zero-team source — the case round 1 raised as reachable — is REFUTED.** The marker upsert at
  `lib/access/groups.ts:274-276` sits **after** the per-team loop and is **unconditional**: a fleet
  with zero teams runs an empty loop and still stamps the marker. So a zero-team restore deploys
  (PRET-6's predicate requires `exists (select 1 from teams)`), boots, and stamps the marker before
  any team can be created. It cannot become wedged later.
- **Markerless populated source** would mean production itself had lost the marker — in which case
  production is wedged on its own next deploy, which a staging-side assertion does not address.

So the fence excludes exactly one thing — a duplicate of a refusal that already exists — and it lands
nowhere because there is nothing left to build. Recorded rather than deferred.

## 1. The rule

**An operator holding a `DATABASE_URL` must be able to complete the PRET-4 materialization without
booting the application; on an already-materialized fleet that must be a read-only no-op; and the
fleet-rewriting case must require explicit confirmation.**

## 2. The design

**One new admin command**, `materialize-builtins`, in the existing CLI (`scripts/admin.ts`, run as
`npm run admin -- materialize-builtins`).

It calls the **shipped** `materializeBuiltinMembershipOnce`. It does not reimplement it, copy its
predicate, or add a second writer — the manual path and the boot path are the same function, so they
cannot drift.

**`--confirm` is REQUIRED to write; dry-run is the default** (round-1 finding, accepted). The
asymmetry with `purge-items`, which already dry-runs by default in this same CLI, was not defensible:
this command is fleet-wide, can create groups, can add memberships, can **delete** deliberately-edited
builtin memberships, and runs against whatever `DATABASE_URL` the shell happens to hold. The concrete
wrong outcome it prevents: an operator believes the URL is staging, it is production, production's
marker is absent mid-recovery, and a member deliberately removed from `everyone` is silently restored
by a reconcile from the retired tier predicate.

**`--confirm` is parsed STRICTLY as a bare flag** (round-2 HIGH, accepted). `parseArgs`
(`scripts/admin.ts:37-48`) assigns the following token as a string, so `--confirm false` yields the
string `"false"`, and `if (!flags.confirm)` treats that as **confirmed**. This command therefore
accepts only the bare form and **refuses** `--confirm <value>` and `--confirm=<value>` rather than
guessing. *(The same trap exists today in `purge-items` at `scripts/admin.ts:531` — a real latent
defect in a destructive command, out of scope here — see §3.)*

**Fleet identity comes from `staging_marker`, not from team identity** (round-2 HIGH, accepted — but
with the proposed remedy REFUTED and replaced). Round 2 proposed binding confirmation to the team
slug/UUID. **Measured, and it does not discriminate:** staging is a restore of production, so both
databases hold the *same* team — `73409b20-c11d-4b35-8ce4-e0a53eb219b5 | aios` — and a
`--confirm-team aios` would match production exactly as well as staging. A hash of the ordered team
UUID set fails identically, for the same reason.

The primitive that *does* discriminate already exists and was purpose-built for this question:
`to_regclass('public.staging_marker')` is **`t` on staging and `f` on production** (measured), because
the table is deliberately absent from `postgres/schema.sql` and every migration so a `--clean` restore
cannot carry it to prod. So:

| database | to write |
|---|---|
| carries `staging_marker` | `--confirm` |
| does **not** carry it (may be production) | `--confirm` **and** `--confirm-production` |

Both paths print which fleet they believe they are pointed at before doing anything.

**Behaviour lives in an import-safe module with injected dependencies** —
`lib/access/materialize-command.ts` **(new file)**, exporting `runMaterializeCommand(deps, opts)`.
Two reasons, the second from round 1:

1. `scripts/admin.ts` calls `main()` at module scope, so a test that imports it executes the CLI. The
   file already solved this once for `formatAccessHealth` (`scripts/admin.ts:98-104`).
2. A static source-text guard is **not behavioural coverage**: `case "materialize-builtins": { /* materializeBuiltinMembershipOnce */ break; }`
   would satisfy it while doing nothing. Injecting `{ readState, materialize }` makes the real
   decisions — which branch runs, what exits non-zero, whether `--confirm` gates the write —
   observable in the unit tier against fakes.

```ts
type FleetState = { marker: boolean; teams: number; stagingMarker: boolean };
type MaterializeDeps = {
  readState: () => Promise<FleetState>;                                  // READ-ONLY by construction
  materialize: () => Promise<{ ok: boolean; ran?: boolean; error?: string }>;
};
type Opts = { confirm: boolean; confirmProduction: boolean };
runMaterializeCommand(deps, opts): Promise<{ lines: string[]; exitCode: number }>
```

**Every reachable outcome has a contract** (round-2 MEDIUM, accepted — the first draft's table omitted
four of these):

| state | effect | exit |
|---|---|---|
| `readState` rejects or errors | reports the read failure; `materialize` **never called** | **non-zero** |
| marker present | reports already-materialized; `materialize` **never called** | 0 |
| marker absent, not confirmed | reports fleet identity + team count + what it would do; **no write** | 0 |
| marker absent, confirmed, no `staging_marker`, no `--confirm-production` | **refuses**, naming the missing flag | **non-zero** |
| marker absent, confirmed, `materialize` → `{ok:true, ran:true}`, teams > 0 | reports N teams reconciled | 0 |
| marker absent, confirmed, `{ok:true, ran:true}`, teams = 0 | reports **marker stamped, zero teams reconciled** — distinct wording | 0 |
| marker absent, confirmed, `{ok:true, ran:false}` | **the race**: boot/tick stamped it between the read and the call (the materializer re-reads at `lib/access/groups.ts:205-211`). Reports *already completed concurrently* — a success, not a lie about having run | 0 |
| marker absent, confirmed, `{ok:false, error}` | reports the error; marker NOT stamped | **non-zero** |
| marker absent, confirmed, `materialize` **throws** | caught and reported like `ok:false` (boot/tick already anticipate throws — `lib/ingest/scheduler.ts:71-75`) | **non-zero** |

The non-zero exit is load-bearing: an operator recovering a wedged deploy needs to know whether to
redeploy, and a command that prints an error and exits 0 reads as success to a human in a hurry and to
any wrapper script.

**Safety envelope, stated precisely** (round-1 narrowing): when the marker is present the function
performs one read and zero writes, because the marker read at `lib/access/groups.ts:205` returns at
`:211` before every write (`:217` groups, `:250` adds, `:257` deletes, `:267` audit, `:273` marker).
That makes an accidental run against a **healthy** production harmless. It does **not** make an
accidental run against a markerless production harmless — which is precisely why `--confirm` exists.

**The wiring pin extends the existing guard.** `test/guards/access-bootstrap-callsites.test.ts`
already pins this function's call sites and states the repo's recurring failure mode in its header.
The new dispatch is pinned there, not in a parallel file.

## 3. Scope

**In:** one command in `scripts/admin.ts`; `lib/access/materialize-command.ts` (new); unit tests over
the handler; one call-site pin added to the existing guard; a dm test executing the real migration
guard; the USAGE line; the runbook section.

**Out, deliberately:**
- **The PRET-6 migration is not modified.** Making it self-materialize would either reproduce a
  TypeScript reconcile in SQL (a second implementation, drift risk) or invoke application code from
  schema replay (materially expanding the deployment contract). **Recorded here as follow-up work; no ticket filed yet** (STAGINGMARK-2 when opened) —
  named rather than left as "a better end state."
- **`scripts/staging-refresh.sh` is not touched** — §0 states the corrected reason.
- **No Railway automation.** Nothing here sets a variable or triggers a deploy.
- **The `docs/OPS.md:702` drift** (`INGEST_POLL_ENABLED` documented `false`, live UNSET) is recorded
  in §0 and **not fixed here**: it concerns a different table, and changing live staging variables is
  outward-facing and needs its own decision. **Recorded here; no ticket filed yet** (STAGINGMARK-3 when opened).
- **`purge-items`' own `--confirm` trap** (`scripts/admin.ts:531` — `--confirm false` reads as
  confirmed, so a destructive command proceeds) is a **pre-existing defect found by this slice's
  round-2 review**, not introduced by it. Fixing a destructive command's confirmation deserves its own
  spec and reviews rather than a drive-by edit here. **Recorded here; no ticket filed yet** (STAGINGMARK-4 when opened).

## 4. Acceptance

- **AC1 — an already-materialized fleet never calls the materializer (unit):** with
  `readState → {marker:true, teams:1}` and a `materialize` fake that throws if invoked,
  `runMaterializeCommand` resolves, `exitCode === 0`, and the fake was **not called**. *This is the
  property that makes a slip against healthy production harmless; asserting the call did not happen is
  stronger than asserting the row did not change.*
- **AC2 — without `--confirm` a markerless fleet is not written (unit):** with
  `readState → {marker:false, teams:3}` and `confirm:false`, the materializer fake is **not called**,
  `exitCode === 0`, and the output names the team count and how to proceed.
- **AC3 — with `--confirm` it runs (unit):** same state, `confirm:true`, materializer returns
  `{ok:true, ran:true}` → it **was** called once, `exitCode === 0`, output distinct from AC1's.
- **AC4 — a failure exits non-zero (unit):** materializer returns `{ok:false, error:"boom"}` →
  `exitCode !== 0` and the output contains `boom`. *An error printed with exit 0 is read as success.*
- **AC5 — the three outcomes are distinguishable (unit):** the `lines` from AC1, AC3 and AC4 are
  pairwise different, and only AC4's matches `/fail/i`. *An operator who cannot tell whether the
  command did anything has to guess whether to redeploy.*
- **AC6 — the remaining non-success states exit non-zero, and two of them never write (unit):** three
  cases beyond AC4 — (a) `readState` rejects; (b) marker absent, `confirm:true`,
  `stagingMarker:false`, `confirmProduction:false` (the production refusal); (c) `materialize`
  **throws** rather than returning `{ok:false}`. All give `exitCode !== 0`; in (a) and (b) a
  `materialize` fake that throws if invoked is **never called**. *Round 2 found the first draft's
  table silent on all three; boot/tick already anticipate a throw (`lib/ingest/scheduler.ts:71-75`),
  so the handler must too.*
- **AC7 — the two success-but-did-not-run states are not reported as a run (unit):** with the
  materializer returning `{ok:true, ran:false}` (the boot/tick race) the output says *already
  completed*, `exitCode === 0`, and does **not** claim it ran; with `{ok:true, ran:true}` and
  `teams:0` the output distinguishes *marker stamped, zero teams reconciled* from AC3's substantive
  wording. *The first draft would have printed "it ran" for a call that did nothing.*
- **AC8 — `--confirm` is a bare flag, and a value is REFUSED (unit):** the CLI-boundary parser accepts
  the bare forms; for `--confirm false`, `--confirm-production <value>` and `--confirm=false` it
  **refuses** with a message rather than treating the string as truthy or silently ignoring it.
  *Verified at the parse boundary, not through the handler, because `parseArgs`
  (`scripts/admin.ts:37-48`) is exactly where `"false"` becomes truthy — AC1–AC5 take an
  already-normalised boolean and structurally cannot catch this. Round 2 also asked for a duplicated
  `--confirm` to be refused; that is **not built and the criterion does not claim it**, because
  `parseArgs` collapses `--confirm --confirm` to the same `true` before this layer sees it, making the
  two spellings indistinguishable by construction — and they mean the same thing.*
- **AC9 — the dispatch is pinned by SHAPE, and there is no second writer (unit guard):**
  `test/guards/access-bootstrap-callsites.test.ts` asserts (a) `scripts/admin.ts` calls
  `runMaterializeCommand(` , (b) `USAGE` lists `materialize-builtins`, and (c) `scripts/admin.ts`
  does **not** reference `materializeBuiltinMembershipOnce` directly. *(c) is the load-bearing half:
  without it the CLI could call the handler AND invoke the materializer itself, leaving AC1 green
  while the real command writes. The file already pins call shape rather than names at `:83-100`.
  Must be mutation-proven to redden when the dispatch is deleted.*
- **AC10 — the real migration guard stops refusing (dm):** against a real Postgres with one
  non-permissive team, builtin groups and **no** marker: extract the `do $$ … $$` block **verbatim
  from `postgres/migrations/20260818210000_pret6_retire_access_enforcement.sql`** (read from the file,
  never retyped) and execute it **inside `begin … rollback`** — it **raises** with the marker message.
  Run `materializeBuiltinMembershipOnce`, execute the same block the same way — it **does not raise**.
  *Round 2 HIGH, accepted: the block's second half drops `teams.access_enforcement` and
  `autoflip_hold` (`:36-43`), and dm isolation truncates rows but not DDL
  (`test/datamechanics/setup.ts:66-76`) — running it bare would corrupt the shared schema for every
  later test, which is exactly the hazard CLAUDE.md records. Postgres DDL is transactional, so the
  rollback keeps the execution verbatim AND leaves no trace. The claim stays scoped to the marker
  refusal; the permissive condition at `:36` is not addressed by this slice.*
- **AC11 — a partial reconcile leaves the marker unstamped (dm):** construct a team where
  `ensureBuiltins` performs a convergent write and then fails, so the function returns before the
  marker upsert. Assert **both** that the partial write landed **and** that `migration_markers` holds
  no `pret4_builtin_materialize` row. *Round 2 LOW, accepted: a failure induced before any write would
  leave the marker absent trivially and prove nothing about marker-last ordering.*
- **AC12 — the runbook names the recovery, runnably (docs + unit guard):** `docs/OPS.md` §11 gains a
  subsection containing the refusal message **verbatim**, the command in `npm run admin -- …` form,
  where it is run from (a checked-out tree of the candidate release with `DATABASE_URL` set — **not**
  the still-running old image, which does not contain the command), and the dashboard-rollback
  alternative. The existing guard forbidding bare `npx tsx scripts/admin.ts` in docs
  (`test/guards/release-tag-policy.test.ts:238`) must stay green. *Verbatim so an operator pasting the
  error into a search lands here.*

## 5. What would falsify this

If `materializeBuiltinMembershipOnce` wrote anything before its marker read, the read-only claim would
be false and the marker-present path would need confirmation too. AC1 is written to catch that by
asserting the materializer is never invoked, against fakes rather than by reading the function.
