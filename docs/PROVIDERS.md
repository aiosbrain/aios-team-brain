# AI Providers — local or cloud

The Team Brain answers queries with an LLM and orders its evidence with an
optional reranker. **Both are configurable, and both default to cloud-free.**
You can run the whole query path on your own machine, on cloud APIs, or mix the
two — purely through environment variables. No code changes.

There are four independent knobs:

| Knob | Env | Default (unset) | Local option | Cloud option |
|------|-----|-----------------|--------------|--------------|
| **Context layer** | `CONTEXT_PROVIDER` | `native` (Postgres + Graphiti) | `external` → a gbrain adapter | `external` → any RAG service |
| **Answering LLM** | `LLM_BASE_URL` | Anthropic (`ANTHROPIC_API_KEY`) | Ollama / Hermes / llama.cpp | any OpenAI-compatible API |
| **Reranker** | `RERANK_URL` | off (Postgres order) | `llama-server --reranking` | Cohere / Voyage / ZeroEntropy |
| **Extra retrieval** | `RETRIEVAL_AUGMENT_URL` | off (Postgres only) | GBrain adapter | hosted retrieval API |

**Context layer vs extra retrieval:** `RETRIEVAL_AUGMENT_URL` *adds* an external source on top of
the native Postgres retrieval. `CONTEXT_PROVIDER=external` *replaces* the whole context layer with
the external service (same `POST {query,limit,tier} → {sources[]}` contract) — the seam for swapping
in gbrain or another engine wholesale. Both providers implement `RetrievalProvider` (`lib/query/provider.ts`).
⚠️ An `external` provider must enforce the caller's **tier** itself — there is no DB backstop (CLAUDE.md §5).

Everything degrades safely: if a local/cloud endpoint is unreachable or times
out, the brain falls back (LLM → error surfaced; reranker/augmentation → skipped)
rather than breaking the query.

---

## 0. Dense (semantic) retrieval — optional pgvector

By default the native provider retrieves with **keyword FTS + Graphiti facts** and runs on stock
Postgres (no extensions). You can add **dense passage retrieval** (embeddings + HNSW + RRF fusion
with the keyword hits) as an opt-in upgrade:

| Env | Default | Purpose |
|-----|---------|---------|
| `EMBEDDINGS_URL` | unset → dense OFF | OpenAI-compatible base, e.g. `https://api.openai.com/v1`, `http://localhost:11434/v1` (Ollama) |
| `EMBEDDINGS_MODEL` | `text-embedding-3-small` | any embedding model the endpoint serves |
| `EMBEDDINGS_DIM` | `1536` | MUST equal the `vector(N)` column in `postgres/optional/pgvector.sql` |

Enable it in three steps (needs a Postgres with the `vector` extension — Railway/Supabase/pgvector image):

```bash
npm run pg:schema           # base schema (as usual)
npm run pg:schema:vector    # optional: create the vector extension + item_chunks + HNSW
export EMBEDDINGS_URL=https://api.openai.com/v1   # the embeddings endpoint (append /embeddings)
npm run embed:backfill      # embed existing items (idempotent); new items index each ingest cycle
```

**The embeddings key** resolves in precedence order: `EMBEDDINGS_API_KEY` env → the team's OpenAI key
from **Admin → Integrations → AI model settings** (encrypted `integrations` store, via `getProviderKey`)
→ the `OPENAI_API_KEY` env. So by default, if you've already set the key in the dashboard for the LLM,
dense retrieval reuses it — no extra env var needed, and `EMBEDDINGS_URL` can equal `LLM_BASE_URL` when
both point at OpenAI.

> **Decoupling (optional, recommended at scale).** Embeddings sharing the answer LLM's key means one
> account's quota exhaustion silently takes down BOTH answering and semantic search at once. Set
> **`EMBEDDINGS_API_KEY`** to a **separate account** to isolate them — semantic search then survives an
> answer-LLM outage and vice-versa. It wins over the shared store key, so it's a one-env-var opt-in with
> no dashboard change. Failures are already surfaced loudly on **Admin → Integrations → Retrieval health**
> (coverage %, degraded state) + the admin email alert, so a degraded leg is visible either way.

With `EMBEDDINGS_URL` unset **or** the pgvector schema not loaded, dense retrieval is a complete
no-op — the brain behaves exactly as before. Dense hits are tier-filtered on live `items.access`
(no leak to `external` viewers). Pair with `RERANK_URL` for best precision.

---

## 1. Answering LLM

### Cloud (default)
Set `ANTHROPIC_API_KEY` and leave `LLM_BASE_URL` unset. Queries use
`claude-opus-4-8` with prompt caching and usage/cost accounting.

```bash
ANTHROPIC_API_KEY=sk-ant-...
```

