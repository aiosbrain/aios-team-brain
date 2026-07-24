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
