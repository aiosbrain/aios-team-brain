# Re-arm the dedupe-pollution alarm for graphiti 0.29.3

**Status:** spec, pre-plan-review · **Date:** 2026-08-07 · **Owner:** Chetan
· **Task:** `ALARMFIX-1` → [AIO-822](https://linear.app/je4light/issue/AIO-822)
· **Found by:** the PIPEFF-2 battery (session 1), which read a structural zero on two independent
  fresh graphs and traced it into the wheel.

## The problem — two layers, both real

**Layer 1: the alarm's evidence no longer exists.** The AIO-693 dedupe-pollution alarm judges the
`IS_DUPLICATE_OF` share of recent `RELATES_TO` edges. graphiti_core **0.29.3** — deployed since #490
— **never writes that relation on the server path**: `add_episode` discards the duplicate pairs
(`nodes, uuid_map, _ = await resolve_extracted_nodes(...)`, `graphiti.py:1131`) and merges via the
uuid map alone. In fact **nothing in the 0.29.3 wheel writes the relation at all** — the only
references are read-side and themselves uncalled, and the one function that captures `duplicates`
(`_extract_and_resolve_nodes`, `graphiti.py:604`) has no callers: dead code. The alarm's predicate
reads a literal zero forever.

**Layer 2: the alarm's self-check caught it — and nothing listens to the self-check.** The
zero-predicate guard (`extraction-health.ts:335`) correctly refuses to judge a literal-zero window
(`judgeable: false`) instead of mailing a false "recovered". Designed for a *rename*; caught a
*removal*. But `judgeable: false` is a terminal quiet state: the edge state machine in
`lib/graph/extraction-alert.ts` keys transitions on judgeable ticks, so the alarm has sat silently
disabled since the upgrade and **no surface says so**. An alarm that cannot fire and does not say it
cannot fire is indistinguishable from a healthy quiet one — the exact shape of failure AIO-693
itself was built against.

## What "pollution" can even look like on 0.29.3 — this changes the signal

0.29.3 resolves **exact normalized-name matches deterministically, before any LLM**
(`dedup_helpers.py:220`). Verified consequences, both measured in the battery:

- The July incident's signature — same-name duplicate nodes exploding — is now *mostly* impossible:
  a same-name duplicate can only arise when **embedding candidate retrieval misses** the existing
  node. On a fresh 108-episode graph: **zero** same-name duplicates (684 names / 684 nodes).
- The surviving failure shape is therefore **candidate-retrieval misses accumulating same-name
  splinters** (embedding degradation, index trouble, retrieval cap pressure) and **variant-name
  fragmentation** ("John" beside "John Smith") when dedupe *judgment* degrades.

So the replacement signal cannot be an edge share. It is the graph's own name-collision census:

> **Same-name split share** = of case-normalised `Entity` names in a group whose newest node was
> created in the recent window, the fraction carried by **more than one node**.

Cheap (one Cypher aggregation, no LLM), computed **per group**, and it measures the *outcome* the
alarm exists for — one thing in the world, several nodes in the graph — rather than the bookkeeping
0.29.3 stopped emitting. Name normalisation mirrors the wheel's `_normalize_string_exact` (lowercase,
trim, **and collapse internal whitespace**) — `toLower(trim(...))` alone would undercount splits that
differ by a whitespace run, and the re-pinned guard's job is to match what 0.29.3 actually writes.

