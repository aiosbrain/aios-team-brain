# A provider refusing our HEADROOM must not kill the task — LLMCREDIT-1

**Status:** spec, written during a live degradation on prod (2026-08-25). ⚠️ **The multi-round
adversarial spec review is deliberately SKIPPED** — this is an incident fix whose terrain is measured
and whose change is one predicate. The Fable diff review is NOT skipped.

**Build with:** opus / high — it changes the single primitive every non-streaming generation task in
the brain goes through, and the failure direction is "spend money differently".

**Deps:** none.

---

## What and why

**Reported:** the Pulse page is showing two red banners, and per-person **summaries have disappeared
from the timeline**.

**Measured on prod, read-only, 2026-08-25 19:20 UTC** (`llm_failures`, last 3 days):

| source | model | reason | count | latest |
|---|---|---|---:|---|
| `graph` | `qwen/qwen3.7-plus` | **`http_402`** | 185 | 19:17 |
| `timeline-summary` | `qwen/qwen3.7-max` | **`http_402`** | 36 | 18:55 |
| `arcs` | `qwen/qwen3.7-plus` | **`http_402`** | 2 | 18:55 |

And `llm_usage` over the last 24h contains **exactly one** successful source: `embeddings`
(62 calls, $0.0122). Every generation call is failing.

The provider's own body says what is wrong:

> `402 {"error":{"message":"This request requires more credits, or fewer max_tokens. You requested up
> to 6900 tokens, but can only afford 3116. … "remedy_hint":"Add credits …, or lower max_tokens /
> prompt size to fit your remaining balance."`

**So the account is nearly out of credit — and that is not a code defect.** What IS a code defect is
what happens next.

### The defect: we ask for headroom we don't need, and treat the refusal as fatal

`completeText` sends a LADDER of `max_tokens` values (`lib/llm/complete.ts`), because a reasoning
model spends hidden tokens before the answer:

| task | its real budget | top rung actually sent |
|---|---:|---:|
| `timeline-summary` | **200** | 200 + 6000 = **6200** |
| `doc_task_infer` | **900** | 900 + 6000 = **6900** |

The provider can afford **3116**. So the top rung is refused — and the ladder does **not** step down,
because `looksLikeTokenLimit` only matches **400/422** (`lib/query/claude.ts:40-45`). A 402 throws
immediately.

**The bottom rungs — 200 and 900 — are both comfortably affordable.** A timeline summary needs 200
tokens; we are failing it while asking for 6200. The headroom is insurance for a reasoning model, and
reasoning is explicitly DISABLED on OpenRouter unless a distinct reasoning model is configured
(`lib/llm/complete.ts`, the `reasoning: { enabled: false }` branch) — so on this fleet the headroom buys
nothing and costs the entire task.

The provider is telling us the remedy in the response body: *"or lower max_tokens / prompt size to fit
your remaining balance"*. The ladder exists for exactly this and does not fire.

## 1. The rule

> **A non-2xx whose body says the request was refused for SIZE — whatever the status — is a
> token-limit refusal, and the ladder steps down. A budget-shaped 402 is refused headroom, not a dead
> account.**

## 2. The design

### 2a. `looksLikeBudgetRefusal`, beside the sibling that owns this vocabulary

`lib/query/claude.ts` already owns `looksLikeTokenLimit`. The new predicate lives beside it, and both
the streaming path (`lib/query/claude.ts`) and the single-shot primitive (`lib/llm/complete.ts`) treat
either as "retry smaller".

