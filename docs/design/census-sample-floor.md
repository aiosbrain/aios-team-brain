# The census tripwire accuses on a sample of one — CENSUSFLOOR-1 / AIO-867

**Status:** spec, pre-review.
**Related:** `docs/design/dedupe-alarm-0293.md` (the alarm this is a defect in, merged `031f5bb`, 4 days old).

---

## 0. What is actually wrong, and a correction to my own first report

The admin card currently shows, for the `aios_external` group:

> ⚠️ *episodes are flowing but the census reads zero names — rename or stalled extractor*

**Nothing is stalled.** In the whole 7-day census window that group contains **one** episode:
`4-shared/index.md`, a **196-character boilerplate directory header** ("What you've deliberately
promoted outward…"). It has no people or projects in it, so it correctly produces zero named
entities. The `aios_team` group in the same read is healthy and judged: 2,439 names, 12.66
entities/episode, 0.2% splits against a 1.6% baseline.

**Confirmed, not assumed — extraction for that group works.** The review would not accept "nothing is
stalled" on the strength of one episode's content, so I read Neo4j directly (read-only, via
`railway ssh` to the graphiti service, the only host that can reach `neo4j.railway.internal`):

```
aios_external | entities: 16 | episodic: 6
aios_team     | entities: 18999 | episodic: 6037
```

`aios_external` has **16 entities all-time**. There is no per-group extraction failure being explained
away here: the zero is purely a *windowing* effect — no new entity landed in the last 7 days because
the only episode in that window is boilerplate.

The cause is one predicate. `deriveNameCollisionPollution` (`lib/graph/extraction-health.ts:643`):

```ts
if (signals.recentNames === 0) {
  return (recentEpisodes ?? 0) > 0 ? refuse("predicate-suspect") : refuse("small-sample");
}
```

**The accusation floor is one episode.** Its sibling judgement, in the same file, refuses below
**twenty-five** — `MIN_EPISODES_FOR_EXTRACTION_SIGNAL` (`extraction-health.ts:48`), whose own
docstring states the reason: *"Below this many projected episodes we can't distinguish 'extractor
broken' from 'fresh install still mid-first-extraction'."* That reasoning applies verbatim to this
tripwire. The two judgements disagree about how much evidence an accusation needs, in the same file,
about the same pipeline.

### Correction: I told the owner this "will email you". It will not — today.

I reported that the blindness meta-alarm would email an accusation about a healthy system. **That was
wrong, and I am correcting it before it becomes the justification for the fix.**
`classifyBlindnessTick` (`extraction-alert.ts:225`) returns `"judged"` if **any** group is judgeable.
`aios_team` is judgeable, so the tick is judged, the blindness clock never runs, and no mail fires.

**What is true is narrower and still worth fixing:**

1. **The card states a falsehood today** — "stalled extractor" about a working one. An alarm surface
   that accuses on no evidence trains its reader to ignore it, which is how the last alarm ended up
   silently dead.
2. **There is a real latent paging path — rarer than I first said, and I am pricing it honestly.**
   `predicate-suspect` *does* run the blindness clock (`extraction-alert.ts:203-204`), while
   `small-sample` parks (`:211-213`). It is masked only because `aios_team` clears
   `MIN_NAMES_FOR_CENSUS_SIGNAL = 50`. If `aios_team` ever falls below that it parks, leaving
   `aios_external`'s false refusal as the only clock-running one, the tick becomes `"running"`, and
   24 hours later the meta-alarm **mails a stalled-extractor accusation**.

   **I first wrote "on a quiet week". That overstates it and the measured rates say so.** The path
   needs a conjunction: `aios_team`'s recent-name arrivals collapsing from **2,439/week to under 50**
   — a >97% drop, a full shutdown rather than a quiet week (and diff-sync means unchanged content
   does not re-project, so it is reachable, roughly annually) — **and** a fresh zero-yield
   `aios_external` push (~0.7/week historically) inside the same window, **and** both holding 24h.

   **The stronger version of this argument is the one I had not made:** AIOS is self-hosted per
   organisation (CLAUDE.md §5). On a small install — one team, low volume, an external group of a
   handful of shared files — *this conjunction is the normal state*, not the annual tail. The bug is
   mild here and routine there.

