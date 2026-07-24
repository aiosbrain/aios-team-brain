# Design pass: ground narrative-arc synthesis on the timeline's evidence

**Status:** design-reviewed by Fable (SOUND-WITH-CHANGES) → **DEFERRED**: the coverage gap this targets is
empty in prod today (see Measurement). Keep as the plan of record for when scale warrants it; ship the
cheap monitoring + the docs-in-timeline fix first. **Author:** Chetan + Claude. **Reviewers:** Fable.

## Measurement (2026-07-24, prod) — the premise doesn't hold yet

- Timeline-active members (in-window work): **Chetan, John Ellison**.
- Current arc participants: **Chetan, John Ellison, Fatma** (superset — arcs are un-windowed).
- **Coverage gap (timeline-active people missing from arcs): EMPTY.** The attribution/coverage problem
  this design targets is not currently manifesting — `#303` (per-contributor round-robin) + the
  4000-char episode cap + `resolveItemCredit` already closed it at this scale.
- Caveat: "timeline-active" here = git+Slack contributors (items with a work-time). It EXCLUDES docs
  (deliverables) that the timeline currently drops for lacking `committed_at`/`source_ts` (the separate
  docs-in-timeline gap). Fixing THAT first would widen timeline coverage and could later surface a real
  arc gap — so the docs fix is the right next step, and this design is revisited only if the gap appears.

**Decision:** do NOT build full Option B now (over-engineering a flaky flagship for a non-manifesting
problem). Instead: (1) add a cheap **coverage-floor monitor** — alert when a timeline-active member is
absent from arcs; build this design only when it fires; (2) ship the docs-in-timeline fix. The revised
design below (Fable's required changes folded in) is what we implement IF/WHEN the monitor fires.
**Scope:** how `lib/graph/arcs.ts` selects and attributes the evidence it feeds the LLM. Does NOT change the
arc *display* or the timeline. Builds off `main` (NOT PR #287, which is superseded — see below).

## Problem

Narrative arcs are **fact-centric**: `synthesizeArcs` pulls a pool of Graphiti atomic facts
(`recentFacts`), balances them across contributors, then back-resolves attribution through a lossy chain
— `fact → episodeUuids → resolveEpisodeItems → item → resolveItemCredit → human`. Every hop can drop or
misattribute a contributor, and the pool itself inherits Graphiti's extraction limits (episode-char cap,
sampling skew). Symptoms we've already patched piecemeal (per-contributor round-robin sampling; the
16384→4000 episode-char cap) treat instances, not the cause: **arc coverage/attribution is only as good
as which facts Graphiti happened to extract and how we back-map them to people.**

Meanwhile the **timeline** (`getWorkTimeline` → `work_timeline_cache`) already holds, per person, their
in-window work with *clean, direct* attribution (`items.member_id` / `item_versions` credit), evidence-
gated tasks, Slack, and a per-day synopsis. One item = one row, no chunk spam. It is the better-attributed
evidence base — that's literally why it was built from `items`, not the graph.

## Goal

Make the timeline the **attribution + coverage backbone** for arc synthesis, so every active contributor
is represented and correctly credited by construction, while keeping the graph's semantic depth.

## Options

**A. Timeline-only (replace the fact pool).** Synthesize arcs from the timeline's per-person work +
synopses; drop Graphiti facts from the input.
- ✅ Clean attribution, deterministic input, no graph dependency, simplest.
- ❌ Loses cross-source *semantic* facts the graph extracts ("X decided Y because Z", "A blocks B"). Arcs
  risk becoming shallow ("John worked on auth; Chetan on retrieval") instead of narrative.

**B. Hybrid, timeline-authoritative attribution (recommended).** Timeline drives *who + what + coverage*;
Graphiti facts still supply *semantic content*. Concretely:
- Seed the synthesis input from the timeline: for **each active person**, a compact block of their recent
  tasks + evidence titles + the day synopsis. This GUARANTEES every working person is in the prompt
  (kills sampling skew at the source).
- Keep a (smaller) Graphiti-fact pool for semantic relationships, but **participants/attribution are
  taken from the timeline block a fact's item belongs to**, not re-derived from episodes.
- ✅ Fixes coverage + attribution durably; keeps semantic richness; one shared evidence source.
- ❌ More complex prompt + reconciliation; two inputs.

**C. Attribution-only correction (minimal).** Keep fact-centric synthesis; only *validate* arc
participants against the timeline (a person stays a participant iff the timeline shows them doing related
in-window work).
- ✅ Smallest change, directly targets attribution.
- ❌ Doesn't fix coverage (a contributor absent from the fact pool still never appears); leaves the lossy
  chain in place.

