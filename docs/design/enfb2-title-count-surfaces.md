---
access: team
---

# ENFB-2 — oracle-gate the title/metadata/count read surfaces (enforcement backlog, slice 2)

## 0. What and why

**What:** the read surfaces that serve TITLES, NAMES, or COUNTS of potentially-restricted
content while gating on posture or on nothing get the membership oracle; and the provenance
predicate moves IN-QUERY (before LIMIT) on every capped structured window, retiring ENFB-1's
deferred Codex M1 (starvation). Landing this slice LIFTS the operational rule ENFB-1 shipped
under ("restricted-initiative curation remains unsupported until ENFB-2").

**Why:** titles are the residual leak ENFB-1 named: a restricted initiative's NAME, its item
paths, its task titles, its decision titles, and its content VOLUME (counts) are all still
served at team posture — and the projects LIST is served with no gate at all beyond team
membership. The gap stays latent (still zero initiative memberships in prod, re-measured
2026-08-19) — the wall must exist before the first restricted curation, which this slice
un-blocks.

**Measured terrain (prod, read-only, 2026-08-19):**
- 19 projects: 17 `kind='source'` + 2 `kind='system'` (`general`, `external-shared`).
  `projects.kind` is free text, default `'source'` (`postgres/schema.sql:963`); zero
  `initiative` rows exist yet — but the dashboard create action mints exactly that kind
  (`app/actions/projects.ts` §11 comment), so the initiative lifecycle is live code, not
  future speculation.
- **Group grants cover ONLY the system projects:** `everyone` → 2 system rows, `external` →
  1 system row; zero grants on any source project. So `visibleProjects(...)` for a stock
  member = {general, external-shared}. **Any project-row gate built on direct grants alone
  silently empties the projects list, 404s every container page, and blanks the create-form
  dropdowns on deploy day** — the ENFB-1 graph-partition class, again. Container visibility
  must derive from the ITEM/TASK oracle (§2.1).
- Per-container content: 5 of 17 source projects hold zero items; two of those are
  TASK-ONLY containers (`extracted-from-meetings` 201 tasks, `aios-team-brain` 140 tasks) —
  so an items-only visibility arm hides real containers; 3 projects hold zero items AND
  zero tasks (would hide from the list under §2.1 — inspected: scaffolding/test rows).
- Tasks 1,187: 1,051 sourced · 1 hand-typed (`created_by`) · **135 with NO provenance**
  (45 non-done). Measured composition (this is the post-review measurement added to #607's
  body): 69 `origin='sync'` orphans (ingest re-stamps `source_item_id` on every push —
  null-source sync = no longer in any pushed file; 59/69 done) and 66 `origin='ui'` rows
  that ALL carry pm links (29 `AIO-*`) — the ADOPTED class (`lib/pm-sync/inbound.ts:476`
  flips adopted issues to `origin='ui'` without `created_by`), which is exactly why the
  reviewed rule refuses `origin` as provenance (Codex B4 HIGH, recorded at
  `lib/dashboard/work-timeline.ts:164-175`). Decisions 82: zero null-source.
- NOT measured: per-surface request volume (no access-log aggregation exists).

