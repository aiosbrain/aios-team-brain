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
3. **HERO — Narrative arcs** (`ArcsPanel`, promoted from Learning): the story of the team right now.
4. **Working on — per person** (`WorkingOn`): who's doing what.
5. **Timeline** disclosure (collapsed): the per-day drill-down (`TimelinePanel`, moved from Learning).
6. **Metrics** disclosure (open for admins): KPIs, knowledge growth, usage, task funnel, decisions,
   range selector — subordinate to the story, not deleted.
7. **Evidence trail** disclosure (collapsed): the raw events + atomic facts (from Learning).

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
