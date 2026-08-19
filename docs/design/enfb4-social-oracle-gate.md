---
access: team
---

# ENFB-4 — oracle-gate the Social Brain surfaces (enforcement backlog, slice 4 — the LAST residual)

## 0. What and why

**What:** the Social Brain content chain gates on the MEMBERSHIP oracle — at ADMISSION (what
discovery may mint), at READ (what a viewer's page shows), and at the one seam content leaves
the system (publish, already tier-doored). This closes the enforcement backlog: after this
slice, every recorded residual is retired.

**Why (the scout's three headline corrections):** (1) `visibleByAccess` is a NO-OP at every
production call site — every caller passes the literal `"team"` (page.tsx:67, generate.ts:210,
plan.ts:81), so the ONLY live gate on social content is `canAccessAdmin` at the page, and the
page's body-rendering reads (`content_plans`/`content_variants`, page.tsx:68-73) bypass even
the vestigial store seam. (2) Variant bodies are DERIVED CONTENT: `buildGenerationPrompt`
embeds up to 800 chars of each evidence item's raw body plus a 280-char summary excerpt
(generate.ts:58-111, discover.ts:55-58) — a `team`-tier variant is readable by any admin while
its prose may be verbatim from an item curated into an initiative none of them hold. No
cascade fires on membership changes (the tier cascade `narrowSocialChainForItem` keys on
`access` only). (3) An arc-derived opportunity whose LLM couldn't cite item-linked evidence is
born with `evidence: []` at `access='external'` (`evidenceCeiling([],0)` → external,
tier.ts:47-49; the free-text fallback at arcs.ts:416) — LLM prose over restricted graph facts,
invisible to any provenance gate AND publishable through every door.

**Measured terrain (prod, read-only, 2026-08-19):** 105 opportunities — ALL `access='team'`,
**ZERO empty-evidence**, **ZERO null created_by**; evidence arrays avg 1.3 / max 8 (item
discovery writes exactly 1; arc discovery caps at 8); 1 plan, 2 variants, 0 published; the
publish poller is off (`SOCIAL_JOBS_ENABLED` unset) and dry-run defaults true. **The
retroactive blast radius of every gate below is ~zero, and the empty-evidence refusal
(D1) retro-hides nothing.** NOT measured: none relevant (no request-volume question — the
page is one admin surface).

**Containment property, stated:** social never flows back into a brain read surface (zero
reads of social tables from metrics/query/dashboard/graph — verified) — the flow is
items → social → (publish). So the gates here close the LAST door; nothing re-imports.

**Ticketing:** row `ENFB-4`; PR carries `AIOS-Work: ENFB-4`.
**Governing spec:** `docs/specs/project-context-classification-v1.md` §5.7/§5.8; the chain
PRET-4 §5 → PRET-6 §5 → ENFB-1/2/3 §0b. **Deps:** ENFB-3 (#614) merged. **Schema: NONE.**
**Build with:** fable / high.

## 0b. Slice principle, deferrals, decidables

**IN:** the admission gates (discovery scoped to the acting admin's oracle set;
evidence-less/partial arc opportunities refused), the read gate (ONE app-side EVERY rule at
the opportunity, everything downstream inheriting by parent-id chains through the store, the
page's inline reads routed back through `lib/social/store.ts`), **the ACTION-level parent
gates (round 1 HIGH 4): every content-touching server action — plan, generate, submit/decide
approval, schedule, cancel, generate-image — resolves its parent chain through the SAME gated
read, so a hidden parent is "not found" (today they gate admin posture then resolve by bare
id); `refreshAnalytics` is the stated EXEMPTION (round 2 HIGH 5) — it moves counts, no
title/body, the same metrics ruling as the analytics reads**, the threaded principal into `loadEvidenceBodies` with the EVERY refusal, **the publish
door's external-shared membership conjunct (round 1 BLOCKER 1 — pulled IN; the slice may now
honestly claim last-residual closure)**, the media route's wall repair INCLUDING parent
inheritance (round 1 HIGH 5: image bytes derive from `opp.title` — the route inherits
asset → chain → evidence), the guard extension (SWEEP_READ gains the social tables; wiring
pins at the store seam; explicit residual reasons for non-serving helpers — round 1 M8), and
the re-specification of the pins whose subject dies.

**DEFERRED, named:**
- `brand_profiles`/`brand_assets`/`social_settings`/`social_jobs` — team config/ops, no
  content axis: admin-role stays (the triad's ops→role arm), recorded in the guard.
- `publication_analytics` reads (counts, no title/body) — admin-role stays, the
  codebases/maturity metrics-ruling precedent, recorded with reason.
- `narrowSocialChainForItem` — a repair path, not a serving read (residual with reason). A
  MEMBERSHIP-change cascade sibling is deliberately NOT built: the read gate is COMPUTED
  (evidence ∩ live oracle at read time), so revocations take effect on the next read with no
  stored state to repair — the strongest argument for the computed shape (scout R6).
- ~~The publish door gains no membership conjunct~~ — **REVERSED at design round 1 (its
  BLOCKER 1): the deferral's invariant was FALSE.** `violatesEvidenceTier` checks only
  `items.access`, so an `access='external'` item curated OUT of external-shared into a
  restricted initiative still passes the tier door — the one PUBLIC egress would have shipped
  membership-blind. The door (schedule-time AND the fire-time re-verify) now requires EVERY
  evidence item to hold a current include in EXTERNAL-SHARED — implemented as: resolve the
  team's `external-shared` system project id, then `visibleItemIdsForProjects(db, teamId,
  {externalSharedId})` ⊇ evidence ids (round 2 HIGH 4: NOT `systemVisibleSourceIds`, which
  includes General by design and would let team-general content pass the PUBLIC door; no
  member principal is needed at fire time — the check is team+project-scoped). A refused fire
  terminal-cancels; the variant is NOT dead — `rejected` is regeneratable → re-approvable →
  re-schedulable (round 2 M6: an ACCIDENTAL revocation costs a regenerate/reapprove cycle,
  stated as the operational price of failing closed on public egress). A revocation between
  schedule and fire correctly terminal-cancels: the content BECAME restricted, and cancelling
  a post of restricted content is the point, not the race hazard the draft feared.

**DECIDABLES — defaults stated for the design review to attack:**
- **D1 — evidence-less AND partial-provenance arc opportunities are REFUSED AT ADMISSION
  (REVISED at round 1's BLOCKER 3: the draft's "floor partial to team" still leaked —
  unresolved-fact prose in a team-tier row renders to any admin whose intersection passes on
  the resolved subset).** `discoverOpportunitiesFromArcs` mints ONLY when every cited fact
  resolved to item-linked evidence (the arcs.ts:416 free-text fallback and the
  unresolved-episode case both refuse); `createOpportunity` refuses `evidence: []` AND (build
  folds) the class's two sibling shapes: an evidence entry lacking an `itemId` (non-empty but
  zero verifiable provenance — it would skip the tier ceiling and be born dark; Fable diff M1)
  and an arc citing a DANGLING item id (unverifiable — the row would be dark for every viewer
  and unrepairable by any grant; the draft's missing→team floor died with the full-dm sweep).
  Measured: prod has zero evidence-less rows — nothing retro-hides. The pins asserting empty→external
  (`social-discover-arcs.test.ts:70`, `social-tier.test.ts:31`) re-specify to the refusal.
- **D1b — the READ quantifier is EVERY, not SOME (round 1's BLOCKER 2):** an opportunity's
  title/summary and its variants' bodies are synthesized over ALL its evidence, so a viewer
  who can see one of two evidence items would still read prose derived from the hidden one.
  The rule everywhere: `evidence.length > 0 && evidence.every(e => vis.ids.has(e.itemId))`.
  At prod's measured shape (avg 1.3 evidence) EVERY ≡ SOME for most rows; mixed-evidence rows
  become visible only to viewers holding ALL their sources — fail-closed, stated. GENERATION
  takes the same quantifier (round 1 M6): `generatePlanDrafts` REFUSES when the acting admin
  cannot see every evidence item — no silent fewer-bodies degradation, no summary-over-hidden
  prompt.
- **D2a — actor-scoped discovery is an INTENDED product change (round 1 M7):** a
  narrowly-granted admin discovers fewer opportunities than a corpus-wide one — discovery
  mines what its operator may see, exactly as the arcs path has since PRET-3. No cron path
  discovers (verified: jobs run publish/analytics only), so the actor always exists.
- **D2 — the admin-role precedent: ENFB-1's ruling applies verbatim (content→membership,
  ops→role).** The read gate is per-viewer: an admin sees the opportunities whose evidence
  intersects THEIR oracle set; role exempts nothing. The approval-stranding case (scout R1) is
  addressed at the ROOT by the admission gates: `discoverNow`'s corpus-wide items scan (R8)
  becomes actor-scoped (`.in("id", actorVis)` — the arcs path already resolves the acting
  admin's scope via `resolveArcScope`, PRET-3; the items path never got the same treatment),
  so every opportunity's evidence was visible to its minting admin at birth, and that admin
  can always see/approve/decide it. RESIDUAL stranding (evidence restricted AFTER creation →
  a pending row no current admin can see): possible, fail-closed, repair = the grant path
  (`grant-project`), named in release notes — the same repair story as every stranded row in
  this program; no escape-hatch read.
- **D3 — the media route** (`app/api/dashboard/social/media/[id]`): the wall becomes
  `canAccessAdmin` (it is the ONE social surface checking bare role — an external-posture
  admin is blocked from the page but can fetch image bytes today), the read is TENANTED
  (team-scoped before the asset lookup), and unknown ≡ denied (uniform 404 — today's 404/403
  split is an existence oracle). Image bytes are derived content (generated from
  `opp.title`), same class as variant bodies.
- **D4 — generation threads the acting principal:** `generateDrafts` passes the actor's
  visible-item set into `generatePlanDrafts` → `loadEvidenceBodies` intersects its
  `.in("id", ids)` with it (the ENFB-2 meeting-todos → extract-todos pattern, guard-pinned at
  both halves). The scheduler/job path (no member principal) does not generate — generation
  is action-triggered only today (verified); if a job path appears it takes
  `systemVisibleSourceIds` semantics, noted at the seam.

## 1. The surface table

| Surface | Today (file:line) | This slice |
|---|---|---|
| opportunities list (`listOpportunities` ← page.tsx:67) | `visibleByAccess(q,"team")` = NOTHING; admin wall only | the ONE read rule: `evidence.length > 0 && evidence.every(e => vis.ids.has(e.itemId))` app-side (the EVERY quantifier, D1b) (arrays ≤8, cap 100 — ~800 comparisons; mirrors the cascade's own in-JS precedent, store.ts:363-67); evidence-less LEGACY rows (0 in prod) go dark, stated |
| plans + variants + pending approvals + publications (page.tsx:68-84) | inline reads BYPASS the store; variants/approvals render BODIES; publications disclose `external_url` | all four route through `lib/social/store.ts`/their modules and INHERIT by parent-id chains from the filtered opportunity set (opportunity → plan → variant → approval/publication) — ONE seam, wiring-pinned; the inline reads die |
| `loadEvidenceBodies` (generate.ts:99-112) | `visibleByAccess(q, variant.access)` — the row's OWN tier, no membership axis, unscoped system read | intersects with the ACTING admin's visible set (D4) |
| `discoverNow` items scan (discover.ts:77-84) | corpus-wide, ungated (R8 — the write-side admission hole; the arcs path was already actor-scoped at PRET-3) | actor-scoped: `.in("id", [...actorVis])` — an admin mints opportunities only from items they can see |
| `discoverOpportunitiesFromArcs` (discover-arcs.ts:116-27) | evidence-less arcs mint `external` publishable rows (R2); partial provenance under-counts `missing` (R3) | D1: REFUSE evidence-less AND partial-provenance arcs at admission (no floor — round 2 caught the stale floor text; the dm pin at discover-arcs:59 asserting missing→team re-specifies to the refusal) |
| media route (route.ts:16-24) | bare `role==='admin'` (no posture), untenanted by-id read, 404/403 split; serves bytes derived from `opp.title` with no chain gate | D3: `canAccessAdmin`, tenanted, uniform 404, AND the asset inherits through its chain to the opportunity's EVERY-visible evidence (round 1 HIGH 5) |
| publish door (publish.ts:54-72, 186-204) | tier-doored (external-only + governance + dry-run + fire-time re-verify), NO membership conjunct — and the tier ceiling is membership-BLIND (round 1 BLOCKER 1's counterexample: an external-access item curated out of external-shared passes it) | schedule-time AND fire-time require EVERY evidence item to hold a current external-shared include; a mid-flight revocation terminal-cancels (correct: the content became restricted) |
| analytics reads (analytics.ts:73,92) | admin wall only | UNCHANGED (counts, no title/body — the metrics ruling), recorded with reason |

## 2. Mechanism notes

- **One computed rule, one seam.** The opportunity-level intersection is app-side (option (a)
  from the scout's fit table): the jsonb shape defeats the pg builder (`compileColumn` throws
  on anything but scalar `->>`, query-builder.ts:65-78), arrays are ≤8, the list caps at 100,
  and the empty-evidence POLICY branch (dark, stated) would be opaque in SQL. Downstream
  inheritance is set-intersection over ids the page already loads — no new queries.
- **Fail directions:** oracle resolution error at the page → the error boundary (the ENFB-2
  L8 shape), never an unfiltered render; a denied/unknown id in every action keeps today's
  identical not-found strings (the collapse already holds, §6 of the scout — the media route
  is the one repair).
- **Guards:** `SWEEP_READ` gains `social_opportunities|content_plans|content_variants`;
  `SWEEP_DIRS` already walks `lib/social` + `app/t`; the vacuous residual line for
  `lib/social/` is REPLACED by real wiring pins (the store's intersection application, the
  page's route-through-store, `loadEvidenceBodies`' threaded ids, discover's actor scope) +
  per-file residual reasons for brand/settings/jobs/analytics. The stated non-coverage note
  stands (raw SQL, select("*")).
- **Re-specified pins, enumerated (round 2 M7 completed the list):** the
  `social-publish`/`social-publish-door` happy-path fixtures build on manual EVIDENCE-LESS
  opportunities — they rebuild around INGESTED external evidence + context backfill (the
  refusal makes their old shape unmintable); `social-generate:82` re-specifies from
  "drop the hidden body and continue" to "refuse generation" (the EVERY quantifier);
  `discover-arcs` dm :59 (missing→team) re-specifies to the refusal. Plus: `social-discover-arcs.test.ts:70` + `social-tier.test.ts:31`
  (empty→external DIES — the refusal/floor is the new contract, both directions pinned);
  `social-content:62,75` + `social-tier-cascade:206` (the `"external"` reader has no
  production caller — the arms re-specify onto the MEMBERSHIP reader: a non-grantee admin
  never sees a restricted-sourced opportunity/variant; the grantee does); the
  posture-tier arms that remain true stay.

## 3. Acceptance criteria (spec-first; exact commands)

1. `npm run test:datamechanics:iso test/datamechanics/enfb4-social.datamechanics.test.ts`
   exits 0 — the READ gate: an opportunity evidenced by a restricted item (with its plan,
   variant, pending approval, and publication) is absent from a non-grantee ADMIN's page
   reads (all five chains) and present for a grantee admin (non-vacuity); the EVERY arm: a
   MIXED-evidence row (restricted + general) is absent for the general-only viewer and
   present for the all-holding viewer; role does not bypass; an evidence-less legacy row is
   dark for everyone; the ERROR arm (oracle failure → throw, never unfiltered); the
   ACTION arms (round 1 H4): plan/generate/approve/decide/schedule/cancel/generate-image on
   a hidden parent each refuse with the not-found shape, and succeed for the grantee.
2. Same file — ADMISSION: `discoverNow`-shape scan scoped to the actor (an item outside the
   acting admin's set mints nothing; inside, it mints — both directions); an arc with
   zero item-linked evidence mints NOTHING, and an arc with PARTIAL resolution mints NOTHING
   (both directions of the D1 refusal; a fully-resolved arc mints, non-vacuity);
   `createOpportunity` refuses `evidence: []`.
3. Same file — GENERATION: `generatePlanDrafts` REFUSES for an actor who cannot see every
   evidence item (no silent degradation) and proceeds for the grantee with all bodies (the
   EVERY quantifier, both directions). PUBLISH: the door refuses an external variant whose
   evidence lacks a current external-shared include (the round-1 counterexample pinned:
   external-ACCESS but initiative-curated), at schedule AND at fire; a fully
   external-shared-included one passes (non-vacuity).
4. Media route (D3): unknown id and denied viewer take the SAME 404; an external-posture
   admin is refused; the read is team-scoped — dm arms via the route handler.
5. `npx vitest run test/guards/dashboard-tier-filter.test.ts` exits 0 with the social sweep
   + wiring pins active; `npx vitest run test/social-tier.test.ts test/social-discover-arcs.test.ts`
   green under the re-specified contracts; mutation `node scripts/mutate.mjs` deleting the
   opportunity intersection reddens the dm suite, and deleting the discover actor-scope
   reddens its admission arm — verbatim verdicts in the PR.
6. Full tiers green: unit, dm iso (sole tolerated red = the named TZ artifact),
   `npm run test:http:local`, `npm run check:docs`; ARCHITECTURE's social row states the
   gates + the retained ops/metrics rulings; release notes name D1/D2's consequences
   (evidence-less refusal; residual stranding repair = the grant path).

## 4. Out of scope, named

A membership-change cascade for stored social rows (the computed gate makes it unnecessary —
§0b), brand/settings/jobs/
analytics gates beyond admin-role (ops/metrics rulings), a member-facing social surface (none
exists), backfill of the zero measured legacy rows, `revoke-project` (still the audit-actor
story).
