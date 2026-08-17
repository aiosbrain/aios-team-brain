---
access: team
---

# PRET-2 — the convergence-gated auto-flip (slice spec)

**Program:** `docs/design/retire-permissive-model.md` (PRET-1) §4-§5 — this slice is bound by
its contracts; deviations below are narrowings, called out inline.
**Ticketing (SR12):** row `PRET-2` in the workspace `3-log/tasks.md` (parent row `PRET-1`),
projected to Linear by pm-sync on `aios push`; this slice's PR carries `AIOS-Work: PRET-2`.
**Deps:** PRET-1 merged (the program design; PR #580). ONE additive schema change (amended
from "none" by the Codex diff review, H2): `teams.autoflip_hold boolean not null default false`
(`postgres/migrations/20260817120000_autoflip_hold.sql`, mirrored in `postgres/schema.sql`) —
the operator-undo hold is CONTROL STATE and cannot ride a best-effort audit insert that can
silently fail; it is written ATOMICALLY with every mode change (the same UPDATE statement:
any downgrade arms it, any enforcing flip clears it).
**Build with:** fable / high — this slice writes the flag that can brick a brain; every branch
must fail toward "stays permissive, loudly".
**Concurrency/durability (SR14):** audit rows are APPEND-ONLY inserts (`lib/api/audit.ts` —
never updated); the flip write is the module's existing read-back-verified idempotent
transition, already race-checked for the no-op path (`access-enforcement.ts` `writeMode`,
pinned by `test/access-enforcement-noop-race.test.ts`), so concurrent scheduler instances and
a concurrent manual flip converge on one terminal state with at most one audit row per actual
change. Existing dm sibling: `test/datamechanics/access-enforcement-flip.datamechanics.test.ts`
covers the MANUAL path and stays; the program-mandated new file below covers the AUTO path.

## 1. What this slice ships

The unattended path that moves the fleet to enforcing, built ON the existing operator surface
(`lib/admin/access-enforcement.ts` — `setAccessEnforcement` already does bootstrap → full drain
→ readiness assessment → refuse-or-write → read-back → audit; this slice adds no second flip
logic):

