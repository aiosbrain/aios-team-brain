import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { embeddingAuthKey } from "@/lib/query/embeddings";

/**
 * The embeddings key precedence is the "provider de-risk" contract: a DEDICATED `EMBEDDINGS_API_KEY`
 * lets semantic search run on a SEPARATE account from the answer LLM, so exhausting one provider's
 * quota can't silently kill the other. These pin that precedence (pure — no live endpoint needed).
 * `embeddingAuthKey` reads env at call time, so mutating process.env here is honest.
 */
describe("embeddingAuthKey precedence (provider de-risk)", () => {
  const saved = { emb: process.env.EMBEDDINGS_API_KEY, oai: process.env.OPENAI_API_KEY };

  beforeEach(() => {
    delete process.env.EMBEDDINGS_API_KEY;
    delete process.env.OPENAI_API_KEY;
  });
  afterEach(() => {
    // Restore exactly (a deleted var must stay deleted, not become the string "undefined").
    if (saved.emb === undefined) delete process.env.EMBEDDINGS_API_KEY;
    else process.env.EMBEDDINGS_API_KEY = saved.emb;
    if (saved.oai === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = saved.oai;
  });

  it("caller-resolved key wins over every env (it already encodes the right choice)", () => {
    process.env.EMBEDDINGS_API_KEY = "env-embed";
    process.env.OPENAI_API_KEY = "env-openai";
    expect(embeddingAuthKey("per-team-key")).toBe("per-team-key");
  });

  it("dedicated EMBEDDINGS_API_KEY decouples from the shared OPENAI_API_KEY when no caller key", () => {
    process.env.EMBEDDINGS_API_KEY = "dedicated-embed";
    process.env.OPENAI_API_KEY = "shared-openai";
    expect(embeddingAuthKey(null)).toBe("dedicated-embed");
    expect(embeddingAuthKey(undefined)).toBe("dedicated-embed");
  });

  it("falls back to the shared OPENAI_API_KEY (today's default) when no dedicated key", () => {
    process.env.OPENAI_API_KEY = "shared-openai";
    expect(embeddingAuthKey(null)).toBe("shared-openai");
  });

  it("falls back to 'local' for keyless self-hosted servers (Ollama/llama.cpp)", () => {
    expect(embeddingAuthKey(null)).toBe("local");
  });
});
