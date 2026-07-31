# Line-item the calls that failed

**Status:** accepted, revised after design review · **Date:** 2026-07-30 · **Owner:** Chetan

## The problem

The costs page says: *"OpenRouter has billed $101.74 on this key; this ledger accounts for $55.51.
$46.23 (45%) can't be attributed to a feature."* That 45% is honest but **anonymous** — it names no
feature, no model, no day, and no count. $46 with no attribution is not actionable.

The gap is structural, not a bug in the meter. Three cases:

| Case | Recorded today |
|---|---|
| 2xx carrying `usage` | ✅ always |
| non-2xx carrying `usage` (post-generation refusal, partial) | ✅ since #450 |
| **no readable body at all** — timeout, abort, connection drop | ❌ **impossible** — the provider billed for tokens it generated and there is nothing to read |
| **any body with no `usage` field** | ❌ silently dropped by `meterFromOpenAiResponse` returning null |

The third case is real but is NOT most of the $46 — **corrected 2026-07-31 by reading OpenRouter's own
per-day chart**, which is what the deferred `provider-daily-truth.md` was going to be built to do:

| 2026-07-29 | |
|---|---|
| OpenRouter billed | **$58.70** (`qwen3.7-max` $58.60) |
| Ledger recorded | **$48.24** |
| Unrecorded | **$10.46 — 18%** |

I had inferred "roughly as much again unrecorded ≈ a 50% abort rate". Wrong by a factor of four. The
storm's aborted calls cost ~$10, not ~$46.

**The larger block is 2026-07-28, and it is not failures at all.** Graph metering's first row is
`2026-07-29 03:25 UTC`, but the proxy went live the day before — so 59 episodes were extracted on 07-28
through OpenRouter with **no meter in existence**. The ledger holds $0.05 for that day. That is not a
call that died; it is a call nobody was counting.

