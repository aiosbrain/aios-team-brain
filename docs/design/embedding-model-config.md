# Per-team Embeddings-model config (Admin picker)

**Goal.** Make the **embeddings model** a per-team, Admin-panel setting — analogous to the existing
"Answering model" and "Reasoning model" pickers — instead of the env-only wiring it has today
(`EMBEDDINGS_URL` / `EMBEDDINGS_MODEL` / `EMBEDDINGS_API_KEY`). Motivating incident: a team's OpenAI
key ran out of quota (`429 insufficient_quota`), which silently killed the semantic index; the team
already pays for OpenRouter (answering + reasoning) and wants to route embeddings there too, from the
UI, without touching Railway env vars.

**Non-goal (explicit).** Changing the embedding **dimension** or supporting a different vector space is
out of scope — see the hard constraint below. No re-index/backfill flow is built here.

---

## 1. The hard constraint that shapes the whole design

The pgvector column is fixed at load time: `item_chunks.embedding vector(1536)`
(`postgres/optional/pgvector.sql:34`). The insert casts every vector `::vector` into that column
(`lib/query/dense-index.ts:85`), so **a model that doesn't emit 1536 dims makes every insert throw**,
and the query embedding must be 1536-dim to be comparable. Therefore:

- The picker offers **only 1536-dimension models**, and **only OpenAI + OpenRouter** — the two providers
  that expose an OpenAI-compatible `/embeddings` endpoint serving `text-embedding-3-small` (1536).
  Anthropic has no embeddings API; Google's are 768-dim (would need a column rebuild + full re-embed).
- **The UI states this reason inline** (per product): a short note that only OpenAI and OpenRouter are
  listed because the semantic index is built at 1536 dimensions and other providers/models would
  require re-indexing the whole corpus.
- **Vector-space note.** OpenAI-direct `text-embedding-3-small` and OpenRouter `openai/text-embedding-3-small`
  are the *same underlying model* → identical vector space → switching provider between them is
  **re-embed-free** (this is exactly the incident fix). The curated model list is deliberately limited
  to that one model per provider so a user cannot silently switch vector spaces and quietly degrade
  search. (A future "change model + reindex" feature can widen this.)

---

## 2. Data model

Mirror `reasoning_provider` / `reasoning_model` exactly.

`postgres/schema.sql` (`teams` block, after `reasoning_provider`):
```sql
-- Explicit embeddings-backend override for the semantic index. Null = auto (env EMBEDDINGS_URL for
-- self-host, else off). Constrained to the providers that serve a 1536-dim OpenAI-compatible
-- /embeddings model matching the item_chunks vector(1536) column (openai/openrouter only).
embedding_provider text check (embedding_provider in ('openai', 'openrouter')),
embedding_model text,
```
Plus the additive `alter table teams add column if not exists …` lines and the idempotent
`teams_embedding_provider_check` re-add in the `do $$ … end $$` block (mirroring lines 126–141).

Two migrations (one column each, matching the existing one-column-per-file convention):
- `20260723HHMMSS_teams_embedding_provider.sql` — add column + idempotent CHECK re-add (the **complete
  value set** `('openai','openrouter')` identical in schema.sql + migration, per `enum-check-replay`).
- `20260723HHMMSS_teams_embedding_model.sql` — add `embedding_model text` (free text, no CHECK).

`lib/api/schemas.ts`: add `EMBEDDING_PROVIDER_TYPES = ['openai','openrouter'] as const` + type, and a
curated dimension map used by validation + UI:
```ts
// 1536-dim models compatible with item_chunks.embedding vector(1536). Value = dimension.
export const EMBEDDING_MODELS: Record<EmbeddingProvider, { model: string; label: string }[]> = {
  openai:     [{ model: 'text-embedding-3-small', label: 'text-embedding-3-small (1536d)' }],
  openrouter: [{ model: 'openai/text-embedding-3-small', label: 'openai/text-embedding-3-small (1536d)' }],
};
export const EMBEDDING_DIM = 1536;
```

---

## 3. Resolution (new `lib/query/embeddings-backend.ts`, pure — mirrors `llm-backend.ts`)

```ts
export type EmbeddingProvider = 'openai' | 'openrouter';
export interface EmbeddingBackendKeys { openaiKey?; openrouterKey?; activeProvider?; model?; }
export interface EmbeddingBackend { provider; baseUrl; model; apiKey; }

// provider → baseUrl (reuse OPENAI_BASE_URL / OPENROUTER_BASE_URL from llm-backend) + default model.
function candidate(provider, keys): EmbeddingBackend | null   // null when that provider has no key
export function selectEmbeddingBackend(env, keys): EmbeddingBackend | null
export function describeEmbedding(env, keys): { requested; provider; model; usedFallback; configured }
```