So: not urgent on this install, genuinely wrong on every install, and it pages exactly when a
spurious page is least welcome.

---

## 1. The fix

Give the tripwire an episode floor, and make a below-floor group read as what it is:

```ts
if (signals.recentNames === 0) {
  return (recentEpisodes ?? 0) >= MIN_EPISODES_FOR_CENSUS_SUSPICION
    ? refuse("predicate-suspect")   // enough pushed that zero names is unexplained
    : refuse("small-sample");       // honest "cannot judge", parks, no accusation
}
```

**A new constant rather than reusing `MIN_EPISODES_FOR_EXTRACTION_SIGNAL`.** My first draft justified
this as "different populations (facts vs names)". That is the wrong reason — **both constants are
denominated in episodes.** The real and stronger one: `MIN_EPISODES_FOR_EXTRACTION_SIGNAL` counts
**lifetime** episodes (`countProjectedEpisodes`, `extraction-health.ts:180-190`, no window), while
this tripwire counts **7-day-windowed** episodes, which is a *rate*. Reusing one constant would couple
a fresh-install threshold to a rate threshold, and a future re-derivation of either would silently
move the other.

**Initial value 25 — chosen conservative against the measured yield, not merely inherited.** At
`aios_team`'s measured 12.66 entities/episode, even 3–5 typical episodes yielding zero names would be
anomalous, so a floor of 25 is far above what detection strictly needs. It is set there deliberately,
against the counter-case that makes a low floor dangerous: a workspace restructure re-pushing several
boilerplate index files in one week would legitimately yield near-zero names, and a card that
accuses on that burst is back to crying wolf. The asymmetry is the same one the review gate uses —
a false accusation costs the alarm's credibility, a missed low-volume detection costs a delay.

`small-sample` is the correct destination: it parks the blindness clock
(`extraction-alert.ts:211-213`), so a low-volume group produces neither an accusation nor a page —
while a genuinely broken extractor on a *busy* group still trips at 25.

---

## 2. What this deliberately does not fix

**A group could push 25 boilerplate episodes and still legitimately yield zero names**, and the
tripwire would then accuse it. An episode count is a proxy for "enough content that entities were
owed"; content *volume* would be the honest measure. I am not building that: the sibling judgement
accepts the identical tradeoff, 25 near-empty episodes in one group is not a realistic steady state,
and adding a second unmeasured threshold to fix an unmeasured one is how thresholds multiply.
Recorded so the next person does not think it was missed.

**And its dual, which my first draft omitted — the inverse of the residual above.** Below the floor,
a *genuine* per-group extraction failure is now **permanently silent**: a client project that
resumes and pushes 10 content-rich episodes a week to `aios_external`, with graphiti rejecting that
group, reads `small-sample` forever — no amber card, no clock — because that group never reaches 25
episodes in a window. Detection of the failures that matter (a graphiti rename, a global stall) rides
entirely on the **busy** group, which does trip: after ≤7 days of stall `aios_team`'s `recentNames`
decays to 0 with thousands of recent episodes. So A2's "the real detection is not lost" is true **for
busy groups only**, and must not be read as "detection preserved, period". The surviving surface for a
quiet group is the observational `entitiesPerEpisode` number on the card. Recorded because I wrote one
half of this residual and not the other, which is the exact failure that let a leak through the
packing spec's criteria two days ago.

**The alarm stays unarmed.** `CENSUS_ALARM_ARMED` is still `false` and this change does not touch it —
arming remains rollout step 3, after `CENSUS_MARGIN` / `CENSUS_ABSOLUTE_FLOOR` are set from measured
prod data. This fix is about a *refusal*, which computes regardless of arming.

---

## 3. Acceptance

