import { OPENAI_BASE_URL, OPENROUTER_BASE_URL } from "./llm-backend";
import { EMBEDDING_MODELS, EMBEDDING_DIM, type EmbeddingProvider } from "@/lib/api/schemas";

/**
 * Embeddings backend selection — the pure analog of `selectLlmBackend`. Turns a team's per-provider
 * keys + `teams.embedding_provider`/`embedding_model` override (+ the env self-host endpoint) into the
 * concrete `{ baseUrl, model, apiKey }` the embeddings client posts to. No I/O — the DB reads live in
 * `resolveEmbeddingBackend` (embedding-key.ts), so the precedence is unit-testable without a live DB.
 *
 * Precedence:
 *   1. explicit team provider (`embedding_provider`) when that provider's key resolves — the Admin
 *      picker's choice (openai/openrouter → OpenAI-compatible /embeddings, 1536-dim model);
 *   2. env `EMBEDDINGS_URL` — the self-host / back-compat endpoint (keyless-tolerant → "local");
 *   3. null → dense retrieval OFF (default install stays pure-FTS; unchanged "optional" contract).
 */

/** `provider:"env"` = the env `EMBEDDINGS_URL` endpoint (self-host); otherwise a picked provider. */
export interface EmbeddingBackend {
  provider: EmbeddingProvider | "env";
  baseUrl: string; // no trailing slash; the client appends `/embeddings`
  model: string;
  apiKey: string; // "local" placeholder for keyless self-hosted servers (Ollama/llama.cpp ignore it)
  /** Expected vector dimension for the sanity check in embed(). Picks are locked to the curated
   *  1536-dim models; the env self-host tier honors EMBEDDINGS_DIM (a custom-dim column, e.g. 768). */
  dim: number;
}

export interface EmbeddingBackendKeys {
  openaiKey?: string | null;
  openrouterKey?: string | null;
  /** `teams.embedding_provider` (already normalized), null = no explicit pick. */
  activeProvider?: EmbeddingProvider | null;
  /** `teams.embedding_model`, null = provider default. */
  model?: string | null;
  /** env `EMBEDDINGS_URL` (self-host tier), null/absent = no env endpoint. */
  envUrl?: string | null;
  /** env `EMBEDDINGS_MODEL`, null = today's default text-embedding-3-small. */
  envModel?: string | null;
  /** resolved env key (dedicated → team OpenAI → OPENAI_API_KEY), null → "local". */
  envKey?: string | null;
  /** env `EMBEDDINGS_DIM` (a custom-dim self-host column); null/absent → the default 1536. */
  envDim?: number | null;
}

const OPENAI_MODEL = EMBEDDING_MODELS.openai[0].model; // text-embedding-3-small
const DEFAULT_ENV_MODEL = OPENAI_MODEL;

const BASE_URL: Record<EmbeddingProvider, string> = {
  openai: OPENAI_BASE_URL,
  openrouter: OPENROUTER_BASE_URL,
};
const DEFAULT_MODEL: Record<EmbeddingProvider, string> = {
  openai: EMBEDDING_MODELS.openai[0].model,
  openrouter: EMBEDDING_MODELS.openrouter[0].model,
};

const nonEmpty = (s: string | null | undefined): s is string => !!s && s.trim().length > 0;

/** Normalize a stored `teams.embedding_provider` to a valid provider or null. Pure. */
export function normalizeEmbeddingProvider(raw: unknown): EmbeddingProvider | null {
  return raw === "openai" || raw === "openrouter" ? raw : null;
}

function providerKey(provider: EmbeddingProvider, keys: EmbeddingBackendKeys): string | null {
  return provider === "openai" ? keys.openaiKey ?? null : keys.openrouterKey ?? null;
}

/** The backend for one picked provider, or null when its key isn't set (→ falls through to env). */
function candidate(provider: EmbeddingProvider, keys: EmbeddingBackendKeys): EmbeddingBackend | null {
  const key = providerKey(provider, keys);
  if (!nonEmpty(key)) return null;
  return {
    provider,
    baseUrl: BASE_URL[provider],
    model: nonEmpty(keys.model) ? keys.model.trim() : DEFAULT_MODEL[provider],
    apiKey: key.trim(),
    dim: EMBEDDING_DIM, // picks are curated to the 1536-dim model
  };
}

export function selectEmbeddingBackend(keys: EmbeddingBackendKeys): EmbeddingBackend | null {
  // 1. explicit team provider (only when its key resolves — else fall through, not error).
  if (keys.activeProvider) {
    const c = candidate(keys.activeProvider, keys);
    if (c) return c;
  }
  // 2. env endpoint — configured iff EMBEDDINGS_URL is set; keyless-tolerant (→ "local").
  if (nonEmpty(keys.envUrl)) {
    return {
      provider: "env",
      baseUrl: keys.envUrl.trim().replace(/\/$/, ""),
      model: nonEmpty(keys.envModel) ? keys.envModel.trim() : DEFAULT_ENV_MODEL,
      apiKey: nonEmpty(keys.envKey) ? keys.envKey.trim() : "local",
      // Self-host may run a custom-dim column (docs/PROVIDERS.md) — honor EMBEDDINGS_DIM, else 1536.
      dim: keys.envDim && Number.isFinite(keys.envDim) && keys.envDim > 0 ? keys.envDim : EMBEDDING_DIM,
    };
  }
  // 3. dense off.
  return null;
}

/**
 * Admin-indicator shape (mirrors `describeAnswering`): the requested provider, the effective
 * provider+model actually resolved, and whether the pick fell back (its key wasn't set → env/off).
 */
export function describeEmbedding(keys: EmbeddingBackendKeys): {
  requested: EmbeddingProvider | null;
  provider: EmbeddingProvider | "env" | null;
  model: string;
  usedFallback: boolean;
  configured: boolean;
} {
  const requested = keys.activeProvider ?? null;
  const backend = selectEmbeddingBackend(keys);
  if (!backend) return { requested, provider: null, model: "", usedFallback: false, configured: false };
  return {
    requested,
    provider: backend.provider,
    model: backend.model,
    usedFallback: requested !== null && backend.provider !== requested,
    configured: true,
  };
}
