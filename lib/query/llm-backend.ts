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

/**
 * The backends the EXTRACTION role may use — Anthropic excluded, and this is load-bearing.
 *
 * The only consumer of this role today is the graph LLM proxy, and Graphiti extracts via
 * `beta.chat.completions.parse`: an OpenAI-shaped structured-output call. `graphChatTarget` therefore
 * refuses Anthropic outright, so allowing it here would let one dropdown make EVERY extraction call
 * 501 while Graphiti keeps answering `202` — a silently empty graph whose first signal is the stall
 * detector six hours later. Kept unrepresentable at all three layers instead (the
 * `teams_extraction_provider_check` CHECK, `setExtractionModel`, and the picker's option list).
 *
 * Widening this (if in-app `complete.ts` callers ever adopt the role, where Anthropic works fine) is a
 * trivial additive migration; narrowing it later is the release-breaking direction.
 */
export type ExtractionProvider = "openai" | "openrouter" | "local";

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
  /**
   * Optional distinct model for high-volume MACHINE extraction (`teams.extraction_model`) — today the
   * knowledge-graph leg via the proxy. When set, a `role: "extraction"` selection uses it instead of the
   * query model. Null/undefined → extraction reuses the answering model (the pre-role behaviour).
   *
   * The model is the activation switch: a provider without a model leaves the role off.
   */
  extractionModel?: string | null;
  /**
   * Optional distinct PROVIDER for the extraction model (`teams.extraction_provider`). Null/undefined
   * with a model set = "the answering backend, different model" — the cheapest useful case, and
   * deliberate. Set = extraction runs on that provider's own backend + key.
   */
  extractionProvider?: ExtractionProvider | null;
  /**
   * Optional CHEAPER model for the extraction calls the upstream itself marks as simple
   * (`teams.extraction_small_model`) — see `selectSmallExtractionBackend`.
   *
   * Deliberately has no `extractionSmallProvider` sibling: it rides the extraction backend's provider
   * and key. A second provider here would reintroduce the half-swap the extraction branch's WHOLE
   * fallback exists to prevent.
   */
  extractionSmallModel?: string | null;
}

/**
 * Which model to select: the default interactive model, the reasoning model, or the high-volume
 * machine-extraction model. `query` and `extraction` differ only in WHICH model they resolve —
 * neither ever turns chain-of-thought on (see `reasoningActive`).
 */
export type LlmRole = "query" | "reasoning" | "extraction";

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

/**
 * Whether a DISTINCT extraction model applies to this call. True only for `role: "extraction"` with
 * `teams.extraction_model` set — the model is the activation switch, so a provider chosen without a
 * model leaves the role off and extraction keeps using the answering model.
 */
