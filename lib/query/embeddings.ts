import "server-only";
import type { EmbeddingBackend } from "./embeddings-backend";
import { adminClient } from "@/lib/db/admin";
import { recordLlmUsage } from "@/lib/costs/llm-usage";
import { resolveOpenAiCost, type OpenAiUsage } from "@/lib/llm/cost";

/** Meter one embeddings call into `llm_usage` (source `embeddings`). System-initiated (member null).
 *  BEST-EFFORT: embeddings feed indexing + retrieval, so a metering failure must never break them —
 *  every error is swallowed. Tokens are recorded even at $0 so embedding VOLUME is visible even when
 *  the provider reports no `usage.cost`. */
async function meterEmbedding(teamId: string, backend: EmbeddingBackend, usage: OpenAiUsage | undefined): Promise<void> {
  try {
    const c = resolveOpenAiCost(usage, backend.provider, backend.model, "embedding");
    await recordLlmUsage(adminClient(), {
      teamId,
      memberId: null,
      source: "embeddings",
      provider: backend.provider,
      model: backend.model,
      inputTokens: c.inputTokens,
      outputTokens: c.outputTokens,
      costUsd: c.costUsd,
      estimated: c.estimated,
    });
  } catch {
    // Metering never breaks embedding.
  }
}

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
export async function embed(
  texts: string[],
  backend: EmbeddingBackend,
  meter?: { teamId: string }
): Promise<number[][]> {
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
      // `usage:{include:true}` asks OpenRouter to report the real `usage.cost` so the embeddings meter
      // records dollars, not just tokens (mirrors the graph proxy + completeText). Harmless elsewhere.
      body: JSON.stringify({
        model: backend.model,
        input: texts,
        ...(backend.provider === "openrouter" ? { usage: { include: true } } : {}),
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      throw new Error(
        `embeddings ${backend.model} @ ${backend.baseUrl}: ${res.status} ${await res.text().catch(() => "")}`
      );
    }
    const data = (await res.json()) as { data?: { embedding: number[] }[]; usage?: OpenAiUsage };
    // Meter BEFORE the vector-shape validation below: the tokens were spent the moment the call
    // succeeded, whether or not the vectors pass the dimension check. Only when a caller opts in.
    if (meter) await meterEmbedding(meter.teamId, backend, data.usage);
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
