import "server-only";

/**
 * Embeddings client for optional dense retrieval — OpenAI-compatible `/embeddings`, mirroring the
 * `LLM_BASE_URL` / `RERANK_URL` convention (any provider that speaks the OpenAI wire shape: OpenAI,
 * Ollama, ZeroEntropy, a local server, …). Dense retrieval is OFF until `EMBEDDINGS_URL` is set.
 *
 *   EMBEDDINGS_URL     base URL, e.g. https://api.openai.com/v1  or  http://localhost:11434/v1
 *   EMBEDDINGS_MODEL   default text-embedding-3-small
 *   EMBEDDINGS_DIM     default 1536 — MUST match the vector(N) column in postgres/optional/pgvector.sql
 *   EMBEDDINGS_API_KEY optional — a DEDICATED embeddings key so semantic search survives the answer
 *                      LLM's quota (and vice-versa). See resolveEmbeddingKey; unset → shared key.
 */

const EMBEDDINGS_URL = process.env.EMBEDDINGS_URL;
const EMBEDDINGS_MODEL = process.env.EMBEDDINGS_MODEL ?? "text-embedding-3-small";
const EMBEDDINGS_TIMEOUT_MS = Number(process.env.EMBEDDINGS_TIMEOUT_MS ?? 20_000);

/** True when an embeddings endpoint is configured (dense retrieval opt-in). */
export function embeddingsConfigured(): boolean {
  return !!EMBEDDINGS_URL;
}

/**
 * Resolve the bearer key for the embeddings call, in precedence order:
 *   1. `apiKey` — the key the caller resolved (per-team store key via resolveEmbeddingKey, which
 *      already prefers a dedicated embeddings key), or
 *   2. `EMBEDDINGS_API_KEY` — a DEDICATED embeddings account at the env layer, so exhausting the
 *      answer LLM's `OPENAI_API_KEY` quota can't silently kill semantic search too (the decouple), or
 *   3. `OPENAI_API_KEY` — the shared env key (today's default; embeddings reuse the LLM's key), or
 *   4. `"local"` — a placeholder for keyless self-hosted servers (Ollama/llama.cpp ignore it).
 * Pure — no I/O — so the precedence is unit-testable without a live endpoint.
 */
export function embeddingAuthKey(apiKey?: string | null): string {
  return apiKey ?? process.env.EMBEDDINGS_API_KEY ?? process.env.OPENAI_API_KEY ?? "local";
}

/**
 * Embed a batch of texts. Returns one vector per input (order-preserving), or null when no endpoint
 * is configured. Throws on a hard HTTP/transport error so callers can log + degrade (the indexer and
 * the query path both treat a throw as "skip dense this time"). Per-team key wins; else OPENAI_API_KEY.
 */
export async function embed(texts: string[], apiKey?: string | null): Promise<number[][] | null> {
  if (!EMBEDDINGS_URL) return null;
  if (!texts.length) return [];

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), EMBEDDINGS_TIMEOUT_MS);
  try {
    const res = await fetch(`${EMBEDDINGS_URL.replace(/\/$/, "")}/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${embeddingAuthKey(apiKey)}`,
      },
      body: JSON.stringify({ model: EMBEDDINGS_MODEL, input: texts }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      throw new Error(`embeddings ${EMBEDDINGS_MODEL} @ ${EMBEDDINGS_URL}: ${res.status} ${await res.text().catch(() => "")}`);
    }
    const data = (await res.json()) as { data?: { embedding: number[] }[] };
    const vectors = (data.data ?? []).map((d) => d.embedding);
    if (vectors.length !== texts.length) {
      throw new Error(`embeddings returned ${vectors.length} vectors for ${texts.length} inputs`);
    }
    return vectors;
  } finally {
    clearTimeout(timer);
  }
}

/** Postgres `vector` literal for a number[] — e.g. [1,2,3] → "[1,2,3]" (pgvector text input form). */
export function toVectorLiteral(v: number[]): string {
  return `[${v.join(",")}]`;
}