| # | Criterion | Tier | Falsifier |
|---|---|---|---|
| A1 | Zero names with **1** recent episode ⇒ `small-sample`, `judgeable: false`, **no accusation** | unit | any `predicate-suspect` below the floor |
| A2 | Zero names with a **literal 25** recent episodes ⇒ `predicate-suspect` — the real detection is not lost **for a busy group** | unit | a genuinely stalled busy group reading `small-sample` |
| A3 | The boundary is exact **at the exported constant**: `FLOOR−1` ⇒ `small-sample`, `FLOOR` ⇒ `predicate-suspect` | unit | an off-by-one at the threshold |
| A4 | `recentEpisodes: null` (unreadable ledger) still ⇒ `small-sample`, never an accusation | unit | any accusation from a null ledger |
| A5 | **The page cannot fire from a below-floor group alone**, tested through the REAL chain: `deriveNameCollisionPollution` → `refusalRunsClock(refusal, …)` → `classifyBlindnessTick`. With `aios_team` at `small-sample` and `aios_external` below the floor, the tick is `"parked"`, not `"running"` | unit | `"running"` — §0.2's latent bug surviving the fix |
| A6 | Prod's exact measured state reproduces: 1 recent episode, 0 names ⇒ `small-sample` | unit | anything else |
| A7 | **Mutation:** restoring `> 0` reddens **A1, A3, A5 and A6** — and not A2 | mutation | a mutation reddening no test, or reddening A2 (which would mean A2 pins the wrong thing) |

**Why A2 uses a literal 25 and A3 uses the constant.** If both read the exported constant, a mutation
raising the floor to 10,000 — which kills detection entirely — leaves the whole suite green. A2's
literal is what makes that mutation fail. A3 legitimately reads the constant, because its job is the
boundary wherever the boundary is.

**A5 must not hand-feed booleans.** `classifyBlindnessTick` takes
`Array<{judgeable, clockRuns}>`, so a test that constructs those literals proves a trivial OR and
nothing about this fix. It has to derive `clockRuns` from the real refusal via `refusalRunsClock` —
the composition `test/extraction-alert.test.ts:340-346` already uses for `graph-unreadable`.
A5 is the only criterion that tests the *consequence* rather than the predicate, and §0.2 is the
reason this fix is worth shipping at all.

### The existing test this fix flips, named rather than discovered

`test/name-collision-pollution.test.ts:104-112` pins `recentEpisodes: 10` ⇒ `predicate-suspect`. It
**must go red** under this change — that is the fix working — and its fixture moves to `≥ 25`. Named
here so the builder does not "resolve" the red by lowering the floor to 10, and does not update it
silently with no criterion covering the change.

`test/name-collision-pollution.test.ts:143-149` (null ledger ⇒ `small-sample`) must stay green
untouched; it is A4's existing pin.

**A third test flipped that neither this spec nor the plan review named** — found by running the full
suite, not by reading: `test/guards/dedupe-predicate-pinned.test.ts:109-121` pins the tripwire at
`recentEpisodes: 12`. So "named rather than discovered" was **incomplete**, and the honest record is
that one of the three was discovered. Its fixture moves to 30, and — because it is a *guard*, whose
job is to make a regression fail the build — it gained the **other side**: the same signals at 1
episode must read `small-sample`. A guard that pins only the firing half can be satisfied by a
regression that drops the floor, which is precisely the failure this whole change is about.

### The contract comment is part of the change

`extraction-health.ts:605-611` currently states: *"episodes projected in the window but zero census
names ⇒ `predicate-suspect`"*. After this fix that sentence is **false as written** and must be
updated in the same commit. A stale contract comment describing behaviour the code no longer has is
the drift class this repo has hit four times in a week — and here it sits directly above the function
it misdescribes.

## 4. Rollout

Pure-function change plus tests. No schema, no migration, no new surface. The card's copy is
unchanged — the point is that the state it renders becomes correct, not that the words change.

**Verification after merge:** the `aios_external` row on the admin card should read as a quiet
small-sample group rather than an orange accusation. That is a one-look check on the same card that
surfaced it, and unlike the last lever it needs no window, no drain, and no spend.
