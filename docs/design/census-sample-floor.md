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
2. **There is a real latent paging path.** `predicate-suspect` *does* run the blindness clock
   (`extraction-alert.ts:202`). It is currently masked only because `aios_team` clears
   `MIN_NAMES_FOR_CENSUS_SIGNAL = 50`. On a quiet week `aios_team` drops to `small-sample`, which
   **parks** — so the only clock-running refusal left is `aios_external`'s false one, the tick
   becomes `"running"`, and 24 hours later the meta-alarm **mails an accusation of a stalled
   extractor during a week when the real story is "not much happened"**. That is the cry-wolf failure
   arriving by the exact route the meta-alarm was built to prevent, inverted.

So: not urgent, genuinely wrong, and it fires on the quiet week when a spurious page is least welcome.

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

**A new constant rather than reusing `MIN_EPISODES_FOR_EXTRACTION_SIGNAL`.** The two judgements read
different populations (facts vs normalised names) and this file's existing convention is one
documented constant per population — `MIN_NAMES_FOR_CENSUS_SIGNAL` exists separately from the episode
minimum for exactly this reason, and says so. Coupling them would mean a future re-derivation of one
silently moves the other. **Initial value 25**, matching the sibling, with the derivation written
down and marked as inherited rather than measured.

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

**The alarm stays unarmed.** `CENSUS_ALARM_ARMED` is still `false` and this change does not touch it —
arming remains rollout step 3, after `CENSUS_MARGIN` / `CENSUS_ABSOLUTE_FLOOR` are set from measured
prod data. This fix is about a *refusal*, which computes regardless of arming.

---

## 3. Acceptance

| # | Criterion | Tier | Falsifier |
|---|---|---|---|
| A1 | Zero names with **1** recent episode ⇒ `small-sample`, `judgeable: false`, **no accusation** | unit | any `predicate-suspect` below the floor |
| A2 | Zero names with **25** recent episodes ⇒ `predicate-suspect` — the real detection is **not** lost | unit | a genuinely stalled busy group reading `small-sample` |
| A3 | The boundary is exact at the constant: floor−1 ⇒ `small-sample`, floor ⇒ `predicate-suspect` | unit | an off-by-one at the threshold |
| A4 | `recentEpisodes: null` (unreadable ledger) still ⇒ `small-sample`, never an accusation | unit | any accusation from a null ledger |
| A5 | **The quiet-week page cannot fire from a below-floor group alone**: with `aios_team` at `small-sample` and `aios_external` below the floor, `classifyBlindnessTick` returns `"parked"`, not `"running"` | unit | `"running"`, which is the latent bug in §0.2 surviving the fix |
| A6 | Prod's exact current state reproduces: 1 episode, 0 names ⇒ `small-sample` | unit (fixture from the measured values) | anything else |
| A7 | **Mutation:** restoring `> 0` reddens A1, A3, A5 and **nothing else** | mutation | a mutation that reddens no test, or reddens A2 (which would mean A2 pins the wrong thing) |

A5 is the one that matters most — it is the only criterion that tests the *consequence* rather than
the predicate, and §0.2 is the reason this fix is worth shipping at all.

---

## 4. Rollout

Pure-function change plus tests. No schema, no migration, no new surface. The card's copy is
unchanged — the point is that the state it renders becomes correct, not that the words change.

**Verification after merge:** the `aios_external` row on the admin card should read as a quiet
small-sample group rather than an orange accusation. That is a one-look check on the same card that
surfaced it, and unlike the last lever it needs no window, no drain, and no spend.
