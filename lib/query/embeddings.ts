import "server-only";
import type { EmbeddingBackend } from "./embeddings-backend";

/**
 * Embeddings client for optional dense retrieval — OpenAI-compatible `/embeddings` (any provider that
 * speaks the wire shape: OpenAI, OpenRouter, Ollama, a local server, …). The backend (baseUrl + model
 * + key) is RESOLVED per team by `resolveEmbeddingBackend` (embedding-key.ts) from the team's Admin
 * pick or the env `EMBEDDINGS_URL` self-host endpoint — this module just posts to it. Dense retrieval
 * is OFF (callers skip) when the resolver returns null.
 */

const EMBEDDINGS_TIMEOUT_MS = Number(process.env.EMBEDDINGS_TIMEOUT_MS ?? 20_000);

/**
 * Embed a batch of texts against the resolved backend. Returns one vector per input (order-preserving).
 * `[]` for empty input. Throws on a hard HTTP/transport error, a count mismatch, or a WRONG-DIMENSION
 * vector (`backend.dim` — 1536 for a curated pick, or the self-host's `EMBEDDINGS_DIM`; the pgvector
 * column is fixed at that width, so a mis-dimensioned model would otherwise fail deep in the `::vector`
 * insert with an opaque error) — callers log + degrade ("skip dense this time").
 */
export async function embed(texts: string[], backend: EmbeddingBackend): Promise<number[][]> {
  if (!texts.length) return [];

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), EMBEDDINGS_TIMEOUT_MS);
  try {
    const res = await fetch(`${backend.baseUrl.replace(/\/$/, "")}/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${backend.apiKey}`,
      },
      body: JSON.stringify({ model: backend.model, input: texts }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      throw new Error(
        `embeddings ${backend.model} @ ${backend.baseUrl}: ${res.status} ${await res.text().catch(() => "")}`
      );
    }
    const data = (await res.json()) as { data?: { embedding: number[] }[] };
    const vectors = (data.data ?? []).map((d) => d.embedding);
    if (vectors.length !== texts.length) {
      throw new Error(`embeddings returned ${vectors.length} vectors for ${texts.length} inputs`);
    }
    const bad = vectors.find((v) => !Array.isArray(v) || v.length !== backend.dim);
    if (bad) {
      const got = Array.isArray(bad) ? `${bad.length}-dim` : "non-array";
      throw new Error(`embeddings model ${backend.model} returned ${got} vectors; the index requires ${backend.dim}`);
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
