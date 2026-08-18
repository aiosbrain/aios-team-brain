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
  — the same `else if` shape as `lib/query/fts-search.ts`. No cache-shape change: the vis-variant
  group_key already hashes the member's visibility (`vis:<posture>:<hash>`), so a member's
  wall-dropped build lands under their own variant, never a shared one.
- Meeting notes (no access column; gated by `canSeeMeetingNotes(posture)`) are Phase-D-grain
  (program §8) and KEEP their posture gate both modes — named, not silently widened.
- The GET `/api/v1/timeline` route and the dashboard timeline/team-work routes inherit the
  change through the builder; their wire shapes are unchanged.
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
| A3 graph scope | `selectEnforcedGraphPartitions` over the member's oracle projects resolves X's partition; Y's partition ABSENT from the scope (the dm-reachable pin — live Graphiti search is not in the dm tier, the PPARC-3 dispensation) |
| A4 arcs | the fused arcs route serves the member a panel resolved from their oracle scope containing X's partition row content; Y's partition prose ABSENT |
| A5 roster/structure | v1 members returns the same roster a team key gets; the retrieve org-structural legs serve actors + REPORTS_TO to this member |
| A6 timeline (the §1 change) | the member's timeline ledger carries X's team-access evidence; Y's evidence ABSENT |
| A7 token | the delegated token (empty scope) reads NOTHING of X or Y through items; org-structural legs ABSENT (token semantics, program §8, byte-unchanged) |
| A8 permissive control | the SAME member on a still-permissive team reads only `access='external'` rows (the posture wall stands where enforcement is off — no stealth widen) |

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
   | A7 | `lib/access/oracle.ts` | `projectIds = new Set([...projectIds].filter((p) => scope.has(p)));` → `` (attenuation drops) |

   Every needle above is a verbatim, grep-able line (A6's exists after §1's change lands, in
   the same PR). Each `red:` verdict line must name the row's arm.
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