### OpenRouter (dashboard, no env)
Set it per-team in **Admin → Integrations → OpenRouter**: paste an OpenRouter key (validated on
save, stored encrypted) and a model slug (e.g. `anthropic/claude-sonnet-4`, `openai/gpt-4o-mini`).
Once connected it **takes precedence** over both `LLM_BASE_URL` and the Anthropic default — a team
can switch models without touching env. OpenRouter is an OpenAI-compatible gateway, so it reuses the
same streaming path. Backend precedence is a single function: `lib/query/llm-backend.selectLlmBackend`
(**OpenRouter → `LLM_BASE_URL` → Anthropic**), shared by the answer stream and the title generator.

### Local
Set `LLM_BASE_URL` to any OpenAI-compatible `/v1` endpoint. `ANTHROPIC_API_KEY`
is then ignored, and reported cost is `$0`.

```bash
LLM_BASE_URL=http://localhost:11434/v1     # Ollama
LLM_MODEL=llama3.1-8b-64k:latest           # any model the endpoint serves
OPENAI_API_KEY=local                        # placeholder; Ollama ignores it
```

Works with **Ollama**, **Hermes Agent**, **llama.cpp `llama-server`**, **LM Studio**,
**vLLM** — anything exposing `POST /v1/chat/completions`.

Notes:
- The brain prompt is summarize-from-sources, so a fast 7–8B instruct model
  (e.g. `llama3.1:8b`) is a good default. A reasoning model also works —
  `streamAnswer` strips `<think>…</think>` spans so answers stay clean.
- Whatever model you name in `LLM_MODEL` must already be available on the
  endpoint (e.g. `ollama pull` / loaded in LM Studio).

Implementation: `lib/query/claude.ts` (`streamAnswer` → `streamLocal`). Both
paths yield the same `{delta}/{done}` stream, so the SSE API routes are unchanged.

---

## 2. Reranker (recommended)

A cross-encoder reranker reorders the retrieved sources by true relevance before
the LLM sees them, so the most relevant source is cited as `[S1]`. This noticeably
improves answer quality on larger brains. It's optional and off by default.

### Local
Run a `llama-server` reranking instance and point the brain at it:

```bash
# one-time: install llama.cpp (brew install llama.cpp) then run the reranker
llama-server -hf ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF \
  --alias qwen3-reranker-0.6b --reranking --pooling rank --port 8081

# brain env
RERANK_URL=http://localhost:8081/v1/rerank
RERANK_MODEL=qwen3-reranker-0.6b
```

### Cloud
Point `RERANK_URL` at any endpoint speaking the ZeroEntropy/llama.cpp rerank
wire shape (`POST {model, query, documents[]}` → `{results:[{index, relevance_score}]}`):

```bash
RERANK_URL=https://api.your-rerank-provider.com/v1/rerank
RERANK_MODEL=rerank-2
RERANK_TOKEN=...        # sent as Authorization: Bearer
```

Implementation: `lib/query/retrieve.ts` (`rerankSources`). Timeout
`RERANK_TIMEOUT_MS` (default 4000ms); on any failure the Postgres order is kept.

---

## 3. External retrieval augmentation (advanced)

By default the brain retrieves from its own Postgres (full-text + graph). You can
merge in extra sources from an external retrieval service — for example a local
[GBrain](https://github.com/garrytan/gbrain) brain via a small adapter, or a
hosted retrieval API.

```bash
RETRIEVAL_AUGMENT_URL=http://localhost:8791/retrieve
RETRIEVAL_AUGMENT_TOKEN=...           # optional bearer
RETRIEVAL_AUGMENT_LIMIT=6
```

**Contract** (vendor-neutral):

```
POST {RETRIEVAL_AUGMENT_URL}
  → body: { "query": string, "limit": number, "tier": "team"|"external" }
  ← 200:  { "sources": [ { "path": string, "text": string,
                           "score"?: number, "project"?: string, "kind"?: string } ] }
```

Returned sources are merged after the Postgres hits (deduped by `path`, same
context budget) and then reranked if a reranker is configured. Timeout
`RETRIEVAL_AUGMENT_TIMEOUT_MS` (default 3000ms); on any failure the brain uses
Postgres-only retrieval. Implementation: `lib/query/retrieve.ts`
(`fetchAugmentedSources`).

---

## Recipes

**Fully local (private, $0 inference):**
```bash
LLM_BASE_URL=http://localhost:11434/v1
LLM_MODEL=llama3.1-8b-64k:latest
RERANK_URL=http://localhost:8081/v1/rerank
RERANK_MODEL=qwen3-reranker-0.6b
```

**Fully cloud (default):**
```bash
ANTHROPIC_API_KEY=sk-ant-...
# (LLM_BASE_URL / RERANK_URL unset)
```

**Hybrid (local LLM, cloud rerank, or vice-versa):** set each knob independently.

Switching is just env + a restart — no rebuild.