## Recommendation

**Option B**, staged so we can de-risk:
1. **Phase 1 — coverage backbone.** Add the per-person timeline block to the synthesis input alongside
   the existing fact pool; make timeline attribution authoritative for participants. Measurable win:
   every active person appears; participants match the ledger. Keep facts for content.
2. **Phase 2 (optional, later).** If facts add little beyond the timeline, taper the fact pool
   (→ Option A) once Phase 1 proves arcs stay rich.

This is the "lowest shared layer" move: timeline becomes the one evidence source both the ledger view and
the arc narrative stand on.

## Key design decisions (revised — Fable's required changes folded in)

1. **Decoupling — read the CACHE only.** Arcs read the timeline via **`readTimelineCache(db, teamId,
   tier)`** — NOT `getCachedWorkTimeline`, which on a stale/cold row triggers a rebuild + per-(person,day)
   LLM synopsis fan-out (the exact coupling we forbid). `readTimelineCache` is null-on-miss and never
   rebuilds; null → fact-only fallback. The timeline must NEVER read arcs.
2. **Flakiness containment.** Timeline-read failure/null → current fact-only pool (no regression).
   Empty-clobber guard stays.
3. **Attribution — `resolveItemCredit` stays the SINGLE oracle.** (Fable High: the timeline attributes by
   raw current `items.member_id`; `resolveItemCredit` is evidence-gated over `item_versions`, keeps a
   reassigned-away contributor, honors locked corrections — making the timeline authoritative would
   REGRESS the `#303` credit fix.) The timeline is the **coverage/seeding layer only**: union the timeline
   blocks' item ids into `allItemIds`, and the existing `resolveItemCredit` batch credits everything —
   one rule, no reconciliation table.
4. **Citable timeline evidence (`[T#]`).** (Fable High: `groundParticipants` drops any participant with no
   cited evidence, and `buildEvidence` only resolves `[F#]` fact cites — so a timeline-only contributor
   would be silently deleted.) Timeline evidence entries get their own `[T#]` numbering → `{itemId,
   source}`, flowing into `evidence` + `contributorsByItem` (strip the Slack `:{authorId}` synthetic
   suffix when mapping to item ids).
5. **Stability hash — DETERMINISTIC fields only.** (Fable High: the day-synopsis is regenerated
   non-deterministically on every timeline rebuild; putting it in the prompt→`factsHash` would make
   `canReuseArcs` almost never fire → arc churn returns.) The per-person block digest uses sorted item
   ids, evidence/task titles + keys, ABSOLUTE dates — NEVER synopses or relative "Today/Yesterday" labels.
   Flag flip forces one re-synthesis (acceptable).
6. **Tier passed explicitly.** Pass `tier` into `synthesizeArcs`/`refreshArcsInBackground` (both callers
   have it); do NOT derive it from `groups.length`. Build per-person blocks with the arc request's tier
   (leak-safe: timeline rows are per-tier, `AccessTier`↔`ViewerTier` is bijective). Guarded + DM-tested.
7. **Coverage-floor shape (Phase 1 scope reduction).** Seed timeline evidence ONLY for contributors
   missing from the balanced fact pool — most of B's value, a fraction of the prompt/reconciliation
   surface. Consider lowering `MAX_FACTS` to keep the total prompt budget flat.
8. **Cost/latency.** Cache-only timeline read (cheap). No extra LLM calls.

## Risk & rollback

Arcs are a flagship, historically-flaky surface. Mitigations: (a) fall back to fact-only on any timeline
read failure; (b) env flag `ARCS_TIMELINE_GROUNDING` to disable instantly without a deploy; (c) the
empty-clobber guard already keeps the last-good arcs if a rebuild returns empty. Rollback = flip the flag.

## Test plan

- **Unit:** the pure prompt-input builder (per-person block shaping, caps); the extended stability hash.
- **Data-mechanics (real Postgres):** an active contributor with in-window timeline work but NO extracted
  Graphiti facts still appears as an arc participant (the coverage fix — this is the assertion that would
  be RED today); tier isolation (external viewer's arc input excludes team-tier work); timeline-read
  failure → falls back to fact-only, arcs non-empty.
- **Eval:** spot-check arc quality vs today on the live team (are arcs still narrative, not shallow?).

## #287 note

PR #287 ("finish reasoning-starvation fix + de-noise graph-health alert") is **superseded** — both fixes
already shipped to `main` via later PRs (`complete.ts`/`claude.ts` headroom+retry; `retrieval-health`
`deriveGraphState`), and its branch is 84 commits behind. It is NOT a base for this work. Close it.