**Ticketing:** row `ENFB-2`; PR carries `AIOS-Work: ENFB-2`.
**Governing spec:** `docs/specs/project-context-classification-v1.md` §5.7/§5.8; the
enforcement backlog chain PRET-4 §5 → PRET-6 §5 → `enfb1-body-surfaces-oracle-gate.md` §0b.
**Deps:** ENFB-1 (#607) merged. **Schema: NONE** (no new columns). The slice is read-side
plus exactly ONE write-side addition: the D1 creator grant on initiative creation (data
rows through the existing sole-writer group module, no schema).
**Build with:** fable / high.

## 0b. The slice principle, the deferrals, and the decidables

**IN:** every surface serving titles/names/counts of items, tasks, decisions, or projects
that today gates on posture or nothing (§1), the project-row visibility rule (§2.1), the
in-query provenance predicate at every capped window (§2.2), and ONE slice-boundary
correction: `GET /api/v1/decisions` serves full `rationale`+`impact` prose at posture — a
BODY surface ENFB-1's table missed; it takes the same rule here rather than waiting for a
slice named after its column set.

**DEFERRED, named:**
- **ENFB-3 — meetings** (`meeting_notes` has no audience column; `work-timeline.ts:685`).
- **ENFB-4 — social:** `social_opportunities` has NO `source_item_id` — provenance lives in
  the `evidence` jsonb array (`schema.sql:2704`), the pg builder throws on jsonb expressions
  (`lib/db/pg/query-builder.ts:70`), and the page is admin-role-walled today
  (`app/t/[team]/social/page.tsx:35-47`) — which after ENFB-1's data-browser ruling
  (role-read exemption overturned) is a precedent question, not just a predicate question.
  Different mechanism + a product ruling → its own slice, not a row here.
- **Graph feed routes** `app/api/brain/events` + `app/api/brain/facts` still resolve
  `visibleTierGroupIds` while `graph-query` moved to `selectEnforcedGraphPartitions`
  (ENFB-1) — two graph read paths now disagree about what a partition means. Cutting the
  feeds over belongs with the graph partition owner, one mechanism, named for ENFB-3 or its
  own slice; recorded in the guard as a residual (§2.8), not silently.
- **Codebases / maturity / people METRICS stay posture-gated, by ruling not omission:**
  repo health, coverage, contributor stats, and session maturity derive from `codebases` /
  `code_metrics` / agent sessions — not from curated brain content, so no membership axis
  exists for them; the triad's content→membership arm does not reach them. The ONE
  content-derived read on those pages — `lib/identity/context.ts` `deriveProjects`
  (all-team tasks + project names, ungated even by `visibleTasks`) — IS in this slice (§1).

**DECIDABLES — stated for the design review to attack, with my defaults:**
- **D1 — item-empty, task-empty projects** (3 in prod) — REVISED after design round 1
  (BLOCKED finding 1: the naive default made project creation a DEAD UI PATH — the button
  only closes its modal and refreshes the now-hiding list
  (`components/projects/new-project-button.tsx:26-28`), so a creator would mint "Roadmap"
  and never see it again anywhere). RESOLUTION: `createProjectAction` (which mints
  `kind='initiative'`) additionally grants the CREATOR through the existing sole-writer
  group machinery — `ensurePersonSingleton(creator)` + `grantProjectToGroup`
  (`lib/access/groups.ts:398,:460`; nothing else may write those tables, build-enforced) —
  so the create→see round-trip holds by construction and the grant is auditable as a
  group add (the ENFB-1 data-browser self-grant shape). **Grant-scope pin (round 2
  BLOCKER 3):** a project grant is an ITEM-membership grant (it feeds
  `visibleItemIdsForProjects`), so the creator grant fires ONLY on a successful FRESH
  insert of `kind='initiative'` inside this action — never on an adopted/source/system
  row. **Ordering + the duplicate arm (round 2 BLOCKER 4):** insert row → creator grant →
  graph-pointer ensure, so a pointer failure can no longer strand a granted-less row; and
  the duplicate-slug heal arm ALSO ensures the creator grant IFF the existing row is
  `kind='initiative'` AND content-empty (zero items, tasks, decisions — an empty
  initiative's grant admits zero items by construction), which makes create-retry converge
  without ever granting a contentful existing slug; a contentful duplicate returns the
  existing "already exists" refusal ungranted. The 3 pre-existing empty
  containers have no creator record and stay hidden absent a grant — stated in release
  notes with their names available to admins via the CLI, not silently.
- **D2 — the 66 adopted no-provenance tasks** (pm-linked, provider-live): stay hidden.
  Re-surfacing rows whose brain-side basis is unknowable was adjudicated as the leak class
  (Codex B4); the titles remain reachable in the provider (Linear), and the repair is
  re-establishing provenance (re-sync/re-curation), not widening the rule. DEFAULT: keep
  the ruling; name the 45 active hidden rows in the PR + release notes.
- **D3 — project-detail existence ruling** (§5.7): the container page (its spine is the
  maximal title inventory) gates on PROJECT-ROW visibility (§2.1) with `notFound()` —
  membership-denied indistinguishable from absent. A member holding a cross-project grant on
  some item inside P but not P's row keeps every `/library/{id}` deep-link (item pages gate
  per-item, ENFB-1) and loses only the container view. DEFAULT: project-row visibility
  gates the page; item links unaffected.

## 1. The surface table (each row: today's sole gate → the gate this slice adds)

| Surface | Today (file:line) | This slice |
|---|---|---|
| projects LIST page (`app/t/[team]/projects/page.tsx:31-38`) | **NOTHING** beyond team membership — no `currentMember` call in the file; serves every non-system project's name/slug + `items(count)`/`tasks(count)` + detail links (the guard's recorded ENFB-2 residual, `dashboard-tier-filter.test.ts:76-84`) | rows per §2.1; counts become VISIBLE-content counts computed by the §2.2 predicate (a naive `.in("id", grantedIds)` both empties the page — measured, grants cover only system rows — and leaves the embeds counting invisible items; the embeds are replaced, not filtered) |
| project DETAIL page (`app/t/[team]/projects/[project]/page.tsx:46-52`) | slug probe: 404 unknown, **200 + name + spine for a member-invisible project**; sub-reads posture-only (`visibleItems`/`visibleDecisions`), decisions select lacks provenance columns | D3: §2.1 row-visibility → the page's EXISTING `notFound()`; the spine intersects the item oracle; the decisions table adds `source_item_id, created_by` and takes the ONE-owner rule; roster stays (structure) |
| create-form project dropdowns (`app/t/[team]/tasks/page.tsx:57-61`, `app/t/[team]/decisions/page.tsx:58-62`) | ungated `projects.select("id, slug, name")` riding on oracle-gated pages | the §2.1 visible-row set (you file into a container you can see; General is grant-visible to everyone, so the dropdown never empties for a stock member — measured) |
| `GET /api/v1/projects` (`app/api/v1/projects/route.ts:17,:26`) | team-posture only — every non-system project's `slug`/`name`/`last_synced_at` over the wire to `aios pull` (round 2 BLOCKER 2: omitted from the draft's table; a non-grantee could have pulled restricted initiative names through the API after the dashboard list was fixed) | rows intersect the §2.1 visible-row set — a non-grantee's pull omits restricted names, byte-identical shape otherwise |
| tasks API list (`app/api/v1/tasks/route.ts:178-197`) | `visibleTasks` posture only; serves titles + `projects(slug)`; select lacks provenance columns; `?all=1` = stalest-500 window (`:114-118`) | the §2.2 in-query predicate (window fills with VISIBLE rows). `unknown_keys`/`truncated` (`:266-272`) stay consistent BY CONSTRUCTION (the filter is in the query, so `found`/`truncated` describe the same set; a membership-hidden key reports unknown — the `:92-94` ruling extends from tier to membership verbatim). Design round 1 finding 3: pushing ONLY the access predicate in-query leaves any MODE filter running post-window (visible-but-not-mode rows still starve mode rows) — every mode filter this route applies after its window moves in-query in the same rewrite where SQL can express it, and any residual post-window filter is NAMED at the site + here, never implied dead |
| decisions API (`app/api/v1/decisions/route.ts` → `lib/sync/decisions.ts:40-51`) | posture only; serves titles **+ full `rationale`/`impact` prose** (the missed body surface), 500-cap; the writeback `uiChanged` filter (`:54`, `updated_at > items.synced_at`) runs POST-window today | the §2.2 in-query predicate AND the `uiChanged` comparison in-query (`items.synced_at` joins in the same raw SQL — round-1 finding 3), so the 500-window fills with rows that will actually SERVE |
| Pulse decisions card (`app/t/[team]/page.tsx:182-185`) | posture only, `limit(8)`, selects `source_item_id` but NOT `created_by` — a naive post-filter would both starve the card and (lacking `created_by`) hide every hand-typed decision from everyone (the PRET-5 H2 class) | select adds `created_by`; the §2.2 predicate in-query → a full 8 VISIBLE rows |
| Pulse bootstrap item count (`app/t/[team]/page.tsx:142-143`) + metrics legs (`lib/metrics/pulse.ts:173-200`) | posture only; per-kind item counts + per-status task counts = the volume/shape of restricted work | DISPLAYED counts compute over the §2.2-visible sets (items leg: membership semijoin; tasks leg: the provenance predicate). The HOME-STATE decision (`pickHomeState`, `lib/dashboard/home-state.ts:11`) keys on a TEAM-TOTAL head count, deliberately NOT visible-only (round-1 finding 5: an ungranted admin over a nonempty restricted corpus must see "no visible content", never the bootstrap/onboarding state — a bare team-has-any-content scalar discloses no title, name, or per-project fact, stated as such) |
| member-context `deriveProjects` (`lib/identity/context.ts:206-234`) | `canSeeMemberContext` posture, then reads EVERY team task with no choke-point at all and emits project names + per-project open/total counts | tasks through the §2.2 predicate; project names through §2.1; counts over the visible rows |
| retrieve + timeline capped windows (`lib/query/retrieve.ts:637-643,650-658` + `structured-extras.ts:60-89`; `work-timeline.ts:312-321,352-361,503-512`; tasks board `tasks/page.tsx:45-52`) | ENFB-1's rule applied AFTER LIMIT (the deferral comment at `retrieve.ts:875-879`); `retrieve.ts:927-931` is an INLINE duplicate of the one-owner rule | the §2.2 predicate in-query at every capped site; the inline duplicate dies; the uncapped decisions page keeps its TS post-filter (no window to starve) |

