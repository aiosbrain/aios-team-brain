# Two falsified assumptions in the cost/throughput plumbing

**Status:** revised after plan review — the review killed my evidence for A and my scope for B
· **Date:** 2026-08-05 · **Owner:** Chetan
· **Task:** `COSTTRUTH-1` → [AIO-805](https://linear.app/je4light/issue/AIO-805)

Both items below are stated assumptions that measurement has contradicted. My first draft got the
evidence wrong on one and undersold the fix on the other; what plan review corrected is recorded
first, because the corrections are the load-bearing part.

---

## What plan review corrected

### 1. My throttling evidence was backwards (BLOCKER)

I attributed 1,904 `http_429` rows in `llm_failures` to our own proxy ceiling. **They cannot be
ours.** The proxy returns 429 and exits before recording anything
(`app/api/internal/llm/v1/chat/completions/route.ts:51-53`), and `recordLlmFailure`'s contract
(`lib/costs/llm-usage.ts:126-130`) says in terms: *"NEVER call this for a refusal we raised BEFORE
reaching a provider (rate limit, …)"*. Every `http_429` row is **OpenRouter refusing a call our
limiter already allowed**.

Re-derived from `rate_limits` (the table the reviewer pointed at, which is never pruned), both
throttles are real and independent:

```
bucket 'graph-llm-proxy'   46 overflow windows · peak 426 attempts/min · 4,248 self-rejections
llm_failures http_429      1,904 provider refusals of calls we DID forward
```

And the overlap is the decisive part:

```
window                we attempted   we forwarded   provider 429s
2026-08-01 11:57            417          120              0      ← model: qwen3.6-35b-a3b
2026-08-01 12:31            405          120              0
2026-08-04 10:47            426          120             97      ← model: qwen3.7-plus
2026-08-04 11:42            290          120            106
```

On Aug 1 the provider absorbed a sustained 120/min without a single refusal. On Aug 4, at the *same*
forwarded rate, it refused ~100/min. The variable is the model, not our ceiling.

**So raising the ceiling to 600 — my draft's central proposal — would have made this worse**, pushing
5× the load at an upstream already refusing at 120. The reviewer flagged exactly this and was right.

### 2. `/key` gives time-sliced per-key truth, which I claimed it didn't

My draft said `/key` "does not get us per-day — `/activity` still 403s". False. `GET /api/v1/key`
returns `usage_daily`, `usage_weekly`, and `usage_monthly` alongside `usage`, on the inference key.
Measured this morning against the ledger:

| period | ledger | provider (this key) | gap |
|---|---|---|---|
| **Today (UTC)** | $0.0491 | $0.049143 | **$0.00** |
| August so far | $69.63 | $70.29 | $0.66 (0.9%) |
| Lifetime | $151.49 | $194.40 | $42.91 (22%) |

Today's figures agree **to four decimal places**. That is the first direct proof the meter is
capturing essentially all current spend — and it relocates the entire 22% lifetime gap to frozen
July history (pre-metering + the timeout storm), which can never clear no matter what we build.

This also **closes the question `provider-daily-truth.md` deferred** on 2026-08-03. That doc deferred
per-day reconciliation because it believed a management key was required. It isn't.

---

## A. The graph proxy's rate ceiling — correct the story, not the number

`lib/llm/graph-proxy.ts:232-240` documents the ceiling's rationale:

> Not for Graphiti's benefit — **its extraction is serial at ~10-20s per episode, so it will never
> come close.** … **so it can never be the thing that wedges the graph.**

Both clauses are now false: Graphiti fans out with `semaphore_gather` since #490, the bucket is
shared with embeddings ("one credential, one budget"), and demand peaks at **426/min** against a
120 ceiling — 46 windows where we refused our own extraction.

### Fix (deliberately minimal)

- **Do NOT change the default.** The evidence says upstream is the binding constraint on the current
  model; 120/min is a smoothing rate the provider demonstrably absorbs. Raising it without evidence
  that upstream can take more just converts our free refusals into billed retries.
- **Make it env-tunable** (`GRAPH_PROXY_CALLS_PER_MINUTE` via the existing `resolvePositiveInt`,
  mirroring `GRAPH_PROXY_TIMEOUT_MS`), so a future backlog import (AIO-798) can be admitted
  deliberately without a code deploy, and export `PROXY_CALLS_PER_MINUTE_FOR_TEST` like the timeout
  does.
- **Rewrite the comment** to state what is true: a leak-damage bound; Graphiti is parallel; the
  bucket is shared with embeddings; measured demand peaks at 426/min so the ceiling *does* bind and
  that is currently acceptable because upstream binds first. The stale rationale is why this went a
  week unnoticed.
- **Two distinct signals, honestly labelled.** Self-throttling is `rate_limits.count > limit` for the
  bucket; provider throttling is `llm_failures.failure_reason='http_429'`. They are different
  problems with different fixes, and my draft would have shipped a probe that called the second one
  the first — the cried-wolf failure. v1 adds a read for each to the extraction-health reason string;
  neither may be reported as the other.

### Not in scope

Making the bucket cost-aware (an embedding and a `dedupe_nodes` call cost 2,000× different amounts
and consume the same token). Real, but a redesign of a security control, separately.

---

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
