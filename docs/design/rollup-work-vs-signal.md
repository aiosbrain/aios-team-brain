# Daily rollup: WORK vs SIGNAL — include decisions, never miscredit them as work

**Status:** design (Fable review before build). **Grounds:** the AIOS CLI daily loop pushes a lot of data,
but the daily rollup (the Timeline, day→person→work) only shows *work output* (commits, docs, active
tasks). Data that is **about** work — decisions, meetings — is dropped, so a person's day looks emptier
than it was, and there's no place to see "what got decided". The fix must add that context WITHOUT
crediting it as the person's work output.

## The one distinction this is built around

| | examples | `item_kind` / source | in the rollup |
|---|---|---|---|
| **WORK** — a person's real output | code, docs, a design | `deliverable`, `artifact`, `skill`, `blueprint` (non-signal source) | the WORK lane; **counted** in their day total, credited to them |
| **SIGNAL** — data *about* work | a decision, a meeting | `decision`, `transcript`; `SIGNAL_SOURCES` (granola/calendar) | a separate **Context** lane; **shown, never counted** as work |

This mirrors the split `lib/attribution/health.isSignalSource` already draws for attribution — we lift it to
a shared, `item_kind`-aware classifier so the rollup and attribution bucket identically. **The invariant:
a SIGNAL item never enters a person's work total, never nests under a task as "work", and never affects
work-based ordering.** It appears only in the clearly-labelled Context lane.

## Scope (this PR)

**In:** decisions — the clearest per-person, CLI-pushed signal (`decisions.decided_by`, tier `audience`).
Shown in a per-person **Context** lane: "decided: <title>", dated by `decided_at`, linking to its
`source_item_id`. **Out (follow-ups):** meetings-as-signal (a granola item's `member_id` is the recorder,
not the participants — team-level, not per-person; a later team-signal row), and other CLI kinds. The lane
is built to be extensible (a typed signal list), but only decisions populate it now.

## Design

**1. Shared classifier — `lib/dashboard/work-classification.ts` (new, pure, unit-tested).**
```
export type WorkClass = "work" | "signal";
export function classifyWork(kind: string | null | undefined, source: string | null | undefined): WorkClass
```
- `signal` when `kind ∈ {decision, transcript}` OR `isSignalSource(source)` (granola/calendar/…).
- `work` otherwise (`deliverable`/`artifact`/`skill`/`blueprint` + code/doc sources).
Lives in `lib/dashboard` (no server-only) so the pure grouper and the builder both use it; re-exports
`isSignalSource` so there's ONE signal definition. Guards against a future `item_kind` addition silently
landing in the WORK lane (a new kind defaults to `work` — reviewed by the `item_kind` enum guard's owner).

**2. Data layer — `lib/dashboard/work-timeline.ts`.** Add a decisions leg to the existing `Promise.all`:
```
visibleDecisions(
  db.from("decisions").select("id, title, decided_by, decided_at, source_item_id, audience")
    .eq("team_id", teamId).gte("decided_at", sinceDate)  -- decided_at is a DATE
    .order("decided_at", { ascending:false }).limit(DECISION_LIMIT),
  tier)
```
- Attribute to a member via the SAME proven `subjectMatchesMember(decided_by, rosterPerson)` used for task
  assignees; an unmatched decision is **dropped, never guessed** (mirrors tasks). THROW on query error
  (core leg — the swallowed-error trap; consistent with git/tasks, not the enrichment legs).
- Emit each as a `SignalItem { id, kind:"decision", title, at: decided_at→ISO, url: /library/<source_item_id> }`
  on a NEW `signal` lane — NOT an `EvidenceWithMember` (evidence = work; keeping the types distinct is what
  makes "signal never counts as work" true by construction, not by a runtime flag).
- Work-time note: decisions are dated by `decided_at` (a date, no time) — placed on that day; a decision
  with no `decided_at` is dropped (no day to place it, same rule as an undated item).

**3. Grouper — `lib/dashboard/timeline-group.ts`.** `PersonDay` gains `signals: SignalGroup[]` (grouped by
kind). `groupTimeline` takes the signal items alongside evidence and buckets them per (day, person) —
**separately from `tasks`/`other`**, and the person's `total` (which orders people + drives the "N items"
summary) is computed from WORK evidence ONLY. A day with *only* signals still shows the person (so "made 3
decisions, no commits" is visible) but ranks below anyone with real work. Pure + unit-tested.

**4. UI — `components/dashboard/person-work-card.tsx`** (shared → Timeline + Home "Working on"). Below the
work (tasks + Other), add a muted **Context** section rendering signals ("⚖ decided: <title>", linking to
the decision's library item). Visually distinct (dimmer, a scale/context icon), explicitly not part of the
work list. Renders nothing when a person has no signals.

**5. Cache — `lib/dashboard/timeline-cache.ts`.** `PersonDay` gaining a `signals` array is a STRUCTURAL
shape change (not an optional field on an existing item) → **bump `PAYLOAD_VERSION`** so old rows rebuild
(a missing `signals` on an old cached row would otherwise crash the card's `.map`). One-line change.

## Tier / access
Decisions carry their own `audience` tier → route the decisions query through **`visibleDecisions(q, tier)`**
(the §5 choke-point), so an `external` viewer never sees a `team`-audience decision. A data-mechanics
tier-isolation assertion is required (new read surface, no RLS backstop) — mirrors the chip PR's test.

## Verification
- **unit:** `classifyWork` (decision/transcript/granola → signal; deliverable/artifact/git → work; unknown
  kind → work) + `groupTimeline` (a decision lands in `signals` not `tasks`/`other`; work `total` excludes
  signals; a signals-only person shows but ranks last).
- **data-mechanics (real Postgres):** a decision attributed via `decided_by` appears in the person's Context
  lane and is NOT in tasks/other/total; an unmatched `decided_by` is dropped; **tier isolation** — an
  external viewer gets no team-audience decision.

## Explicitly NOT changing
- The WORK lane (tasks nesting, Other, credit oracle, Slack) — byte-identical; this is additive.
- Meeting exclusion from WORK stays (they're not a person's output). Meetings-as-team-signal = a follow-up.