## 2. Mechanism

### 2.1 Project-row visibility: `visibleProjectRows` (lib/access/enforce.ts)

A container project's row (name, slug, existence, counts, dropdown entry) is visible iff:

1. **granted** — `projectId ∈ visibleProjects(db, principal).projectIds` (covers the system
   rows for everyone today, and any future directly-granted initiative), OR
2. **content-visible** — the member can see ≥1 item whose `items.project_id = P` (via the
   §2.2 items predicate), OR ≥1 task in P passing the provenance predicate, OR ≥1 decision
   in P passing it. (Design round 1 finding 2 killed the draft's "decisions ride
   tasks/items" claim: `createDecisionAction` REQUIRES a `projectId` and writes
   `source_item_id: null, created_by: me.id` (`app/actions/decisions.ts:47,:53`) — a
   container holding one hand-typed decision and nothing else would be visible on the
   decisions page yet 404 as a container. The decisions arm is load-bearing, not
   defensive.)

ONE owner: `visibleProjectRows(db, principal): Promise<ReadonlySet<string>>` beside the
oracle primitives, computed by one SQL statement (the §2.2 fragment applied to the item,
task, and decision arms); `canSeeProjectRow(db, principal, projectId)` is the by-id form
for the detail page (the `canSeeItem` shape: shared predicate, no drift). Fail-closed: no
member, read error → empty set / false → `notFound()` / empty list.
**Set-identity warning (design round 2 BLOCKER 1 — the draft conflated these):**
`visibleItemIds(...).projectIds` is the GRANTED set (`visibleProjects`, `project_groups`
only — measured: system rows only in prod) and is NOT the §2.1 row-visible set (granted ∪
content-visible). Every list/dropdown/detail consumer resolves `visibleProjectRows` /
`canSeeProjectRow`; nothing consumes `projectIds` as a substitute — reusing it would
re-create the empty-list bug this section exists to prevent, and the §2.8 guard patterns
match the `visibleProjectRows` application specifically so the substitution cannot ship
silently.
**Item-page container link (round 2 HIGH 5):** an entitled item CAN live in a container
whose row the viewer cannot see (cross-project curation). The library item page's
"Project" link (`app/t/[team]/library/[itemId]/page.tsx:86`) renders only when
`canSeeProjectRow` passes; otherwise the page renders WITHOUT the container link/slug —
indistinguishable from a container-less item (§5.7 for container names), the item's own
body untouched.
**Deleted-author consequence (round 2 HIGH 6), named:** `decisions.created_by` is
`on delete set null` — deleting a member turns their hand-typed decisions into
no-provenance rows, which then hide (and can flip a decision-only container invisible).
This is the SAME deliberate fail-closed over-restriction the task rule records
(`work-timeline.ts:173-175`), now stated for decisions and pinned by a dm arm rather than
discovered in prod.

