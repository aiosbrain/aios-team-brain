# Pulse — the home surface redesign

**Status:** shipped. **Register:** product (dashboard UI). **Supersedes:** the old analytics-command-center Home + the separate "Learning" tab.

## Why

The old Home led with a **query box + KPI/growth/usage charts** and buried the differentiated
content — narrative arcs and per-person "working on" — below the fold, while the arcs themselves lived
on a *separate* "Learning" tab. The flagship feature (the context-management system) was fragmented and
understated. Home should answer *"what is my team's brain telling me right now?"* in ~10 seconds.

## What changed

**IA.** Home became the flagship **"Pulse"** surface and absorbed the "Learning" tab (arcs, timeline,
facts/events). The `/learning` route now redirects to the team home; the nav "Learning" entry was
removed and "Home" was renamed **"Pulse"** (Brain icon).

**Pulse composition (top → bottom).**
1. Admin pipeline-health banner (unchanged).
2. Title "Pulse" + a **slim ask bar** (`components/dashboard/ask-bar`) — a single line that hands the
   question to the full Query chat (`/query?q=…`), replacing the old embedded query hero (`AskBrain`, removed).
3. **SNAPSHOT — "At a glance"**: the KPI ribbon + range selector.
4. **SNAPSHOT — two columns**: "What's happening" (`ArcsPanel variant="digest"`, 2/3 width) beside
   "Working on" (`WorkingOn variant="roster"`, 1/3).
5. **Timeline** disclosure (collapsed): the per-day drill-down (`TimelinePanel`, moved from Learning).
6. **Metrics** disclosure (collapsed): knowledge growth, usage, task funnel, decisions.
7. **Evidence trail** disclosure (collapsed): the raw events + atomic facts (from Learning).

## The snapshot pass — bounding the fold

The first cut of Pulse got the *order* right (story → people → metrics → evidence) but built it in the
wrong genre: a **feed**, where every band's height is proportional to how much data exists. So the band
answering "what's happening" was also the tallest thing on the page and sat first. Measured on prod
(6 arcs, ~400 chars of prose each): the arcs band alone ≈1,200px, the whole page ≈2,700px — about three
viewports, with `MAX_ARCS = 12` free to double the top band at any time.

A dashboard snapshot is the opposite property: **total height is constant regardless of data volume.**
The rule is therefore *every above-the-fold band shows "N with a link", never "all N"*:

- **`lib/dashboard/pulse-digest.ts`** owns the caps (`DIGEST_ARC_LIMIT = 3`, `DIGEST_PEOPLE_LIMIT = 6`)
  and `headlineTask` as pure, tested values — not magic numbers inside JSX.
  `test/pulse-digest.test.ts` asserts the capped counts as **literals**, so raising a cap goes red and
  forces a deliberate decision about the fold.
- **`ArcsPanel variant="digest"`** renders clamped headlines and expands to the full editable list
  *in place* — one panel, not a digest plus a duplicate list, so there is no second fetch and no way for
  the two to disagree. Editing stays a full-view affordance (a two-line clamp is not an editing surface).
- **`PersonWorkCard variant="row"`** is the same `PersonDay` at a second density (~56px vs ~300px); the
  evidence tree stays in the full card, so the #358 "identical by construction" invariant still holds.
- **Two columns** (story beside people) — the single column left ~half the width empty while pushing
  "who's on what" a full screen down. Container widened `max-w-5xl` → `max-w-6xl`.
- **Metrics is collapsed for everyone.** The headline numbers were promoted to the ribbon (with the
  range selector that scopes them); what remains is ~700px of charts, i.e. drill-down. Opening it by
  default for admins pushed the fold down for the people who use the page most.

`headlineTask` ranks via **`lib/tasks/activity-policy`** rather than a local status list — the
`activity-policy-single-source` guard caught exactly that duplication during this change, and deriving
means a newly mapped provider status inherits the ordering. Within a tier there is no invented
precedence; ties fall back to `groupTimeline`'s order (`evidenceCount` DESC, then title — not recency).

The digest's expand affordance is rendered **unconditionally**, not only when arcs are hidden: `ArcsPanel`
is mounted in exactly one place, so gating it on `hidden > 0` made editing, recompute, evidence trails and
the un-clamped prose unreachable product-wide whenever synthesis returned ≤ 3 arcs. For the same reason
the unsaved-corrections banner renders in **both** densities — the digest shows edited text, so hiding the
only save control behind the expanded view left an in-memory edit looking applied.

**"Working on" is labelled `· most recent activity`.** The band only ever covers each person's most
recent day, so on prod it showed 2 of 9 members — which, unlabelled, reads as "the team is idle" rather
than "2 people have activity in this window". Compressing the rows would only have sharpened the wrong
impression.

## The "Working on ≠ Timeline" consistency fix (shipped separately in #358)

The reason "Working on" looked stale: the Home card read `/api/dashboard/team-work` → the assignee-based
`assembleTeamWork` (all-status incl. `ready`, **no evidence gate**), while the Learning Timeline read the
evidence-gated `getWorkTimeline` context layer. **PR #358** fixed this by repointing
`/api/dashboard/team-work` at `getCachedWorkTimeline` (collapsed to each person's most recent day via
`mostRecentPerPerson`) and sharing one `PersonWorkCard` between the Home card and the Timeline panel — so
the two surfaces are identical by construction. **This redesign reuses that component unchanged**; it does
not re-implement the fix (an earlier draft of this branch did a parallel per-person rollup — dropped once
#358 landed, to avoid two competing implementations).

## Design direction

Restrained (product floor), reusing the existing token system: tinted-neutral `ink` text,
`surface-inset/raised` layers, **violet** as the single accent for current/emphasis, light editorial
surface. No new palette, no dark reskin. Arcs read as headlines; metrics are small/dense and collapsed.
