import "server-only";

/**
 * Anthropic list prices (USD per token), Opus-class. Used to ESTIMATE the cost of an Anthropic
 * generation for the brain-spend meter when the provider doesn't hand back a real charge (unlike
 * OpenRouter, which reports the actual `usage.cost`). This is a rough meter value, not a bill —
 * recorded with `estimated=true`. Mirrors the constants in `lib/query/claude.ts` (the streaming
 * answer path); kept here so the non-streaming `completeText` primitive can estimate too.
 */
const ANTHROPIC_INPUT_PER_TOKEN = 5 / 1_000_000;
const ANTHROPIC_OUTPUT_PER_TOKEN = 25 / 1_000_000;

export function estimateAnthropicCostUsd(inputTokens: number, outputTokens: number): number {
  return inputTokens * ANTHROPIC_INPUT_PER_TOKEN + outputTokens * ANTHROPIC_OUTPUT_PER_TOKEN;
}

/** The `usage` block an OpenAI-compatible response returns — chat carries `completion_tokens`, an
 *  embeddings call carries only `total_tokens`; OpenRouter additionally reports the real `cost`. */
export interface OpenAiUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  cost?: number;
}

/**
 * OpenAI embedding list prices (USD per token) — used to ESTIMATE embedding spend when the provider
 * reports no `usage.cost` (OpenRouter reports the real charge; OpenAI direct does not). Keyed by a
 * model-name substring so a dated/suffixed id still matches. Small on purpose: a wrong table row is
 * worse than an honest "unpriced" $0, so only well-known models are listed.
 */
const EMBEDDING_PRICE_PER_TOKEN: { match: string; usdPerToken: number }[] = [
  { match: "text-embedding-3-small", usdPerToken: 0.02 / 1_000_000 },
  { match: "text-embedding-3-large", usdPerToken: 0.13 / 1_000_000 },
  { match: "text-embedding-ada-002", usdPerToken: 0.1 / 1_000_000 },
];

/** Estimated embedding cost from the price table, or null when the model isn't priced here. */
export function estimateEmbeddingCostUsd(model: string, tokens: number): number | null {
  const row = EMBEDDING_PRICE_PER_TOKEN.find((r) => model.toLowerCase().includes(r.match));
  return row ? tokens * row.usdPerToken : null;
}

export interface ResolvedCost {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  /** false = a real charge (provider-reported `usage.cost`, or an authoritative self-host $0);
   *  true = a price-table estimate OR an unpriced paid call recorded at $0 so it doesn't read as free. */
  estimated: boolean;
}

/**
 * Turn an OpenAI-compatible `usage` block into a ledger row's tokens + cost. The precedence mirrors
 * the `completeText` primitive so every metered path agrees:
 *   1. provider-reported `usage.cost` (OpenRouter) → the real charge, `estimated:false`.
 *   2. self-host (`local`/`env`) → genuinely $0, authoritative.
 *   3. an embedding on a priced model → price-table estimate, `estimated:true`.
 *   4. any other paid call with no reported charge → $0 but `estimated:true`, so an uncounted paid
 *      call never masquerades as an authoritative free one (it silently undercounts spend otherwise).
 * Tokens are ALWAYS recorded (even at $0) so volume is visible even where cost is unknown.
 */
export function resolveOpenAiCost(
  usage: OpenAiUsage | undefined,
  provider: string,
  model: string,
  kind: "chat" | "embedding"
): ResolvedCost {
  // Chat: input = prompt_tokens (never total — that would fold completion tokens into the input column).
  // Embedding: no completion half, so total_tokens is the input when prompt_tokens is absent.
  const inputTokens = usage?.prompt_tokens ?? (kind === "embedding" ? usage?.total_tokens : undefined) ?? 0;
  const outputTokens = usage?.completion_tokens ?? 0;
  if (typeof usage?.cost === "number") {
    return { inputTokens, outputTokens, costUsd: usage.cost, estimated: false };
  }
  if (provider === "local" || provider === "env") {
    return { inputTokens, outputTokens, costUsd: 0, estimated: false };
  }
  if (kind === "embedding") {
    const est = estimateEmbeddingCostUsd(model, usage?.total_tokens ?? inputTokens);
    if (est !== null) return { inputTokens, outputTokens, costUsd: est, estimated: true };
  }
  return { inputTokens, outputTokens, costUsd: 0, estimated: true };
}

/** Parse an OpenAI-compatible response body and resolve its ledger cost; null when the body isn't JSON
 *  or carries no `usage` (nothing to meter — an error body, or a provider that omitted usage). */
export function meterFromOpenAiResponse(
  text: string,
  provider: string,
  model: string,
  kind: "chat" | "embedding"
): ResolvedCost | null {
  let usage: OpenAiUsage | undefined;
  try {
    usage = (JSON.parse(text) as { usage?: OpenAiUsage }).usage;
  } catch {
    return null;
  }
  if (!usage) return null;
  return resolveOpenAiCost(usage, provider, model, kind);
}