### 2.2 The in-query predicate: ONE SQL owner beside the ONE TS owner

`lib/access/provenance.ts` keeps `rowVisibleByProvenance` (unchanged — uncapped/app-side
sites). NEW sibling `provenanceSql(alias, p)` returns the parameterized fragment:

```sql
(
  (ALIAS.source_item_id is not null and exists (
     select 1 from project_context_units u
     join project_context_memberships m
       on m.context_unit_id = u.id and m.valid_to is null and m.decision = 'include'
    where u.team_id = $team and u.state = 'active' and u.unit_kind = 'item'
      and u.source_item_id = ALIAS.source_item_id
      and m.project_id = any($grantedProjectIds)))
  or (ALIAS.source_item_id is null and ALIAS.created_by is not null and $isTeamPosture)
)
```

- The item form (for `items` rows / the §2.1 items arm) is the same EXISTS with
  `u.source_item_id = i.id`. Index basis: `pcu` partial unique `(team_id, source_item_id)
  where unit_kind='item'` (`schema.sql:1143`) and `pcm_unit_idx` (`:1165`).
- `$grantedProjectIds` comes from `visibleProjects` (3 reads, ≤19 ids today) — the semijoin
  REPLACES the materialized ≤65k id list at these sites (the documented IN-wall deferral
  retires where the fragment lands; `visibleItemIds` remains for set-shaped consumers).
