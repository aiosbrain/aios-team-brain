/**
 * Answering-LLM backend selection. A single pure function so the answer stream (lib/query/claude)
 * and the title generator (lib/chat/title) pick the SAME backend.
 *
 * Two modes:
 *   • AUTO (no explicit override, `activeProvider` null): precedence
 *       1. OpenRouter — a per-team key configured in Admin → Integrations (OpenAI-compatible gateway).
 *       2. LLM_BASE_URL env — a self-hosted OpenAI-compatible endpoint (Ollama/Hermes/llama.cpp).
 *       3. Anthropic — the default cloud path (per-team key or the SDK's env key).
 *     Note AUTO never routes to OpenAI-cloud even if an OpenAI key is set — that key is used for
 *     embeddings/compat, so switching answers onto it must be an explicit choice (no silent change).
 *   • EXPLICIT OVERRIDE (`activeProvider` set by the admin, `teams.answering_provider`): force that
 *     backend when it's configured; if the chosen backend has no key/endpoint, fall back to AUTO
 *     (the caller/UI surfaces the fallback rather than erroring the query box).
 *
 * OpenRouter, OpenAI-cloud and LLM_BASE_URL share the OpenAI-compatible wire shape, so callers treat
 * them as one streaming path; only Anthropic differs. Every backend carries a `provider` tag + a
 * `model`, so the UI can show exactly which model is answering.
 */

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
export const OPENAI_BASE_URL = "https://api.openai.com/v1";
/** Sensible default when a team enables OpenRouter without picking a model. Admin can override. */
export const DEFAULT_OPENROUTER_MODEL = "openai/gpt-4o-mini";
/** Default model for a bare LLM_BASE_URL endpoint (kept from the original claude.ts constant). */
export const DEFAULT_LOCAL_MODEL = "llama3.1-8b-64k:latest";
/** Default answer model for the Anthropic cloud backend (was hardcoded in claude.ts). */
export const DEFAULT_ANTHROPIC_MODEL = "claude-opus-4-8";
/** Default answer model for the OpenAI-cloud backend. */
export const DEFAULT_OPENAI_MODEL = "gpt-4o";

/** The answering backends an admin can force via `teams.answering_provider`. */
export type AnsweringProvider = "anthropic" | "openai" | "openrouter" | "local";

export interface LlmBackendEnv {
  LLM_BASE_URL?: string;
  LLM_MODEL?: string;
}

export interface LlmBackendKeys {
  anthropicKey?: string | null;
  anthropicModel?: string | null;
  openaiKey?: string | null;
  openaiModel?: string | null;
  openrouterKey?: string | null;
  openrouterModel?: string | null;
  /** Explicit override (`teams.answering_provider`); null/undefined = auto precedence. */
  activeProvider?: AnsweringProvider | null;
  /**
   * Optional distinct model for reasoning-heavy tasks (`teams.reasoning_model`). When set, a
   * `role: "reasoning"` selection uses it instead of the query model. Null/undefined → reasoning
   * tasks reuse the query model.
   */
  reasoningModel?: string | null;
  /**
   * Optional distinct PROVIDER for the reasoning model (`teams.reasoning_provider`). When set (and
   * configured), a reasoning-role call runs on THIS provider's backend+key with `reasoningModel` —
   * so reasoning can run on a different provider than answering (e.g. answer on OpenAI, reason on
   * OpenRouter). Null/undefined → reasoning reuses the ANSWERING backend, just swapping the model.
   */
  reasoningProvider?: AnsweringProvider | null;
}

/** Which model to select: the default interactive/extraction model, or the reasoning model. */
export type LlmRole = "query" | "reasoning";

/**
 * Whether chain-of-thought reasoning should be left ON for this call. TRUE only when a reasoning-role
 * task actually resolved to a DISTINCT reasoning model (`teams.reasoning_model` set). When it's unset,
 * `role:"reasoning"` falls back to the QUERY model (see selectLlmBackend) — and if that model is itself
 * a reasoning model, leaving reasoning on lets it spend the whole token budget on hidden thinking and
 * return empty (the starvation that blanks the Learning arcs; the query role turns reasoning off for
 * exactly this reason). So a fallen-back reasoning role is treated like the query role: reasoning OFF.
 * Single source of truth for the reasoning toggle — used by both selectLlmBackend (model swap) and the
 * completion primitive (the `reasoning:{enabled:false}` flag).
 */
export function reasoningActive(role: LlmRole | undefined, keys: LlmBackendKeys): boolean {
  return role === "reasoning" && nonEmpty(keys.reasoningModel);
}

export type LlmBackend =
  | { kind: "openrouter"; provider: "openrouter"; baseUrl: string; model: string; apiKey: string; headers: Record<string, string> }
  | { kind: "openai-compatible"; provider: "openai" | "local"; baseUrl: string; model: string; apiKey: string | null }
  | { kind: "anthropic"; provider: "anthropic"; model: string; apiKey: string | null };

const nonEmpty = (s: string | null | undefined): s is string => !!s && s.trim().length > 0;
const pick = (chosen: string | null | undefined, fallback: string): string =>
  nonEmpty(chosen) ? chosen.trim() : fallback;

