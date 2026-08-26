# Say "the provider is out of credit", not 400 characters of its JSON — LLMCREDIT-3

**Status:** spec. ⚠️ **The Codex spec round is deliberately SKIPPED** — this is operator-facing COPY
over an already-measured fault taxonomy, with no schema, money or data-path change. The Fable diff
review is NOT skipped.

**Build with:** opus / high — it is the sentence an operator reads at 2am, and a wrong diagnosis sends
them to the wrong console.

**Deps:** LLMCREDIT-1 and LLMCREDIT-2 (both merged, deployed) — this reuses the refusal predicates they
added.

---

## What and why

**Reported by the operator, verbatim:** *"the error message should be smart enough to tell me that
openrouter needs to be topped up (or whatever model provider we are using) instead of the downstream
errors."*

This is what the Pulse page showed him instead, on 2026-08-26 (both banners, real screenshot):

> **doc_task_infer** — failing since 1d ago: `every worker failed — LLM qwen/qwen3.7-max @
> https://openrouter.ai/api/v1: 402 {"error":{"message":"This request requires more credits, or fewer
> max_tokens. You requested up to 900 tokens, but can only afford 840. To increase, visit
> https://openrouter.ai/settings/credits and add more credits","code":402,"metadata":
> {"limit_source":"openrouter_credits","remedy_hint":"Add credits at …` *(clipped mid-word)*

Every fact needed to say **"OpenRouter is out of credit — add credits"** is in that string. The
operator has to read 400 characters of provider JSON to find it, and it appears **twice** on one page
in slightly different clippings.

**The diagnosis already exists in the codebase — it just never reaches the reader.** LLMCREDIT-1 and
-2 added `looksLikeBudgetRefusal` / `looksLikeInFlightRefusal`, and the ledger already files
`http_402` vs `http_402_in_flight`. What is missing is the one sentence between the classification and
the human.

⚠️ **AND THE SAME BANNER PROVES A WRONG DIAGNOSIS IS WORSE THAN A RAW ONE.** In the same screenshot,
`Learning arcs` failed with `LLM returned empty content (finish_reason=length)` — a **reasoning-model
starvation**, not a credit problem, whose remedy is a different setting on a different page. Any
classifier here must keep those apart or it will send an operator to top up an account that is fine.

## 0. Terrain, measured

### 0a. The fault kinds actually observed on this fleet, with their real bodies

| kind | observed marker | correct remedy |
|---|---|---|
| **out of credit** | `402` + `"limit_source":"openrouter_credits"` / *"requires more credits, or fewer max_tokens"* | top up the provider account |
| **in-flight budget** | `402` + `"reason":"in_flight_budget_exhausted"` | top up (raises the in-flight budget); transient, already retried by LLMCREDIT-2 |
| **reasoning starvation** | 200 OK, `empty content … finish_reason=length` | pick a NON-reasoning answering model |
| **bad/expired key** | `401` / `403` | fix the key in Admin → Integrations |
| **rate limited** | `429` | wait; not a spend problem |

The first three are evidenced by production screenshots and `llm_failures` rows from 2026-08-25/26.
⚠️ *`401`/`403`/`429` are NOT observed on this fleet — they are included because the classifier's job
is to say "I don't know" safely, and having named branches makes the unknown branch honest. They are
marked as unobserved in the code rather than presented as measured.*

### 0b. Where the raw string surfaces today

- `lib/query/llm-health.degradedNote` — appends `` (${errs[0]}) `` verbatim to the generation banner.
- `components/admin/pipeline-health-banner` renders `: {l.error}` from `PipelineLeg.error`, which is
  `firstError(r.errors)` — the leg's own recorded string, clamped at 500 chars by
  `lib/ingest/runs.MAX_ERROR_CHARS`.

Both are the same underlying provider text, reached by two different paths — which is why the fix is
ONE pure classifier consumed twice, not two pieces of copy.

## 1. The rule

> **When a provider failure is recognisable, the operator reads the DIAGNOSIS and the ACTION first.
> The provider's own words stay available underneath, never as the headline — and an unrecognised
> failure still shows its raw text rather than a confident guess.**

## 2. The design

### 2a. One pure classifier: `lib/llm/provider-fault.ts`

```ts
export type ProviderFaultKind = "out_of_credit" | "in_flight_budget" | "reasoning_starved" | "bad_key" | "rate_limited";
export interface ProviderFault { kind: ProviderFaultKind; headline: string; action: string; }
export function diagnoseProviderFault(text: string | null): ProviderFault | null;
```

Pure and total: `null` means "not recognised", which is a real answer and the default. It reuses the
LLMCREDIT-1/-2 predicates rather than re-spelling their regexes, so the vocabulary has one owner.

### 2b. PROVIDER-AGNOSTIC, because the operator asked for that explicitly

*"(or whatever model provider we are using)"*. The provider name is **derived from the failure text's
own base URL** (`openrouter.ai` → OpenRouter, `api.openai.com` → OpenAI, `anthropic.com` → Anthropic),
falling back to **"the model provider"** when it cannot be identified.