**Precedence** (in the DB-reading resolver `resolveEmbeddingBackend(db, teamId)`):
1. `teams.embedding_provider` set **and** that provider's team key resolves → use it
   (`baseUrl` from provider, `model` = `teams.embedding_model` || provider default, `apiKey` = team key).
2. else env `EMBEDDINGS_URL` set → env backend (today's self-host behavior; key via the existing
   `EMBEDDINGS_API_KEY` → team OpenAI key → `OPENAI_API_KEY` precedence).
3. else `null` → dense retrieval OFF (unchanged "optional, degrades to FTS" contract).

`resolveEmbeddingBackend` replaces the key-only `resolveEmbeddingKey`; it does the `getProviderSettings`
reads for openai + openrouter and the one `teams` read, then calls the pure `selectEmbeddingBackend`.

---

## 4. `embed()` + call-site refactor

- `embed(texts, backend: { baseUrl; model; apiKey })` — takes the resolved backend instead of reading
  `EMBEDDINGS_URL`/`EMBEDDINGS_MODEL` from env. Returns `null` when `backend` is null (dense off).
- `indexItem(item, backend)` and `indexPendingItems(limit, backend?)` — resolve the backend per team
  (`indexPendingItems` memoizes per `team_id`, exactly like it memoizes the key today,
  `dense-index.ts:132`).
- `denseSearch(teamId, tier, q, …)` — resolves the backend internally (replacing the `resolveEmbeddingKey`
  call at `dense-search.ts:46`).
- `denseIndexAvailable()` splits: the global `item_chunks`-table probe stays; the "is embeddings
  configured" half moves to "did `resolveEmbeddingBackend` return non-null" at the per-team call sites.
  Default install (no team provider, no env URL) → null → pure FTS, unchanged.

**Back-compat:** an env-only self-host (`EMBEDDINGS_URL` set, no team setting) keeps working via
precedence #2. Prod today (`EMBEDDINGS_URL=api.openai.com`, team OpenAI key) is unchanged **until** an
admin picks a provider in the UI — at which point #1 takes over.

---

## 5. Key management + delete cascade

- The embedding key reuses the **existing provider key** for the chosen provider (`getProviderKey`
  openai/openrouter) — no new key entry UI; keys are still set in the AI-provider-keys panel.
- **Cascade:** extend `clearDanglingProviderPointers` (`lib/integrations/manage.ts`) so deleting the
  last enabled key of a provider also nulls `teams.embedding_provider`/`embedding_model` when they point
  at it (exactly as it already nulls `answering_provider` / `reasoning_provider`). Prevents a dangling
  embeddings pointer that would silently fall back.

---

## 6. Admin UI

`app/t/[team]/admin/integrations/page.tsx`: select the two new columns, build sentinel keys, compute
`describeEmbedding(...)`, pass an `embedding` prop.

`components/admin/integrations-manager.tsx`: a **third `RolePicker`** in the "Answering & reasoning
models" card (or a sibling "Embeddings model" card), wired to a new `setEmbeddingModel` action.
Differences from the answering/reasoning pickers:
- Provider dropdown lists **only OpenAI + OpenRouter**.
- Model is a **dropdown** of the curated 1536-dim models for the chosen provider (not a free-text box),
  so a dim-incompatible model can't be typed.
- **Inline helper text** (the product ask): _"Only OpenAI and OpenRouter are available — the semantic
  index is built at 1536 dimensions, and other providers/models would require re-indexing every
  document."_
- Shows the effective provider·model + a `usedFallback`/"not configured" indicator like the others.

`app/t/[team]/admin/integrations/actions.ts`: `setEmbeddingModel(teamSlug, provider, model)` mirroring
`setReasoningModel` (admin gate, allowlist `['openai','openrouter']`, **validate `model` ∈
`EMBEDDING_MODELS[provider]`** → reject a dim-mismatch even if the client is bypassed, couple
provider+model like reasoning, write `teams.update`, `audit('team.embedding_provider_set')`).

---

## 7. Tests (spec-first)

- **`test/datamechanics/embedding-backend.datamechanics.test.ts`** (clone `answering-backend`): store an
  OpenRouter key + set `embedding_provider='openrouter'` → `resolveEmbeddingBackend` returns
  `{ baseUrl: openrouter.ai/api/v1, model: openai/text-embedding-3-small, apiKey }`; OpenAI path; env
  fallback when unset; null when nothing configured.
- **`test/embeddings-backend.test.ts`** (pure): `selectEmbeddingBackend` precedence + `describeEmbedding`
  `usedFallback`; `candidate` returns null without a key.