**Group scoping, decided:** the census runs per group (an improvement over the old global signal —
the file's own header laments the masking a global read causes), the card shows per-group numbers,
and the ALARM's verdict for a tick is: judgeable if **any** group judged, polluted if **any** judged
group is polluted — **with group memory on the recovery edge**. The alert transition row records the
polluted group id(s) in `meta`, and "recovered" requires **those groups** to be judged-and-healthy;
while any previously-polluted group is unjudged, the combined verdict is UNJUDGEABLE, not healthy.
Without this, a small group that alerted and then dipped under its name minimum while the team group
judged healthy would trigger a "recovered" mail for a group that was never re-judged — the
one-quiet-Saturday false recovery `extraction-alert.ts` documents as a prior review finding,
reintroduced one layer up. Transition state stays one machine (the existing single-row read), keyed
on that combined verdict — per-group state machines are explicitly out of scope here and belong to a
future card iteration if per-group history earns its keep.

Variant-name fragmentation is explicitly **out of scope for the alarm**: detecting it needs
identity judgment (which strings co-refer), which is a model call — an alarm that spends LLM money
on a schedule to check whether LLM quality degraded is the design this repo rejected in the
battery's Q7 round. The name-collision census is the mechanical, free signal; entity-yield drift on
the Costs page (calls/episode panel) remains the coarse backstop for the rest.

## The design

### 1. New signal in `extraction-health.ts`: `nameCollisionSignals`

```cypher
MATCH (n:Entity {group_id: $g})
// Return PER-NAME rows; the TS layer normalises (mirroring the wheel's _normalize_string_exact:
// lowercase, trim, COLLAPSE INTERNAL WHITESPACE) and re-groups before computing the share.
// Normalising after a Cypher-side aggregation is impossible — two raw names that collapse to one
// arrive as pre-aggregated totals that cannot be re-merged — so the aggregation lives on the TS
// side of the normalisation, and the recency filter is applied there too.
RETURN n.name AS name, count(n) AS nodes, max(n.created_at) AS newest
```

Baseline window computed identically over the trailing period (excluding recent), keeping the
relative-margin **architecture** — but with the old signal's zero-semantics **inverted, explicitly,
because a faithful port would brick the alarm the other way**:

- **Zero SPLIT names is a legal, healthy reading.** On 0.29.3, exact-name resolution is
  deterministic and even cross-type same-names are force-merged when retrieval works
  (`_resolve_with_similarity` merges a single same-named candidate regardless of entity type), so the
  battery's measured **0 splits / 684 names** is the expected steady state, not a broken predicate.
  The old rule — `zero dupes over a real sample ⇒ unjudgeable` — must NOT be carried forward; the
  guard's two zero-baseline tests are retired with it, not re-pinned.
- **At a zero baseline the relative margin rejects nothing, so the alarm rides the absolute floor
  alone.** Stated as the judging rule, not left to be discovered: `baselineShare === 0` ⇒ only the
  absolute floor applies. The rollout measures that floor before arming.
- **The "is the query even matching anything" tripwire is REPLACED, not dropped** — a zero-name
  census is indistinguishable from a young group on its own, which would recreate the silent death.
  The new tripwire cross-checks the census against the **Postgres `graph_episodes` ledger**: episodes
  projected for the group inside the window **but zero census names** ⇒ `predicate-suspect` (the
  clock RUNS); no episodes either ⇒ a genuinely young or quiet group (`small-sample` — the clock
  PARKS). "Young group" is thereby defined by the ledger, the one source that knows whether anything
  was pushed. **The `predicate-suspect` signature has two causes and the mail says so:** a graphiti
  bump renaming `Entity`/`created_at` produces it, and so does a **stalled extractor** (episodes
  202-accepted, worker dying on every job, zero new nodes — both 2026-07 prod incidents). The mail
  copy names both candidates and points at the extraction banner and service logs rather than
  diagnosing a rename it cannot distinguish; since the stalled leg is banner-only today, this mail
  may in fact be the only push notification a stall gets, which is a feature so long as the copy is
  honest about what it knows.

Constants: minimum-sample refusal, relative margin, absolute floor — with the census's recent
window a **new constant (`CENSUS_RECENT_MS`), not a reuse of `DEDUPE_RECENT_MS`**: the denominator
counts only names that gained a node in the window, and names arrive far slower than edges, so a
24h window on a mature mostly-merging graph could sit permanently under any minimum. Pre-committed
response if prod measurement shows that: widen `CENSUS_RECENT_MS` until the denominator clears the
minimum, rather than lowering the minimum — **and the trailing baseline window scales with it**
(recent:baseline stays ~1:14), else a widened recent window quietly eats the baseline sample it is
judged against. Initial values derived from prod measurement **as the
first implementation step** (the card ships the numbers before the alarm judges them; see rollout).

### 2. `deriveDedupePollution` v2 — additive contract, new evidence

**The output shape is ADDITIVE, not identical** — the review caught that "exact shape" and a
reason-keyed meta-alarm clock cannot both hold, because today every refusal is
`{judgeable: false, reason: null}` with no machine-readable cause. v2 adds one field:

```ts
refusal: "graph-unreadable" | "graph-unconfigured" | "small-sample" | "no-baseline"
       | "predicate-suspect" | null   // null = judged
```

Named consumers: the meta-alarm clock (below) keys on it; the admin card renders it. `polluted` and
`judgeable` keep their exact semantics so `extraction-alert.ts`'s existing edge machine reads
unchanged. The old
`IS_DUPLICATE_OF` predicate and its guard are **retired in the same PR** (`test/guards/
dedupe-predicate-pinned.test.ts` re-pinned to the new census — the guard's job, "the query must
match what the deployed image writes", now means matching what 0.29.3 *does* write: nodes).

### 3. The meta-alarm: unjudgeable-persisting is itself an alert state

New edge in `extraction-alert.ts`: **no judged tick within `UNJUDGEABLE_ALERT_HOURS` (default 24h),
while at least one refusal in that span was clock-running (see taxonomy) → one admin email**
("the pollution alarm has been unable to judge for a day — it is not protecting you"),
edge-debounced, recovery mail on the first judged tick. The wall-clock formulation — not
"unjudgeable on every tick" — is chosen deliberately so a quiet weekend with no scheduler activity
cannot reset or satisfy the clock.

**Ledger mechanics, specced because the naive version has a named second-order bug:**

- Rows in the `GRAPH_HEALTH_SOURCE` ledger gain `meta.alarm: "pollution" | "blindness"`. The
  prior-state read (`lastGraphHealthFailed`) becomes **per alarm kind** — without the discriminator,
  a blindness row written `ok: false` would make the next healthy pollution tick mail
  "graph extraction recovered" for an alert that never fired.
- **The 24h clock's anchor is persisted, not in-memory**, and blindness rows carry **three
  distinguishable meanings** in `meta.phase`: `anchor` (clock start, written on the first
  clock-running refusal after a judged/unknown state — no mail), `fired` (the mail was sent), and
  `cleared` (first judged tick after an anchor or fired — edge-only, no mail). The mail condition is
  exactly: *an `anchor` ≥ 24h old with no `fired` or `cleared` since it*. One meaning is not enough
  in either direction: without `fired`, every tick past hour 24 re-mails forever; without `cleared`,
  a judged tick that voids the clock leaves a stale anchor behind, and a clock-running refusal weeks
  later fires instantly off it. An in-memory clock resets on every deploy — frequent here — and
  could keep the meta-alarm perpetually below threshold.
- **Legacy rows** (no `meta.alarm`) read as `"pollution"` kind in the per-kind read — prod's ledger
  is empty today, but fixtures and older installs are not guaranteed to be. Anchor rows are written
  `ok: true` (a running clock is not a pipeline failure) so the admin run list does not render red
  for a non-failure; the kind discriminator, not `ok`, is what the reads key on.

**Refusal taxonomy vs the clock:** `predicate-suspect` RUNS the clock. `no-baseline` runs it
**only when the ledger shows the baseline window had episode flow** — a fresh install whose recent
window clears the name minimum before its 14-day baseline fills would otherwise get a "your alarm is
blind" mail at ~week 2 while perfectly healthy; the ledger-defined-young test applies per *window*,
symmetrically with the tripwire. `small-sample` (ledger-confirmed young/quiet group) and
`graph-unconfigured` (no Neo4j — nothing to protect) PARK it. `graph-unreadable` **parks for a
6-hour grace, then RUNS the clock with unreadable-specific mail copy** — the review verified that
"defer to the reachability leg" defers to a pull surface (the admin card render); **no path in this
repo mails on Neo4j being down**, so a permanent park would reproduce the silent-death shape behind
a pager that does not exist. Transient restarts stay quiet inside the grace; a rotted credential
eventually pages, with copy that says what it actually knows.

This is the fix for layer 2 and it is **signal-agnostic**: any future evidence removal parks the
alarm in a state that pages instead of a state that hides.

## Rollout

1. Ship the census on the admin card first (numbers visible, alarm not yet judging it) plus the
   meta-alarm. **The meta-alarm fires within ~24h of deploy** — its anchor row is written on the
   first clock-running refusal after boot, and prod has been unjudgeable since #490 — and that first
   mail is the live validation of layer 2. (Not "immediately": with an empty transition ledger there
   is nothing to anchor an instant verdict on, and the review rightly called the earlier claim
   unimplementable as written.)
2. Measure prod's split-share baseline from the card for a few days.
3. Set the margin/floor constants from those measurements in a follow-up commit (the same
   measured-not-chosen path the original constants took), flipping the alarm to judge.

## How we will know it worked

- The meta-alarm mail arrives once within ~24h of deploy (the alarm IS currently unjudgeable) and
  the card shows the census with real numbers.
- After step 3, `deriveDedupePollution` returns `judgeable: true` on prod ticks — the alarm is armed
  for the first time since #490.
- The guard suite fails the build if the census Cypher drifts from what 0.29.3 writes, exactly as
  the old guard did for 0.13.2.

## Falsifiers / risks

- **If prod's split share is high at baseline** (candidate misses already common), the relative
  design absorbs it — but it would also mean same-name splinters are accumulating today, which is
  worth knowing on its own; the card makes it visible either way.
- **A group with few active names** gives a noisy share — the minimum-sample refusal (a NAME-based
  minimum, its own constant) refuses rather than judges, and per the taxonomy above the clock parks
  on `small-sample` — where "young/quiet" is ledger-confirmed, so a rename that zeroes the census
  cannot hide in this bucket. A cold-start install gets no "your alarm is blind" mail on day one.
- **`created_at` semantics:** node `created_at` is extraction time, not content time — same choice
  and same reason as the old signal's `r.created_at` (a backfill must be judged by what the
  extractor just did, not its content's age).
