# Two falsified assumptions in the cost/throughput plumbing

**Status:** revised after plan review — the review killed my evidence for A and my scope for B
· **Date:** 2026-08-05 · **Owner:** Chetan
· **Task:** `COSTTRUTH-1` → [AIO-805](https://linear.app/je4light/issue/AIO-805)

Both items below are stated assumptions that measurement has contradicted. My first draft got the
evidence wrong on one and undersold the fix on the other; what plan review corrected is recorded
first, because the corrections are the load-bearing part.

---

## What plan review corrected

### 1. My throttling evidence was backwards — and the problem is already fixed (BLOCKER)

I attributed 1,904 `http_429` rows in `llm_failures` to our own proxy ceiling. **They cannot be
ours.** The proxy returns 429 and exits before recording anything
(`app/api/internal/llm/v1/chat/completions/route.ts:51-53`), and `recordLlmFailure`'s contract
(`lib/costs/llm-usage.ts:126-130`) says in terms: *"NEVER call this for a refusal we raised BEFORE
reaching a provider (rate limit, …)"*. Every `http_429` row is **OpenRouter refusing a call our
limiter already allowed**.

Re-derived, both throttles were real and independent — and the reviewer's discriminator queries
settled the cause outright:

```
1,902 of 1,904 provider 429s are on  mistralai/mistral-small-3.2-24b-instruct   (07:08-11:50 Aug 4)
        2                       on  qwen/qwen3.7-plus
our own bucket: 46 overflow windows, peak 426 attempts/min, 4,248 self-rejections
```

`mistral-small` is the cheap SUMMARY model that #488 routes `ModelSize.small` requests to. So the
provider throttling was never about the extraction model or our ceiling: **graphiti 0.13.2's
per-entity summary fan-out generated hundreds of small calls a minute, and OpenRouter rate-limited
that one cheap model at ~100/min.** Our own bucket overflowed for the same reason — the fan-out, not
the corpus.

**#490 (graphiti 0.29.3) removed the fan-out, and that closed both throttles.** Since it deployed
(2026-08-04 12:31 UTC):

```
provider 429s          0
failures of any kind   0
our overflow windows   0
peak attempts/min     76   (was 426; ceiling is 120)
```

So the problem I opened this task for **no longer exists**, fixed by work that shipped yesterday.
This is why the fix below is now three lines instead of a subsystem: building the observability I
first proposed would be a guard for a failure mode that has been structurally removed — ceremony by
CLAUDE.md §7's own test.

### 2. `/key` gives time-sliced per-key truth, which I claimed it didn't

My draft said `/key` "does not get us per-day — `/activity` still 403s". False. `GET /api/v1/key`
returns `usage_daily`, `usage_weekly`, and `usage_monthly` alongside `usage`, on the inference key.
Measured this morning against the ledger:

| period | ledger | provider (this key) | gap |
|---|---|---|---|
| **Today (UTC)** | $0.0491 | $0.049143 | **$0.00** |
| August so far | $69.63 | $70.29 | $0.66 (0.9%) |
| Lifetime | $151.49 | $194.40 | $42.91 (22%) |

Today's figures agree **to four decimal places** — the first direct proof the meter captures
essentially all current spend, relocating the whole 22% lifetime gap to frozen July history.

`usage_monthly` = $70.29 ≈ August-only $69.63 also **rules out a rolling 30-day window**: a rolling
window would include the late-July storm (pre-August ledger alone is ~$82). That is a discriminating
observation, not a suggestive one. UTC-vs-account-local calendar is not separable from this data;
the PR records a before/after-midnight `usage_daily` sample as the falsifiable check.

This **narrows** — does not close — what `provider-daily-truth.md` deferred: it falsifies that doc's
premise that a management key is needed for per-period truth, but gives no per-day *history* and no
per-model attribution, which is what `/activity` is for. That doc's reopening bar is restated
against the monthly gap in the same PR.

## A. The graph proxy's rate ceiling — correct the record, keep the number

`lib/llm/graph-proxy.ts:232-240` documents the ceiling's rationale:

> Not for Graphiti's benefit — **its extraction is serial at ~10-20s per episode, so it will never
> come close.** … **so it can never be the thing that wedges the graph.**

Both clauses were false for the whole fan-out era: demand hit **426/min** against a 120 ceiling and
we refused our own extraction 4,248 times across 46 windows. They are *incidentally* true again
today (peak 76/min) — but for a reason the comment doesn't state, which is exactly how a stale
rationale hides a live problem for a week.

### Fix (three lines, no behaviour change)

- **Default unchanged at 120.** Post-#490 demand peaks at 76/min; there is no evidence to raise it,
  and the historical overflow had a cause that has been removed.
- **Env-tunable** (`GRAPH_PROXY_CALLS_PER_MINUTE` via the existing `resolvePositiveInt`, mirroring
  `GRAPH_PROXY_TIMEOUT_MS`), with `PROXY_CALLS_PER_MINUTE_FOR_TEST` exported like the timeout — so a
  deliberate backlog admission (AIO-798's repo import) needs a variable, not a deploy.
- **Rewrite the comment** to the true history: a leak-damage bound; extraction is *not* serial;
  the bucket is shared with embeddings; it demonstrably bound at 426/min during the 0.13.2 fan-out
  and does not today at 76/min; the diagnosis path is `rate_limits` (ours) vs
  `llm_failures.http_429` (the provider's), which are different problems.

### Explicitly NOT built

The extraction-health signal I first proposed. Both throttles are at zero and the fan-out that
caused them is gone; a probe now would be a guard with no live failure mode. The two queries that
diagnosed this in three minutes are written into the comment instead, which is the cheaper artifact.

## B. Reconcile against this key, per period — not the account, per lifetime

`lib/costs/provider-usage.ts` reads `GET /api/v1/credits` and describes `total_usage` three times as
key-scoped ("on the same key", "cumulative for the key", "this team's key has spent"). It is
**account-wide**: $202.69 account vs $194.36 this key — $8.33 of someone else's key attributed to
our blind spot, uncloseable by any amount of correct metering.

### Fix

- Read `GET /api/v1/key` → `data.usage` (per key), plus `usage_daily` / `usage_monthly`.
- **Surface the MONTHLY reconciliation as the headline**, with lifetime demoted to context. The
  lifetime number is dominated by a frozen July block and can never improve; the monthly number is
  the one an operator can act on, and at 0.9% today it says "the meter is sound" — which the lifetime
  figure's 22% actively obscures. This is the honest version of what #463's banner copy was working
  around in prose.
- **Drop `totalCreditsUsd`.** Verified unrendered: nothing outside `provider-usage.ts` and its test
  reads it. `data.limit` is a per-key spend cap, not credits-purchased, so it is not a substitute —
  and plumbing a new field into a display that doesn't exist is how dead code is born.
- Use `OPENROUTER_BASE_URL` (`lib/query/llm-backend.ts:21`) rather than a second hardcoded URL.
- **The monthly headline needs its OWN copy states.** The existing `reconcileLedger` states were
  written for lifetime magnitudes and reusing them mis-speaks on a monthly window: a
  provider-resets-first boundary skew lands in `ledger-exceeds`, whose copy blames key rotation
  (`page.tsx:196-199`) — false for a month boundary. And the ledger's monthly sum must truncate in
  **UTC** to match the provider's, or the skew is self-inflicted.
- **Raise the materiality floor for the monthly view.** The $1 / 5% thresholds were tuned against
  lifetime totals; in the first days of a month the denominator is small enough that ordinary timing
  skew clears both legs and would render an alarm about nothing.
- **Comment sites to correct** (the reviewer found three my draft missed):
  `provider-usage.ts:13-24`, `lib/metrics/llm-costs.ts:62-64`, `graph-proxy.ts:349-350`,
  `app/t/[team]/costs/page.tsx:64`, and `test/provider-usage.test.ts:7-8`. The page copy at
  `page.tsx:160,203-204` already says "on this key" — **false today, true after this change**, which
  is its own small lesson about copy written ahead of the code.

---

## Guards (CLAUDE.md §7)

Trimmed on review — two of my proposed three were ceremony:

- ~~Assert the comment no longer contains a phrase~~ — **cut.** No guard in this repo pins prose, and
  it defends against re-typing one sentence, a failure with no history.
- ~~`DEFAULT >= 4 × OBSERVED_PEAK`~~ — **cut.** A tautology: I'd write both constants in the same PR
  to make it pass.
- **KEEP — the shape guard that has real history:** a `/credits`-shaped body (`data.total_usage`, no
  `data.usage`) must parse to `null`, never a number. A silent revert to the account endpoint must
  read as "we don't know", not as a plausible wrong figure.
- **Endpoint pin:** the fetched URL is the per-key endpoint; parser fed a **recorded real `/key`
  body**, not a hand-written one.
- **Null contract preserved:** absent / negative / non-finite usage → `null` (existing behaviour).
- **Ceiling tunability:** `PROXY_CALLS_PER_MINUTE_FOR_TEST` pins the default and the env override —
  the repo-idiomatic pattern already used for the timeout, which catches a silent lowering without
  pretending to validate the number.

## Scope: one PR or two?

The reviewer recommended splitting, because A carried a 5× change to a security bound. **A no longer
changes the default**, so that rationale is gone: both items are now comment-and-observability
changes to the same subsystem, with B adding one endpoint swap. One PR, and the revert lever is a
single commit either way.

## How we will know it worked

- The banner shows a monthly gap near zero on a healthy month (0.9% today) instead of a permanent
  22% that no action can move — and a *rising monthly* gap becomes the real alarm.
- Self-throttling and provider-throttling are separately visible, so the next occurrence is diagnosed
  from the card rather than from someone querying `rate_limits` by hand at 8am.

## Risks

- `usage_daily`/`usage_monthly` reset semantics (UTC? account timezone? calendar or rolling?) are not
  documented by OpenRouter. Today's exact match suggests UTC-calendar, and the August figure agrees —
  but the PR must state this as inferred-from-two-observations, and the UI should say "provider's
  month" rather than implying our own boundary. If they diverge, the daily figure is the one to trust
  (it matched to 4dp).
