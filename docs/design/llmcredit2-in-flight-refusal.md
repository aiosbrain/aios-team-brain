# An in-flight budget refusal is transient — retry it — LLMCREDIT-2

**Status:** spec, written during the same live degradation as LLMCREDIT-1 (2026-08-25). ⚠️ **The
multi-round adversarial spec review is deliberately SKIPPED** — incident follow-up, measured terrain,
one predicate plus a bounded retry. The Fable diff review is NOT skipped.

**Build with:** opus / high — it changes the shared completion primitive and it makes the brain retry
against a paid API.

**Deps:** LLMCREDIT-1 (merged, deployed 20:38 UTC) — this reuses the refusal-classification seam it
added.

---

## What and why

LLMCREDIT-1 restored timeline summaries by stepping the token ladder down on a **size**-shaped 402.
It worked — and revealed a SECOND 402 underneath it, with a different cause and a different remedy.

**Measured on prod after that deploy** (`llm_usage` / `llm_failures`, since 20:38 UTC):

| | |
|---|---:|
| `timeline-summary` **succeeded** | **13** |
| `timeline-summary` **failed** | 43 |
| `arcs` failed | 5 |
| successful summary input tokens | 339 – 2,288 (avg 1,499) |
| when the 43 failures happened | **41 in a single minute**, 23:14–23:15 |

**The operator-visible banner now names the new refusal:**

> `402 … "This request would exceed your available credits given your current in-flight requests.
> Retry after in-flight requests settle, or add credits." … "reason":"in_flight_budget_exhausted",
> "limit_source":"openrouter_in_flight_budget", "remedy_hint":"Retry after your in-flight requests
> settle (see the Retry-After header)."`

### It is NOT the size refusal, and the difference is the whole slice

| | size refusal (LLMCREDIT-1) | in-flight refusal (this) |
|---|---|---|
| `reason` | `openrouter_credits` | **`in_flight_budget_exhausted`** |
| what is too big | this request's `max_tokens` + prompt | the SUM of requests in flight right now |
| provider's remedy | *"lower max_tokens / prompt size"* | ***"Retry after your in-flight requests settle"*** |
| our behaviour today | steps down the ladder ✅ | **throws immediately** ❌ |

`looksLikeBudgetRefusal` correctly does not match it (no size language), so it falls through to the
generic non-2xx path and the task is discarded. **The provider is telling us to retry and we do not.**

### Why this is what the user is seeing

Timeline summaries fan out at `CONCURRENCY = 6` (`lib/dashboard/timeline-summary.ts:53`), so six
requests are in flight at once. Against a small balance, OpenRouter reserves credit per in-flight
request and refuses the ones that do not fit — so within a single rebuild burst some person-days get
prose and some do not, **independently of how big they are.**

⚠️ **THE MEASUREMENT CORRECTED MY FIRST HYPOTHESIS, which was that the big days were failing.** I
reconstructed the ACTUAL prompt for all 14 person-days from `work_timeline_cache`, using the real
`summaryPromptFor` shape (per-source `itemCap = 8`), and compared it against whether that day got
prose — sorted by prompt size:

| summary? | ~tokens | items | tasks | person / day |
|---|---:|---:|---:|---|
| no | **2,404** | 16 | 7 | Chetan / Fri Aug 21 |
| **YES** | **2,006** | 9 | 4 | Chetan / Today |
| no | 1,751 | 8 | 4 | Chetan / Wed Aug 19 |
| **YES** | 1,579 | **45** | **17** | John Ellison / Fri Aug 21 |
| no | 1,062 | 40 | 8 | John Ellison / Thu Aug 20 |
| no | 524 | 36 | 5 | John Ellison / Wed Aug 19 |
| **YES** | 535 | 28 | 9 | John Ellison / Today |
| no | **63** | 2 | 0 | John Ellison / Tue Aug 18 |
| **YES** | **33** | 2 | 0 | Fatma / Thu Aug 20 |

**A 63-token prompt FAILED while a 2,006-token prompt SUCCEEDED.** The two distributions overlap
almost completely (with: 33–2,006 · without: 63–2,404). Against an affordability of ~3,116 tokens, a
63-token request is affordable under any reading — so **size cannot be the discriminator**, and the
`itemCap` already bounds the tail. That is exactly the shape a per-request in-flight reservation
produces, and it matches the code's own comment that *"some people have prose and some don't is the
common outcome of a flaky or rate-limited provider"* (`timeline-summary.ts:149-150`).