Matched on the provider's own words — `fewer max_tokens`, `can only afford`, `lower max_tokens`, `to
fit your remaining balance` — and **only** at status 402, so a 402 that is genuinely "this account is
dead" (no size language) still fails fast rather than being retried twice for nothing.

### 2b. The step-down is recorded, because a silent recovery is the worse bug

⚠️ **If it just worked, nobody would learn the account is nearly empty** — and this repo has been
bitten by exactly that ("a provider key's quota exhaustion degrades whatever model class points at
it", now loud on the health card). So a budget refusal files an `llm_failures` row **even when the
retry succeeds**, which is the ledger whose entire job is provider refusals and which already surfaces
as `failed_attempts` in the cost breakdown (`lib/metrics/llm-costs.ts:52-59`).

It is filed as the refusal it was (`http_402`), and it does NOT mark the pass or the leg failed —
because the task did succeed, and claiming otherwise would redden a banner about work that got done.

### 2c. `doc_task_infer` stops saying "model returned null"

`lib/dashboard/doc-task-infer-run.ts:336` records `"model returned null for every worker"` when every
worker's `completeTextOrNull` came back null. That sentence sends an operator to look for a model bug;
today the true answer was "the provider refused on credits". The leg carries the last provider failure
reason when it has one.

## 3. Scope

**In:** `lib/query/claude.ts` (the predicate + the streaming retry) · `lib/llm/complete.ts` (the
ladder + the refusal record) · `lib/dashboard/doc-task-infer-run.ts` (the message) · unit criteria.

**Out:**
- **The graph-extraction stoppage.** Its 185 refusals come from the **graphiti sidecar's own**
  requests, which the brain only proxies (`app/api/internal/llm/v1/chat/completions` →
  `lib/llm/graph-proxy`, a pass-through that forwards the caller's `max_tokens`). This slice cannot
  reach them, and clamping another service's extraction budget is a different decision. **Graph
  extraction needs credits.**
- **Topping up, or repointing the answering model.** The durable fix, and the operator's.
- **The token budgets themselves** (200 / 900 are already right-sized).
- **An in-stream budget refusal** — HTTP 200 with `data:{"error":…}` routes through
  `classifyErrorFrame` (`lib/query/stream-retry.ts`) as a 400 and never reaches this ladder.
  Pre-existing, found by the diff review, not widened into an incident fix.

⚠️ **WHAT THIS DOES NOT RESTORE, at the measured balance.** The affordable ceiling was **3,116
tokens**, and the ladder's bottom rung is the task's own answer budget — so only tasks whose budget is
UNDER that recover:

| task | bottom rung | recovers at 3,116? |
|---|---:|---|
| `timeline-summary` | 200 | ✅ — this is the missing-summaries report |
| `doc_task_infer` | 900 | ✅ |
| `arcs` | 4,096 | ❌ still refused |
| streaming Q&A (`ANSWER_BUDGET`) | 4,096 | ❌ still refused |
| graph extraction | the sidecar's own | ❌ out of reach entirely |

**So the Pulse banner will still be red after this ships**, and that is correct rather than a failed
fix: the account is out of credit and two of its legs cannot be served on what remains.

## 4. Acceptance

- **AC1 — a budget-shaped 402 is a token-limit refusal (unit):** `looksLikeBudgetRefusal(402, body)`
  is true for the four provider phrasings, using the REAL body captured from prod.
- **AC2 — a 402 with no size language is NOT retried (unit):** an "account suspended" style 402
  returns false, so it fails fast instead of being re-sent twice.
- **AC3 — a non-402 status with size language is not claimed by this predicate (unit):** 400/422 stay
  `looksLikeTokenLimit`'s business; the two predicates do not overlap.
- **AC4 — the ladder steps DOWN on a budget refusal and returns the model's text (unit):** a stubbed
  transport that 402s on 6200 and succeeds on 200 yields the completion, not a throw.
- **AC5 — and the refusal is FILED even though the call succeeded (unit):** one `llm_failures` row,
  `http_402`, with the metered source — while the caller still gets its text.
- **AC6 — a 402 at EVERY rung still throws (unit):** the account really being empty must not be
  silently swallowed into `null`.
- **AC7 — `doc_task_infer` reports the provider reason (unit):** when the last failure was a 402, the
  leg's error names it instead of "model returned null for every worker".

| # | mutation | must redden |
|---|---|---|
| 1 | `looksLikeBudgetRefusal` returns true for any 402 | AC2 |
| 2 | the predicate also accepts 400 | AC3 |
| 3 | the ladder throws on a budget refusal instead of stepping down | AC4 |
| 4 | the step-down succeeds but files no refusal row | **AC5** |
| 5 | a final-rung 402 is swallowed to `null` | AC6 |
| 6 | the leg keeps its hardcoded "model returned null" string | AC7 |

## 5. Risks

| risk | direction | mitigation |
|---|---|---|
| The credit problem becomes invisible because service resumes | SILENT degrade — the failure mode this repo names by name | §2b: the refusal is filed every time, and shows as `failed_attempts` |
| Retrying burns the remaining balance faster | money | a refused request generates nothing and is not billed; the retry is the ladder that already exists |
| A reasoning model loses its hidden-token headroom and returns empty | quality **and money** | ⚠️ **NOT MITIGATED — the review corrected me here.** I wrote "reasoning is off on OpenRouter unless a distinct reasoning model is set", which is exactly FALSE for the one configuration where this risk exists: with `teams.reasoning_model` set to a distinct model, `reasoning:{enabled:false}` is NOT sent, so the step-down lands on the bare answer budget with reasoning ON, hidden thinking eats it, and the empty completion is METERED — turning a $0 refusal into a paid nothing, every cron cycle. Accepted because the identical trade already exists on the 400/422 rung and no team on this fleet has a distinct reasoning model set — but accepted knowingly, not mitigated. (`LLM_DISABLE_REASONING=0` is a second way to reach it.) |
| A genuinely dead account is retried three times | noise | AC2 — only SIZE-shaped 402s step down |

## 6. What this does NOT fix

**Graph extraction, and the account itself.** With a depleted balance even a 200-token request
eventually fails; this buys graceful degradation, not credit. The banner on Pulse is telling the truth
and will keep telling it until the account is topped up.