- **Dimension guard** — a unit test asserting `setEmbeddingModel` (or a pure validator) rejects any model
  not in `EMBEDDING_MODELS[provider]` (the corruption guard), and that every curated model maps to
  `EMBEDDING_DIM` (1536).
- **Delete-cascade** — extend `integration-delete-provider-cascade.datamechanics.test.ts`: deleting the
  provider's last key nulls `embedding_provider`/`embedding_model`.
- Guards: new migrations satisfy `migrations-numbering` + `enum-check-replay`.
- Keep `test/embeddings-key.test.ts` green (or fold into the new backend test).

---

## 8. Deploy

New `teams` columns → run `npm run pg:schema` against prod after merge (additive; migrations apply in
order). No data migration. Architecture map (`docs/ARCHITECTURE.md`) row for `teams.answering_provider`
/ embeddings updated in the same PR.

---

## 9. Risks

- **Dimension corruption** — mitigated by the curated allowlist + save-time validation + column-dim
  constant. The only supported change is provider (OpenAI↔OpenRouter) on the *same* model → no re-embed.
- **Two writers of `teams` provider pointers** — `deleteIntegration` cascade + the new action; both are
  existing patterns; audited.
- **Vector-space drift** if the curated list is later widened to a different model without a reindex —
  called out so a future change adds the reindex flow first.

---

## 10. Plan-review resolutions (Fable — SHIP-WITH-CHANGES)

- **[Blocker] Same-dim vector-space corruption (ada-002).** 1536-dim ≠ same vector space; the sha-only
  dedup (`dense-index.ts:66,123`) would make a mixed-space index permanent. **Resolution:** two guards,
  (a) the curated model list is a **single model** (`text-embedding-3-small`) per provider, so the UI can
  never introduce a second space; (b) a **canonical-space** check — `canonicalEmbeddingModel(model)`
  strips the provider prefix (`openai/text-embedding-3-small` → `text-embedding-3-small`), and
  `setEmbeddingModel` **refuses** when the picked model's canonical space differs from the index's
  existing baseline (env `EMBEDDINGS_MODEL`, default `text-embedding-3-small`) with a clear "your index
  was built with X; switching the embedding space needs a re-index (not yet supported)" error. So the
  OpenAI↔OpenRouter switch on `text-embedding-3-small` (identical canonical space) is allowed and
  re-embed-free, while an ada-002 baseline blocks the switch instead of silently corrupting. A durable
  per-chunk `item_chunks.embedding_model` provenance column + model-aware staleness predicate is the
  follow-up when we widen the list / add a reindex flow (noted, not built here).
- **[High] retrieval-health dense leg is env-keyed.** `retrieval-health.ts:138` reads
  `!!process.env.EMBEDDINGS_URL`; a team-configured-but-env-less install would read "off" and never
  alert. **Resolution:** `configured` comes from `resolveEmbeddingBackend(teamId) !== null`; add a
  `deriveDenseState` test for the team-configured case.
- **[High] keyless env (Ollama/llama.cpp) regression.** **Resolution:** the env tier is configured iff
  `EMBEDDINGS_URL` is set, with `apiKey` falling through to `"local"` (preserve `embeddings.ts:35`); pure
  test covers it.
- **[High] no Auto/clear path.** **Resolution:** `setEmbeddingModel(teamSlug, provider: EmbeddingProvider
  | null, model)` — null (picker "Auto") nulls **both** columns in one write, mirroring `setReasoningModel`.
- **[Medium] `scripts/embed-backfill.ts`.** **Resolution:** add to the refactor surface — resolve backend
  per team, gate per-team instead of the env exit.
- **[Medium] batch starvation on multi-team instances.** **Resolution:** `indexPendingItems` resolves
  backends first and **excludes null-backend teams** from the pending scan (they don't count toward
  `scanned`/`failed`), plus a cheap global short-circuit (env unset AND no team has `embedding_provider`)
  so a default pure-FTS install pays no per-tick scan.
- **[Medium] `EMBEDDINGS_API_KEY` decouple outranked.** Picking OpenAI re-couples onto the shared team
  key. **Resolution:** acceptable as explicit opt-in; `describeEmbedding` / helper text notes the
  effective key source when `EMBEDDINGS_API_KEY` is set.
- **[Low] confirmations.** CHECK `('openai','openrouter')` (no `'local'`) confirmed; migrations satisfy
  numbering + enum-check-replay; delete cascade correct; add a runtime `vectors[i].length === EMBEDDING_DIM`
  assert for a clear error; update `test/query-dense-index.test.ts` for the signature change.
