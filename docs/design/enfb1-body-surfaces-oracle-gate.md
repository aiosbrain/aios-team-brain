---
access: team
---

# ENFB-1 — oracle-gate the body-serving read surfaces (enforcement backlog, slice 1)

## 0. What and why

**What:** the read surfaces that serve ITEM BODIES or body-derived free text while gating on
POSTURE alone get the MEMBERSHIP oracle: `GET /api/v1/items/[id]`, the okf-bundle pager, the
dashboard library item page, the skills/team-tools/tasks-board/decisions pages, the admin data
browser, `POST /api/v1/graph-query`'s partition scope, and the grounding corpus statistic.
**Why:** post-PRET-6, membership is the access model — but these surfaces still treat team
posture as sufficient. The gap is LATENT, measured: prod holds **zero initiative memberships
today** (2,714 of 2,718 live memberships in `general`, 4 in `external-shared`), so nothing is
exposed *yet* — the wall must exist BEFORE the first restricted initiative is curated, not
after. The list/by-id disagreement is the sharpest shape: `GET /api/v1/items` intersects with
`visibleItemIdsForProjects` while `GET /api/v1/items/[id]` serves the same denied row's full
body by id.

**Measured terrain (prod, read-only, 2026-08-18):** 2,718 items · 1,183 tasks · 82 decisions ·
19 projects · memberships as above. NOT measured: per-surface request volume (no access-log
aggregation exists); the cost claims below are derived from row counts, not traffic.

**Design review round 2 (Codex, BLOCKED — folded):** the round-1 decisions KEEP was itself the
leak (a purged restricted synced decision re-surfaces as page prose) → **`decisions.created_by`
JOINS this slice** (§2.7; measured: prod holds ZERO null-source decisions, so nothing hides and
no backfill question exists); the okf cursor's tiebreaker must be UNIQUE → `updated_at|id`
(§2.5 revised; `(team_id, project_id, path)` is the uniqueness, not path alone); the redaction
map carries target IDS compared against the visible set (§2.4 revised); AC4 adds the
missing-builtin-pointer LOUD condition; the admin self-grant path is CLI-only today — stated in
rollout notes.

**Design review round 1 (Codex, BLOCKED — all folded):** the graph-partition mint-vs-stored-pointer
blocker (§1 graph-query row rewritten onto `selectEnforcedGraphPartitions`), the okf redaction
contract (§2.4), the sufficiency re-framing (§0b), the okf cursor keyset fix (§2.5), the shared
by-id predicate (§2.1), the grounding error contract (§2.6), the board/decisions provenance
implementability (§1 rows), the data-browser exemption DROPPED (§1 row).

