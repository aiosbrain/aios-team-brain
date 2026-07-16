import { describe, expect, it } from "vitest";
import { selectLlmBackend } from "@/lib/query/llm-backend";

// Spec (two-model config): a team can set a distinct reasoning model. `role: "reasoning"` selects it
// (on whatever provider answers); unset or `role: "query"` uses the query model. This is what lets
// arc synthesis use a reasoning model while extraction stays on a fast, direct one.

const OR = {
  openrouterKey: "or",
  openrouterModel: "openai/gpt-4o-mini",
  activeProvider: "openrouter" as const,
};

describe("selectLlmBackend role → model", () => {
  it("query role (default) uses the query model", () => {
    expect(selectLlmBackend({}, OR).model).toBe("openai/gpt-4o-mini");
    expect(selectLlmBackend({}, OR, { role: "query" }).model).toBe("openai/gpt-4o-mini");
  });

  it("reasoning role uses the reasoning model when set", () => {
    const b = selectLlmBackend({}, { ...OR, reasoningModel: "qwen/qwen3.7-plus" }, { role: "reasoning" });
    expect(b.provider).toBe("openrouter"); // same provider
    expect(b.model).toBe("qwen/qwen3.7-plus");
  });

  it("reasoning role falls back to the query model when no reasoning model is set", () => {
    expect(selectLlmBackend({}, OR, { role: "reasoning" }).model).toBe("openai/gpt-4o-mini");
  });

  it("the reasoning model applies on whatever provider answers (here Anthropic auto-fallback)", () => {
    // No provider configured → auto lands on anthropic; reasoning role still swaps the model.
    const b = selectLlmBackend({}, { reasoningModel: "claude-sonnet-5" }, { role: "reasoning" });
    expect(b.kind).toBe("anthropic");
    expect(b.model).toBe("claude-sonnet-5");
  });
});