/** Build the candidate backend for one provider, or null when it isn't configured. */
function candidate(
  provider: AnsweringProvider,
  env: LlmBackendEnv,
  keys: LlmBackendKeys
): LlmBackend | null {
  switch (provider) {
    case "openrouter":
      return nonEmpty(keys.openrouterKey)
        ? {
            kind: "openrouter",
            provider: "openrouter",
            baseUrl: OPENROUTER_BASE_URL,
            model: pick(keys.openrouterModel, DEFAULT_OPENROUTER_MODEL),
            apiKey: keys.openrouterKey.trim(),
            // OpenRouter uses these for attribution/analytics; optional, so a static title is enough.
            headers: { "X-Title": "AIOS Team Brain" },
          }
        : null;
    case "openai":
      return nonEmpty(keys.openaiKey)
        ? {
            kind: "openai-compatible",
            provider: "openai",
            baseUrl: OPENAI_BASE_URL,
            model: pick(keys.openaiModel, DEFAULT_OPENAI_MODEL),
            apiKey: keys.openaiKey.trim(),
          }
        : null;
    case "local":
      return nonEmpty(env.LLM_BASE_URL)
        ? {
            kind: "openai-compatible",
            provider: "local",
            baseUrl: env.LLM_BASE_URL,
            model: pick(env.LLM_MODEL, DEFAULT_LOCAL_MODEL),
            apiKey: keys.openaiKey ?? null,
          }
        : null;
    case "anthropic":
      // Always available: a per-team key wins, else the SDK reads ANTHROPIC_API_KEY from the env.
      return {
        kind: "anthropic",
        provider: "anthropic",
        model: pick(keys.anthropicModel, DEFAULT_ANTHROPIC_MODEL),
        apiKey: keys.anthropicKey ?? null,
      };
  }
}

/**
 * Choose the backend from env + per-team keys + the optional explicit override. Deterministic.
 * An override is honored only when its backend is configured; otherwise it falls through to the
 * auto precedence (OpenRouter → LLM_BASE_URL → Anthropic). `anthropic` is always available, so
 * auto never returns null.
 */
export function selectLlmBackend(
  env: LlmBackendEnv,
  keys: LlmBackendKeys,
  opts?: { role?: LlmRole }
): LlmBackend {
  const backend =
    (keys.activeProvider ? candidate(keys.activeProvider, env, keys) : null) ??
    candidate("openrouter", env, keys) ??
    candidate("local", env, keys) ??
    candidate("anthropic", env, keys)!;

  // For a reasoning-role task, use the team's distinct reasoning model. It runs on its OWN provider
  // (`reasoning_provider`) when that provider is configured, so reasoning can differ from answering in
  // BOTH provider and model; otherwise it reuses the answering `backend`, just swapping the model.
  // Unset reasoning model → `reasoningActive` is false, the query model on `backend` stands, and the
  // completion primitive turns reasoning OFF (so a query model that happens to be a reasoning model
  // can't starve the answer — the whole point).
  if (reasoningActive(opts?.role, keys)) {
    const reasoningBackend = (keys.reasoningProvider ? candidate(keys.reasoningProvider, env, keys) : null) ?? backend;
    return { ...reasoningBackend, model: keys.reasoningModel!.trim() };
  }
  return backend;
}

/**
 * Did an explicit override get honored, or did it fall back? Pure helper for the admin indicator —
 * returns the requested provider, the effective provider+model actually in use, and whether they
 * diverged (the chosen backend wasn't configured). `requested` is null in AUTO mode.
 */
export function describeAnswering(
  env: LlmBackendEnv,
  keys: LlmBackendKeys
): { requested: AnsweringProvider | null; provider: AnsweringProvider; model: string; usedFallback: boolean } {
  const backend = selectLlmBackend(env, keys);
  const requested = keys.activeProvider ?? null;
  return {
    requested,
    provider: backend.provider,
    model: backend.model,
    usedFallback: requested !== null && backend.provider !== requested,
  };
}

/**
 * Describe the effective REASONING backend for the admin indicator. `enabled` is false when no
 * distinct reasoning model is set (reasoning-role tasks reuse the query model — nothing to show).
 * When enabled, returns the provider+model actually used for reasoning and whether the requested
 * reasoning provider fell back (its backend wasn't configured, so it borrowed the answering provider).
 */
export function describeReasoning(
  env: LlmBackendEnv,
  keys: LlmBackendKeys
): { enabled: boolean; requested: AnsweringProvider | null; provider: AnsweringProvider; model: string; usedFallback: boolean } {
  const answering = selectLlmBackend(env, keys).provider;
  if (!reasoningActive("reasoning", keys)) {
    return { enabled: false, requested: null, provider: answering, model: "", usedFallback: false };
  }
  const backend = selectLlmBackend(env, keys, { role: "reasoning" });
  const requested = keys.reasoningProvider ?? null;
  return {
    enabled: true,
    requested,
    provider: backend.provider,
    model: backend.model,
    usedFallback: requested !== null && backend.provider !== requested,
  };
}