**Ticketing:** row `ENFB-1` (this slice); PR carries `AIOS-Work: ENFB-1`.
**Governing spec:** `docs/specs/project-context-classification-v1.md` §5.7/§5.8 (enforced
reads; the not-visible answer never names the restricted project) and the PRET program's
enforcement backlog (`docs/design/pret6-retirement.md` §5, inherited from PRET-4 §5).
**Deps:** PRET-6 (#604) merged — this slice builds on the one-mode world.
**Schema:** ONE additive column — `decisions.created_by uuid references members(id) on delete
set null` (migration + schema.sql mirror, the standing two-place rule). **Build with:** fable / high.

## 0b. The slice principle (what is IN, what is DEFERRED, and why the line is where it is)

**IN (ENFB-1): everything that serves bodies or body-derived prose, plus the existence
oracle.** A body is the maximal leak; decision `rationale`/`impact` and graph facts are prose
ABOUT restricted work; the grounding statistic converts corpus membership into an observable
(the abstain flips on a restricted-only term). One slice because they share one mechanism.

**Sufficiency, stated honestly (design-review round 1 HIGH):** ENFB-1 alone is NOT a
sufficient precondition for restricted curation — title/inventory surfaces (Pulse decision
titles, the ungated projects list, task titles) still leak names until ENFB-2. The operational
rule until then, carried in the PR and release notes: **restricted-initiative curation remains
unsupported until ENFB-2 lands**; ENFB-1 removes the maximal (body/prose) exposure first
because it is also the mechanically-shared half.

**DEFERRED, named:**
- **ENFB-2 — title/metadata/count surfaces:** the tasks API list (titles+metadata), the
  project page (spine+titles), the projects LIST page (initiative-name inventory, currently
  gated by NOTHING — not even posture), the decisions/Pulse title cards, Pulse KPIs/metrics
  counts, social, codebases/maturity/people. Titles leak less than bodies and some of these
  need product decisions (does a non-grantee see that a restricted project EXISTS?).
- **ENFB-3 — meetings:** `meeting_notes` has NO access/audience column (noted at
  `lib/dashboard/work-timeline.ts:685`) — row-level gating needs schema, its own slice.
- ~~decisions.created_by~~ — PULLED INTO THIS SLICE by design-review round 2 (§2.7).

## 1. The surface table (each row: today's sole gate → the gate this slice adds)

| Surface | Today (file:line) | This slice |
|---|---|---|
| `GET /api/v1/items/[id]` (`app/api/v1/items/[id]/route.ts:29`) | `isRestrictedTier` posture arm only — full body by id | after the posture arm: `canSeeItem(db, {teamId, memberId}, id)` (§2.1) — false → the EXISTING 404 shape (`:34`), indistinguishable from absent (§5.7) |
| okf-bundle (`app/api/v1/okf-bundle/route.ts:87`) | posture arm; pages the whole corpus at 500/page, bodies on `include_body`; plus an UNFILTERED whole-team path read at `:67-70` feeding link redaction | the page query intersects `.in("id", …)` with `visibleItemIdsForProjects` (the items-list pattern, `app/api/v1/items/route.ts:251-263`); empty → empty page. Link redaction per the §2.4 contract; the cursor per §2.5 |
| library item page (`app/t/[team]/library/[itemId]/page.tsx:36`) | `canSeeAccess` only — full body + provenance | `canSeeItem` after the posture check; false → the page's EXISTING `notFound()` |
| skills page (`app/t/[team]/library/skills/page.tsx:74`) | `visibleItems` — 200 bodies | intersect with the member's visible-id set (empty → empty list) |
| team-tools (`app/t/[team]/team-tools/page.tsx:23`) | `visibleItems` — latest blueprint body | same intersect; invisible latest → next visible or empty state |
| tasks BOARD page (`app/t/[team]/tasks/page.tsx:37`) | `visibleTasks` — 500 rows INCLUDING `body` (`:39`; the API list at `app/api/v1/tasks/route.ts:238` deliberately excludes bodies) | task rows gate by the timeline's settled provenance rule (`lib/dashboard/work-timeline.ts:176-183`): sourced → source item in the visible set; null-source → `created_by` set (hand-typed, team posture). The select ADDS `source_item_id, created_by` (round-1 MEDIUM: the rule is unimplementable over today's column set) |
| decisions page (`app/t/[team]/decisions/page.tsx:39`) | `visibleDecisions` — every decision with `rationale`+`impact`, no limit | the SETTLED provenance rule, now possible because `decisions.created_by` ships in-slice (§2.7): sourced → source item visible; null-source → `created_by` set (hand-typed, team posture) — the create→see round-trip holds AND the purged-basis class stays dropped (round-2 BLOCKER resolved without the round-1 over-correction). The select adds `source_item_id, created_by` |
| admin data browser (`components/library/data-browser.tsx:65,92`) | admin-role layout + `visibleItems` — bodies by channel | ORACLE-GATED like every content surface (round-1 MEDIUM overturned the draft's role-read exemption: the triad is content→membership, ops→role — body previews are CONTENT, and a role-read here would mint the ops-reads-content precedent the program rejected). An admin needing corpus-wide review grants themselves membership deliberately (auditable as a group add). No allowlist row; the guard's oracle layer covers this file too |
| `POST /api/v1/graph-query` (`app/api/v1/graph-query/route.ts:50`) | `visibleGroupIds(slug, tier)` — the LEGACY tier partitions; a team member searches every fact | **`selectEnforcedGraphPartitions`** (`lib/graph/partition-read.ts:45`) over the member's oracle project set — the STORED-pointer path the retrieve/arcs reads already use (round-1 BLOCKER: `graphGroupIdsForVisibleProjects` MINTS UUID-derived ids while the built-ins carry grandfathered legacy pointers `<slug>_team`/`<slug>_external` — the naive swap would silently empty the route). Uncapped (the arcs shape — the route's own `maxFacts` caps output; no wire change); arming/suppression/readiness semantics inherited; empty scope → empty facts |
| grounding statistic (`lib/query/grounding.ts:37`, sole caller `lib/query/retrieve.ts:592`) | posture-only whole-corpus `total`/`df` — a restricted-only term flips `grounded=true` (the abstain is an existence oracle) | `analyzeTermSpecificity` takes the SAME `visArr` its sibling legs take (`retrieve.ts:533`); counts computed over the visible corpus; `null` never reaches it (retrieve throws on a null view since PRET-6) |

