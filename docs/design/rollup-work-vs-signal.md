# Daily rollup: WORK vs SIGNAL — include decisions, never miscredit them as work

**Status:** design (Fable-reviewed → revised). **Grounds:** the AIOS CLI daily loop pushes a lot of data,
but the daily rollup (the Timeline, day→person→work) only shows *work output* (commits, docs, active
tasks). Data that is **about** work — decisions, meetings — is dropped, so a person's day looks emptier
than it was, and there's no place to see "what got decided". The fix must add that context WITHOUT
crediting it as the person's work output.

## The one distinction this is built around

| | examples | in the rollup |
|---|---|---|
| **WORK** — a person's real output | code, docs, a design, **Slack threads they're in** | the WORK lane; **counted** in their day total, credited, drives ordering |
| **SIGNAL** — data *about* work | a decision, a (non-Slack) meeting/transcript | a separate **Context** lane; **shown, never counted** as work |

**The invariant:** a SIGNAL item never enters a person's work `total`, never nests under a task, never
affects work-based ordering **and never displaces a person's most-recent-work day on Home** (see §3). It
appears only in the clearly-labelled Context lane.

## Scope (this PR)

**In:** decisions — the clearest per-person, CLI-pushed signal. **Out (follow-ups):** meetings-as-signal (a
granola item's `member_id` is the recorder, not the participants — team-level, not per-person), and any
`decided_by` we can't confidently pin to ONE roster member (empty / "the team" / "Chetan + John" / an
ambiguous bare first name) — those are **dropped** here and are the natural home for a later *team-level*
signal row. The lane is a typed signal list, extensible, but only decisions populate it now.

## Design

