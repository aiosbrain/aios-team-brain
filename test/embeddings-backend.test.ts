import { describe, expect, it } from "vitest";
import {
  selectEmbeddingBackend,
  describeEmbedding,
  normalizeEmbeddingProvider,
} from "@/lib/query/embeddings-backend";
import { canonicalEmbeddingModel, isCuratedEmbeddingModel, EMBEDDING_MODELS, EMBEDDING_DIM } from "@/lib/api/schemas";

/**
 * The embeddings backend is the per-team, Admin-configurable analog of `selectLlmBackend`. These pin
 * the pure precedence (team pick → env self-host → off), the keyless-env tolerance (Ollama), the
 * fallback indicator, and the corruption guards (curated 1536-dim list + canonical vector-space id).
 */

describe("selectEmbeddingBackend precedence", () => {
  it("uses the picked provider when its key is set (OpenRouter → openrouter.ai + default model)", () => {
    const b = selectEmbeddingBackend({ activeProvider: "openrouter", openrouterKey: "or-key" });
    expect(b).toEqual({
      provider: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      model: "openai/text-embedding-3-small",
      apiKey: "or-key",
      dim: 1536,
    });
  });

  it("honors an explicit team model over the provider default", () => {
    const b = selectEmbeddingBackend({ activeProvider: "openai", openaiKey: "k", model: "text-embedding-3-small" });
    expect(b?.provider).toBe("openai");
    expect(b?.baseUrl).toBe("https://api.openai.com/v1");
    expect(b?.model).toBe("text-embedding-3-small");
  });

  it("falls through to the env endpoint when the picked provider has no key", () => {
    const b = selectEmbeddingBackend({
      activeProvider: "openrouter", // no openrouterKey
      envUrl: "https://api.openai.com/v1",
      envModel: "text-embedding-3-small",
      envKey: "env-openai",
    });
    expect(b?.provider).toBe("env");
    expect(b?.apiKey).toBe("env-openai");
  });

  it("keeps keyless self-hosts working — env endpoint with no key resolves apiKey='local' (Ollama)", () => {
    const b = selectEmbeddingBackend({ envUrl: "http://localhost:11434/v1" });
    expect(b).toEqual({
      provider: "env",
      baseUrl: "http://localhost:11434/v1",
      model: "text-embedding-3-small",
      apiKey: "local",
      dim: 1536,
    });
  });

  it("honors a custom self-host dimension (EMBEDDINGS_DIM) for the env tier", () => {
    const b = selectEmbeddingBackend({ envUrl: "http://localhost:11434/v1", envModel: "nomic-embed-text", envDim: 768 });
    expect(b?.dim).toBe(768);
  });

  it("a curated pick is always locked to the 1536-dim index regardless of envDim", () => {
    const b = selectEmbeddingBackend({ activeProvider: "openai", openaiKey: "k", envDim: 768 });
    expect(b?.dim).toBe(1536);
  });

  it("is OFF (null) when nothing is configured — default install stays pure-FTS", () => {
    expect(selectEmbeddingBackend({})).toBeNull();
  });
});

describe("describeEmbedding indicator", () => {
  it("flags usedFallback when the picked provider isn't configured but env is", () => {
    const d = describeEmbedding({ activeProvider: "openai", envUrl: "https://api.openai.com/v1", envKey: "k" });
    expect(d.configured).toBe(true);
    expect(d.requested).toBe("openai");
    expect(d.provider).toBe("env");
    expect(d.usedFallback).toBe(true);
  });

  it("no fallback when the pick resolves; not configured when fully off", () => {
    expect(describeEmbedding({ activeProvider: "openai", openaiKey: "k" }).usedFallback).toBe(false);
    expect(describeEmbedding({}).configured).toBe(false);
  });
});

describe("corruption guards", () => {
  it("normalizeEmbeddingProvider rejects non-embedding providers", () => {
    expect(normalizeEmbeddingProvider("openrouter")).toBe("openrouter");
    expect(normalizeEmbeddingProvider("anthropic")).toBeNull();
    expect(normalizeEmbeddingProvider(null)).toBeNull();
  });

  it("canonicalEmbeddingModel makes OpenAI-direct and OpenRouter-routed 3-small the SAME space", () => {
    expect(canonicalEmbeddingModel("openai/text-embedding-3-small")).toBe("text-embedding-3-small");
    expect(canonicalEmbeddingModel("text-embedding-3-small")).toBe("text-embedding-3-small");
    // a genuinely different model is a different space even at the same 1536 dims
    expect(canonicalEmbeddingModel("text-embedding-ada-002")).not.toBe(
      canonicalEmbeddingModel("text-embedding-3-small")
    );
  });

  it("only curated 1536-dim models pass isCuratedEmbeddingModel", () => {
    expect(isCuratedEmbeddingModel("openai", "text-embedding-3-small")).toBe(true);
    expect(isCuratedEmbeddingModel("openrouter", "openai/text-embedding-3-small")).toBe(true);
    expect(isCuratedEmbeddingModel("openai", "text-embedding-3-large")).toBe(false); // 3072-dim
    expect(isCuratedEmbeddingModel("openai", "text-embedding-ada-002")).toBe(false);
  });

  it("every curated model is declared for the fixed index dimension", () => {
    expect(EMBEDDING_DIM).toBe(1536);
    // one model per provider so the UI can't introduce a second vector space
    expect(EMBEDDING_MODELS.openai).toHaveLength(1);
    expect(EMBEDDING_MODELS.openrouter).toHaveLength(1);
  });
});
