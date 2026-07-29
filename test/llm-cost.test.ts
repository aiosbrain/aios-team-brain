import { describe, expect, it } from "vitest";
import {
  resolveOpenAiCost,
  meterFromOpenAiResponse,
  estimateEmbeddingCostUsd,
} from "@/lib/llm/cost";

/**
 * The cost resolver is the parse/format boundary every metered path shares (Q&A, graph extraction,
 * embeddings). Its whole job is to decide, from one `usage` block, what a ledger row's tokens + cost
 * are and whether that cost is REAL or an estimate. The specs below are the contract: a provider-
 * reported charge is authoritative, a self-host call is a real $0, a priced embedding is an estimate,
 * and — the one that matters for honesty — a paid call with no reported charge is $0-but-flagged, never
 * a silent authoritative $0 that undercounts spend.
 */
describe("resolveOpenAiCost", () => {
  it("uses the provider-reported charge as REAL (OpenRouter usage.cost)", () => {
    const c = resolveOpenAiCost({ prompt_tokens: 100, completion_tokens: 50, cost: 0.0123 }, "openrouter", "qwen/x", "chat");
    expect(c).toEqual({ inputTokens: 100, outputTokens: 50, costUsd: 0.0123, estimated: false });
  });

  it("treats a self-host endpoint (local/env) as an authoritative $0", () => {
    for (const provider of ["local", "env"]) {
      const c = resolveOpenAiCost({ prompt_tokens: 10, total_tokens: 10 }, provider, "m", "embedding");
      expect(c.costUsd).toBe(0);
      expect(c.estimated).toBe(false); // a real free call, not an unknown one
    }
  });

  it("ESTIMATES a priced embedding model from the table (estimated=true)", () => {
    const c = resolveOpenAiCost({ total_tokens: 1_000_000 }, "openai", "text-embedding-3-small", "embedding");
    expect(c.inputTokens).toBe(1_000_000);
    expect(c.outputTokens).toBe(0);
    expect(c.costUsd).toBeCloseTo(0.02, 6); // $0.02 / 1M tokens
    expect(c.estimated).toBe(true);
  });

  it("records tokens at $0-but-FLAGGED for a paid call with no reported charge (never a silent free $0)", () => {
    // This is the whole point: an OpenAI/OpenRouter call whose usage carries no `cost` and whose model
    // isn't in the price table must not read as an authoritative $0 — that silently undercounts spend.
    const chat = resolveOpenAiCost({ prompt_tokens: 200, completion_tokens: 100 }, "openai", "gpt-4o", "chat");
    expect(chat).toEqual({ inputTokens: 200, outputTokens: 100, costUsd: 0, estimated: true });
    const emb = resolveOpenAiCost({ total_tokens: 500 }, "openrouter", "some/unknown-embed", "embedding");
    expect(emb).toEqual({ inputTokens: 500, outputTokens: 0, costUsd: 0, estimated: true });
  });

  it("falls back to total_tokens for input when prompt_tokens is absent (embedding shape)", () => {
    const c = resolveOpenAiCost({ total_tokens: 42 }, "local", "m", "embedding");
    expect(c.inputTokens).toBe(42);
  });

  it("handles a missing usage block without throwing", () => {
    const c = resolveOpenAiCost(undefined, "openai", "gpt-4o", "chat");
    expect(c).toEqual({ inputTokens: 0, outputTokens: 0, costUsd: 0, estimated: true });
  });
});

describe("estimateEmbeddingCostUsd", () => {
  it("prices known models by substring; null for unknown", () => {
    expect(estimateEmbeddingCostUsd("text-embedding-3-large", 1_000_000)).toBeCloseTo(0.13, 6);
    expect(estimateEmbeddingCostUsd("openai/text-embedding-3-small-v2", 2_000_000)).toBeCloseTo(0.04, 6);
    expect(estimateEmbeddingCostUsd("some-local-model", 1_000_000)).toBeNull();
  });
});

describe("meterFromOpenAiResponse", () => {
  it("extracts usage from a JSON body", () => {
    const body = JSON.stringify({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 7, cost: 0.5 } });
    expect(meterFromOpenAiResponse(body, "openrouter", "m", "chat")).toEqual({
      inputTokens: 5,
      outputTokens: 7,
      costUsd: 0.5,
      estimated: false,
    });
  });

  it("returns null on a non-JSON body or one without usage (an error body / stream — nothing to meter)", () => {
    expect(meterFromOpenAiResponse("not json", "openrouter", "m", "chat")).toBeNull();
    expect(meterFromOpenAiResponse(JSON.stringify({ error: { message: "quota" } }), "openrouter", "m", "chat")).toBeNull();
  });
});
