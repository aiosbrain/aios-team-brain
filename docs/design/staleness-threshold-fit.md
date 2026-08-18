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

## Measured (prod, 7 days) — RE-MEASURED TWICE

The first pass pooled ALL triggers. **The banner's clock reads `trigger='scheduler'` rows only**
(`lib/ingest/pipeline-health.ts`), so the sample was wrong — `meeting_notes` also runs on every
`aios push` (`trigger='api'`). The second pass used the banner's own filter but was taken hours
earlier, and its window happened to exclude the largest gap for two of the three legs. **The numbers
below are the third and current measurement** (2026-08-18, trailing 7 days, `trigger='scheduler'`),
over every source that recorded at least two scheduler runs in the window:

| leg | threshold | runs | worst gap | p95 | mis-fit? |
|---|---|---|---|---|---|
| `meeting_notes` | 3h | 300 | **293 min (4.9h)** | 78 | **YES** |
| `context_backfill` | 3h | 276 | **293 min (4.9h)** | 78 | **YES** |
| `context_backfill_all` | 3h | 276 | **293 min (4.9h)** | 78 | **YES** |
| `github` | 3h | 325 | 95 min | 39 | no |
| `access_bootstrap` | 3h | 309 | 86 min | 39 | no |
| `linear` / `slack` | 3h | 365/366 | 30 min | 30 | no |
| `auth_cleanup` | 26h | 7 | 1467 min (24.5h) | 1464 | no — 93 min of grace |
| `doc_task_infer` / `dense` / `graph_project` / `linear_inbound` | `null` | 10/39/182/361 | 2108 / 2107 / 69 / 60 min | — | n/a — never aged |

**The second measurement said `context_backfill[_all]` peaked at 235 min, and I fitted 5h (300 min) to
it — 7 minutes of grace.** The re-measure puts all three at 293 min. That is not a rounding
difference: fitting a bar 7 minutes above the observed worst case would have reproduced this ticket
within days. Recorded because the lesson is the method, not the number — **a threshold fitted to a
single window's maximum is fitted to noise.**

`doc_task_infer` (35h) and `dense` (35h) are the loudest argument for the `null` entries: those legs
are correct and healthy at gaps ten times the default.

**Full audit of the PIPELINE-LEG universe** (every `recordIngestRun` source, minus those the banner
structurally excludes): `access_bootstrap`, `arcs`, `auth_cleanup`, `auto_flip`, `context_backfill`,
`context_backfill_all`, `dense`, `doc_task_infer`, `github`, `graph_project`, `linear`,
`linear_inbound`, `meeting_notes`, `plane`, `pm_sync`, `scan`, `slack`. Excluded by
`NOT_PIPELINE_LEGS` and therefore never aged: **`llm`** and **`graph_health`** (a transition ledger
that writes only when an alarm flips — the earlier draft of this audit omitted it and claimed to be
complete). `graph_extract` is synthetic (`stale: false` hardcoded, never reaches `staleThresholdMs`).
`plane` is orphan-suppressed — no enabled integration, no scheduler rows in the window at all.

### The causal story — the second one was wrong, and the data says so

The earlier draft claimed the tail was **chain congestion**: one sequential `await` chain, a slow
upstream stage (backfill drain, then the per-team LLM meeting-notes pass) delaying every DOWNSTREAM
leg's recording, so the tail grows with corpus size. **That is refuted.** Inside the single worst gap
(2026-08-17 04:27→09:18 UTC), counting scheduler rows per source:

| leg | position in the tick chain | rows recorded during the gap |
|---|---|---|
| `slack` / `linear` / `linear_inbound` | early | **13** |
| `github` / `access_bootstrap` | middle | **7** |
| `context_backfill` / `context_backfill_all` / `meeting_notes` / `doc_task_infer` / `dense` | late | **0** |

The loop was **alive and ticking throughout** — congestion would have delayed `slack` too, and it did
not. The tick was being **TRUNCATED**: every pass reached `access_bootstrap` and no pass got a
`context_backfill` row durable, for eight consecutive ticks. `slack` at 13 runs in 4.85h is *faster*
than the 30-minute interval, which points at repeated process restarts re-entering `tick()` from the
top rather than a slow stage.

Two consequences, and the second is the important one:

1. The tail is **not** a function of corpus size. It is a function of how often a tick fails to reach
   the end of the chain. A threshold fitted to it is fitted to restart frequency.
2. **These legs are therefore NOT the clean dead-scheduler heartbeats this spec assumed.** Their
   newest-row age is "last time a tick got that far", not "last time the poller ran". That weakens the
   fitted-not-nulled argument below — and it is why the decision now rests on a different, checkable
   claim: a dead scheduler is caught at 3h by the UPSTREAM legs regardless, so widening these three
   costs no dead-scheduler detection at all.

**The real defect this exposed — the deep half of the tick chain silently stops recording when a tick
does not complete — is NOT fixed here.** It is instrumentation/failure-path work (a chain-level
heartbeat, or recording at pass start), it changes what every leg's row means, and it wants its own
measurement of restart frequency. Named as the next slice rather than bundled into a threshold change.

`STALE_MS_BY_SOURCE` already encodes the rule — *"each infrequent/irregular leg gets its OWN threshold
= its cadence + grace"* — and `auth_cleanup`, `doc_task_infer`, `arcs` and `dense` were each re-tuned
or nulled after exactly this bug. `meeting_notes` and `context_backfill` are the **5th and 6th**
recurrences.

## Decision

