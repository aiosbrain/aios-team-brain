import { describe, expect, it } from "vitest";
import { selectLlmBackend, OPENROUTER_BASE_URL, DEFAULT_OPENROUTER_MODEL } from "./llm-backend";

/**
 * Spec: the answering LLM backend is chosen by an explicit precedence so a team can switch providers
 * from the dashboard without env changes:
 *   1. OpenRouter (per-team key set)  → OpenAI-compatible gateway, team-chosen model
 *   2. LLM_BASE_URL env               → a local/self-hosted OpenAI-compatible endpoint
 *   3. else                            → Anthropic (per-team key or env)
 * Pure + deterministic so both the answer stream and the title generator select identically.
 */

describe("selectLlmBackend", () => {
  it("routes to OpenRouter when a team key is set — beating LLM_BASE_URL", () => {
    const b = selectLlmBackend(
      { LLM_BASE_URL: "http://localhost:11434/v1", LLM_MODEL: "llama3" },
      { openrouterKey: "sk-or-1", openrouterModel: "anthropic/claude-sonnet-4", openaiKey: "sk-x" }
    );
    expect(b.kind).toBe("openrouter");
    expect(b.baseUrl).toBe(OPENROUTER_BASE_URL);
    expect(b.model).toBe("anthropic/claude-sonnet-4");
    expect(b.apiKey).toBe("sk-or-1");
  });

  it("defaults the OpenRouter model when the team hasn't chosen one", () => {
    const b = selectLlmBackend({}, { openrouterKey: "sk-or-1" });
    expect(b.kind).toBe("openrouter");
    expect(b.model).toBe(DEFAULT_OPENROUTER_MODEL);
  });

  it("uses the LLM_BASE_URL endpoint when no OpenRouter key is set", () => {
    const b = selectLlmBackend(
      { LLM_BASE_URL: "http://localhost:11434/v1", LLM_MODEL: "llama3" },
      { openaiKey: "sk-x" }
    );
    expect(b.kind).toBe("openai-compatible");
    expect(b.baseUrl).toBe("http://localhost:11434/v1");
    expect(b.model).toBe("llama3");
    expect(b.apiKey).toBe("sk-x");
  });

  it("falls back to Anthropic when neither OpenRouter nor LLM_BASE_URL is configured", () => {
    const b = selectLlmBackend({}, { anthropicKey: "sk-ant" });
    expect(b.kind).toBe("anthropic");
    expect(b.apiKey).toBe("sk-ant");
  });

  it("ignores a blank/whitespace OpenRouter key (treats as unset)", () => {
    const b = selectLlmBackend({ LLM_BASE_URL: "http://x/v1" }, { openrouterKey: "   " });
    expect(b.kind).toBe("openai-compatible");
  });
});
