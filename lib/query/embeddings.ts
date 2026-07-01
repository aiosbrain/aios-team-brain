import "server-only";

/**
 * Embeddings client for optional dense retrieval — OpenAI-compatible `/embeddings`, mirroring the
 * `LLM_BASE_URL` / `RERANK_URL` convention (any provider that speaks the OpenAI wire shape: OpenAI,
 * Ollama, ZeroEntropy, a local server, …). Dense retrieval is OFF until `EMBEDDINGS_URL` is set.
 *
 *   EMBEDDINGS_URL   base URL, e.g. https://api.openai.com/v1  or  http://localhost:11434/v1
 *   EMBEDDINGS_MODEL default text-embedding-3-small
 *   EMBEDDINGS_DIM   default 1536 — MUST match the vector(N) column in postgres/optional/pgvector.sql
 */

const EMBEDDINGS_URL = process.env.EMBEDDINGS_URL;
const EMBEDDINGS_MODEL = process.env.EMBEDDINGS_MODEL ?? "text-embedding-3-small";
const EMBEDDINGS_TIMEOUT_MS = Number(process.env.EMBEDDINGS_TIMEOUT_MS ?? 20_000);

/** Vector dimension of the configured model; must equal the `item_chunks.embedding` column dim. */
export const EMBEDDING_DIM = Number(process.env.EMBEDDINGS_DIM ?? 1536);

/** True when an embeddings endpoint is configured (dense retrieval opt-in). */
export function embeddingsConfigured(): boolean {
  return !!EMBEDDINGS_URL;
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
        Authorization: `Bearer ${apiKey ?? process.env.OPENAI_API_KEY ?? "local"}`,
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