⚠️ **AND THE REVIEW NARROWED WHICH EVIDENCE ACTUALLY CARRIES THIS.** The burst timing is weak on its
own — a rebuild that runs in one minute puts all its failures in one minute under ANY cause — and so
is the item-count inversion at n=14, since item count is a poor proxy for tokens. What carries it is
(a) the table above, where the smallest prompt in the whole set failed; (b) the provider CLASSIFYING
ITS OWN refusal as `in_flight_budget_exhausted`, which is not statistics; and (c) the fact that these
43 failures happened AFTER LLMCREDIT-1 shipped — a size-shaped 402 now steps down to the 200-token
rung, so a size refusal can no longer kill a summary, and 43 died anyway.

## 1. The rule

> **A 402 that says "retry after the in-flight requests settle" is a THROTTLE, not a verdict. Wait and
> retry the same request, bounded — never discard the work on the provider's own advice to retry.**

## 2. The design

### 2a. `looksLikeInFlightRefusal`, the third member of the family

Beside `looksLikeTokenLimit` and `looksLikeBudgetRefusal` in `lib/query/claude.ts`. Matched on the
provider's own words — `in_flight_budget_exhausted`, `in-flight requests settle`, `in_flight_budget` —
at status 402 only.

The three predicates are DISJOINT by construction and a criterion asserts it: a size refusal must not
be retried-in-place (it will just be refused again), and an in-flight refusal must not be stepped down
(a smaller request does not help when the problem is the other five in flight).

### 2b. A bounded wait-and-retry, honouring `Retry-After`

In `lib/llm/complete.ts`, before the size ladder: on an in-flight refusal, sleep and re-send the SAME
rung. `Retry-After` when the header is present and sane, else exponential backoff.

⚠️ **JITTER APPLIES TO THE HEADER PATH TOO, and the first draft got this exactly backwards.** It
jittered only the FALLBACK branch — i.e. never in production, because the provider's own `remedy_hint`
says *"see the Retry-After header"*, so all six refused siblings receive the SAME value, sleep the same
2,000 ms, and are released in the same instant, reproducing the collision that refused them. The
review caught it, and caught that the criterion PINNED the bug (`expect(...).toBe(2000)`). RFC 9110
makes `Retry-After` a MINIMUM, so the spread goes upward from it, still clamped.

Bounded at **2 extra attempts per rung** — so up to +4 requests for a two-rung call, or +6 for a
three-rung reasoning-role call. ⚠️ *An earlier draft said "2 extra attempts" without "per rung".*

⚠️ **AND `timeoutMs` DOES NOT BOUND THE WHOLE CALL — I claimed it did, in three places.**
`AbortSignal.timeout` is constructed inside each request, so every attempt gets a fresh budget and the
wall clock is their SUM (worst case ~152 s for a summary against ~40 s before). Rather than just
correcting the sentence, the ADDED waiting is now bounded for real: `postRung` computes the wait and
refuses to start it when `elapsed + wait` would exceed the caller's `timeoutMs`. The per-attempt
timeouts are pre-existing and unchanged.

### 2c. The two 402s stop being indistinguishable in the ledger

`llm_failures.failure_reason` records `http_402` for both flavours today, so nothing in the database
could have told these two apart — the only reason this was diagnosable at all is that a human pasted
the banner text. The in-flight flavour files `http_402_in_flight`.

⚠️ **INCLUDING THE TERMINAL ROW.** The first draft filed the flavour only on the RETRY rows, leaving
the row that describes the failure which actually KILLED the task as a plain `http_402` —
indistinguishable from a dead account, and the one row an operator reads first. The reason now rides
on `LlmHttpError`, because the throw site is the only place still holding the provider's body.

`failure_reason` is `text` with no CHECK, and the one consumer
(`lib/metrics/llm-costs.getLlmCostBreakdown`) groups by `source` and never by reason, so widening the
vocabulary is safe — stated because "no consumer switches on this" is the kind of claim that must be
checked rather than assumed.

## 2d. Tier safety

