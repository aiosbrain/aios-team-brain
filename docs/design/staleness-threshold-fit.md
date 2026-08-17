# The pipeline banner cries wolf via STALENESS (BANNERFLAP-2)

Status: **proposed — needs a cold read before code** · Owner: chetan
· Tier build-with: unit (the pure threshold + mis-fit detector)

**Deps:** none. Sibling of BANNERFLAP-1, which fixed the FAILURE half of the same banner.

**Increment:** ONE PR = fitted thresholds for the two mis-fitted legs + a mis-fit detector that makes
the next recurrence visible. No change to the failure path, no new surface, no schema change.

## Problem

Reported live: Pulse showed *"three ingestion legs are broken"*, and a reload cleared it. **No ingest
run had failed in the previous 8 hours.** What fired was the STALENESS half of the banner.

`BANNERFLAP-1` debounced the FAILURE half — a lone failure is `unconfirmed` (shown, quiet) and only a
streak of `FAILURES_TO_CONFIRM` (2) goes loud. **Staleness bypasses that entirely.** In
`lib/ingest/pipeline-health.ts` it is computed instantaneously —

```ts
const stale = threshold !== null && clock !== undefined && now - Date.parse(clock) > threshold;
```

— and the loud set is `(l.failureClass === "confirmed" || l.stale)`. So **one late tick reddens the
banner with no debounce: a leg that is merely LATE is treated more harshly than one that actually
FAILED.**

## Measured (prod, 7 days) — RE-MEASURED after the cold read

The first pass pooled ALL triggers. **The banner's clock reads `trigger='scheduler'` rows only**
(`lib/ingest/pipeline-health.ts`), so the sample was wrong — `meeting_notes` also runs on every
`aios push` (`trigger='api'`). Re-measured with the banner's own filter, over **every source that has
ever recorded**, not a hand-picked six:

| leg | threshold | runs | worst gap | p95 | gaps > 3h |
|---|---|---|---|---|---|
| `meeting_notes` | 3h **(mis-fit)** | 301 | **293 min (4.9h)** | 78 | **4** |
| `context_backfill` | 3h **(mis-fit)** | 275 | **235 min (3.9h)** | 41 | **2** |
| `context_backfill_all` | 3h **(mis-fit)** | 275 | **235 min (3.9h)** | 41 | **2** |
| `github` | 3h | 324 | 96 min | 37 | 0 |
| `access_bootstrap` | 3h | 307 | 86 min | 39 | 0 |
| `linear` / `slack` | 3h | 363/364 | 30 min | 30 | 0 |
| `graph_project` / `linear_inbound` / `dense` / `doc_task_infer` / `auth_cleanup` | `null` or fitted | — | — | — | not aged / within fit |

**THREE mis-fitted legs, which is exactly what the user saw.** The first draft of this spec listed two
and would have shipped leaving the banner flapping. `context_backfill_all` is written by the SAME
invocation as `context_backfill`, milliseconds later (`lib/ingest/scheduler.ts`), so its gaps are
identical by construction — the measurement confirms it (275/235/41/2 for both).

**Full audit of the leg universe** (every source that has ever recorded): `access_bootstrap`, `arcs`,
`auth_cleanup`, `context_backfill`, `context_backfill_all`, `dense`, `doc_task_infer`, `github`,
`graph_project`, `linear`, `linear_inbound`, `llm`, `meeting_notes`, `plane`, `pm_sync`, `scan`,
`slack`. Of those, only the three above are mis-fitted; `plane` is orphan-suppressed (not an enabled
integration); `llm` is excluded from the leg set entirely.

### The causal story, corrected

These are **not** "each leg's own irregular cadence". The scheduler tick is one sequential `await`
chain, and the worst gaps rise in **chain order**: `access_bootstrap` 86 → `context_backfill` 235 →
`meeting_notes` 293. That is a slow upstream stage (backfill drain, then the per-team LLM meeting-notes
pass) delaying every DOWNSTREAM leg's recording. So the tail is a function of **corpus size and LLM
latency — a moving quantity**, not a fixed property of each leg. A threshold fitted to this week's
congestion will under-fit a bigger corpus later, which is stated here rather than discovered as a 7th
recurrence.

**The class fix that follows from that story — decoupling the heartbeat from stage duration** (record
at pass START, or one chain-level heartbeat) — is DEFERRED, not dismissed: it changes what every leg's
row means, so it deserves its own slice rather than riding along with a threshold change.

`STALE_MS_BY_SOURCE` already encodes the rule — *"each infrequent/irregular leg gets its OWN threshold
= its cadence + grace"* — and `auth_cleanup`, `doc_task_infer`, `arcs` and `dense` were each re-tuned
or nulled after exactly this bug. `meeting_notes` and `context_backfill` are the **5th and 6th**
recurrences.

## Decision

**1. Fit the THREE thresholds from the measurement above** (not from a guess):
- `meeting_notes` → **6h** (worst observed 4.9h + grace).
- `context_backfill` → **5h** (worst observed 3.9h + grace).
- `context_backfill_all` → **5h** — same invocation, identical gaps, so it must move with its sibling
  or the banner keeps flapping on the leg the first draft missed.

