# Silent fact loss when extraction output hits the token ceiling (EXTRUNC-1)

Status: **proposed — needs a cold read before code** · Owner: chetan
· Tier build-with: unit (parse) + data-mechanics (persistence) + unit guard (single writer)

**Deps:** none. Independent of PIPEFF-3 (which only raises tail exposure modestly by allowing
4,000-char chunks) and of the GRAPHSMALL work (that is cost, this is correctness).

**Increment:** ONE PR = detect + persist + surface. **Retry is explicitly NOT in it** — see
"Why not retry (yet)".

## Problem

An extraction call whose OUTPUT saturates the model's token ceiling returns truncated JSON. Graphiti
cannot parse it, the episode is `202`-accepted, and **its facts are never written**. Nothing records
that this happened. That is the 2026-06/07 blank-arcs class: the graph quietly missing content nobody
can point at.

## Measured, and it corrects the ticket in both directions

Re-derived from `llm_usage` (all graph rows, 45 days) rather than taken from the ticket:

| call_kind | calls | max output | **at ≥16,384** | p99 |
|---|---|---|---|---|
| `extract_edges` | 1,937 | 16,384 | **1** | 3,670 |
| `node_attributes` | 3,432 | 16,384 | **13** | 2,438 |
| (pre-instrumentation) | 68,041 | 20,069 | **495** | 6,719 |
| `dedupe_nodes` / `extract_nodes` / `node_summaries_batch` | — | ≤5,524 | 0 | — |

**The ticket under-counted** (it found 1; there are 14 labelled, and 495 in the pre-instrumentation
period). **And it over-claims currency**: saturations stop dead after **2026-08-05** —

- 07-29 → 08-04: 7 → 137 per day
- 08-05: 1 · **08-06 → today: zero**

**12 clean days is NOT evidence of a fix.** At the measured `extract_edges` rate (1 in 1,937) you would
expect ~0.7 events across the ~1,400 such calls since; observing zero is unsurprising either way. What
*has* structurally gone is `node_attributes` — the 0.13.2 per-entity fan-out that 0.29.3 replaced with
batched summaries, and **13 of the 14 recent saturations**. So the remaining live exposure is
`extract_edges` at ~0.05% of calls ≈ **1–2 episodes per month losing their facts, undetectably**.

That rate is the whole argument for this slice: it is too rare to notice and too silent to measure, so
it will persist indefinitely unless it is instrumented. It is also why the fix is **detection first**.

## Decision

**Persist `finish_reason` on `llm_usage`, and surface saturation.**

**Why `llm_usage` and NOT `llm_failures`:** that table means *"billed, but nothing to price"*
(`lib/costs/llm-usage.ts`), and `meterGraphCall` already files there for un-meterable bodies. A
truncated call **is** billed **and** meterable — it has full `usage`. Filing it as a failure would
double-count the same attempt against `calls` and `failed_attempts` and make the Costs page's
"their dollars are never in these bars" read false. The truncation is a *property of a metered call*,
so it belongs as a column on the metered row.

**Why a column and not a log line:** the entire defect is that this is invisible. A `console.warn`
leaves the rate unknowable and the history unqueryable. One nullable column makes "how often does
extraction truncate, and on which call kind" answerable forever — exactly what `call_kind` itself did
for the cost question (GRAPHCOST-8), which is why that question became answerable at all.

Concretely:
1. `postgres/migrations/` adds `llm_usage.finish_reason text` (+ mirrored into `schema.sql` for
   from-zero). Nullable: most providers set it, none are required to.
2. `meterFromOpenAiResponse` (`lib/llm/cost.ts`) also extracts `choices[0].finish_reason`.
3. `recordLlmUsage` persists it; every existing caller keeps working (optional field).
4. A read that reports saturation — count and share, per `call_kind` — so the number is visible rather
   than merely stored.

## Why not retry (yet)

The ticket proposes "detection-and-retry". Retry is deferred, with reasons, not dropped:

- **The proxy cannot re-drive Graphiti's pipeline.** It sees one completion request. Re-issuing the
  same request is the only retry available to it, and Graphiti has already moved on — the episode's
  fact-writing path is upstream of the proxy and does not get a second chance from here.
- **A re-issue likely reproduces the failure.** 16,384 output tokens from ~625 tokens of content is
  ~26× the input, which is degenerate repetition, not honest density. Re-asking the same model the same
  question is the least likely thing to break the loop — and it doubles the cost of the most expensive
  call class we have.
- **The rate is ~1–2/month and the biggest source is already gone.** Building a retry before knowing
  the post-upgrade rate is building against a number measured on a code path (`node_attributes`) that
  no longer exists.

Detection makes the retry decision *evidence-based instead of assumed*, which is the same order this
codebase used for cost (instrument → measure → then choose the lever).

## Scope

**In:** the column + migration, the parse, the persistence, the surfaced count, and tests.

**Cut:** transparent retry (above); any chunk-size change (the ticket is explicit this is NOT a
chunking fix, and PIPEFF-3 owns chunk sizing); back-filling `finish_reason` for historical rows (it is
unrecoverable — the response bodies were never stored).

## Acceptance criteria

1. **unit** — `meterFromOpenAiResponse` returns `finishReason: "length"` for a truncated body, the real
   value for a normal one, and `null` when the body has no `choices` — without disturbing the cost
   fields it already resolves.
2. **unit** — a body with `usage` but a malformed/absent `choices` array still meters (cost is
   unaffected by the new field), because metering must never regress on a parse detail.
3. **data-mechanics** — `recordLlmUsage` persists `finish_reason`, and a row written WITHOUT one reads
   back `null` rather than `''` — so "unknown" and "the provider said nothing" stay distinguishable.
4. **data-mechanics** — `postgres/schema.sql` loads from zero AND re-loads idempotently with the new
   column, and the migration is additive (`add column if not exists`).
5. **unit** — the saturation read reports count and share per `call_kind`, and returns an explicit
   zero-state (not an empty object) when nothing truncated, so "no truncations" is distinguishable from
   "the query did not run".
6. **unit guard** — `finish_reason` is written only by `lib/costs/llm-usage`, matching the existing
   single-writer discipline for that table.

## What would falsify this

- A truncated response that this parse does NOT flag (e.g. a provider signalling truncation another
  way — Anthropic's `stop_reason: "max_tokens"` differs from OpenAI's `finish_reason: "length"`).
- A metered row that regresses because of the new field — cost accuracy must be untouched.
- `finish_reason` reading `''` for "the provider said nothing", collapsing unknown into a value.
- Saturation continuing at the historical rate with nothing appearing on the surfaced count — the
  detection is wired to nothing.
