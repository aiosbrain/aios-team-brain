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
uuid map alone. Only the bulk path (which the server never calls) persists them. So the alarm's
predicate reads a literal zero forever.

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

Cheap (one Cypher aggregation, no LLM, no ledger join), tier-scoped per group like every graph read,
and it measures the *outcome* the alarm exists for — one thing in the world, several nodes in the
graph — rather than the bookkeeping 0.29.3 stopped emitting.

Variant-name fragmentation is explicitly **out of scope for the alarm**: detecting it needs
identity judgment (which strings co-refer), which is a model call — an alarm that spends LLM money
on a schedule to check whether LLM quality degraded is the design this repo rejected in the
battery's Q7 round. The name-collision census is the mechanical, free signal; entity-yield drift on
the Costs page (calls/episode panel) remains the coarse backstop for the rest.

## The design

### 1. New signal in `extraction-health.ts`: `nameCollisionSignals`

```cypher
MATCH (n:Entity {group_id: $g})
WITH toLower(trim(n.name)) AS name, count(n) AS nodes, max(n.created_at) AS newest
WHERE newest >= datetime($recentSince)          -- names ACTIVE in the recent window
RETURN count(*) AS names,
       count(CASE WHEN nodes > 1 THEN 1 END) AS split
```

Baseline window computed identically over the trailing period (excluding recent), same
relative-margin architecture as the old signal and for the same reason: the healthy split share is
not zero (legitimate homonyms exist — two PRs titled "fix", a person and a project sharing a name),
so only a **rate change against the graph's own baseline** is signal. Constants mirror the old
derivation's roles: minimum-sample refusal, relative margin, absolute floor — initial values derived
from prod measurement **as the first implementation step** (the card ships the numbers before the
alarm judges them; see rollout).

### 2. `deriveDedupePollution` v2 — same contract, new evidence

Keeps the exact output shape (`polluted`, `judgeable`, `reason`) so `extraction-alert.ts`'s edge
state machine and both admin surfaces are consumers of an unchanged interface. The old
`IS_DUPLICATE_OF` predicate and its guard are **retired in the same PR** (`test/guards/
dedupe-predicate-pinned.test.ts` re-pinned to the new census — the guard's job, "the query must
match what the deployed image writes", now means matching what 0.29.3 *does* write: nodes).

### 3. The meta-alarm: unjudgeable-persisting is itself an alert state

New edge in `extraction-alert.ts`: **`judgeable: false` on every tick for
`UNJUDGEABLE_ALERT_HOURS` (default 24h) → one admin email** ("the pollution alarm has been unable to
judge for a day — it is not protecting you"), edge-debounced exactly like ok→polluted, recovery mail
on the first judgeable tick. State rides in the same `GRAPH_HEALTH_SOURCE` transition ledger. This
is the fix for layer 2 and it is **signal-agnostic**: any future evidence removal parks the alarm in
a state that pages instead of a state that hides.

## Rollout

1. Ship the census on the admin card first (numbers visible, alarm not yet judging it) plus the
   meta-alarm. **The meta-alarm fires immediately in prod** — correctly, since the alarm has been
   unjudgeable since #490 — and that first mail is the live validation of layer 2.
2. Measure prod's split-share baseline from the card for a few days.
3. Set the margin/floor constants from those measurements in a follow-up commit (the same
   measured-not-chosen path the original constants took), flipping the alarm to judge.

## How we will know it worked

- The meta-alarm mail arrives once after deploy (the alarm IS currently unjudgeable) and the card
  shows the census with real numbers.
- After step 3, `deriveDedupePollution` returns `judgeable: true` on prod ticks — the alarm is armed
  for the first time since #490.
- The guard suite fails the build if the census Cypher drifts from what 0.29.3 writes, exactly as
  the old guard did for 0.13.2.

## Falsifiers / risks

- **If prod's split share is high at baseline** (candidate misses already common), the relative
  design absorbs it — but it would also mean same-name splinters are accumulating today, which is
  worth knowing on its own; the card makes it visible either way.
- **A group with few active names** gives a noisy share — the minimum-sample refusal (mirroring
  `MIN_EDGES_FOR_DEDUPE_SIGNAL`'s role, in names) refuses rather than judges, and the meta-alarm's
  clock does not run while refusal is for sample size on a *young* group (a cold-start install must
  not get a "your alarm is blind" mail on day one — the unjudgeable clock keys on the
  predicate-suspect and evidence-absent reasons, not the small-sample one).
- **`created_at` semantics:** node `created_at` is extraction time, not content time — same choice
  and same reason as the old signal's `r.created_at` (a backfill must be judged by what the
  extractor just did, not its content's age).