## 2. Mechanism

### 2.1 ONE new primitive: `canSeeItem` (lib/access/enforce.ts)

By-id surfaces must not materialize the member's full id set per view (2,718 ids today; the
documented >65k IN-list wall). New primitive beside `visibleItemIds`:

```
canSeeItem(db, principal, itemId): Promise<boolean>
```

**Drift-proof by construction (round-1 HIGH): the row predicate is EXTRACTED, not re-spelled.**
The membership-row filter `visibleItemIdsForProjects` applies app-side (`state==='active' &&
unit_kind==='item' && source_item_id` over `decision='include'`/`valid_to is null` rows,
`enforce.ts:58-75`) moves into ONE shared function; the list path and `canSeeItem` both call
it — one owner of the visibility question, so the pair cannot disagree by drift. `canSeeItem`
= `visibleProjects` (3 reads) + one membership read scoped to this item's `source_item_id`
through the shared predicate. Fail-closed: no principal, read error, empty project set, no
active unit → `false`. dm-pinned both directions AND for agreement: the same fixtures assert
`canSeeItem(x) === visibleItemIds(...).ids.has(x)` across granted/ungranted/General/retracted
arms. The by-id 404 keeps ONE body for absent and denied (§5.7); its "(or above your tier)"
wording updates to membership-era ("or not visible to you") in the same breath.

### 2.2 Per-principal rows (§0c of the PRET-6 spec applies verbatim)

MEMBER → oracle; delegated TOKEN → `effectiveVisibleProjects`-derived (items-by-id and
okf-bundle already refuse tokens? — VERIFIED in build: tokens are `isAgentBearer`-refused on
these surfaces today, and this slice does NOT open them); CONNECTOR key → reads as its member
row resolves (∅ — connectors are not principals); ADMIN ROLE → the data browser's stated
team-wide read only, everything else oracle like any member.

### 2.4 The okf link-redaction contract (round-1 BLOCKER 2, decided)

