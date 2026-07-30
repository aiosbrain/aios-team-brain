import { describe, expect, it } from "vitest";
import { describeExtraction, selectLlmBackend } from "@/lib/query/llm-backend";

/**
 * Spec: a team can extract with a DIFFERENT, cheaper model than it answers with.
 *
 * Why this role exists, measured: graph extraction was 99% of the brain's LLM bill ($51.01 of $51.70
 * lifetime), because the graph proxy forced Graphiti onto the team's ANSWERING model — a reasoning
 * model at $4.425/M output, ~87% of whose completion tokens were chain-of-thought on a mechanical,
 * schema-constrained transformation. A reasoning model is the right pick for answering and the wrong
 * one for extraction, and before this you could not have both.
 *
 * The invariant that matters most is the FALLBACK shape — see the "whole, never half" block. Everything
 * else here is the activation truth table from docs/design/graph-extraction-model.md.
 */

const ANSWERING_ON_OPENROUTER = {
  activeProvider: "openrouter" as const,
  openrouterKey: "sk-or",
  openrouterModel: "qwen/qwen3.7-max",
};

describe("selectLlmBackend — the extraction role", () => {
  it("is OFF by default: with no extraction model, extraction resolves exactly like answering", () => {
    // The whole installed base sits here. Both columns null must be byte-identical to today.
    const answering = selectLlmBackend({}, ANSWERING_ON_OPENROUTER);
    const extraction = selectLlmBackend({}, ANSWERING_ON_OPENROUTER, { role: "extraction" });
    expect(extraction).toEqual(answering);
    expect(extraction.model).toBe("qwen/qwen3.7-max");
  });

  it("model set + no provider = the answering backend with the cheap model (the common case)", () => {
    // "Answer with qwen3.7-max, extract with qwen3.6-flash, on the same OpenRouter key."
    const keys = { ...ANSWERING_ON_OPENROUTER, extractionModel: "qwen/qwen3.6-flash" };
    const b = selectLlmBackend({}, keys, { role: "extraction" });
    expect(b.provider).toBe("openrouter");
    expect(b.model).toBe("qwen/qwen3.6-flash");
    // …and the answering role is untouched by it.
    expect(selectLlmBackend({}, keys).model).toBe("qwen/qwen3.7-max");
    expect(selectLlmBackend({}, keys, { role: "query" }).model).toBe("qwen/qwen3.7-max");
  });

  it("model + provider = extraction runs on its own backend", () => {
    const keys = {
      activeProvider: "openai" as const,
      openaiKey: "sk-oai",
      openaiModel: "gpt-4o",
      openrouterKey: "sk-or",
      extractionProvider: "openrouter" as const,
      extractionModel: "openai/gpt-4o-mini",
    };
    expect(selectLlmBackend({}, keys).provider).toBe("openai"); // answering unmoved
    const b = selectLlmBackend({}, keys, { role: "extraction" });
    expect(b.provider).toBe("openrouter");
    expect(b.model).toBe("openai/gpt-4o-mini");
  });

  it("a provider with no model does NOT activate the role — the model is the switch", () => {
    const keys = { ...ANSWERING_ON_OPENROUTER, extractionProvider: "openai" as const, openaiKey: "sk-oai" };
    const b = selectLlmBackend({}, keys, { role: "extraction" });
    expect(b.provider).toBe("openrouter");
    expect(b.model).toBe("qwen/qwen3.7-max");
  });

  it("extraction never turns chain-of-thought on, whatever the reasoning role says", () => {
    // `reasoningActive` keys on role === "reasoning", so an extraction call can't inherit it. Pinned
    // because reasoning ON over an extraction prompt is the 4x bill this whole design is about.
    const keys = { ...ANSWERING_ON_OPENROUTER, reasoningModel: "qwen/qwen3.7-plus", extractionModel: "cheap" };
    expect(selectLlmBackend({}, keys, { role: "extraction" }).model).toBe("cheap");
    expect(selectLlmBackend({}, keys, { role: "reasoning" }).model).toBe("qwen/qwen3.7-plus");
  });
});

/**
 * THE fallback invariant. `llm-backend.ts`'s reasoning role, when its provider is set but has no key,
 * borrows the answering BACKEND while keeping the reasoning MODEL — a model name pointed at a backend
 * that may not serve it, which is a guaranteed 404 per call.
 *
 * For reasoning that costs one failed arc synthesis. For extraction it means EVERY call errors while
 * Graphiti keeps returning 202 to the projector, so the graph silently stops growing and the first
 * signal is the stall detector six hours later — the exact failure mode this stack spent a week on.
 *
 * So the extraction role falls back WHOLE: the answering backend AND the answering model.
 *
 * Note which assertion is load-bearing: a test that only checked `provider` would pass against the
 * half-swap bug, because the half-swap gets the provider right. `model` is the one that catches it.
 */
describe("extraction fallback is WHOLE, never a half-swap", () => {
  const keys = {
    activeProvider: "openai" as const,
    openaiKey: "sk-oai",
    openaiModel: "gpt-4o",
    // Asked for OpenRouter, but there is no OpenRouter key — the admin deleted it, or never set it.
    extractionProvider: "openrouter" as const,
    extractionModel: "qwen/qwen3.6-flash",
  };

  it("falls back to the answering backend AND its model", () => {
    const b = selectLlmBackend({}, keys, { role: "extraction" });
    expect(b.provider).toBe("openai");
    expect(b.model).toBe("gpt-4o"); // NOT "qwen/qwen3.6-flash" — that would 404 on every call
  });

  it("is indistinguishable from the role being off — a working extractor, not a broken one", () => {
    const off = { ...keys, extractionProvider: undefined, extractionModel: undefined };
    expect(selectLlmBackend({}, keys, { role: "extraction" })).toEqual(
      selectLlmBackend({}, off, { role: "extraction" })
    );
  });

  it("surfaces the fallback instead of silently reverting — a cost setting that reverts unseen is a surprise bill", () => {
    const d = describeExtraction({}, keys);
    expect(d).toMatchObject({
      enabled: true,
      requested: "openrouter",
      provider: "openai",
      model: "gpt-4o",
      usedFallback: true,
    });
  });
});

describe("describeExtraction — what the admin card shows", () => {
  it("reports disabled when no extraction model is set", () => {
    expect(describeExtraction({}, ANSWERING_ON_OPENROUTER)).toMatchObject({ enabled: false, usedFallback: false });
  });

  it("reports the effective provider+model with no fallback when it resolves", () => {
    const d = describeExtraction({}, { ...ANSWERING_ON_OPENROUTER, extractionModel: "qwen/qwen3.6-flash" });
    expect(d).toMatchObject({
      enabled: true,
      requested: null,
      provider: "openrouter",
      model: "qwen/qwen3.6-flash",
      usedFallback: false,
    });
  });
});