export function extractionActive(role: LlmRole | undefined, keys: LlmBackendKeys): boolean {
  return role === "extraction" && nonEmpty(keys.extractionModel);
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

  // For an extraction-role task, use the team's cheap high-volume model. Same shape as reasoning above
  // with ONE deliberate difference: the fallback is WHOLE.
  //
  // A requested-but-unconfigurable extraction provider returns the answering backend AND the answering
  // MODEL — never the extraction model pointed at a backend that may not serve it. That half-swap (what
  // the reasoning branch above does) is a guaranteed 404 per call; for reasoning it costs one failed arc
  // synthesis, but for extraction EVERY call fails while Graphiti keeps answering `202` to the projector,
  // so the graph silently stops growing and the first signal is the stall detector six hours later. That
  // is the precise failure this whole stack spent a week chasing, so it must not be reachable by a
  // dropdown. `describeExtraction` surfaces the fallback on the admin card — silence would be a
  // cost setting that reverts unnoticed, i.e. a surprise bill.
  //
  // (Why the reasoning branch isn't converged onto this: `reasoningActive` is the single switch that
  // turns chain-of-thought ON and keys on `reasoningModel` being set, so falling reasoning back to the
  // answering MODEL would leave reasoning enabled over a model that may itself be a reasoning model —
  // the token starvation that blanked the Learning arcs. Fixing that means changing the reasoning
  // contract, which is its own change. See docs/design/graph-extraction-model.md.)
  if (extractionActive(opts?.role, keys)) {
    const own = keys.extractionProvider ? candidate(keys.extractionProvider, env, keys) : backend;
    if (!own) return backend;
    return { ...own, model: keys.extractionModel!.trim() };
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
 * Describe the effective EXTRACTION backend for the admin indicator. `enabled` is false when no
 * distinct extraction model is set (extraction reuses the answering model — nothing to show).
 *
 * `usedFallback` is not cosmetic here: extraction is where nearly all the spend is, so a requested
 * cheap model that silently reverted to the expensive answering model is a surprise bill. This is the
 * one surface that says so.
 */
export function describeExtraction(
  env: LlmBackendEnv,
  keys: LlmBackendKeys
): { enabled: boolean; requested: ExtractionProvider | null; provider: AnsweringProvider; model: string; usedFallback: boolean } {
  const answering = selectLlmBackend(env, keys).provider;
  if (!extractionActive("extraction", keys)) {
    return { enabled: false, requested: null, provider: answering, model: "", usedFallback: false };
  }
  const backend = selectLlmBackend(env, keys, { role: "extraction" });
  const requested = keys.extractionProvider ?? null;
  return {
    enabled: true,
    requested,
    provider: backend.provider,
    model: backend.model,
    usedFallback: requested !== null && backend.provider !== requested,
  };
}

/**
 * The backend for extraction calls Graphiti itself marks as simple, or NULL when small routing is
 * off. Null is the safe answer everywhere — the caller then uses the ordinary extraction target, so
 * every unconfigured or degraded state costs today's money rather than degrading the graph.
 *
 * Three ways it is off, and each is deliberate:
 *
 *  1. **No small model set.** The feature is opt-in; an operator who sets nothing gets byte-identical
 *     behaviour.
 *  2. **The extraction role itself is off** (`extractionModel` unset, so extraction reuses the
 *     ANSWERING model). Layering a cheap model beneath a role the operator never enabled would
 *     downgrade calls they never chose to treat as extraction.
 *  3. **The extraction target FELL BACK** — a requested extraction provider that isn't configured.
 *     The extraction branch falls back WHOLE precisely because the extraction model on a backend
 *     that may not serve it is a guaranteed 404 per call, and Graphiti keeps answering 202 while the
 *     graph silently stops growing. The small model inherits that trap exactly, so it switches off
 *     rather than riding a fallback.
 *
 * It rides the extraction backend's provider and key by construction (spread, model replaced), so it
 * cannot be pointed at a backend nobody configured.
 */
export function selectSmallExtractionBackend(env: LlmBackendEnv, keys: LlmBackendKeys): LlmBackend | null {
  if (!nonEmpty(keys.extractionSmallModel)) return null; // (1)
  if (!extractionActive("extraction", keys)) return null; // (2)
  const extraction = selectLlmBackend(env, keys, { role: "extraction" });
  const requested = keys.extractionProvider ?? null;
  if (requested !== null && extraction.provider !== requested) return null; // (3)
  return { ...extraction, model: keys.extractionSmallModel.trim() };
}

/**
 * Describe the effective SMALL extraction backend for the admin indicator.
 *
 * `inert` is the point of this function, not `enabled`. A small model that is set but not in effect
 * is a cost setting that reverted unnoticed — the exact surprise-bill shape `describeExtraction`'s
 * `usedFallback` was written to make visible. Shipping the setter without this indicator would
 * recreate that gap on a new setting.
 */
export function describeSmallExtraction(
  env: LlmBackendEnv,
  keys: LlmBackendKeys
): { enabled: boolean; inert: boolean; model: string; provider: AnsweringProvider | null } {
  const requestedModel = nonEmpty(keys.extractionSmallModel) ? keys.extractionSmallModel.trim() : "";
  const backend = selectSmallExtractionBackend(env, keys);
  if (backend) return { enabled: true, inert: false, model: backend.model, provider: backend.provider };
  // Configured but not in effect → inert. Nothing configured → nothing to warn about.
  return { enabled: false, inert: requestedModel !== "", model: requestedModel, provider: null };
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
