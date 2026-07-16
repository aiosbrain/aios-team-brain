import { describe, it, expect } from "vitest";
import { completionMaxTokens, looksLikeTokenLimitError, REASONING_HEADROOM_TOKENS } from "@/lib/llm/limits";

describe("completionMaxTokens", () => {
  it("adds reasoning headroom on top of the answer budget", () => {
    expect(completionMaxTokens(24)).toBe(24 + REASONING_HEADROOM_TOKENS);
    expect(completionMaxTokens(4096)).toBe(4096 + REASONING_HEADROOM_TOKENS);
  });
});

describe("looksLikeTokenLimitError", () => {
  it("matches 400/422 responses whose body names a token/context ceiling", () => {
    expect(looksLikeTokenLimitError(400, "max_tokens is too large for this model")).toBe(true);
    expect(looksLikeTokenLimitError(400, "This model's maximum context length is 8192 tokens")).toBe(true);
    expect(looksLikeTokenLimitError(422, "max_completion_tokens exceeds the limit")).toBe(true);
    expect(looksLikeTokenLimitError(400, "please reduce the length of the messages")).toBe(true);
  });
  it("does NOT match unrelated errors or other statuses (so we don't retry a real failure)", () => {
    expect(looksLikeTokenLimitError(401, "invalid api key")).toBe(false);
    expect(looksLikeTokenLimitError(429, "rate limit exceeded")).toBe(false);
    expect(looksLikeTokenLimitError(500, "internal error")).toBe(false);
    expect(looksLikeTokenLimitError(400, "content policy violation")).toBe(false);
  });
});
