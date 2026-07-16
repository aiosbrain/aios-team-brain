/**
 * Shared LLM token-budget helpers — the single definition of reasoning headroom, used by ALL three
 * sanctioned transports (lib/llm/complete, lib/chat/title, lib/query/claude). #281 added headroom to
 * only `complete.ts`; a reasoning model (e.g. OpenRouter `qwen/qwen3.7-plus`) still starved the title
 * and streaming-answer paths, which call the chat-completions endpoint directly.
 *
 * Reasoning models spend completion tokens on HIDDEN reasoning BEFORE any answer, and `max_tokens`
 * caps reasoning+answer TOGETHER. With only the answer-sized budget, reasoning can consume all of it →
 * empty/truncated output. Adding headroom on top is FREE for non-reasoning models (you're billed only
 * for tokens generated) and unbreaks reasoning ones. Override with LLM_REASONING_HEADROOM_TOKENS.
 */
const RAW_HEADROOM = Number(process.env.LLM_REASONING_HEADROOM_TOKENS);
export const REASONING_HEADROOM_TOKENS = Number.isFinite(RAW_HEADROOM) && RAW_HEADROOM >= 0 ? RAW_HEADROOM : 6000;

/** The `max_tokens` to send for a given answer budget: answer + reasoning headroom. */
export function completionMaxTokens(answerBudget: number): number {
  return answerBudget + REASONING_HEADROOM_TOKENS;
}

/**
 * A non-OK completion response whose status+body indicate the request exceeded the model's output /
 * context ceiling — i.e. the headroom pushed `max_tokens` past what this model accepts. The caller
 * retries once WITHOUT headroom so a ceiling-constrained small model doesn't hard-fail (the inverse
 * of the starvation the headroom fixes). Provider messages vary; match the common shapes.
 */
export function looksLikeTokenLimitError(status: number, body: string): boolean {
  if (status !== 400 && status !== 422) return false;
  return /max[_ ]?tokens|max_completion_tokens|maximum context|context length|too many tokens|reduce (?:the )?(?:length|tokens)/i.test(
    body
  );
}
