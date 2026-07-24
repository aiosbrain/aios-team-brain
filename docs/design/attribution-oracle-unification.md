# Design pass: one attribution oracle for every surface

**Status:** design-reviewed by Fable (SOUND-WITH-CHANGES) → **required changes incorporated** → **BUILT**
(oracle ID+strict variant · timeline on `primaryId`, Slack exempt · admin drill-down `credited` field +
divergence monitor · single-source guard · `human-actors` allowlisted). **Reviewers:** Fable (design ✓) →
Fable (code, next). Builds off `main`.

### Fable's required changes (folded in)
1. **Oracle needs a STRICT (throwing) mode.** `resolveItemCredit` swallows errors → empty map (fine for
   arcs). The timeline THROWS on DB errors so an empty ledger is never cached as fresh (#249). The
   ID-variant gets a strict mode for the timeline; arcs keep best-effort.
2. **Timeline keys on `primaryId`, NOT `contributorIds`.** The oracle has ONE timestamp per item; a
   contributor's work happened at a different time. Keying on contributors would date person A's row by
   B's edit → pollutes `PersonDay.total` / day ordering / `mostRecentPerPerson` (Home "Working on") /
   `summaryPromptFor` (LLM asserts wrong-day work). `primaryId` = one row ≈ today; the only change is the
   intended one (a pure-reassignment item moves to the actual worker). Full multi-contributor display is
   deferred until per-version work time (`itemWorkTime(version.frontmatter)`) exists.
3. **Slack leg is EXEMPT.** It attributes per-participant (ignores `member_id`); its `participants[]`
   ledger IS its evidence-gated credit. Migrating it would regress per-replier attribution.
4. **Admin page stays OWNER-based; credit is ADDED as an explicit labeled field in the drill-down.**
   Making per-person views credit-based would MASK the raw-owner misattribution the page exists to catch,
   and health counts are full-table SQL GROUP BYs (the oracle is a JS batch — scale inversion). API gets a
   NEW credit field, not a changed meaning.
5. **Guard = file-level allowlist + raw-SQL grep**, and it must cover the surfaces the first draft missed:
   `lib/graph/human-actors.ts` (events route + arc grounding) and `lib/dashboard/team-work.ts` (Pulse
   accomplished commits) are ALSO current-owner reads — migrate to the oracle or allowlist with rationale,
   else "drift is structurally impossible" is false on day one.
6. **Drop the rollout flag** (primaryId swap is a near-no-op; staged PRs + revert suffice). **Cut the
   arc↔timeline cross-link** from this scope (separate lifecycle — its own design). **Keep the monitor.**
7. **Document behavior changes** of the ID variant: nameless-but-human members now credited (drop the
   has-name gate, keep connector exclusion); homonyms (two "Alex") now split correctly by id. Decide the
   timeline's `.not("member_id","is",null)` prefilter explicitly (keep → an owner-null/version-authored
   item stays hidden; document it).

**Motivation:** future-proofing, not a current bug. Prod divergence is 2/567 items today (a small-team
artifact), but its drivers — **reassignment** (item moves A→B) and **co-authorship** (multiple version
authors) — both scale with team size + collaboration. Putting attribution on one shared layer NOW is an
invisible migration (99.6% of items already agree) that makes drift **structurally impossible** later;
retrofitting it after it's visible at a customer is the disruptive path. This is the "lowest shared
layer" principle applied to a derived fact.

## Today: four surfaces, two different attribution notions

| Surface | Attributes by | Notion |
|---|---|---|
| Arcs (`lib/graph/arcs`) | `resolveItemCredit` | credited contributors (version authors, evidence-gated, lock-aware) |
| Timeline (`lib/dashboard/work-timeline`) | raw `items.member_id` | current owner only |
| Admin Attribution page (`lib/attribution/health`) | raw `items.member_id` | current owner only |
| `GET /api/v1/attribution` | via `lib/attribution/health` | current owner only |

Arcs credit everyone who did the work; the timeline/admin show only the current owner. On a
reassignment or co-authored item these disagree — rarely today, materially at scale.

## The oracle

`resolveItemCredit(db, teamId, itemIds) → Map<itemId, {contributors, primary}>` already encodes the rule
(evidence-gated over `item_versions`; a LOCK collapses credit to the corrected owner; connectors
excluded). One gap: it returns display **names**. The pure rules underneath (`creditedContributorIds` /
`creditedPrimaryId`) already work on member **IDs**.