**No tier surface changes.** This slice touches the transport primitive and the failure ledger only —
no route, no read path, no new data reaches a member. `llm_failures` is already role-scoped exactly
like spend (admin sees team-wide; background work carries `member_id = null`, so a non-admin sees
effectively none), and this adds a value to an existing `failure_reason` column rather than a column,
a table, or a reader. The retry sends the SAME prompt to the SAME backend the team already resolved
through `selectLlmBackend`, so no content crosses a tier boundary that it did not already cross.
Default-deny is unaffected: nothing here grants a read.

## 3. Scope

**In:** `lib/query/claude.ts` (the predicate) · `lib/llm/complete.ts` (the retry + the ledger reason) ·
unit criteria.

**Out:**
- **The streaming Q&A path.** Its retry seam is a single non-2xx branch with no delay primitive, and
  the Query box is interactive — a user watching a spinner is a different product decision from a
  background rebuild. Named, not silently skipped.
- **Lowering `CONCURRENCY`.** It would reduce collisions and it is a one-constant change, but it slows
  every healthy rebuild to fix a condition that only exists on a depleted balance. The retry is the
  targeted answer; if it proves insufficient, the constant is the next lever.
- **Graph extraction** (the sidecar's own requests) and **arcs' 4,096-token floor** — both still need
  credit, per LLMCREDIT-1 §5a.
- **Topping up.** Still the durable fix, and still the operator's.

## 4. Acceptance

- **AC1 — the real in-flight body is recognised (unit):** `looksLikeInFlightRefusal(402, body)` is
  true for the production body and for each of its three phrasings on its own.
- **AC2 — the three predicates are DISJOINT (unit):** the in-flight body is not a size refusal, the
  size body is not an in-flight refusal, and neither is a token-limit refusal. *Overlap here would
  mean retrying what should step down, or stepping down what should wait.*
- **AC3 — an in-flight refusal is retried at the SAME rung and succeeds (unit):** first call 402s,
  second returns text; the caller gets the text and both requests carried the same `max_tokens`.
  *Same rung, because a smaller request does not help when the problem is the other five in flight.*
- **AC4 — the retry is BOUNDED (unit):** a provider that refuses every time throws rather than
  looping, after exactly the configured number of attempts.
- **AC5 — `Retry-After` is honoured when present and sane (unit):** the wait matches the header; an
  absent, negative, or absurd header falls back to the jittered default. *An unbounded header value
  would let a provider stall a rebuild for as long as it likes.*
- **AC6 — the flavours are distinguishable in the ledger (unit):** an in-flight refusal files
  `http_402_in_flight`; a size refusal still files `http_402`.
- **AC7 — a size refusal is NOT retried in place (unit):** it steps down the ladder exactly as
  LLMCREDIT-1 shipped, and the LLMCREDIT-1 criteria pass UNMODIFIED.

| # | mutation | must redden |
|---|---|---|
| 1 | the in-flight predicate returns true for any 402 | AC2 |
| 2 | the in-flight refusal is thrown instead of retried | AC3 |
| 3 | the retry re-sends a SMALLER rung | AC3's same-rung assertion |
| 4 | the retry bound is removed (loop forever) | AC4 |
| 5 | `Retry-After` is ignored | AC5 |
| 6 | an absurd `Retry-After` is honoured verbatim | AC5's clamp |
| 7 | the in-flight refusal files plain `http_402` | AC6 |
| 8 | a size refusal is retried in place instead of stepped down | AC7 |

## 5. Risks

| risk | direction | mitigation |
|---|---|---|
| Retrying spends money that a refusal did not | money | a refused request generates nothing and is not billed; the retry is bounded at 2 and clamped by `timeoutMs` |
| Six siblings retry in lockstep and re-collide | the bug, again | jitter is part of the design, not an implementation detail — AC5 |
| A provider stalls a rebuild via `Retry-After` | latency | the header is clamped, and the caller's timeout still governs |
| The credit problem becomes invisible because service resumes | SILENT degrade | every refusal is still filed, now with a reason that says which kind |
| It masks a genuine outage as a slow success | diagnosability | the retry is only for the ONE reason the provider marks retryable |

## 6. What this still does NOT fix

**The account is out of credit.** This makes the brain survive a small balance; it does not create one.
Arcs (4,096-token floor), graph extraction (the sidecar's own budget) and task suggestions stay red
until the account is topped up — and the Pulse banner will keep saying so, correctly.