Which means: the reconciliation gap is dominated by "metering did not exist yet", a one-time historical
fact that no code can retroactively fix — and both of its causes are now closed (graph metering since
07-29, the timeout since #438). The gap should stop growing. This ledger addresses the genuine but
smaller slice.

**No meter fix closes it** — you cannot read a `usage` block off a connection that died. What we CAN
do is stop losing the *fact* of the call.

## Proposal

Record the ATTEMPT, not only the result. A call that fails is still an event with a **source**, a
**model**, a **provider**, a **timestamp**, and a **reason** — everything except the dollars.

That converts *"$46.23 unattributed"* into *"Graph extraction: 8,958 calls, 4,612 failed (timeout)"*,
which is a sentence you can act on.

### Data — a SIBLING TABLE (reversed in review; the original same-table plan was wrong)

The first draft put an `outcome` column on `llm_usage`. **Design review blocked it, correctly**, and
the reason is the caps every money read already carries:

| Reader | Cap |
|---|---|
| `getLlmCostBreakdown` | `.limit(100_000)` with **no ORDER BY** — past the cap Postgres returns an arbitrary subset |
| Pulse Spend KPI | `.order(created_at desc).limit(50_000)` — newest-first |
| `getLedgerLifetimeUsd` (the reconciliation banner) | 500k, returns null at the cap |

Failures arrive in **retry-amplified storms** — 07-29 produced 8,958 rows in a day, each job retried
three times. Sharing the table would let $0 attempt rows evict real spend rows inside those caps, so
the **Spend KPI would FALL during a paid-failure storm**, and at the lifetime cap the reconciliation
banner would disappear during the exact event it exists to explain. An observability feature that
understates the spend it set out to explain is worse than the gap.

Same-table also needs an `outcome` filter remembered at four read sites forever, with no DB backstop —
the shape of bug CLAUDE.md §2 says to make structurally impossible instead.

```sql
create table if not exists llm_failures (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams(id) on delete cascade,
  member_id uuid references members(id) on delete set null,
  source text not null,
  provider text not null,
  model text not null default '',
  failure_reason text not null,
  duration_ms integer not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists llm_failures_team_time_idx on llm_failures (team_id, created_at desc);
```

Mirrored into `postgres/schema.sql`; the single-writer guard's regex covers both tables.

### The writer

`recordLlmFailure()` beside `recordLlmUsage` in `lib/costs/llm-usage.ts`, which is the table's single
legal writer (`test/guards/single-writer-llm-usage.test.ts`). Same best-effort contract: metering must
never break the call it is metering.

There is **no cost column at all** — see below.

**A billed failure that DOES carry usage stays in `llm_usage`.** Review caught this: a non-2xx with a
`usage` block (metered since #450) is real, priced money and belongs in the money table. Only the
*usage-less* attempts go to the sidecar. The two tables split on "is there anything to price", not on
"did it succeed".

**Deliberately no estimated token count.** We know the request we sent and could divide characters by
four — but that number would land in the same `input_tokens` column the real aggregates sum, so a
guess would silently become a total. The honest output of this feature is *counts and reasons*, not
invented dollars. The banner already carries the authoritative dollar gap.

### The reasons

| `failure_reason` | Meaning |
|---|---|
| `timeout` | our own deadline fired — `AbortError` (manual abort) **or** `TimeoutError` (`AbortSignal.timeout`), which are different names for the same fault; classifying only the first would file our own bug under "network" |
| `network` | the connection failed before a response |
| `http_<status>` | the provider answered non-2xx with no `usage` to record |
| `no_usage` | 2xx, but the body carried no `usage` block (nothing to meter) |


`timeout` vs the rest is the distinction that matters: a timeout is **our** bug (it was, on 07-29),
the others are the provider's.

**`empty_content` is NOT a failure row** (dropped in code review). That call IS priced — the money fix
below records it — so filing it here too would double-count one attempt as both a `call` and a
`failed_attempt`, and make the page's "their dollars are never in these bars" copy false. The two tables
split on *is there anything to price*, and an empty completion has plenty. Why it produced nothing is
already durable in `ingest_runs` via `recordLlmOutcome`.

**A provider non-2xx files `http_<status>`, not `network`** — the status rides on a typed error rather
than only inside the message string. A 402 insufficient-credits filed as "network" sends an operator to
chase infrastructure when the answer is "top up the account": the same misattribution the `timeout`
distinction exists to prevent.

**A call that reached no provider is never filed.** The Anthropic SDK throws at *construction* when no
key resolves, and a malformed base URL throws before any request. Those spend $0, so they stay out of a
ledger whose only job is explaining money.

### A live money leak found while verifying this

`lib/llm/complete.ts` parsed OpenRouter's authoritative `usage.cost` and then threw on empty content
**before** `recordLlmUsage` ever ran. So every reasoning-model starvation (the failure that blanked the
Learning arcs) discarded dollars already in scope, and they landed in the Costs page's "can't be
attributed" remainder. Fixed: meter first, then throw.

**Both branches.** Code review caught that the Anthropic path had the identical shape one level down —
it threw on empty *before* computing its estimate — so fixing only the branch I happened to be reading
would have left the same bug behind, in the code I had just declared fixed.

No migration file: CLAUDE.md §6 — a brand-new table needs none, `create table if not exists` in
`schema.sql` covers it. Verified by loading a from-zero database with the migration deleted.

### Where it is instrumented

The two sanctioned non-streaming transports, which is where essentially all metered spend is:

- `lib/llm/graph-proxy.ts` — `forwardUpstream`'s existing catch (timeout/network) plus the currently
  silent `meterGraphCall` early return (`no_usage` / `http_<status>`). ~99% of spend.
- `lib/llm/complete.ts` — the single catch at the bottom of the retry loop.

**NOT instrumented: `lib/query/claude.ts` (streaming Q&A), `lib/chat/title.ts`, and app-side embeddings
(`lib/query/embeddings.embed` — a fourth metered writer the first draft missed).** Streaming failures
have a different shape and Q&A is $0.16 lifetime. All three are named in the page's help text — a
"failed attempts" figure that silently covers only some callers is the same class of lie as a breakdown
presenting a floor as a total, which is the bug this page just fixed.

**The unit is one ATTEMPT, not one logical call.** Providers bill each attempt, and the SDKs above us
retry — so one extraction that dies three times is three rows, which is the honest unit for a spend gap.
`complete.ts` files once per logical call (its only retry is the token-limit re-ask), so it under-counts
by at most one. Under-counting a gap beats over-counting it. The UI says "attempts" for this reason.

**Pre-flight refusals are never filed** — the route rate limit, the Anthropic-backend refusal, a bad
embedding dimension, a stream request. They never reach a provider and spend nothing, so counting them
would inflate a ledger whose only job is explaining money. The hooks live at the transport, after the
request is on the wire.

### The read path

With the sidecar, the money reads need no change at all — `total_usd`, the Pulse Spend KPI, the
per-slice `estimated` flags and `hasEstimates` are untouched by construction, because failure rows are
not in the table they read. That is the entire argument for two tables.

`getLlmCostBreakdown` gains one extra query against `llm_failures`, scoped by team + window and
role-scoped the same way spend is (a non-admin sees only attempts they initiated, which in practice is
~none — graph and background work carries `member_id = null`; the same admin-only direction the spend
page already has). It reports:

- `failed_attempts` at the top level and `failed_attempts` per source slice;
- `failed_truncated`, set by fetching `cap + 1` rows, so a truncated count renders as **"≥ N"**. A
  storm is exactly when a silent truncation would understate the thing you are looking at.

`calls` deliberately keeps meaning "calls whose spend is in `cost_usd`". Silently growing it would make
every derived reading wrong, and a source that ONLY ever failed still gets a slice — it spent money we
cannot see, which is the point.

### Guards

Per CLAUDE.md §7, one invariant here traces to a real failure and gets a build-failing test:

**A failed row must never move a dollar figure.** A data-mechanics test recording a failure and
asserting `total_usd` and the Pulse Spend KPI are byte-identical before and after, and that
`failed_calls` incremented while `calls` did not. Mutation: making `calls` count all rows must turn it
red.

## What this does NOT do

- It does not recover the missing dollars. Those are unknowable per-call; the provider banner is the
  only source of that truth.
- It does not reduce failures. That was the timeout fix (#438) and the model change — currently
  **0 failures in 139 calls**, so this ledger should stay near-empty. If it doesn't, that is the point.
- It does not give per-day provider truth. That needs an OpenRouter **management** key (the inference
  key 403s on `/activity`); tracked separately.

## How we will know it worked

The next time the gap grows, the failed-call count tells you which feature and why — instead of a
lifetime percentage that names nothing. And on a healthy day the count is zero, which is itself the
signal that the remaining gap is historical.