⚠️ Deliberately NOT hardcoded to OpenRouter, and deliberately not taken from the team's *configured*
provider: the failure text is the evidence of who actually refused the call, and a fleet can have the
answering model on one provider and embeddings on another. Naming the configured provider when a
different one refused would be a confident lie.

### 2c. Consumed at both surfaces, headline first

- **`degradedNote`** leads with the diagnosis + action instead of appending the raw string; the raw
  text moves to the end, clipped.
- **`PipelineLeg`** gains an optional `diagnosis: { headline, action } | null`, computed in
  `pipeline-health` from the leg's own error, so the banner can render the sentence and keep the raw
  string secondary.

The reasoning-starvation hint that `degradedNote` already carries **moves into the classifier**, so
the two surfaces cannot drift apart on the one fault they both already knew about.

## 2d. Tier safety

No tier surface changes: pure string classification over text these two admin-gated banners already
render. No route, no table, no read path, no new data reaches any member. Both banners are already
admin-area gated and this neither widens nor narrows that.

## 3. Scope

**In:** `lib/llm/provider-fault.ts` (new) · `lib/query/llm-health.ts` (`degradedNote`) ·
`lib/ingest/pipeline-health.ts` (`PipelineLeg.diagnosis`) ·
`components/admin/pipeline-health-banner.tsx` · unit criteria.

**Out:**
- **The underlying failures.** This slice changes what the operator READS, never what happens. A
  topped-up account is still the fix for the credit faults.
- **Any new detection.** Every kind here is already recognisable from text the system already stores.
- **The `llm_failures` vocabulary** — `http_402` / `http_402_in_flight` are unchanged; this is the
  human-facing layer above them.
- **Auto-remediation** (pausing legs, switching models). Naming the remedy is not performing it.

## 4. Acceptance

- **AC1 — the real out-of-credit body yields the credit diagnosis (unit):** the verbatim production
  402 classifies `out_of_credit`, the headline names **OpenRouter**, and the action says to add
  credits. *The body is pasted from the screenshot, not paraphrased.*
- **AC2 — the real in-flight body yields the in-flight diagnosis (unit):** classified
  `in_flight_budget`, distinct from AC1's kind. *Two different reservations, and LLMCREDIT-2 proved
  the remedies differ.*
- **AC3 — reasoning starvation is NOT a credit problem (unit):** `empty content … finish_reason=length`
  classifies `reasoning_starved`, and its action names the answering-model picker, NOT topping up.
  *This is the failure mode that was on screen NEXT TO a credit failure; conflating them sends the
  operator to top up an account that is fine.*
- **AC4 — an unrecognised failure returns `null` (unit):** a timeout, a socket error and an empty
  string all yield `null`, so the surfaces fall back to the raw text instead of a confident guess.
- **AC5 — the provider is DERIVED, never assumed (unit):** an OpenAI base URL in the text yields
  "OpenAI"; an unidentifiable one yields "the model provider". *The operator asked for
  provider-agnostic in as many words.*
- **AC6 — `degradedNote` leads with the diagnosis (unit):** for a credit failure the note's FIRST
  sentence carries the headline and action; the raw provider text no longer opens it. *And the
  existing "Still working: …" clause survives — it is the part that stops a partial outage reading as
  a total one.*
- **AC7 — the leg carries its diagnosis (unit):** a `doc_task_infer` leg whose error is the production
  402 exposes `diagnosis.kind === "out_of_credit"`; a leg with an unrecognised error exposes `null`.
- **AC8 — the banner renders the headline, not the JSON (unit):** the rendered output contains the
  action sentence and does NOT open with `{"error"`.

| # | mutation | must redden |
|---|---|---|
| 1 | the classifier returns `out_of_credit` for any 402 | AC2 |
| 2 | reasoning starvation classified as `out_of_credit` | **AC3** |
| 3 | an unrecognised failure returns a generic credit fault instead of `null` | AC4 |
| 4 | the provider name is hardcoded to "OpenRouter" | AC5 |
| 5 | `degradedNote` appends the diagnosis instead of leading with it | AC6 |
| 6 | `degradedNote` drops the "Still working" clause | AC6's survival assertion |
| 7 | the leg's diagnosis is computed from the SOURCE name rather than the error text | AC7 |
| 8 | the banner renders `l.error` ahead of the diagnosis | AC8 |

## 5. Risks

| risk | direction | mitigation |
|---|---|---|
| A confident WRONG diagnosis | worse than raw text — sends the operator to the wrong console | AC3 + AC4: unrecognised is `null`, and the two adjacent faults are pinned apart |
| The raw provider text disappears entirely | a real outage becomes undiagnosable | it is retained, secondary and clipped — never removed |
| The classifier drifts from the retry predicates | two vocabularies for one fault | it CONSUMES `looksLikeBudgetRefusal`/`looksLikeInFlightRefusal` rather than re-spelling them |
| Naming the configured provider when another one refused | a confident lie | §2b: derived from the failure text's own base URL |

## 6. What this does NOT fix

The faults themselves. On the day this was written the account was **out of credit again** — the
provider reported it could afford 840 tokens against a 900-token request — so `doc_task_infer` and
task suggestions were failing for real. This slice makes that sentence readable in one line instead of
four hundred characters; it does not add credit.
