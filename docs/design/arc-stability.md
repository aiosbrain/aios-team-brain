# Narrative arcs — day-to-day stability

**Status:** shipped. **Register:** product (Learning / Pulse). **Ticket:** AIO-689.

## The complaint

> "The narrative arcs shift from day to day. Keep them stable or relatively stable. It's fine to merge
> them or split them, but they should be relatively stable day to day."

## Why they shifted — three compounding causes

1. **Identity was a hash of the title.** `stableId(title) = sha256(title.trim().toLowerCase())`. Reword
   *"Social Brain rollout"* into *"Rolling out the Social Brain"* and it became a brand-new arc. The
   codebase already knew: `ArcCorrection.arc_title` exists **only** because "`arc_id` is sha(title) and
   churns on every recompute (M7)". Identity was pinned to the most volatile thing an LLM emits.
2. **Every recompute was de novo.** `buildPrompt` sent facts + corrections; the model never saw its own
   previous answer, so it re-invented both the partition and the wording each time.
3. **The requested arc count moved daily.** `arcsRequested = min(12, max(6, 2 × contributors))` — one
   person going quiet took the target from 8 to 6 and forced a re-partition of unchanged work.

**The existing guard did not cover this.** `canReuseArcs` requires a byte-identical fact set, so it only
stops churn between views on the *same day*. Any new work at all → full re-synthesis → all three above.

## What changed

### 1. Identity by evidence, not by title (`lib/graph/arc-continuity`)

After synthesis, each arc is matched against the previous set on the **brain item ids its evidence
cites** — the one durable thing an arc carries, since item ids come from the graph rather than the model.
A match inherits the prior arc's `id`, so "same work, reworded" is a continuation.

- **Same-arc test:** ≥2 shared items, or containment where the PRIOR is also tiny (≤2 items) — so a
  1-evidence arc, often a person's only thread, isn't reborn daily. The prior-side condition matters:
  without it a 1-item arc could claim an 8-item prior's identity on one shared item, which is exactly the
  incidental-all-hands case the ≥2 rule exists to exclude, and it would bind that prior's stored
  correction to unrelated work.
- **Title:** the prior title is kept while ≥50% of the prior arc's items are still cited; below that the
  work has moved on and the model's new title is the honest label. At exactly half, stability wins.
- **Merge/split are first-class**, as the product asked. Each prior id is claimed by at most one arc, so
  the strongest match continues it. Lineage is recorded under two DISTINCT names because they are
  different claims: `supersedes` = priors nobody inherited (this arc absorbed them; they are gone), and
  `splitFrom` = the prior that lives on under another arc (nothing was superseded, so saying so would be
  a stored falsehood).
- **Ids emitted are unique.** A split whose children both keep the parent's title — which the continuity
  prompt explicitly asks for — makes both children parse as `sha("Costs")`, the very id the winner
  inherits. Inherited ids are reserved first and any colliding non-inheritor is re-keyed on
  title + sorted evidence ids (deterministic, so it doesn't reintroduce churn). Without this: duplicate
  React keys, one edit targeting two cards, and a single `arc_corrections` row bound to two arcs.
- Deterministic by construction (pairs ordered by shared count, then ratio, then position). A
  non-deterministic reconciler would reintroduce the churn it exists to remove.

### 2. The prompt shows the standing arcs

A continuity block lists the previous titles and asks the model to keep them unless work genuinely
diverged/converged/stopped. **A nudge, not the mechanism** — identity is settled deterministically,
precisely because prompt compliance isn't something to depend on.

**The continuity block is excluded from `factsHash`** (`systemPromptForHash`). The hash answers one
question — *did the input work change?* — and prior titles are not work. Folding them in would make an
unchanged fact set re-synthesize whenever the model reworded anything, i.e. the continuity nudge would
have disabled the reuse guard it was meant to reinforce. Caught by `arcs-degraded-skips-model`.

### 3. The requested count stops oscillating (`stableArcTarget`)

Hysteresis: hold the previous count while the derived target is within 1, else move one step toward it.

**Banded, and the band is load-bearing.** The only available anchor is how many arcs the last synthesis
*output*, and the model routinely returns fewer than requested. Anchoring naively creates a **downward
ratchet** — ask 6, get 3, ask 4, get 2, ask 3 — collapsing the panel with nothing in the fact set having
changed. So the result is clamped to the `arcsRequested` band `[MIN_ARCS_REQUESTED, MAX_ARCS]`, and a
prior outside that band doesn't anchor at all. Both guards are separately mutation-tested; the bug was
found by an existing test, not by reading the code.

## Measurement — the part that makes this checkable

`arc_cache` stores only the *current* set, so there was no way to say whether carry-over was 30% or 90%,
and therefore no way to confirm a stability fix worked (CLAUDE.md §3). Each background synthesis now
records to `ingest_runs`:

```
source='arcs', trigger='api', created=<arcs>,
meta={group_key, carried_over, prior_count, continuity_pct}
```

`trigger='api'` because the refresh is view-triggered (SWR), not the poller — `pipeline-health` reads
`scheduler` rows as poller-heartbeat evidence and this is not that. `group_key` is in `meta` because a
team with external viewers records a row per tier scope, and without it the two silently mix in the trend.

**A failed synthesis is not a stability observation.** When the model returns nothing while facts existed,
the reconciler yields 0% carry-over and `commitArcs` correctly keeps the healthy prior — so `ok` follows
`untrustworthy`, not `payloadDegraded` (the bytes served are the good prior, which would have reported the
failure as success), and the row records `{synthesis_failed: true}` INSTEAD of continuity numbers. Logging
a transient outage as 100% churn would poison the very series this exists to create.

Only the background path records — it runs on a schedule, so the series is comparable over time. Nothing
is recorded on a hash-skip (the model didn't run). `arcs` is `null` in `STALE_MS_BY_SOURCE`: it is a
record-only-when-active leg, so an age threshold would flag a team whose work simply hasn't changed.

**Target:** ≥80% carry-over day to day, and an arc should not disappear while its work is still active.

## Known residuals (deferred, with reason)

- `distinctId` is reserved but not re-checked against itself: two unmatched arcs with the SAME title and
  identical evidence sets still collide. Degenerate — they would be indistinguishable arcs — and a
  legacy `arc_cache` row already holding duplicate ids can likewise hand one id to two inheritors.
- `supersedes` is still recorded on a single-shared-item overlap with a prior that vanished. Weak, but it
  names a real disappearance; the field has no consumer yet.
- An arc whose prior had ≥3 items and gets only one citation today is reborn rather than continued —
  the price of closing the containment back door, and the safer direction.

## Deliberately not done

- **No arc history table.** `continuity_pct` in `ingest_runs` answers the stability question without a
  new table to keep. If per-arc lifetimes are ever wanted, that's the point to reconsider.
- **The 50% title rule is a judgement call**, not a measured optimum. It is one constant in one place so
  it can be revisited against the recorded series rather than argued about.