**2. `auto_flip: null` — a LATENT recurrence, fixed pre-emptively.** `runAutoFlip` records only when it
flips/defers/errors, so a quiet pass writes nothing; it is absent from the map, so it would inherit the
3h default. It has **zero rows today** (verified), so it is not firing — but the first row it ever
writes would age past 3h and pin the banner red forever on a healthy leg. That is the
`doc_task_infer` class exactly, and it is one line to prevent instead of the 7th recurrence.

**Fitted, NOT nulled.** Both record every scheduler tick, so their newest-row age genuinely is
last-poll age — they are real dead-scheduler heartbeats, and nulling them would delete a working
alarm to silence a threshold bug. (Contrast `dense`/`arcs`/`doc_task_infer`, which record only when
there is work, so no finite threshold is correct for them — that is why those are `null`.)

**3. Make the NEXT mis-fit detectable**, since hand-fitting has now failed six times. A pure
`detectMisfitThresholds(gapsBySource, thresholds)` reports any leg whose observed worst/p95 gap sits
at or above its configured threshold, so a mis-fit is a number someone can see rather than a flapping
banner someone happens to notice.

### Two designs considered and REJECTED — recorded so they are not re-proposed

- **Debounce staleness like failures ("two consecutive stale readings").** *Not available.* The
  failure streak works because failures are durable ROWS that can be counted
  (`count(*)::int as streak_length`). Staleness is derived from a single timestamp with no reading
  history, and the banner is computed per page load. Two consecutive readings would require new
  persisted state on a non-deterministic cadence. I proposed this before checking, and the code says
  it cannot work as described.
- **Auto-derive each threshold from the leg's own observed cadence.** Tempting — it mechanises the
  documented rule and would end the recurrence — but it fails in the **dangerous** direction: a leg
  that degrades gradually raises its own bar and goes SILENT. Crying wolf is annoying; a health banner
  that quietly stops alarming is the failure this whole file exists to prevent. Thresholds stay
  explicit; only the DETECTION of a bad one is automated.

## Scope

**In:** the THREE fitted constants + `auto_flip: null`; `detectMisfitThresholds` (pure); tests pinning
each against the measured cadences.

**Cut:** any change to the failure/streak path — including the sharpest adjacent fix the cold read
found: `runMeetingNotesBackfill`'s outer catch writes **no row at all**, so a failing `teams` read
silently skips recording every tick, and this heartbeat is its only detector. Recording `ok=false`
there would route it through the debounced failure path AND shrink the very tail being fitted here —
but it is a change to the failure path this slice deliberately does not touch, and the swallowing catch
is its own defect. Named as the next slice rather than bundled. Also cut: nulling the fitted legs; auto-tuning (above); a new UI
surface for the detector (it is a pure function + test now; wiring it to a surface is only worth it if
a 7th recurrence happens); back-filling or altering historical `ingest_runs`.

## Acceptance criteria

1. **unit** — `staleThresholdMs` returns 6h for `meeting_notes` and 5h for BOTH `context_backfill` and
   `context_backfill_all`, as literal millisecond values, each exceeding its measured worst gap.
2. **unit** — a leg NOT listed in `STALE_MS_BY_SOURCE` still gets the 3h default (`slack` as the
   witness), so this cannot silently widen an unrelated leg. Deliberately witnessed by a leg that is
   correctly on the default — the first draft phrased this as "every unlisted leg", which would have
   PINNED `auto_flip` to the threshold that makes it a fossil.
3. **unit** — the null set (`dense`, `arcs`, `doc_task_infer`, `llm`, `scan`, `pm_sync`,
   `linear_inbound`, `graph_project`, and now `auto_flip`) still returns `null`, so no
   record-only-when-active leg became age-checked.
4. **unit** — `detectMisfitThresholds` flags a leg whose worst gap exceeds its threshold, does NOT
   flag one comfortably inside it, and reports NOTHING for a `null`-threshold leg (which cannot be
   mis-fitted because it is never aged).
5. **unit** — `detectMisfitThresholds` fed the ACTUAL measured 7-day cadences from the table above
   reports all THREE mis-fits under the PRE-change thresholds and reports none under the shipped
   `staleThresholdMs` — so the fix is demonstrated against the real numbers rather than asserted.
6. **unit** — `detectMisfitThresholds` does NOT auto-derive a replacement: its finding carries the
   observed numbers and no suggested threshold, so no code path can widen a bar without a human
   editing the constant (the rejected dangerous direction, pinned rather than trusted).

## What would falsify this

- A leg going silent on a genuine break because its threshold was widened past a real outage (the
  dangerous direction — 6h on a leg that polls every 30 min still catches a dead scheduler within 6h).
- **ANY leg** flapping stale-then-fresh after the fix — not just the named three. The first draft's
  falsifier named two legs, which is exactly how `context_backfill_all` would have escaped it.
- A gap growing past a fitted threshold as the corpus grows (the tail is stage duration, not cadence),
  which is the predicted way this fix ages out.
- The detector reporting a mis-fit for a `null`-threshold leg (it has no threshold to mis-fit).
- A 7th recurrence on some other leg while the detector reported nothing → the detector is measuring
  the wrong thing.
