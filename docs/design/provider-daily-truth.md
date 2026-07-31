# Per-day provider truth (OpenRouter `/activity`)

**Status:** **DEFERRED** after design review — the question this was built to answer needs no code
· **Date:** 2026-07-31 · **Owner:** Chetan

> ## Why this is deferred
>
> The $46 question is answerable **today, in a browser**, at `openrouter.ai/activity` — per day, per
> model, no schema change. And the 30-day window expires ~**2026-08-28** regardless of how long a build
> takes, so shipping a feature to read it could easily miss the data it was built for.
>
> The forward-looking half is already solved: `llm_failures` (#458) records billed-but-unmeterable
> attempts **with feature attribution**, which `/activity` structurally cannot provide (its rows are
> per-day/per-model, not per-call). What a permanent per-day table adds is narrow: an alarm for spend
> that escapes *both* the meter and `llm_failures`.
>
> **Evidence bar for reopening:** the lifetime `/credits` reconciliation already on the Costs page shows
> the gap **growing again** after #458. That would prove a blind spot #458 doesn't cover, and would
> justify the build with data instead of with a hunch.
>
> **The corrected design is below** — it changed materially in review, so if this is reopened, start
> from the corrections, not from the original plan.

## The problem

The Costs page reconciles the ledger against the provider **once, lifetime**: *"OpenRouter has billed
$101.74; this ledger accounts for $55.51."* That is honest but un-sliceable — it cannot say **which day**
or **which model** the missing $46 belongs to, so it can name a total and nothing else.

`llm_failures` (#458) fixed the forward-looking half: from now on a billed-but-unmeterable attempt is
recorded with a feature and a reason. It cannot explain the **existing** $46, because it only records
from the day it shipped.

## What unlocks it

`GET /api/v1/activity` returns, per day and per model:

```json
{ "date": "2026-07-29", "model": "qwen/qwen3.7-max", "provider_name": "Alibaba",
  "requests": 5, "prompt_tokens": 50, "completion_tokens": 125, "reasoning_tokens": 25,
  "usage": 0.015, "byok_usage_inference": 0.012 }
```

Three things matter here beyond the daily split:

- **`usage` is dollars**, so it reconciles directly against `llm_usage.cost_usd`.
- **`reasoning_tokens` is a first-class field.** The chain-of-thought waste that took a live-proxy probe
  to measure was in the provider's own data the whole time.
- **`api_key_hash`** filters to one key, so other spend on the account can't contaminate the comparison.

**It requires a management key.** Verified from the API reference's own error list: `403 — "Only
management keys can perform this operation"`. The inference key cannot read it, and a management key
cannot make completions (they are disjoint by design). Created at
`openrouter.ai/settings/provisioning-keys`.

**30-day window.** `date` filters "a single UTC date in the last 30 days", so the 2026-07-29 storm is
recoverable until roughly 2026-08-28 and then permanently gone.

## Where the key lives

**Admin → Integrations, encrypted at rest like every other key.** Not an env var: a second place a key
lives, invisible to the console, is exactly the failure that killed graph extraction for hours on
2026-07-28 (Graphiti's own `OPENAI_API_KEY`), and this repo spent a week removing it.

**As a nullable `integrations.management_secret_ciphertext` column on the EXISTING `openrouter` row** —
NOT a new integration type. My first draft proposed `openrouter_admin`, and review was right that it
jumped from "not a second row of the same type" straight to "therefore a new type", skipping the option
that dominates both:

- **No CHECK widening**, so the whole incident-#251 hazard below evaporates. `add column if not exists`
  is the benign migration shape.
- **No leak points.** No `INTEGRATION_TYPES` entry, no zod config schema, no connectors-filter exclusion,
  no `GET /api/v1/integrations` surface, no delete-cascade question. The "each is a filter, so each is a
  place someone forgets" problem set becomes empty.
- **It models the domain correctly.** A management key is a second credential *of the same account*, not
  a different integration — and deleting the OpenRouter integration should take it along, which the
  separate type would not do (it would strand a live admin key).
- **It generalizes.** Anthropic has admin keys too; a generic management-secret column serves every
  provider with no further CHECK widenings, where `openrouter_admin` starts a `*_admin` type family that
  repeats this whole exercise each time.

A dedicated typed reader (`getManagementKey`) rather than widening `ProviderIntegrationType` — that
narrow union is itself what keeps the key away from every answering/embedding resolver.

### Why a second row of the same type is still ruled out

 `getProviderSettings` resolves a provider key with

```ts
.eq("type", type).eq("status", "enabled").limit(1).maybeSingle()   // no ORDER BY
```

so a second row of the same type is picked **nondeterministically**. Since a management key cannot call
completions, roughly half of all inference — answering, extraction, embeddings — would authenticate with
a key that physically cannot serve it. Intermittent, total, and indistinguishable from a provider outage.

### The migration hazard the column design avoids (recorded because my plan for it was WRONG twice over)

Had this gone the new-type route, it would widen `integrations_type_check` — the constraint behind
incident #251. My original prescription was wrong in both shape and scope, and it is worth writing down:

- **Shape:** I wrote "a conname-guarded DO block". That block adds the constraint *only when the name is
  absent* — so on any existing database the narrow constraint is already there, the widening is
  **skipped entirely**, and the first insert of the new type fails at runtime. The proven pattern is two
  plain idempotent statements: `drop constraint if exists` then `add constraint`.
- **Scope:** I wrote "the migration", singular. **Four** existing migrations re-add this constraint
  (`20260624120000`, `20260710140000`, `20260711160000`, `20260725160000`) and `pg:schema` replays all of
  them on every deploy with no applied-tracking. Widening only a new one means the next deploy replays an
  older, narrower re-add against a row that now violates it — byte-for-byte the #251 failure.
- I also proposed guard discipline the repo **already automates**:
  `test/guards/integrations-type-check-replay.test.ts` and `test/guards/enum-check-replay.test.ts` pin
  every definition of the set against `schema.sql`. They would have caught my plan in CI.

### Three places the new type must NOT leak

1. **`PROVIDER_INTEGRATION_TYPES`** — that set means "an LLM provider key the answer path may resolve".
   A management key is not one. Adding it there would make it selectable as an answering backend.
2. **The connectors list** in `components/admin/integrations-manager.tsx`, which renders every
   integration that isn't github/openrouter/a provider type. Left alone, the management key would appear
   as a knowledge **source** to sync.
3. **The embeddings/answering pickers**, for the same reason as (1).

Each is a filter, so each is a place someone forgets. A guard asserts the type is absent from the
provider sets.

## The read

`getProviderDailyUsage(db, teamId)` in `lib/costs/provider-usage.ts` — beside the existing `/credits`
call, same best-effort contract (a provider outage degrades to "no per-day view", never a broken page),
same 10-minute cache, same 4s timeout. Parsing is a pure function so the shape is pinned without a
network call, mirroring `parseCreditsBody`.

**READ-ONLY, and this is a security statement, not a style note.** A management key can create and delete
API keys on the account — a materially larger blast radius than an inference key. This code path issues
exactly one request, `GET /activity`, and a guard fails the build if the management key is ever passed
to a different URL.

## The surface

A per-day table under the existing lifetime banner, shown only when a management key is configured:

| Day | Provider billed | Ledger attributed | Unattributed |
|---|---|---|---|

Reusing `reconcileLedger`'s existing semantics per row (clamped at zero, `ledger-exceeds` as its own
state, materiality on both a fraction and an absolute).

**Both numbers must be built from the same window and the same provider**, or the comparison invents a
gap. The ledger side filters `provider='openrouter'` (as `getLedgerLifetimeUsd` already does) and buckets
by UTC date to match `activity`'s `date`, which is UTC.

## Risks

| Risk | Mitigation |
|---|---|
| The `date` parameter is documented as a single-date filter; whether omitting it returns the full 30 days is **unverified** | Parse defensively and treat a single-day response as a single day. Verify against the live API the moment a key exists, before trusting the table. |
| Timezone skew between `activity`'s UTC `date` and ledger bucketing | Bucket the ledger in UTC explicitly, not in server-local time |
| A rotated inference key makes ledger and provider disagree by construction | `api_key_hash` filtering, if the current key's hash is derivable; otherwise state the caveat |
| The key leaks | Encrypted at rest (AES-256-GCM under `SECRETS_KEY`), never returned to the client, read-only usage, guarded |

## Out of scope

- Backfilling `llm_usage` from `/activity`. The provider's rows are per-day/per-model, not per-call, so
  they cannot be attributed to a **feature** — which is what the ledger is for. Mixing them would make
  `source` slices lie.
- Any write operation with the management key.

## How we will know it worked

The 2026-07-29 storm gets a line: provider $X on `qwen/qwen3.7-max`, ledger $48.24, remainder named. If
the remainder concentrates on that one day, the timeout diagnosis is confirmed from the provider's own
books rather than from my inference.
