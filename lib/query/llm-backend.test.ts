import { describe, expect, it } from "vitest";
import {
  selectLlmBackend,
  describeAnswering,
  OPENROUTER_BASE_URL,
  OPENAI_BASE_URL,
  DEFAULT_OPENROUTER_MODEL,
  DEFAULT_ANTHROPIC_MODEL,
  DEFAULT_OPENAI_MODEL,
} from "./llm-backend";

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

  it("carries the Anthropic answer model — team-chosen, else the default", () => {
    expect(selectLlmBackend({}, {}).model).toBe(DEFAULT_ANTHROPIC_MODEL);
    expect(selectLlmBackend({}, { anthropicModel: "claude-haiku-4-5-20251001" }).model).toBe(
      "claude-haiku-4-5-20251001"
    );
  });

  it("tags every backend with its provider so the UI can name what's answering", () => {
    expect(selectLlmBackend({}, {}).provider).toBe("anthropic");
    expect(selectLlmBackend({}, { openrouterKey: "sk-or" }).provider).toBe("openrouter");
    expect(selectLlmBackend({ LLM_BASE_URL: "http://x/v1" }, {}).provider).toBe("local");
  });
});

describe("selectLlmBackend — explicit override (teams.answering_provider)", () => {
  it("AUTO never routes to OpenAI-cloud just because an OpenAI key exists (no silent switch)", () => {
    // The OpenAI key is for embeddings/compat; answering stays Anthropic unless forced.
    const b = selectLlmBackend({}, { openaiKey: "sk-x", anthropicKey: "sk-ant" });
    expect(b.provider).toBe("anthropic");
  });

  it("forces OpenAI-cloud when selected + keyed (base url + model)", () => {
    const b = selectLlmBackend(
      {},
      { activeProvider: "openai", openaiKey: "sk-x", openaiModel: "gpt-4.1", anthropicKey: "sk-ant" }
    );
    expect(b.kind).toBe("openai-compatible");
    expect(b.provider).toBe("openai");
    expect(b.baseUrl).toBe(OPENAI_BASE_URL);
    expect(b.model).toBe("gpt-4.1");
  });

  it("defaults the OpenAI model when forced without one", () => {
    const b = selectLlmBackend({}, { activeProvider: "openai", openaiKey: "sk-x" });
    expect(b.provider).toBe("openai");
    expect(b.model).toBe(DEFAULT_OPENAI_MODEL);
  });

  it("forces Anthropic even when OpenRouter is configured (override beats precedence)", () => {
    const b = selectLlmBackend({}, { activeProvider: "anthropic", openrouterKey: "sk-or" });
    expect(b.provider).toBe("anthropic");
  });

  it("forces the local endpoint when selected + LLM_BASE_URL is set", () => {
    const b = selectLlmBackend(
      { LLM_BASE_URL: "http://ollama/v1", LLM_MODEL: "llama3" },
      { activeProvider: "local", openrouterKey: "sk-or" }
    );
    expect(b.provider).toBe("local");
    expect(b.baseUrl).toBe("http://ollama/v1");
  });

  it("falls back to AUTO when the forced backend isn't configured", () => {
    // Forced OpenAI, but no OpenAI key → precedence picks OpenRouter (configured).
    const b = selectLlmBackend({}, { activeProvider: "openai", openrouterKey: "sk-or" });
    expect(b.provider).toBe("openrouter");
  });
});

describe("describeAnswering — the admin indicator", () => {
  it("reports the resolved provider+model and no fallback in AUTO mode", () => {
    const d = describeAnswering({}, { anthropicModel: "claude-x" });
    expect(d).toEqual({ requested: null, provider: "anthropic", model: "claude-x", usedFallback: false });
  });

  it("flags usedFallback when a forced backend is unavailable", () => {
    const d = describeAnswering({}, { activeProvider: "openai", anthropicKey: "sk-ant" });
    expect(d.requested).toBe("openai");
    expect(d.provider).toBe("anthropic");
    expect(d.usedFallback).toBe(true);
  });

  it("honored override is not a fallback", () => {
    const d = describeAnswering({}, { activeProvider: "openai", openaiKey: "sk-x" });
    expect(d).toEqual({ requested: "openai", provider: "openai", model: DEFAULT_OPENAI_MODEL, usedFallback: false });
  });
});