**1. Shared classifier — `lib/dashboard/work-classification.ts` (new, pure, unit-tested).**
```
export type WorkClass = "work" | "signal";
export function classifyWork(kind: string | null | undefined, source: string | null | undefined): WorkClass
```
Rule (source-first, with the Slack carve-out — Slack threads are `kind:"transcript"` yet are per-person WORK):
```
signal  ⇔  kind === "decision"
        ||  isSignalSource(source)                                   // granola / calendar / zoom / …
        ||  (kind === "transcript" && normalizeSource(source) !== "slack")   // a bare/meeting transcript, NOT a Slack thread
work    otherwise                                                    // deliverable/artifact/skill/blueprint + code/doc + Slack
```
Lives in `lib/dashboard` (no server-only) so the pure grouper and the builder share it; re-exports
`isSignalSource` so there's ONE signal definition. A future `item_kind` addition defaults to `work` — the
spec test `classifyWork("transcript","slack") === "work"` is the one that catches the Slack mis-bucketing
(Fable's #1 finding); also assert `("decision", …) → signal`, `("transcript","granola") → signal`,
`("deliverable","github") → work`, `("artifact","git") → work`.
*Note:* the decisions-only PR routes only decisions through the signal lane, but the classifier is defined
correctly now so the meetings follow-up (and any attribution-side caller) can't reintroduce the Slack bug.

**2. Data layer — `lib/dashboard/work-timeline.ts`.** Add a decisions leg to the existing `Promise.all`:
```
visibleDecisions(
  db.from("decisions").select("id, title, decided_by, decided_at, source_item_id, audience, still_valid")
    .eq("team_id", teamId).gte("decided_at", sinceDate)   -- decided_at is a DATE (YYYY-MM-DD)
    .order("decided_at", { ascending:false }).limit(DECISION_LIMIT),   -- DECISION_LIMIT = 500
  tier)
```
- **Attribution (drop-never-guess):** match `decided_by` to a member via the SAME `subjectMatchesMember`
  used for task assignees, but **drop on an AMBIGUOUS match** — if `decided_by` (e.g. a bare first name)
  matches ≥2 roster members, drop it (never first-wins-guess, unlike `team-work.ts`). Empty / group /
  multi-name `decided_by` → also dropped (no confident single owner). Dropped decisions are invisible here
  (the team-signal follow-up is their home).
- **Error handling: WARN, not throw** (Fable — consistency with the Slack/chips *enrichment* legs, which
  warn: a `decisions`-read failure must not blank the whole WORK timeline; the context lane is never
  counted, so it's strictly less critical than Slack, which already accepted the warn trade-off).
- Emit each matched row as a `SignalItem { id, kind:"decision", title, at: decided_at /* bare YYYY-MM-DD */,
  url? }` — a DISTINCT type, NOT `EvidenceWithMember` (keeping the types separate is what makes "signal
  never counts as work" true by construction, not a runtime flag — Fable endorsed). `url` =
  `/library/<source_item_id>` when `source_item_id` is non-null (dashboard-created decisions have none →
  no link). `still_valid` is included regardless (it WAS decided that day; later supersession doesn't
  un-happen it) — optionally rendered as a "superseded" hint, not a filter.
- Dated by `decided_at` (a bare date, no time) — placed on that day; a decision with no `decided_at` is
  dropped (no day to place it — same rule as an undated work item).

**3. Grouper — `lib/dashboard/timeline-group.ts`.** `PersonDay` gains `signals: SignalGroup[]` (grouped by
kind; one kind today, pre-positioned for meetings). `groupTimeline` buckets signal items per (day, person)
**separately from `tasks`/`other`**; the person's `total` (which orders people + the "N items" summary) is
computed from WORK evidence ONLY (unchanged — `total` already sums `tasks`+`other`, and `summaryPromptFor`
reads only those, so decisions structurally cannot enter the work synopsis; a spec test pins this). A day
with only signals still appears in the day-by-day Timeline (so "made 3 decisions, no commits" is visible)
but ranks last (`total === 0`).
- **`mostRecentPerPerson` fix (Fable #2 — the Home leak).** It currently picks each person's newest day;
  a decision-only Wednesday would replace a person's real-work Monday on Home "Working on" ("0 items").
  Change it to pick each person's most recent day **with `total > 0`** (real work). Signal-only days never
  become a person's Home card. Spec test: work-Monday + signal-only-Wednesday → Home shows Monday.

**4. UI — `components/dashboard/person-work-card.tsx`** (shared → Timeline + Home). Below the work, a muted
**Context** section renders `signals` ("⚖ decided: <title>", linking to the decision's library item when
`url` is set), **no timestamp** (bare-date signal). Renders nothing when empty. The summary/count line
appends a labelled "· N decision(s)" — kept OUT of the work item count so a decisions-only day reads "0
items · 2 decisions", never "2 items".

**5. Cache — `lib/dashboard/timeline-cache.ts`.** `PersonDay` gaining a required `signals` array is a
STRUCTURAL shape change → **bump `PAYLOAD_VERSION`** so old rows rebuild (an old row lacking `signals` would
TypeError the card's `.map`). (The `summary` field went additive-optional/no-bump; we bump here because a
required array is safer for the stable `GET /api/v1/timeline` CLI shape and avoids scattered optional
chains — the cold rebuild is the cheap pure builder, no inline LLM.)

## Tier / access
Decisions carry their own `audience` tier → route the query through **`visibleDecisions(q, tier)`** (the §5
choke-point); the cache's per-tier `group_key` rows keep payloads separated. A data-mechanics tier-isolation
assertion is REQUIRED (new read surface, no RLS backstop) — mirrors the chip PR's test.

## Verification
- **unit — `classifyWork`:** `("transcript","slack")→work` (the Slack guard), `("decision",_)→signal`,
  `("transcript","granola")→signal`, `("deliverable","github")→work`, `("artifact","git")→work`,
  `(unknown,_)→work`.
- **unit — `groupTimeline`:** a decision lands in `signals`, not `tasks`/`other`; work `total` excludes it;
  a signals-only person shows in the Timeline but with `total===0`; **`summaryPromptFor` output is identical
  with vs without signals** (no work-synopsis leak).
- **unit — `mostRecentPerPerson`:** work-Monday + signal-only-Wednesday → Monday.
- **data-mechanics (real Postgres):** a decision attributed via `decided_by` appears in the Context lane and
  is NOT in tasks/other/total; an unmatched OR ambiguous `decided_by` is dropped; **tier isolation** — an
  external viewer gets no `team`-audience decision.

## Build-loop checklist (§1)
- Update the **Timeline** flow prose in `docs/ARCHITECTURE.md` in the same PR (no new route/table/source, so
  the drift guard won't fire — the prose is on us).

## Explicitly NOT changing
- The WORK lane (tasks nesting, Other, credit oracle, **Slack per-participant**) — byte-identical; additive.
- Meeting/granola exclusion from WORK stays. Meetings-as-team-signal + team-level decisions = a follow-up.
