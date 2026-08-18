---
access: team
---

# PRET-5 — the external-member proof: the leak-suite matrix + the timeline's wall drop (slice spec)

## 0. What and why

**What:** the program's AC3 proof file — `test/datamechanics/membership-leak-suite.datamechanics.test.ts` —
the end-to-end matrix for an external-invited member with membership in project X (sees X's
items including `access='team'` rows, X's graph partition scope, X's fused arcs, the roster
and org-structural legs; sees NOTHING of project Y; an attenuated token still sees only its
scope), with every absence assertion mutation-verified against its own gate. Plus the ONE
surface where ruling 2 did NOT fall out of PRET-2..4: the work-timeline's builder legs still
apply the posture wall under enforcing, so an external member granted X gets X's items and
arcs but not X's team-access work evidence — this slice makes the timeline mode-keyed like
every other content leg (PRET-4 §1b's rule, applied to the last holdout) and adds it to the
matrix.
**Why:** ruling 2 ("an external collaborator is a member like any other") shipped across
PRET-3/4 surface by surface; without the single-file matrix, each surface's proof lives in a
different suite with different fixtures, and the program's falsifiability criterion (AC3
names exactly this file) stays unmet. The timeline residual was NAMED in PRET-4 (cold-read
M7) with its decision deferred to this spec — deciding it here closes the last content
surface where membership does not yet govern.