- **Precedent, not invention:** `structured-extras.ts` and `lib/query/fts-search` and the
  okf pager are already raw SQL for exactly this "builder cannot express it" reason
  (`query-builder.ts` has no `.or()`); site #2 adopts the fragment as-is. Builder sites
  that go in-query (retrieve legs, board, timeline structured legs, pulse counts, tasks API,
  decisions API) move to `runSql` with column lists copied verbatim from today's selects.
- **Agreement pin (the §2.1-of-ENFB-1 discipline):** every fixture row carries its
  EXPECTED visibility, hand-derived from the access-substrate contract at authoring time —
  the third artifact (round 2 MEDIUM 7: parity alone lets both owners be wrong together).
  The dm suite asserts each planted row against that expectation for BOTH owners (the SQL
  window and `rowVisibleByProvenance` over the materialized set); owner↔owner parity is
  then a corollary, not the pin. Arms (round 1 finding 4 widened these — the fragment's
  four membership conjuncts each need their INVERSE fixture): sourced-granted /
  sourced-ungranted / hand-typed / no-provenance / external-posture, PLUS
  `decision='exclude'`, `valid_to` set (expired), `state<>'active'` (retracted), and a
  non-`item` `unit_kind` row planted against the same source id (each must NOT admit).
- Posture stays A CONJUNCT, not replaced: existing `audience`/tier arms on these queries are
  preserved verbatim (the predicate ANDs in).

### 2.3 Existence and error contracts

