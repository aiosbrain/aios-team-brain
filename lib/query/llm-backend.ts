/**
 * Answering-LLM backend selection. A single pure function so the answer stream (lib/query/claude)
 * and the title generator (lib/chat/title) pick the SAME backend. Precedence:
 *   1. OpenRouter — a per-team key configured in Admin → Integrations (OpenAI-compatible gateway;
 *      the team also picks a model slug). Lets a team switch providers from the dashboard, no env.
 *   2. LLM_BASE_URL env — a self-hosted OpenAI-compatible endpoint (Ollama/Hermes/llama.cpp).
 *   3. Anthropic — the default cloud path (per-team key or the SDK's env key).
 * OpenRouter and LLM_BASE_URL share the OpenAI-compatible wire shape, so callers treat both as one
 * streaming path; only Anthropic differs.
 */

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
/** Sensible default when a team enables OpenRouter without picking a model. Admin can override. */
export const DEFAULT_OPENROUTER_MODEL = "openai/gpt-4o-mini";
/** Default model for a bare LLM_BASE_URL endpoint (kept from the original claude.ts constant). */
export const DEFAULT_LOCAL_MODEL = "llama3.1-8b-64k:latest";

export interface LlmBackendEnv {
  LLM_BASE_URL?: string;
  LLM_MODEL?: string;
}

export interface LlmBackendKeys {
  anthropicKey?: string | null;
  openaiKey?: string | null;
  openrouterKey?: string | null;
  openrouterModel?: string | null;
}

export type LlmBackend =
  | { kind: "openrouter"; baseUrl: string; model: string; apiKey: string; headers: Record<string, string> }
  | { kind: "openai-compatible"; baseUrl: string; model: string; apiKey: string | null }
  | { kind: "anthropic"; apiKey: string | null };

const nonEmpty = (s: string | null | undefined): s is string => !!s && s.trim().length > 0;

/** Choose the backend from env + per-team keys. Deterministic; see the precedence above. */
export function selectLlmBackend(env: LlmBackendEnv, keys: LlmBackendKeys): LlmBackend {
  if (nonEmpty(keys.openrouterKey)) {
    return {
      kind: "openrouter",
      baseUrl: OPENROUTER_BASE_URL,
      model: nonEmpty(keys.openrouterModel) ? keys.openrouterModel : DEFAULT_OPENROUTER_MODEL,
      apiKey: keys.openrouterKey.trim(),
      // OpenRouter uses these for attribution/analytics; optional, so a static title is enough.
      headers: { "X-Title": "AIOS Team Brain" },
    };
  }
  if (nonEmpty(env.LLM_BASE_URL)) {
    return {
      kind: "openai-compatible",
      baseUrl: env.LLM_BASE_URL,
      model: nonEmpty(env.LLM_MODEL) ? env.LLM_MODEL : DEFAULT_LOCAL_MODEL,
      apiKey: keys.openaiKey ?? null,
    };
  }
  return { kind: "anthropic", apiKey: keys.anthropicKey ?? null };
}
