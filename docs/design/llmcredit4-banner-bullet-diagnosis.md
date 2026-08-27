# The bullet reads the diagnosis too — LLMCREDIT-4

**Status:** spec, written AFTER the code, and that is the defect this document also records. ⚠️ The
Codex spec round is skipped (a copy fix inside LLMCREDIT-3's own stated scope); the Fable diff review
is not — it returned **BLOCKED** and is folded below.

**Build with:** opus / high — it is the sentence an operator reads first.

**Deps:** LLMCREDIT-3 (merged, deployed) — this finishes what §2c of that spec claimed.

---

## What and why

LLMCREDIT-3 said the diagnosis would be *"consumed at both surfaces"*. It reached the generation
banner's summary **paragraph** (`degradedNote`) and not the per-task **bullet** above it, which kept
rendering `{t.lastError}` — the provider's raw JSON, unclipped, **rendered first**.

The operator reported it against the shipped build: *"Even after the merge I'm still getting the same
error message on the pulse screen."* He was right about what he saw. The screenshot shows the
ingestion banner correctly leading with *"OpenRouter is out of credit — … Top up the account"*, and
the generation banner's bullet still opening with `{"error":{"message":"This request requires more
credits…`.

⚠️ *Not "the most prominent red text on the page" — an earlier draft of this claim said that and a
review disproved it from the classNames. It is `text-xs` at `text-red-600/80`. What makes it the thing
he saw is that it renders FIRST and carried ~470 unclipped characters.*

## 1. The rule

> **No surface renders the provider's raw error as its own message. The composition belongs to one
> shared helper, and reverting to raw must turn a test red.**

## 2. The design

- `LlmTaskHealth` gains `diagnosis`, computed **server-side** in `deriveTaskHealth`.
  ⚠️ Server-side because the banner is `"use client"` and `diagnoseProviderFault` reaches
  `lib/query/claude`, which is `server-only`: a value import there breaks `next build` while `tsc` and
  the whole unit tier stay green. That exact mistake shipped once on this lane and CI caught it.
- The bullet composes through **`legDetail`** — the pure, client-safe helper already extracted during
  LLMCREDIT-3 for precisely this — so both banners share the lead/raw split AND the clip length.
- `diagnosis` keeps `kind`, so `degradedNote` reads the field instead of re-deriving the same answer
  from the same string.

## 3. Scope

**In:** `lib/query/llm-health.ts` · `components/admin/generation-health-banner.tsx` ·
`test/generation-health-banner.test.ts` · `test/provider-fault-diagnosis.test.ts` ·
`test/llm-health.test.ts`.

**Out:** the underlying faults (still an empty provider balance), the classifier itself (LLMCREDIT-3),
and any new fault kind.

## 4. Acceptance

- **AC1 — the raw provider error is NEVER interpolated into the markup (guard, unit):** ∀ over the JSX
  region — no `{t.lastError` occurrence — and `legDetail({ error: t.lastError` is present, so it
  cannot pass by rendering nothing.
- **AC2 — the client component imports `llm-health` as a TYPE only (guard, unit):** every matching
  import line carries `type`. *The hazard was documented three times in this lane and guarded zero.*
- **AC3 — every task with an in-window failure carries its own diagnosis (unit):** `deriveTaskHealth`
  populates it from the error TEXT; an unrecognised error yields `null` and the bullet falls back to
  the raw string.

| # | mutation | must redden |
|---|---|---|
| 1 | revert the whole component to `origin/main` (the bullet back to raw `{t.lastError}`) | **AC1** |
| 2 | make the `llm-health` import a value import | AC2 |
| 3 | `deriveTaskHealth` stops populating `diagnosis` | AC3 |

## 5. Risks

| risk | direction | mitigation |
|---|---|---|
| A value import creeps back into the client component | `next build` breaks; tsc + unit tier stay green | AC2 |
| The bullet quietly reverts to raw JSON | the reported defect, again | AC1 — ∀, and mutation 1 is the reviewer's own surviving mutation |
| Two diagnoses for one error disagree | the paragraph and the bullet contradict each other | `kind` retained; `degradedNote` reads the field |

## 6. What this does NOT fix

The account is still out of credit. This changes what the operator READS, not what failed.