- §5.7 everywhere: membership-denied container = the SAME `notFound()`/404/absent-key as
  nonexistent (detail page, tasks API `unknown_keys`, list omission).
- Oracle/read error at any new site → empty window / `notFound()` / zero counts — never the
  unfiltered row set. The tasks API on a visibility-resolution error returns 500 (its
  existing DB-error shape), never the ungated list.
- Wire shapes are byte-identical for entitled readers: same fields, same orders, same
  cursors (`since`/`updated_at` pagination on the API lists is untouched — the predicate
  only removes rows the caller may not see; `unknown_keys` semantics per §1).

### 2.8 The guard extends

`test/guards/dashboard-tier-filter.test.ts` gains `TITLE_SURFACE_WIRING` — per-file
APPLICATION patterns (the ENFB-1 tightening applies from birth): the projects list + detail
(`visibleProjectRows`/`canSeeProjectRow`), both dropdown reads, the Pulse card + metrics
legs, `deriveProjects`, the tasks API, the decisions sync module, and the in-query sites
(`provenanceSql(` application per file). The `:76-84` residual note moves those rows from
"recorded" to "enforced" and re-records what remains (social/ENFB-4, graph feeds, meetings/
ENFB-3). **Round-1 finding 6 (enumeration is evadable by construction) adds a SWEEP layer,
honestly framed as a TRIPWIRE + residual inventory, not a closure proof (round 2
MEDIUM 8):** the guard walks `app/api/**/route.ts` +
`lib/{sync,metrics,identity,dashboard,social}/**` for `.from("projects"|"tasks"|"decisions")`
reads whose select carries a name/title or a count, and FAILS LOUD on any file that is
neither in the wiring set nor on the stated-residual list, where EVERY residual entry
carries its reason (its §1 row, its ENFB-3/4 deferral, or its structure ruling) — a new
ungated list route tomorrow reddens the build instead of riding the gap the projects list
rode. Named non-coverage, recorded in the guard's doc block: `select("*")`,
template-built column lists, raw SQL, and variable table names pass the regex — those
shapes are what the enumerated APPLICATION patterns and review remain for. Parallel guards
(`member-context-tier-filter`) extend to pin the new call, not just the posture gate's
position.

## 3. Fail directions, stated

Every new gate fails CLOSED (empty list, `notFound()`, zero counts, absent keys). The
latent-gap posture of ENFB-1 holds for the MEMBERSHIP arms (prod: everything in General,
granted to everyone → behavioral no-op until curation) with the SAME carve-out ENFB-1's
body-measurement missed and #607's amended body now names: the PROVENANCE arm acts on
deploy day — the 135 no-provenance tasks (D2) are already hidden from the board by #607;
this slice extends that hiding to the tasks API list, Pulse task counts, and
`deriveProjects` counts (measured: 135 of 1,187, 45 non-done, all in one container). The
3 empty containers hide from the list (D1). No other deploy-day behavior change exists for
an all-General corpus; the dm tier plants initiative memberships to exercise every
discriminating arm (that is the design, not vacuity).

## 4. Acceptance criteria (spec-first; exact commands)