The `:67` whole-team read STAYS UNFILTERED and now selects `id, path, access, projects(slug)`
— the map value carries the target's ID so membership-visibility is decidable (round 2:
`access` alone cannot distinguish visible from membership-invisible); it remains an internal
map that is never serialized, and it is what lets the route DISCRIMINATE the three target
states. The
contract per outbound link target:
- **absent** (dangling): PRESERVED, exactly as today (`targetAccess === undefined` →
  preserve — a broken link is the author's problem, not access);
- **present but membership-invisible to this principal**: REDACTED, byte-identically to
  today's above-tier redaction;
- **present and visible**: preserved.

The existence disclosure this makes ("a redacted link ⇒ a real target you cannot see") is the
SAME class today's tier redaction already discloses and §5.7 accepts: the redaction never
names the target's project, and the link path lives in a body the author was entitled to
write. Stated, not accidental. dm arm: all three states in one fixture, each discriminated.

### 2.5 The okf cursor becomes keyset-correct (round-1 HIGH, pre-existing, fixed in-slice)

The page orders by `(updated_at, path)` but the cursor carries only `updated_at`
(`:83` vs `:117`) — 501 visible rows sharing one timestamp silently skip row 501 today, and
path alone cannot tiebreak either (round 2: items are unique on `(team_id, project_id, path)`
— two projects can hold the same path). Ordering becomes `(updated_at, id)` and the cursor the
composite `<updated_at>|<id>` (opaque string; the route ACCEPTS the legacy bare-timestamp form
for one release, discriminated by the absence of `|`). The within-timestamp serve order
changes from path-alphabetical to id — stated; no consumer contract names it. dm arm:
>PAGE_SIZE rows sharing one `updated_at`, including duplicate paths across projects, drain
losslessly; a legacy cursor still resumes.

### 2.7 `decisions.created_by` ships in this slice (round-2 BLOCKER's exit)

Additive migration `postgres/migrations/` + `schema.sql` mirror: `created_by uuid references
members(id) on delete set null`, written ONLY by the dashboard create action
(`app/actions/decisions.ts` — the same sole-writer shape as `tasks.created_by`, which is what
makes it PROVENANCE). Sync/ingest writers never set it. With the column present, the decisions
arms in RETRIEVAL (`lib/query/retrieve.ts` recency+keyword legs) and the TIMELINE adopt the
task rule too: sourced → source-item visibility; null-source → `created_by != null` ∧ team
posture. Measured basis: prod holds 0 null-source decisions today, so the rule changes nothing
retroactively and discriminates correctly from the first post-deploy dashboard decision.

### 2.6 The grounding error contract (round-1 MEDIUM)

`analyzeTermSpecificity` currently swallows errors into `{specificMatching:false,
allCommon:true}` (`grounding.ts:61`), which routes grounding to the fts-hit fallback. Under
enforcement that fallback is ALREADY vis-scoped (the fts leg takes `visArr`), so an error
cannot widen past visible evidence — but the spec states the contract rather than inheriting
it silently: on a statistic error, `grounded` derives from vis-scoped legs alone, never from
corpus-wide state; the dm arm plants a statistic failure (broken-db shim) and asserts the
answer path's grounding never exceeds the visible legs' evidence.

### 2.3 The guard extends — the coarse-wall certifier stops certifying sufficiency

`test/guards/dashboard-tier-filter.test.ts` currently certifies the posture helpers as THE
gate (`:14-17`). It gains a second layer: every file in the BODY-SURFACE set above must ALSO
match an oracle-call pattern (`canSeeItem|visibleItemIds|visibleItemIdsForProjects`), with the
admin data browser on a named allowlist (role-read, stated). The projects LIST page's
zero-gate hole (invisible to the guard because `items(count)` embeds don't match its regex) is
recorded in the guard as a known ENFB-2 row, not silently.

## 3. Fail directions, stated

Every new gate fails CLOSED: oracle read error → 404/empty/`grounded=false`-wards, never the
row. The §5.7 rule holds everywhere: a membership-denied by-id read returns the same 404/
notFound as a nonexistent id (items-by-id keeps its existing "(or above your tier)" wording).
No wire shape changes: fields, cursors, and status codes are byte-identical for entitled
readers (the okf-bundle's `next_cursor` keyset is unchanged — pages just skip invisible rows).
Latent-gap consequence, named: on prod TODAY every gate is a behavioral no-op (everything
lives in General, granted to everyone) — the dm tier is where the discriminating fixtures
live, and that is by design, not vacuity: each AC below plants an initiative membership first.

## 4. Acceptance criteria (spec-first; exact commands)

1. The by-id pair closes: `npm run test:datamechanics:iso
   test/datamechanics/enfb-item-by-id.datamechanics.test.ts` exits 0 — a team-posture member
   NOT in a restricting group gets 404 from `GET /api/v1/items/[id]` for a restricted-project
   item AND the identical 404 body for a nonexistent id (§5.7 indistinguishability pinned);
   the entitled member gets 200 with the body; the General item serves to any everyone-member;
   and the AGREEMENT pin: `canSeeItem(x) === visibleItemIds(...).ids.has(x)` across
   granted/ungranted/General/retracted arms (the shared-predicate §2.1 discipline).
2. okf-bundle: same file, arms for — restricted bodies/rows absent from a full drain;
   `include_body` parity; the §2.4 THREE-state link contract in one fixture (dangling
   preserved, invisible redacted byte-identically to above-tier, visible preserved); the §2.5
   cursor: >PAGE_SIZE visible rows sharing one `updated_at` drain losslessly, and a legacy
   bare-timestamp cursor still resumes; the entitled reader's pages byte-match the pre-slice
   shape for a no-initiative corpus (the latent no-op, asserted).
3. Dashboard body pages (AS BUILT — re-specified from page-render tests to the honest
   two-layer pin, recorded here): the provenance RULE has one owner
   (`lib/access/provenance.rowVisibleByProvenance`) with every arm pinned in
   `npx vitest run test/access-provenance.test.ts` (exit 0), and the pages' WIRING to the
   oracle is pinned by the §2.3 guard layer (`test/guards/dashboard-tier-filter.test.ts` —
   dropping any body surface's oracle call reddens the build). The library page's
   `canSeeItem → notFound` rides AC1's route-level pin of the same primitive.
4. graph-query cuts to oracle partitions via the STORED-pointer path: `npm run
   test:datamechanics:iso test/datamechanics/enfb-graph-query-scope.datamechanics.test.ts`
   exits 0 — the stubbed Graphiti receives exactly `selectEnforcedGraphPartitions`' groups for
   the member: a stock everyone-member still reaches the grandfathered `<slug>_team` pointer
   (the round-1 silently-empty blocker, pinned as the POSITIVE arm), a granted initiative's
   armed pointer appears, an ungranted one never does, and an external member resolves
   external-shared's legacy pointer.
5. The grounding existence-oracle closes: in the enforced-retrieve suite — a restricted-only
   term with zero visible matches yields `grounded=false` (abstain), the same term grounds
   for the entitled member, AND the §2.6 error contract holds (a statistic failure never
   widens grounding past the visible legs) (`npm run test:datamechanics:iso
   test/datamechanics/access-enforce-retrieve.datamechanics.test.ts` exits 0).
6. The guard layer: `npx vitest run test/guards/dashboard-tier-filter.test.ts` exits 0 with
   the oracle-pattern layer active; mutation `node scripts/mutate.mjs` deleting the
   `canSeeItem` call from the library page reddens the guard (verbatim invocation in the PR).
7. The migration replays: `npm run db:test:up` exits 0 (from-zero incl. the new
   `decisions.created_by` migration), and the dashboard create action writes the column
   (dm-pinned in the decisions page suite).
8. Full tiers stay green: unit, dm iso (sole tolerated red = the named TZ artifact),
   `npm run check:docs`; `docs/ARCHITECTURE.md`'s synced-content row retires its
   "posture-walled-NOT-oracle-gated" caveat for the gated surfaces and re-states the ENFB-2/3
   residuals.

## 5. Out of scope, named

ENFB-2 (title/metadata/count surfaces incl. the ungated projects LIST inventory), ENFB-3
(meetings schema), any RPC/covering-index move of the id
materialization (the documented deferral stands), token access to by-id surfaces (stays
refused), UI affordances for "why can't I see this" (the inspector already answers it), a
dashboard self-grant UI for admins (the deliberate-grant path is the CLI/group machinery
today — named in rollout notes, ENFB-2 may add the affordance).
