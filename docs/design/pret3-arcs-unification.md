---
access: team
---

# PRET-3 — arcs unification: the fused panel is the ONLY arcs read (slice spec)

**Program:** `docs/design/retire-permissive-model.md` (PRET-1) §5 slice 2, bound by its
contracts; ruling 1 (the fused per-project panel IS the product) is what this slice makes true
for every reader, not just enforcing members.
**Ticketing:** row `PRET-3` in the workspace `3-log/tasks.md` (parent `PRET-1`), projected via
pm-sync; this slice's PR carries `AIOS-Work: PRET-3`.
**Deps:** PRET-2 merged (PR #583 — the fleet is converging to enforcing, so the tier path's
audience is already shrinking). No SCHEMA change; ONE DATA migration (the H2 corrections
re-key, `postgres/migrations/` + mirrored disposition notes — additive, idempotent,
replay-safe).
**Build with:** fable / high — this slice deletes a read path; the failure modes are a reader
class silently losing its panel (vanish) or the retired path surviving un-called (dead code
attested as retired — the SR16 class).

## 1. The reader-destination table (every class named; the H2 discipline)

The complete production reader inventory of the tier-row ARCS path (M1: scoped claim —
`getArcs(`/`getFusedArcs(`/`readArcCache(` callers outside tests; `visibleGroupIds` has
NON-arcs callers that survive this slice with named destinations:
`app/api/v1/graph-query/route.ts`, `app/api/brain/events/route.ts`,
`app/api/brain/facts/route.ts` (graph reads — PRET-4's wall-teardown), and
`lib/query/retrieve.ts` (the permissive Graphiti union — PRET-4), plus
`lib/cache/tier-invalidation.ts` (a WRITER-side door this slice EXTENDS per H3). Program AC2's
grep is correspondingly arcs-scoped: the assertion is "no production CALLER of the tier-row
arcs read path", not a repo-wide absence of `visibleGroupIds`):

| Reader | Today | After PRET-3 |
|---|---|---|
| Enforcing team-tier member (`app/api/brain/arcs/route.ts`) | fused over `selectEnforcedGraphPartitions` | UNCHANGED |
| External member (any team; same route) | `getArcs` tier path over `visibleGroupIds(slug, "external")` | fused over the SAME oracle resolution every member gets (mode-keyed, not tier-keyed — M3): on an enforcing team their oracle scope (today: the external-shared built-in's pointer partition, `lib/graph/project-pointer.ts` grandfathers `<slug>_external`; with initiative memberships, those partitions too — ruling 2 working as designed); on a permissive team the external built-in partition. Content: the external-shared row, now CORRECTIONS-FREE by the H1 rule — NOT byte-identical to the old tier row where corrections had leaked in; that difference is the point |
| Member of a still-permissive team (same route) | `getArcs` tier path over the tier-group union | fused over the BUILT-IN pointer partitions their tier resolves to (`g:<slug>_team` [+ external-shared for team tier] — the built-ins ARE partitions with pointers; the fused cold policy synthesizes one inline and warms the rest, so first reads are served, not blanked) |
| Social discovery (`app/t/[team]/social/actions.ts` → `lib/social/discover-arcs.ts` — M2: the earlier `discover.ts` citation was the items path) | `getArcs` tier path over a HARDCODED team-tier union, ignoring enforcement entirely | the fused read as the ACTING ADMIN's `resolveArcScope` — a stated PRODUCT CHANGE on enforcing teams (M2): discovery input narrows to the admin's memberships, so arcs from projects the admin is not in stop generating opportunities; correct under membership-is-the-model, named here rather than smuggled |
| The recompute route (`app/api/brain/arcs/recompute/route.ts`), non-enforced arm | tier-scope key | the fused-scope keys (`g:<group>`), same resolution as the read route — one scope vocabulary |
| `app/api/v1/graph-query/route.ts` | tier-scoped GRAPH search (`visibleGroupIds`) | OUT OF SCOPE — this is graph search, not arcs; its tier conjunct is PRET-4's wall-teardown territory (named destination, not silently fenced out) |

**What RETIRES with no production caller (program AC2):** `getArcs`' tier-row synthesis entry
(the sorted-tier-set scope), the PCCC-6a permissive union machinery inside the arcs path, and
the corrections read's tier arm (`includeLegacy: true` — the tier path was its only caller).
**Legacy `''`-scoped corrections rows:** KEPT — human data is never deleted (the PPARC-3
multi-group precedent, `postgres/migrations/20260816150000_arc_corrections_partition_scope.sql`
comment block) — but unread after this slice; counted by the criterion-4 query below.

## 1a. Three rulings the cold read forced (H1/H2/H3 — each was a shipped leak or vanish)

- **H1 — the external-shared partition's synthesis is CORRECTIONS-FREE, by rule.** Today's code
  keeps corrections out of external-facing prose with an argument that this slice invalidates
  (`lib/graph/arcs.ts:725-747`: "there is no external-principal path to [the g: row]" — PRET-3
  creates exactly that path, and enforced members already write corrections scoped
  `g:<slug>_external`). The rule replacing it: a synthesis whose partition is the
  external-shared built-in NEVER loads corrections — client-facing prose carries no internal
  editorial text, same invariant, new mechanism, pinned by a dm test and a mutation. Team
  members lose correction application on external-shared arcs only (small, principled, stated);
  PRET-5 may revisit when external membership semantics are proven end-to-end. WRITE-side
  corollary (found during build): the recompute route REFUSES a correction whose `sourceGroup`
  is the external-shared partition (422 naming the rule) — accepting it would store prose the
  read side never loads, the H13 dead-correction shape through a new door. This also reverses
  the Fable-6b-Medium-4 allowance (corrections loaded for a `g:<slug>_external` partition
  scope) — that allowance existed BECAUSE no external principal could read the row, the exact
  premise this slice retires; the reversal is the H1 rule applied consistently.
- **H2 — tier-keyed corrections are RE-KEYED, not stranded** (rules hardened by the diff
  review — the fleet holds shapes the first draft did not model: kept-`p:` multi-group rows
  keep the PPARC-3 ruling and are NEVER re-keyed into General, the migration excludes `p:%`;
  ONE newest eligible sibling per (team, arc) is re-keyed so rename-era duplicate keys cannot
  collide the per-scope unique and halt a deploy from preDeploy; an existing `g:` row wins its
  slot with losers kept-unread and honestly counted; teams with no General pointer are skipped
  and counted; and standing `g:<slug>_external` cache rows synthesized under the old
  corrections allowance are wiped ONCE, marker-bounded, so externals are never served
  pre-H1 laundered prose). Every read becomes `g:`-exact
  after this slice, so current tier-set-keyed correction rows (a permissive team's entire
  correction history — and any enforcing team's pre-PPARC rows the retiring `includeLegacy`
  arm still served) would silently stop feeding synthesis: the H13 revert, fleet-wide. A DATA
  migration (no schema change) re-keys them: `group_key = <sorted tier set>` →
  `g:<slug>_team` (single target — the external-shared partition is corrections-free per H1,
  so duplicating there would feed nothing). Idempotent, replay-safe, per-scope-unique-aware
  (`on conflict` keeps the newer row, counted); `''`-legacy rows keep their PPARC-3
  disposition (kept, unread, counted). The cold read notes this gap ALREADY fires at each
  PRET-2 auto-flip — this slice closes it program-wide rather than inheriting it.
- **H3 — the reclassification purge door gains the external PARTITION.**
  `lib/cache/tier-invalidation.ts` hard-deletes only the TIER external key and stale-marks the
  rest — sufficient while only team-tier members read `g:` rows, a reopened SWR leak the
  moment externals do (`purgeArcCacheKey`'s own doc names why stale-marking is not enough).
  `purgeExternalTierCaches` additionally purges the external PARTITION row, resolved from the
  external-shared project's STORED `graph_group_id` (diff review H4: a renamed team's pointer
  is frozen under the old slug — a slug-derived key deletes nothing and leaves the served row
  alive; the slug form is only the unbootstrapped-team fallback); both existing call
  sites (`lib/ingest/reclassify.ts`, `lib/graph/run.ts`) inherit it unchanged; dm-pinned by a
  narrowed-item fixture through the external fused read.

## 1b. Per-tier safety posture (SR7 — default-deny stated, not implied)

| Principal | Read posture through this slice | Fail direction |
|---|---|---|
| Enforcing team-tier member | fused over their oracle partitions (unchanged) | a failed enforcement resolution → 500, never the unfiltered set (`app/api/brain/arcs/route.ts` — existing) |
| External member | fused over the external-shared pointer partition ONLY — their oracle can resolve nothing wider | a failed resolution → 500; an empty resolution → empty panel, never the team partitions |
| Permissive team-tier member | fused over the built-in pointer partitions (the same content their tier row synthesized) | a resolution READ failure → 500; a structurally-missing pointer (unbootstrapped team) → 200 empty panel + loud log (SR15 boundary, §3) — never a cross-team or wider read |
| Delegated token (`aiosd_*`) | UNCHANGED — no arcs surface accepts tokens today and this slice adds none | n/a |

The HTTP wire contracts are unchanged: the arcs route's response shape and status codes are
byte-compatible (both arms already return one shape); the recompute route keeps its existing
403 out-of-scope refusal, now over the `g:` vocabulary for every caller; the v1 tier-422
contract (`vitest.http.config.ts`, `npm run test:http`) is untouched — no v1 route changes in
this slice. Every scope resolution defaults DENY: unknown tier, missing pointer, or a
resolution error yields the EMPTY scope, never the union.

## 2. What stays deliberately

- `filterArcsByVisibleItems` (the PCCB-5 evidence filter, `lib/graph/arcs.ts`, applied at
  `app/api/brain/arcs/route.ts`) — defense-in-depth for restricted-between-synthesis-and-read,
  unchanged for every class.
- The fused envelope semantics (PPARC-3, `lib/graph/arc-fusion.ts`: honest `as_of` floor, one
  clock, coverage disclosure), the correction write gate's `sourceGroup` validation
  (`app/api/brain/arcs/recompute/route.ts`), the arc-cache purge doors
  (`lib/graph/arc-cache.ts` `purgePartitionArcCache` + both gated self-clear doors in
  `lib/graph/reconcile.ts` / `lib/graph/project.ts`), the straggler and orphan sweeps
  (`lib/graph/arc-cache.ts` `sweepStaleScopedArcCache` / `sweepOrphanedPartitionArcCache`).
- The `arc_cache` tier rows themselves: unread after this slice, collected by nothing new —
  they age in place until PRET-6's cleanup (regenerable cache; a sweep here would widen this
  slice's blast radius for zero product effect; the PRET-6 deferral is named at the site).
- The QMIR-1 permissive-triple rels arm in retrieve: NOT this slice (it is not an arcs read;
  PRET-4/6 own it, per the program's guard-lifecycle note).

## 3. Contracts

- **One resolution function decides every member's fused scope** (SR9 — named and typed):
  `resolveArcScope(db, { teamId, teamSlug, memberId, tier }): Promise<{ groups: string[]; arm: boolean }>`
  in `lib/graph/partition-read.ts` — MODE-keyed (M3 resolved: PRET-1's "member reads arm" wins
  and ruling 2 makes externals members): ENFORCING team → the member's oracle scope via
  `selectEnforcedGraphPartitions` with `arm: true` for every tier (an external member's oracle
  today resolves the external-shared partition; with granted memberships, more — no
  external-specific branch); PERMISSIVE team → the tier's built-in pointer partitions with
  `arm: false` (the PCCC-6a ruling: a permissive read is not a reader-signal, and the
  built-ins' content IS the legacy graph). The error boundary, decided (SR15): a READ
  FAILURE anywhere in resolution (db error, oracle error) THROWS → the route's existing
  fail-closed 500 — never a silent empty; a STRUCTURALLY-EMPTY result (the queries succeeded
  and found no pointer rows / no memberships) returns `{ groups: [], arm: false }` → a 200
  with an empty panel plus one loud `console.error` naming the team (an unbootstrapped team is
  an operational fault, not a request error). Never a fallback union in either case. The route, social discovery, and the recompute route all consume THIS
  function — the call-site guard pins all three (the pin-the-call-site rule).
- **Writer/locking discipline (SR14):** this slice writes nothing new — `arc_cache` keeps its
  sole writer (`lib/graph/arc-cache.ts`), corrections their per-scope upsert arbiter
  (`lib/graph/arc-corrections.ts`), and the fused read path's only writes remain the existing
  budgeted warm commits behind the purge-generation fence (`lib/graph/arcs.ts`
  `schedulePartitionRefresh`). Retirement deletes call sites; it moves no state.
- **Wire contract (M4 corrected — the earlier "same fields from both arms" claim was false):**
  `coveredPartitions`/`totalPartitions` are fused-arm-only today
  (`app/api/brain/arcs/route.ts` says so verbatim) — after the cutover every client gains
  them: ADDITIVE, stated. The route's real pin is the unit-level
  `test/arcs-route-llm-diagnosis.test.ts` (there is no http-tier arcs file), updated in-slice
  if its shape assertions bite. The recompute route's scope-key vocabulary narrows to `g:`
  keys; an ABSENT `sourceGroup` (the old permissive-client shape) now gets a 422 naming the
  new requirement (M5: a NEW refusal class, stated — not "unchanged"; the served panel
  annotates every arc with `sourceGroup` post-cutover, so live UI self-heals on next load;
  verified during build: `components/learning/arcs-panel.tsx` has grouped per-partition and
  sent `sourceGroup` whenever arcs carry it since PPARC-3 — NO component change is needed, and
  a stale pre-deploy panel's group-less POST gets the 422 until reload. A team member editing
  an external-shared arc now receives the H1 422 with its stated reason — accepted; hiding the
  edit affordance for that partition is UI-phase polish).
- **Cold-start cost:** a formerly-tier-path reader's first fused read synthesizes AT MOST ONE
  partition inline and warms the rest under `PPARC_SYNTH_BUDGET_PER_READ`
  (`lib/graph/arcs.ts`, consumed by `lib/graph/arc-fusion.ts`) — the same bill the tier row
  paid on ITS cold reads, split per partition. No new budget machinery.

## 4. Acceptance criteria (spec-first; exact files and commands)

1. `test/datamechanics/arcs-unified-read.datamechanics.test.ts` (this slice creates exactly
   this file) — an EXTERNAL member's panel through the route-level read path is served from
   the external-shared partition's `g:` row and contains their external-visible arc content;
   a PERMISSIVE team member's panel is served from the built-in partitions' `g:` rows; both
   assert the tier-row scope key was NOT read (the retired path stays cold — the inverse
   assertion, mutation-verified). Verify:
   `npm run test:datamechanics:iso test/datamechanics/arcs-unified-read.datamechanics.test.ts`
   exits 0.
2. Same file — the enforcing member's read is byte-identical to today (the fused arm was
   already theirs), and social discovery on a permissive team mines the fused built-in rows
   (its output references arcs present in those `g:` rows). Same command, exits 0.
3. `test/guards/arcs-single-read-path.test.ts` (program AC2's named guard) — the arcs route,
   social discovery, and the recompute route consume the ONE resolution function; `getArcs`'
   tier entry has no production caller (grep of `app/ lib/` shows callers only in comments/
   tests); widening any call site reddens it. Verify:
   `npx vitest run test/guards/arcs-single-read-path.test.ts` exits 0.
4. After the slice, both halves by complete commands (SR11 — a no-match grep exits 1, so the
   assertion inverts it):
   `! grep -rn "includeLegacy: true" lib/ app/ --include="*.ts"` exits 0 (no production
   caller — the corrections tier arm is dead), and the legacy-rows count is recorded in the PR
   body via the read-only query
   `psql "$PUBURL" -tc "select count(*) from arc_corrections where group_key = '' or group_key not like 'g:%';"`
   (the Railway public proxy per CLAUDE.md §6; if prod access is unavailable, record
   "count: NOT RUN — no prod access", never a silent skip).
5. Existing suites adapt, not vanish (SR2 — made grep-able): every deleted `it(` block from
   the tier-path suites appears in the PR body's re-homing table with its replacement test
   name or a written reason, and
   `npx vitest run test/datamechanics/access-enforce-arcs.datamechanics.test.ts test/arcs-degraded-skips-model.test.ts`
   exits 0 post-surgery (the two suites holding today's tier-path pins).
6. `docs/ARCHITECTURE.md` arcs rows updated in the same PR; `npm run check:docs` exits 0.
   The amended governing docs re-gate: preflight
   `test -x /opt/homebrew/bin/aios && test -f ~/Projects/chetan-workspace/.env`; if BOTH hold,
   from the repo root
   `set -a && . ~/Projects/chetan-workspace/.env && set +a && /opt/homebrew/bin/aios spec eval
   docs/design/pret3-arcs-unification.md --tier deterministic --no-llm`
   prints `verdict: SPEC_READY`, exit 0 (and the same for any other doc this slice amends); if
   either preflight fails, record "spec gate: NOT RUN — CLI unavailable" in the PR body —
   never a silent skip.

## 4b. Small print (from the reviews' Lows)

- Rollout races (Codex diff review H1/H2): the data migration runs at preDeploy while the OLD
  application still serves, so the pre-H1 external-row wipe and a catch-up correction re-key
  run in the NEW code's boot path instead (`lib/graph/pret3-boot-sweep.ts`, marker-guarded via
  `migration_markers`, first scheduler tick post-activation — strictly after old writers are
  gone; a failure records a loud `pret3_sweep` ingest run). The migration keeps the bulk
  re-key (idempotent, replayed every deploy).
- The purge door's pointer read distinguishes error from no-row (Codex H3): on a READ ERROR it
  sweeps ALL external-shaped partition rows for the team (`purgeExternalShapedPartitionRows`) —
  a purge door's safe direction is deleting more regenerable cache, never a targeted delete
  that might miss the served row.
- The coverage pair is on EVERY response branch, including the enforcing-empty neutral
  envelope (Codex M4).
- A failed built-in ADOPTION (kind flipped, pointer conversion failed mid-bootstrap) can leave
  `resolveArcScope`'s permissive branch returning a minted-but-empty source partition — a
  silently blank panel until the idempotent bootstrap heals it on the next tick (Codex L5).
  Fails CLOSED for access; accepted and named, not coded around.

- The external correction WRITE path stays closed (the recompute route 403s external members
  today and continues to — L1, stated because every external READ re-routes).
- Cold-cost honesty (L2): a permissive team-tier reader's first fused read is ~2 syntheses
  (one per built-in partition) where the tier row was 1 over the union — budget-bounded,
  slightly more calls, smaller prompts each.
- AC1's honest observable (L3): the retired-path-stays-cold assertion is implemented as
  sentinel content in a pre-seeded tier-key row (must NOT appear in the served panel) PLUS
  "no NEW tier-key `arc_cache` row exists post-read" (a cold tier read would have committed
  one) — never an un-instrumentable "was not read" claim.

## 5. Out of scope, named

The tier-wall teardown outside arcs (PRET-4: retrieve legs, graph-query route, roster,
`syncBuiltinMembership`), the external leak suite (PRET-5), tier-row garbage collection and
the flag/branch purge (PRET-6), and any UI (the post-program UI phase).