1. **`autoFlipIfReady(db, teamId)`** in `lib/admin/access-enforcement.ts`, with cost-ordered
   stages and two absolute exclusions:
   - **The operator-undo hold (cold-read H3; twice corrected):** `teams.autoflip_hold` — a
     column set atomically with ANY downgrade to permissive and cleared by any enforcing flip
     (the sole flip writer's single UPDATE). The team is EXCLUDED from auto-flip while held;
     only a manual re-flip re-arms it. History of the rule: originally member-attributed
     (defeated — the CLI undo is member-less and audits as `system`), then any-downgrade but
     AUDIT-derived (defeated — Codex H2: `audit()` is best-effort, so a downgrade whose audit
     insert silently failed would be re-flipped within a tick, and same-timestamp audit rows
     are unordered). Control state now lives in the row it controls.
   - **The cheap warning pre-check BEFORE any drain (cold-read H2), as a COST OPTIMIZATION
     only:** connectors from the members read; unplaced agents from ONE bulk `group_members`
     read (Codex M4: the per-agent oracle loop was unbounded N+1 work). The AUTHORITATIVE
     warning gate is `setAccessEnforcement`'s `refuseOnWarnings` option — post-drain,
     pre-write, judging the full assessment's own warnings — so a shape the cheap scan
     under-detects defers there, never flips unwarned.
   - Only a warning-free, un-held team proceeds to
     `setAccessEnforcement(db, teamId, "enforcing", { actorMemberId: null })` — the full
     prepare → drain → assess → refuse-or-write sequence, whose own blockers defer likewise.
   - **The deferral fingerprint latch (H2's audit-growth bound):** a deferral writes the
     `access.autoflip_deferred` audit row (meta `{ blockers, warnings, error? , fingerprint }`,
     fingerprint = sha of the sorted reason strings) ONLY when the fingerprint differs from the
     team's most recent deferral row — an unchanged stuck state writes nothing, so audit growth
     is one row per DISTINCT state, not per tick (the latch is AUDIT HYGIENE only; attempt
     scheduling belongs to the pass's rotation, §1.2). (`audit()` is best-effort and never throws — a swallowed deferral write just means
     the next tick retries the write; stated, harmless.)
   - **Budget accounting under errors (Codex M1):** whether the expensive stage RAN is
     tracked outside the try, so a throw AFTER the drain began still reports `drained: true`
     and consumes the pass's budget — a late-throwing team cannot make a pass run unboundedly
     many drains.
   - **Error containment (cold-read M2):** the whole per-team body is wrapped — any throw
     (readiness reads throw by design, `access-enforcement.ts:109,126`) becomes a deferral
     with `error` in meta, never a pass abort; `autoFlipIfReady` returns
     `{ flipped: boolean; deferred?: { blockers: string[]; warnings: string[]; error?: string } }`
     and NEVER throws. `checkedAt`/last-attempt = the audit row's `created_at`; a
     never-attempted team simply has no row and is immediately eligible.
2. **The scheduler pass** — extracted as an exported, testable module
   `lib/admin/auto-flip-pass.ts` (`runAutoFlipPass(db)`), called from `lib/ingest/scheduler.ts`'s
   tick beside `runContextBackfill` (cold-read L2: the tick is a closure with nothing to
   export today; the dm tests and the call-site guard need a module). Per pass: enumerate
   `permissive` teams (the HOLD rides the same team row and is read with the mode — no audit
   scan on the hot path), attempt up to
   **`PRET_FLIP_MAX_PER_TICK` (default 3, `resolvePositiveInt`)** under the rotation below.
   `AUTO_FLIP_ENABLED=false` is the operator kill switch for the whole pass (diff review: the
   rate-limit env cannot express zero; same opt-out pattern as `GRAPH_PROJECT_ENABLED`).
   **Fair rotation (Codex H1):** the deferral latch dedups AUDIT ROWS only — it cannot order
   the queue — so the pass keeps a per-process monotonic attempt sequence: every team whose
   expensive stage ran rotates to the back; never-attempted teams go first. Permanent blockers
   therefore cannot monopolize the budget (dm-pinned: 3 permanent blockers + 1 ready team,
   budget 3 — the ready team flips by pass 2). Per-process on purpose: no schema, no clock;
   a restart re-shuffles at most one budget's worth of attempts. A failed fleet ENUMERATION
   returns a pass-level error the scheduler records as a FAILED `auto_flip` run (Codex M3 —
   the mechanism must not stop silently).
   The count short-circuit is not consulted AT ALL (the latent count-skip bug,
   `backfill.ts:168`, is DEFERRED to PRET-6 with a comment at the site — it can only delay a
   scheduler backfill, never gate a flip). **Honest cost statement (H2 corrected —
   the earlier "exactly the work the tick does anyway" claim was false):** a full drain has
   deliberately NO short-circuit and walks the corpus cursor; under this design a drain is
   paid ONLY by warning-free flip candidates, at most `PRET_FLIP_MAX_PER_TICK` per tick, and
   each candidate's outcome is a flip or a fingerprint-latched blocker-deferral — so repeated
   full-cost attempts on an unchanged team cannot happen.
   **The fleet-level consequence, stated (H2):** most REAL teams carry connectors or agents,
   so the scheduler pass is the mover for clean teams and the surfacing machinery for
   everyone else — the fleet largely lands via MANUAL flips made with eyes on the surfaced
   warnings, and the operator's own prod (4 connectors, per the module's own comment) WILL be
   a manual flip. That is the intended shape of ruling 1's rollout, not a failure of it.
3. **New teams — one path, no created-enforcing special case:** team creation stays
   permissive; the demo/bootstrap seed completes (`docker/bootstrap.mjs` seeds via `ingestItem`,
   which bypasses the items route's reconcile hook — the flip's own drain is what partitions
   those rows); then the auto-flip runs once post-seed via a NAMED entry point (cold-read L1:
   `docker/bootstrap.mjs` cannot import TS/`server-only` modules — it spawns scripts): a new
   `scripts/admin.ts` subcommand `auto-flip <team-slug>` calling `autoFlipIfReady`, invoked
   from `docker/bootstrap.mjs` through its existing `npx tsx` spawn pattern; best-effort — the
   scheduler pass is the retry. Accepted latency, stated: a post-flip item whose route
   reconcile hook fails is invisible for up to one scheduler tick (~30min) — the §11 backstop,
   not a bug.
4. **Stuck-state surfacing — corrected premise (there is NO admin card for enforcement today;
   PR #578 shipped the CLI + module only, verified by its file list):** the surfaces are the
   permission INSPECTOR and the CLI. `lib/access/inspect.ts` (whose result the dashboard route
   `app/api/dashboard/access/inspect/route.ts` serves, and which already reports the mode at
   `inspect.ts:76`) gains one ADDITIVE field —
   `autoFlip: { at: string; blockers: string[]; warnings: string[]; error?: string } | null`
   (flat — as built and pinned by the route test; amended from the earlier nested draft shape)
   — populated from the most recent `access.autoflip_deferred` audit row for a still-permissive
   team; and `scripts/admin.ts`'s `access-enforcement` command prints the same. **Surfacing is
   the RAW latest deferral (reason + first-seen timestamp), amended from the earlier
   attempts-counted STUCK rule (diff-review M3):** the fingerprint latch deliberately writes
   ONE row per distinct state and `audit_log` is append-only by trigger, so an attempt counter
   cannot exist without either audit spam (the H2 hazard) or an audit UPDATE (forbidden).
   Blockers-vs-warnings in the surfaced row IS the classification — blockers = stuck on a
   fault, warnings = awaiting the operator's manual-flip decision; no wall-clock or
   attempt-count label is applied (which also moots cold-read M4's mislabeled-queue concern —
   nothing is labeled by time at all). A rendered STUCK badge is deferred to whichever slice
   first builds an enforcement UI surface. Wire contract
   disposition (SR7): this slice changes NO HTTP contracts — no route added or removed, the
   existing tier-422 refusals untouched; the inspect payload change is additive-only, and any
   http-tier pin on its shape is updated in this same slice.
5. **The flip-day cost estimate, BEFORE any flip:** `scripts/pret-flip-estimate.mjs` — for each
   permissive team: initiative partitions (`projects.graph_group_id` non-null, non-built-in) ×
   items per partition (membership counts) × `cardinality(chunk_shas)` sums × the measured
   quiet-window per-episode rate ($0.0057, `docs/design/phase-c-per-project-graphs.md` cost
   gate). Chunk counts are sourced from the TIER-GROUP ledger rows (`graph_episodes` under the
   built-in pointer groups — the content that would fan out), not the empty initiative
   partitions of a permissive team (cold-read L5: the two differ and the formula must say
   which). Preflight (SR15): requires a readable `DATABASE_URL` (locally: the Railway public
   proxy per CLAUDE.md §6, read-only); if unavailable, record "estimate: NOT RUN — no prod
   access" in the PR body and do not enable the scheduler pass until it has run — never a
   silent skip. Numbers recorded in this slice's PR body before the pass is enabled. The
   runtime worst case stays budget-bounded regardless (`PPARC_SYNTH_BUDGET_PER_READ`,
   defined+enforced `lib/graph/arcs.ts` / consumed `lib/graph/arc-fusion.ts`;
   `GRAPH_FANOUT_PUSH_MAX_PER_PASS`, defined+enforced `lib/graph/project.ts`). Zero-LLM ordering (SR13): every readiness/estimate
   signal in this slice is plain SQL — no model call occurs before or during a flip decision;
   the only LLM work a flip can eventually cause is the projector/synthesis machinery
   downstream, behind its own budgets.
6. **The release note** (`CHANGELOG.md`): a converged team's Learning panel changes from the
   single tier-row narrative to the fused per-project panel on flip day — ruling 1's accepted
   change, named at the slice that causes it.

## 1b. Per-principal safety posture across the flip (SR7 — every tier named)

| Principal class | Pre-flip (permissive) | Post-flip (enforcing) | Fail direction |
|---|---|---|---|
| team-tier member | full team-tier reads | oracle ∧ tier — byte-identical items after the drain (§11 promise, criterion 1); arcs panel becomes the fused per-project panel (priced §1.5, noted §1.6) | a missing membership hides content (fail closed) — which is why the flip is refusal-gated |
| external-tier member | external-shared only | oracle ∧ tier — same external-shared content via its membership | unchanged posture; fail closed |
| delegated token (`aiosd_*`) | always-attenuated (tier-independent) | identical — the flip does not touch token semantics | fail closed, unchanged |
| agent member | tier reads | oracle-resolved; an unplaced agent reads ZERO (readiness WARNING → no auto-flip; manual only) | fail closed, human-decided |
| connector service account | can read today | reads ZERO (readiness WARNING → no auto-flip; manual only) | fail closed, human-decided |

The 422 wire contract and every route's refusal behavior are byte-identical through this slice
(§1.4); the ONLY reads that change are the flipped team's, in the enforced direction.

## 2. Acceptance criteria (spec-first; the dm file is the program-mandated
`test/datamechanics/access-flip.datamechanics.test.ts`)

1. `test/datamechanics/access-flip.datamechanics.test.ts` — a seeded, drained team:
   `autoFlipIfReady` flips it to enforcing (read back from the row), and a member's
   `nativeRetrieve` ITEM-LEG sources (the FTS/recency/dense hit list — paths and ids) are
   IDENTICAL pre/post flip: the §11 byte-identical promise, scoped to the legs it governs.
   **The legs EXPECTED to differ post-flip are enumerated and asserted as such, not wished
   away (cold-read M1):** the activity digests / full-corpus task aggregate / commitments legs
   go omitted (`omitGraph`), the rels triple narrows to `REPORTS_TO`, null-source decisions
   drop, and the graph leg switches to partition-served (possibly empty on a just-flipped
   team's unarmed initiative partitions) while the actors/REPORTS_TO legs SURVIVE via the
   QMIR-1 member arm. A full-structured-equality assertion is red by design and forbidden.
   Verify:
   `npm run test:datamechanics:iso test/datamechanics/access-flip.datamechanics.test.ts` exits 0.
2. Same file — a team with an UNPARTITIONED item does not flip; the refusal writes
   `access.autoflip_deferred` with the blocker in meta; the row still reads `permissive`.
3. Same file — a team with a WARNING (an active connector member) does not auto-flip, and the
   deferred audit row carries the warning; the MANUAL `setAccessEnforcement` on the same team
   still succeeds (the narrowing gates only the unattended path).
4. Same file — a readiness/prepare ERROR (induced) does not flip (default-deny, deferred with
   `error` in meta, the pass NOT aborted for other teams); a second `autoFlipIfReady` on an
   already-enforcing team is a no-op with no new audit row (idempotency, the no-phantom-audit
   property the module already pins for the manual path); the RACE arm: a flip whose guarded
   write (`.eq("access_enforcement", previous)`) loses to a concurrent change fails cleanly
   with no mis-attributed audit row (the write returns its MATCHED ROWS — Codex M2: a
   read-back cannot distinguish "my write landed" from a same-target concurrent winner);
   and the OPERATOR-UNDO HOLD: any downgrade arms `teams.autoflip_hold` atomically and the
   team is never auto-flipped while held — including the member-less CLI shape, and even if
   the audit trail is wiped (dm-pinned).
5. Same file — FIVE ready permissive teams, one scheduler pass: exactly
   `PRET_FLIP_MAX_PER_TICK` (3) flip; the remaining two flip on the next pass
   (rate limit, mutation-verified: budget 3→5 reddens the exact-count assertion).
6. `test/guards/autoflip-callsites.test.ts` — the scheduler tick's call site and the
   post-seed call site are pinned (the pin-the-call-site rule); `PRET_FLIP_MAX_PER_TICK` has
   exactly ONE parse site. Verify: `npx vitest run test/guards/autoflip-callsites.test.ts`
   exits 0.
7. `docs/ARCHITECTURE.md` Access-enforcement row records the auto-flip in the same PR;
   `npm run check:docs` exits 0.

## 3. Out of scope, named

The arcs unification (PRET-3 — this slice may flip teams onto the already-shipped enforced
fused path; that panel change is priced in §1.5 and release-noted in §1.6), the tier-wall
teardown (PRET-4), and the flag's removal (PRET-6). `setAccessEnforcement`'s manual semantics
change in exactly ONE way (cold-read M3 — fulfilling PRET-1 §4's binding flip-writer contract
instead of amending it down): `writeMode`'s update gains the guarded predicate
`.eq("access_enforcement", previous)`, so a write raced by a concurrent flip FAILS its
read-back cleanly instead of clobbering and mis-attributing an audit row; strictly safer for
the manual path, dm-covered in criterion 4's race arm.