**Program:** `docs/design/retire-permissive-model.md` (PRET-1) §5 slice 4, program AC3.
**Ticketing:** row `PRET-5` in the workspace `3-log/tasks.md` (parent `PRET-1`); the PR
carries `AIOS-Work: PRET-5`. **STACKED on PRET-4 (#594)** — PR base
`chetan/pret4-tier-teardown`, retargeted to `main` after #594 merges.
**Deps:** PRET-4 (in review). No schema change, no migration.
**Substrate this suite consumes (SR16 — the concrete files, all in the stacked branch):**
the oracle `lib/access/oracle.ts` (`visibleProjects`) · the enforced-read primitives
`lib/access/enforce.ts` (`visibleItemIds`, `memberEnforcement`, `resolveTimelineEnforcement`)
· posture `lib/access/posture.ts` · member creation `lib/admin/members.ts` (`createMember`) ·
the flip `lib/admin/access-enforcement.ts` (`setAccessEnforcement`) · graph scope
`lib/graph/partition-read.ts` (`selectEnforcedGraphPartitions`, `resolveArcScope`) · the arcs
route `app/api/brain/arcs/route.ts` + fusion `lib/graph/arc-fusion.ts` + cache
`lib/graph/arc-cache.ts` (`writeArcCache` for the deterministic pre-seed) · items route
`app/api/v1/items/route.ts` · retrieve `lib/query/retrieve.ts` · members route
`app/api/v1/members/route.ts` · tokens `lib/access/agent-tokens.ts` (`mintAgentToken`,
`verifyAgentToken`) · the timeline builder `lib/dashboard/work-timeline.ts` + cache
`lib/dashboard/timeline-cache.ts`.
**Build with:** fable / high — a leak suite whose absence assertions are green by
construction is worse than none (the omission-breaks-absence class); the timeline change
touches a cached, shared surface.

## 1. The timeline wall drop (the M7 decision, decided)

`lib/dashboard/work-timeline.ts`'s evidence legs (`visibleItems`/`visibleTasks`/
`visibleDecisions` at the builder's item/task/decision/meeting reads) apply the posture wall
UNCONDITIONALLY — under enforcing they stack it on top of the §5.8 vis-set, which re-blocks
ruling 2 exactly the way the retired retrieve conjuncts did. The rule that fixed every other
leg applies verbatim (PRET-4 §1b): **enforcing (a vis-set present) → the oracle-derived set
alone; permissive → the posture wall alone.**

- The builder receives its enforcement via the existing `enforce` param
  (`TimelineEnforcement | null`); each wall call site becomes mode-keyed on `enforce != null`
  — the same `else if` shape as `lib/query/fts-search.ts`. The SIX call sites, enumerated
  (cold-read M6 — :488 and :312 are the miss risks): `visibleItems` at
  `lib/dashboard/work-timeline.ts:257` (git), `:278` (other), `:312` (slack);
  `visibleTasks` at `:297` (active) and `:488` (the all-status chip/link-target read);
  `visibleDecisions` at `:337`. The meeting read (`canSeeMeetingNotes` at `:675` +
  `srcVisible`) is NOT one of them and is KEPT — the named exception.
- **The null-source task ruling (cold-read H2 — the widen the bare drop would smuggle):** a
  hand-typed task (`source_item_id` null, `created_by` set) belongs to NO project — no
  membership axis exists for it — so under enforcing its `taskVisible` arm keeps the posture
  wall: sourced tasks → the vis-set alone; null-source tasks →
  `created_by != null && !isRestrictedTier(posture)`. The audience wall survives on exactly
  the one branch membership cannot express, with its own matrix sub-assertion and mutation.
- **Why the decisions/tasks drop is sound HERE though PRET-4 kept the query path's audience
  conjuncts both modes (cold-read M1):** the timeline's decision/task grains carry a REAL
  source-item gate (`srcVisible`/`taskVisible` — membership-derived under enforcing), which
  the query path's aggregate legs lack — H-WIDEN's replacement-gate condition holds here and
  not there. The resulting cross-surface divergence is NAMED: an external member granted X
  can see a team-audience decision title on the timeline that the query path's structured
  legs still refuse; harmonization is Phase-D/PRET-6 territory.
- Cache: no shape change — the vis-variant group_key is `vis:<posture>:<hash>` with posture
  IN the key (verified `lib/dashboard/timeline-cache.ts:41`), so a wall-dropped build lands
  under the member's own variant; the posture segment becomes load-bearing solely for the
  meeting carve-out once the walls drop (cold-read L3 — a comment at the key derivation pins
  it against a hash-only "simplification"). `PAYLOAD_VERSION` is BUMPED (cold-read L2): the
  wall drop changes what a `vis:external:*` row means, and the module's own convention bumps
  on meaning changes; without it, stale walled rows would under-serve for one TTL.
- The GET `/api/v1/timeline` route and the dashboard timeline/team-work routes inherit the
  change through the builder; their wire shapes are unchanged. The http tier's external pin
  (`test/http/timeline.http.test.ts` — external key → 200 `days: []`) SURVIVES because its
  fixture team is permissive, where the posture wall stands (cold-read L4 — stated so the
  pin is not "fixed" mid-build).
- Fail directions unchanged: a substrate error while resolving enforcement still THROWS
  (never a cached error-empty — the existing pin survives); an empty vis-set still builds an
  honest empty ledger.

## 1b. Default-deny and the wire contract (SR7 — stated, not implied)

Every arm of this slice fails CLOSED: an unresolved posture at an auth boundary is a thrown
error → the boundary's existing 401/500 (never a widened read); an empty oracle resolution
serves empty results (items `{items:[]}`, an empty timeline ledger, an empty arc panel), never
a fallback union; the token arm's empty scope reads nothing. NO wire contract changes in this
slice: the v1 tier-422 ingest boundary is untouched (posture has the same vocabulary; the
boundary logic is byte-unchanged from PRET-4), no route gains or loses a status code, and the
timeline routes' shapes are unchanged — the wall drop changes which ROWS an enforced build
carries, under the member's own vis-variant cache key. There is no "invalid tier input"
surface: posture is derived state (a row-presence read), not client input.

## 2. The matrix (the leak-suite file's arms — spec-first, absence-mutation-verified)

One fixture: an ENFORCING team; projects X and Y (initiatives) each holding one
`access='team'` item (rare FTS terms); an external-invited member (created via the REAL
`createMember`, activated) with membership in a group granted X only; the seeded team-tier
admin; a delegated token minted for the external member with an empty project scope.

| Arm | Assertion (presence AND absence) |
|---|---|
| A1 items (route) | v1 items GET serves X's team item; Y's path ABSENT |
| A2 items (retrieve) | the enforced retrieve grounds X's item on X's term; Y's term grounds NOTHING |
| A3 graph scope | `selectEnforcedGraphPartitions` over the member's oracle projects resolves the EXACT set {X's partition, external-shared's partition} — General ABSENT is the ruling-2 boundary, Y ABSENT (cold-read M2; the dm-reachable pin — live Graphiti search is not in the dm tier, the PPARC-3 dispensation). Fixture: X's partition pointer minted AND ready-latched via the FakeGraphiti project+confirm pattern (`test/datamechanics/graph-arming.datamechanics.test.ts` precedent) — an unarmed initiative never enters any scope |
| A4 arcs | the route's exact composition (`memberEnforcement` → `resolveArcScope` → `getFusedArcs` — the session-authed route itself is dm-unreachable, cold-read M3; precedent `arcs-unified-read.datamechanics.test.ts`) serves a panel containing X's partition prose; Y's partition prose ABSENT. Deterministic: the fixture pre-seeds fresh `arc_cache` `g:` rows for EVERY scope group (X's + external-shared's) AND a distinctively-prosed row for Y's partition — the absence probe must exist to be absent (one-condition-per-fixture) |
| A5 roster/structure | v1 members returns the same roster a team key gets; the retrieve org-structural legs serve actors + REPORTS_TO to this member |
| A6 timeline (the §1 change) | the member's ledger carries X's team-access evidence across the LEG CLASSES (a git item, a slack item, a sourced task header incl. the `:488` chip read, a decision — cold-read M6); Y's evidence ABSENT; a null-source hand-typed team task ABSENT for this external-posture member (the H2 sub-assertion); a meeting note whose transcript is in X ABSENT (the kept carve-out, cold-read L1) |
| A7 token | SPLIT (cold-read H1 — an external-launcher token is UNMINTABLE, `mintAgentToken` refuses and `verifyAgentToken` re-nulls; that refusal IS the token-semantics observable): (a) a token minted for the team-posture admin with `projectScope: []` reads NOTHING of X or Y and no org-structural legs (the AC3 attenuation proof); (b) minting for the external member returns the Phase-A refusal — pinned |
| A8 permissive control | an EQUIVALENTLY-INVITED external member on a SECOND, still-permissive team (members are per-team rows — "same member" is unrepresentable, cold-read M4) reads only `access='external'` rows via v1 items AND their timeline tier row (the §1 permissive arm's pin) |

Absence-assertion mutations (§4 AC3): each absence arm is reddened by deleting or widening
exactly its own gate — the omission-breaks-absence discipline, verdicts pasted in the PR.

## 2b. Writer discipline (SR14)

This slice's build change writes NOTHING new: `lib/dashboard/work-timeline.ts` keeps its sole
writer relationship to `work_timeline_cache` (via `lib/dashboard/timeline-cache.ts`, whose
per-variant upsert discipline is untouched — the wall drop changes row SELECTION inside the
builder, not the cache write path). The SUITE's only writes go through sanctioned writers:
`createMember`/`addMemberToGroup`/`grantProjectToGroup` (the access single writer),
`writeArcCache` (the arc-cache single writer, for A4's deterministic pre-seed), `ingest`
(items), and `mintAgentToken` (the token single writer). No locks are introduced or bypassed.

## 3. What this slice does NOT do (named, with destinations)

- No new access machinery: the suite consumes PRET-2..4's substrate; a matrix arm failing is
  a finding, not a place to patch the suite around.
- Meeting-note evidence stays posture-gated (Phase D, program §8).
- The v1 capability-403 reclassification, flag removal, dead branches — PRET-6.
- Dashboard list pages / items-by-id / graph-query oracle gating — the enforcement backlog
  (PRET-4 §5's entry stands).
- No UI.

## 4. Acceptance criteria (spec-first; exact files and commands)

1. `test/datamechanics/membership-leak-suite.datamechanics.test.ts` (this slice creates
   exactly this file — program AC3's named path) — the §2 matrix, all arms. Verify:
   `npm run test:datamechanics:iso test/datamechanics/membership-leak-suite.datamechanics.test.ts`
   exits 0.
2. The timeline wall drop is mode-keyed at every builder call site: the A6 arm plus the
   existing timeline dm suite stay green —
   `npm run test:datamechanics:iso test/datamechanics/access-enforce-timeline.datamechanics.test.ts`
   exits 0 post-change (its outsider-absence arms are the enforcing-oracle half of the same
   rule and must survive byte-unchanged).
3. Every ABSENCE arm's mutation reddens exactly that arm — run via the one mutation command,
   from a committed tree, against the suite file, with the default expectation (`--expect
   reddened`, exit 0 = the mutation was caught). PREFLIGHT for the isolated DB (SR15): run
   `bash scripts/dm-isolated.sh test/datamechanics/membership-leak-suite.datamechanics.test.ts`
   once — it creates/starts this worktree's container and prints the URL line
   `[dm-isolated] aios-dm-<hash> → postgres://app:app@localhost:<port>/app_test`; use that
   printed URL as `$DM_URL` below. If Docker is unavailable, record
   "mutations: NOT RUN — no isolated DB available" in the PR body and run none against the
   shared container (a collision-corrupted verdict is worse than an honest gap). One
   invocation per mutation, with `<target-file>`, `<needle>`, `<replacement>` instantiated
   per the mutation set below:
   `DATABASE_TEST_URL=$DM_URL node scripts/mutate.mjs <target-file> --edit <needle> <replacement> -- --config vitest.datamechanics.config.ts test/datamechanics/membership-leak-suite.datamechanics.test.ts`
   — each invocation must exit 0 and its printed `red:` line must name the intended arm (the
   verdict lines pasted verbatim in the PR body, never narrated). The mutation set, INSTANTIATED
   (SR11 — needle → replacement, one single-site edit each; needles are verbatim lines in the
   stacked branch, except A6's which is the §1 change's post-build shape):

   | Arm | `<target-file>` | `<needle>` → `<replacement>` |
   |---|---|---|
   | A1 | `app/api/v1/items/route.ts` | `q = q.in("id", [...ids]);` → `` (delete — the oracle filter drops) |
   | A2 | `lib/query/retrieve.ts` | `if (visArr) recentB = recentB.in("id", visArr); // enforcement: recency over visible items only` → `` |
   | A3 | `lib/graph/partition-read.ts` | `.in("id", [...visibleProjectIds])` → `` (the scope restriction drops) |
   | A4 | `lib/graph/partition-read.ts` | `  if (enforce != null) {` (the `resolveArcScope` enforcing-arm guard) → `  if (false) {` — resolution falls through to the permissive built-in partitions, widening past the member's oracle |
   | A6 | `lib/dashboard/work-timeline.ts` | the §1 change's `if (visArr) … .in("id", visArr)` on the items evidence leg → `` |
   | A7 | `lib/access/oracle.ts` | `projectIds = new Set([...projectIds].filter((p) => scope.has(p)));` → `` (attenuation drops — reddens A7a) |
   | A2b | `lib/query/fts-search.ts` | `where += ` and `i.id = any($${params.length}::uuid[])`;` → `` (the fts vis application — cold-read M5's missing gate) |
   | A6b | `lib/dashboard/work-timeline.ts` | the §1 null-source posture conjunct (`!isRestrictedTier` on the `created_by` arm) → `` (the H2 widen — reddens the hand-typed-task sub-assertion) |

   Every needle above is a verbatim, grep-able line (A6/A6b's exist after §1's change lands,
   in the same PR). Each `red:` verdict line must name the row's arm. "Exactly that arm" is
   scoped honestly (cold-read M5): a mutation reddens its own arm and only arms DOWNSTREAM of
   the same gate — A3's `.in` restriction co-reddens A4 (same function feeds
   `resolveArcScope`) and suites in the stacked branch; A4's own single-arm probe is the
   enforce-guard flip; each mutation's expected co-reds are named beside its verdict in the
   PR body.
4. The suite uses PRODUCTION member creation (`createMember` + activation) for the external
   member — never the fixture backdoor — so fixture-reality divergence cannot green the
   matrix (the PRET-4 Fable-H1 lesson).
5. `docs/ARCHITECTURE.md` timeline row notes the mode-keyed wall in the same PR;
   `npm run check:docs` exits 0. The amended docs re-gate: preflight
   `test -x /opt/homebrew/bin/aios && test -f ~/Projects/chetan-workspace/.env`; if BOTH
   hold, from the repo root
   `set -a && . ~/Projects/chetan-workspace/.env && set +a && /opt/homebrew/bin/aios spec eval
   docs/design/pret5-leak-suite.md --tier deterministic --no-llm`
   prints `verdict: SPEC_READY`, exit 0; if preflight fails, record
   "spec gate: NOT RUN — CLI unavailable" in the PR body — never a silent skip.