1. `npm run test:datamechanics:iso test/datamechanics/enfb2-project-rows.datamechanics.test.ts`
   exits 0 — projects LIST: a stock everyone-member sees every content-bearing container
   (the grants-only-cover-system trap pinned as the POSITIVE arm) including a TASK-ONLY
   container AND a decision-only container (round-1 finding 2's arm); a restricted
   initiative's row/name/counts absent for a non-grantee, present for the grantee; counts
   equal the VIEWER-visible item/task counts, not the totals; an item-empty task-empty
   project absent without a grant, present with one; the D1 round-trip:
   `createProjectAction` → the CREATOR immediately sees the new initiative on the list, the
   detail page, and both dropdowns, while a non-creator stock member does not; the D1
   grant-scope pins (round 2 blockers 3–4): a duplicate-slug create against a CONTENTFUL
   existing row grants nothing, against an empty initiative it converges (creator granted),
   and `GET /api/v1/projects` serves a non-grantee the visible rows only (the restricted
   name absent from the wire).
2. Same file — project DETAIL (D3): non-grantee gets `notFound()` for a restricted
   container, byte-indistinguishable from an unknown slug (§5.7); grantee gets the page;
   the spine lists only oracle-visible items; the page's decisions table applies the
   one-owner rule; a member with an item grant but no project-row visibility keeps the
   `/library/{itemId}` page (ENFB-1's gate) while the container 404s — AND that item page
   omits the container link/slug entirely (round 2 HIGH 5; the link renders for a
   row-visible container, absent otherwise); the deleted-author arm (round 2 HIGH 6): a
   hand-typed decision whose creator member is deleted drops from every enforced surface
   and its decision-only container hides — pinned as the stated fail-closed direction.
3. Same file — dropdowns: the board/decisions create-forms list exactly the §2.1 set for
   team-posture members (never empty for a stock member — General pinned present).
4. `npm run test:datamechanics:iso test/datamechanics/enfb2-inquery-provenance.datamechanics.test.ts`
   exits 0 — the STARVATION class dies: with cap-size invisible rows planted NEWER than a
   visible row, the visible row still serves on the tasks API list, the decisions API, the
   board query, the retrieve recency/keyword/task-digest legs, the timeline structured legs,
   and the Pulse decisions card (per-site arms); the WRITEBACK arm (round-1 finding 3):
   cap-size visible-but-not-writeback rows planted ahead of a writeback row still yield the
   writeback row from the decisions sync window; the SQL↔TS agreement pin (§2.2) holds
   across ALL its arms including the four inverse-conjunct arms; `unknown_keys` reports a
   membership-hidden row_key as unknown with `truncated:false` when the window genuinely
   drained (§5.7 for keys).
5. Same file — counts: Pulse item-kind/task-status counts and `deriveProjects`
   per-project counts equal the visible-set counts for a non-grantee vs grantee pair; the
   decisions card serves 8 visible rows when ≥8 visible exist behind ≥8 invisible newer;
   and the HOME-STATE split (round-1 finding 5): an ungranted member over a nonempty
   restricted corpus gets the normal home state (team-total scalar) with zero-valued
   visible counts — never the bootstrap/onboarding state.
6. `npx vitest run test/guards/dashboard-tier-filter.test.ts test/guards/member-context-tier-filter.test.ts`
   exits 0 with `TITLE_SURFACE_WIRING` active; mutation `node scripts/mutate.mjs` deleting
   the projects-list `visibleProjectRows` application reddens the guard, and deleting the
   `provenanceSql` application from ONE in-query site (the tasks API) reddens its dm arm —
   verbatim verdicts in the PR (one mutation per invariant, the intended test named).
7. Full tiers green: unit, dm iso (sole tolerated red = the named TZ artifact),
   `npm run test:http:local` (the tasks-page + any new http pins), `npm run check:docs`;
   `docs/ARCHITECTURE.md`'s rows for the projects/tasks/decisions/Pulse surfaces state the
   oracle gate and the remaining residuals (social, graph feeds, meetings) in the same
   change; release notes name D1/D2's deploy-day consequences with the measured numbers.

## 5. Out of scope, named

ENFB-3 (meetings schema; the graph feed routes' partition disagreement), ENFB-4 (social's
jsonb provenance + the admin-role precedent question), codebases/maturity/people metrics
(structure/code-derived ruling, §0b), any backfill or re-provenance of the 135 no-provenance
tasks (D2 keeps the ruling; repair is an ops/re-sync question), the `?all=1` stalest-500
window itself (pre-existing, documented; this slice only makes its filter honest), RPC/
covering-index moves beyond the §2.2 semijoin, retroactive creator grants for the 3
pre-existing empty containers (admin CLI grants exist; only NEW creations get the D1
auto-grant), UI affordances for "why can't I see this".