**Change:** make the oracle return member IDs (`{contributorIds, primaryId}`) as the canonical shape;
name resolution becomes a thin caller-side map (arcs need names for the prompt; the timeline/admin need
IDs to key rows). One function, one rule, every surface.

## Consumers migrate onto it

1. **Timeline** — group evidence by the item's `contributorIds` (or `primaryId`; see decision D1)
   instead of raw `member_id`. Near-no-op today (primary == owner for 99.6%); correct at scale (a
   reassigned-away contributor is credited; a co-authored item surfaces under each contributor).
2. **Arcs** — already use `resolveItemCredit`; switch to the ID variant + map to names locally. No
   behavior change.
3. **Admin Attribution page** (`lib/attribution/health`) — **this is the control + mirror surface**:
   - **Per-person + drill-down → credit-based** (via the oracle), so what the admin sees matches what
     users see in the timeline/arcs. The drill-down keeps the raw owner + provenance/mismatch (the
     correction aid) AND now shows the **credited contributors**.
   - **Source-level health** (human/connector/unattributed %) → **stays owner-based** on purpose: it
     measures raw-attribution *quality* (the thing you correct), which is an owner-level question. (D2 —
     flag for Fable: is that split right, or should health also be credit-based?)
   - Corrections (set `member_id` + lock) already flow to the oracle (locks collapse credit) → so a
     correction on this page propagates to the timeline + arcs by construction. That's the payoff.
4. **`GET /api/v1/attribution`** — inherits the health migration (same lib), so the CLI/LLM read the same
   credit.

## Single-source guard

A build-failing test (`test/guards/…`) that fails if any attribution read resolves who-did-what outside
the oracle (grep for `items.member_id` group-bys / `.eq("member_id"` person-attribution reads in the
timeline/health/arcs layers, allowlisting the oracle + the raw correction/ingest writers). This is the
durable protection — a tripwire, not vigilance — exactly what the "structural, not remembered" rule asks.

## Auditability (folds in the coherence work)

- **Arc ↔ timeline evidence cross-link**: arc evidence items are the same items the timeline shows; tag
  timeline evidence with its arc, so an *intentional* difference (arcs' cross-time memory) is auditable
  rather than mysterious.
- **Admin credit surfacing**: the drill-down shows credited contributors + links to where they appear.

## Key decisions (for Fable)

- **D1 — timeline: contributors vs primary.** Show a co-authored item under EVERY contributor (fully
  matches arcs) or under `primary` only (≈ today's one-row UX)? Recommend: key on `contributorIds` at the
  data layer, but **render simple** — primary + a "+N" affordance — deferring a full multi-row UI until
  real multi-team usage. Don't speculatively over-build the rendering.
- **D2 — admin source-health: owner or credit?** (above).
- **D3 — perf.** The oracle adds an `item_versions` batch read per surface. Timeline already batches
  items; add versions in the same round. Bounded; measure on the data-mechanics tier.
- **D4 — tier.** The oracle is tier-agnostic (operates on item ids the caller already tier-filtered via
  `visibleItems`/`visibleGroupIds`); confirm no surface passes cross-tier item ids in.
- **D5 — lock semantics.** A locked correction must still collapse credit to the corrected owner on ALL
  surfaces (already true in the pure rule; verify the timeline path honors it after migration).

## Measurement (done, prod)

- Human contributor divergence, in-window: **2 / 567 items** (both multi-author GitHub). → adopting the
  oracle is an invisible migration today. Add a **coverage/divergence monitor** so we see the number rise.

## Test plan

- **Unit:** the ID-returning oracle shape; the pure rules already unit-tested.
- **Data-mechanics (real Postgres):** a reassigned item (A→B) credits both on the timeline AND arcs AND
  the admin page (one assertion per surface, one oracle); a locked correction collapses credit everywhere;
  tier isolation; the single-source guard is non-vacuous.
- **Guard:** fails the build when a new `items.member_id` person-attribution read is added outside the
  oracle.

## Rollout

Flag `ATTRIBUTION_ORACLE_UNIFIED` for instant rollback; near-no-op today so low blast radius. Staged:
oracle ID variant → arcs switch (no-op) → timeline → admin/health → guard → cross-link.