**1. Fit all THREE thresholds to `6h`, UNIFORMLY** (worst observed 293 min + ~67 min of grace):
- `meeting_notes`, `context_backfill`, `context_backfill_all` → **6h**.
- Uniform, not per-leg, because the measurement shows their large gaps are **the same event** — the
  three legs gap together to the second (04:26:21 / 04:26:26 / 04:26:21 → 09:19:30 / 09:19:35 /
  09:19:30). Fitting them individually is what produced the 5h/7-minutes-of-grace error; there is only
  one tail here, so there is one number.
- **The cost of widening is bounded and checkable:** a genuinely dead scheduler still reddens the
  banner within 3h via `slack`/`linear`/`github`/`access_bootstrap`, which are upstream, on the
  default, and record every tick they reach. What these three uniquely detect is a wedge confined to
  the DEEP half of the chain — which is exactly the condition currently firing as a false alarm.

**2. `auto_flip: null` — a LATENT recurrence, fixed pre-emptively.** `runAutoFlip` records only when it
flips/defers/errors, so a quiet pass writes nothing; it is absent from the map, so it would inherit the
3h default. It has **zero rows today** (verified), so it is not firing — but the first row it ever
writes would age past 3h and pin the banner red forever on a healthy leg. That is the
`doc_task_infer` class exactly, and it is one line to prevent instead of the 7th recurrence.

**Fitted, NOT nulled — on a narrower claim than the first draft made.** The first draft argued "they
record every scheduler tick, so their age IS last-poll age". The truncation measurement above shows
that is not reliably true. The claim that survives: each of the three records on every tick that
REACHES it, so a bounded age is still meaningful for them in a way it is not for
`dense`/`arcs`/`doc_task_infer` (which record only when there is work, so NO finite threshold is
correct). Nulling them would delete the only signal for a deep-chain wedge; widening them costs no
dead-scheduler detection, because the upstream legs cover that at 3h.

**3. Make the NEXT mis-fit detectable**, since hand-fitting has now failed six times, TWICE within
this slice alone. Two pieces:
- a pure `detectMisfitThresholds(cadenceBySource, thresholdFor)` reporting any leg whose observed
  worst gap sits at or above its configured threshold, so a mis-fit is a number rather than a flapping
  banner someone happens to notice; and
- a **build-failing guard that SCANS `recordIngestRun` call sites** for their `source:` literals and
  fails when one is not accounted for in the leg ledger. The hand-maintained list this slice started
  with could only catch regressions among legs someone had already thought of — it would not have
  caught `auto_flip`, and will not catch the 7th. Scanning is what makes it catch a leg nobody added
  to a list.

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

**In:** the THREE fitted constants + `auto_flip: null`; `detectMisfitThresholds` (pure); the
call-site-scanning ledger guard; tests pinning each against the measured cadences.

**Cut, each with the reason:**
- **Any change to the failure/streak path.** Including the sharpest adjacent fix the cold read found:
  `runMeetingNotesBackfill`'s outer catch writes **no row at all**, so a failing `teams` read silently
  skips recording every tick and this heartbeat is its only detector. Widening 3h→6h *doubles that
  blind window*, which is a real cost of this slice and is stated rather than buried. It is bounded:
  reaching that catch takes a `teams` read or a dynamic import failing, i.e. a database-wide fault
  that reddens the upstream legs at 3h anyway.
- **The tick-truncation defect itself** — the deep half of the chain silently not recording when a
  pass does not complete. It is the real cause of the tail, it is instrumentation work, and it wants
  its own measurement of restart frequency. Named as the next slice.
- **Nulling the fitted legs** (deletes the only deep-chain-wedge signal); **auto-tuning** (above); a
  **UI surface for the detector** (pure function + guard now; a surface is worth it at a 7th
  recurrence); **back-filling or altering historical `ingest_runs`**.

## Acceptance criteria

1. **unit** — `staleThresholdMs` returns 6h for ALL THREE of `meeting_notes`, `context_backfill` and
   `context_backfill_all`, as literal millisecond values, each exceeding the measured 293-min worst
   gap by a stated margin and each still under 24h (so the bar remains an alarm).
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
7. **unit** — `test/guards/ingest-leg-ledger.test.ts` SCANS `recordIngestRun` call sites for their
   `source:` literals and fails the build on any leg absent from the ledger, and the scan is proven
   non-vacuous (it finds a known set of real legs, so a regex that matched nothing could not pass).

## What would falsify this

- A leg going silent on a genuine break because its threshold was widened past a real outage (the
  dangerous direction — 6h on a leg that polls every 30 min still catches a dead scheduler within 6h).
- **ANY leg** flapping stale-then-fresh after the fix — not just the named three. The first draft's
  falsifier named two legs, which is exactly how `context_backfill_all` would have escaped it.
- **A gap growing past 6h as tick truncation gets more frequent** — this is the predicted way the fix
  ages out, and note the correction: the tail is NOT stage duration (that was the refuted story), so
  it will move with deploy/restart churn rather than with corpus size. If it recurs, the answer is
  the deferred tick-truncation slice, not a wider bar.
- **Any threshold fitted to a single window's maximum.** Already observed twice inside this slice: a
  measurement taken hours apart moved `context_backfill`'s worst gap from 235 to 293 min, and the 5h
  bar fitted to the first number had 7 minutes of grace.
- The detector reporting a mis-fit for a `null`-threshold leg (it has no threshold to mis-fit).
- A 7th recurrence on some other leg while the detector reported nothing → the detector is measuring
  the wrong thing.
