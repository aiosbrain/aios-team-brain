import { describe, expect, it } from "vitest";
import {
  authorizeGraphProxy,
  forwardBody,
  graphChatTarget,
  graphEmbeddingTarget,
  isRefusal,
} from "@/lib/llm/graph-proxy";
import { EMBEDDING_DIM } from "@/lib/api/schemas";

/**
 * The graph LLM proxy exists because a SECOND provider key, on a second service, was invisible to
 * this app — and on 2026-07-28 it quietly ran out of quota and killed graph extraction for hours.
 * These specs pin the decisions that make the console the single source of truth, and the two
 * refusals that stop it doing damage while it's at it.
 */

const SECRET = "s".repeat(40);

describe("authorizeGraphProxy — fails closed", () => {
  it("accepts the exact bearer secret", () => {
    expect(authorizeGraphProxy(`Bearer ${SECRET}`, SECRET)).toBe(true);
  });

  it("REFUSES when no secret is configured — an unset secret must never mean 'open'", () => {
    // This endpoint spends money on a paid API. "We forgot to set it" defaulting to open would be
    // strictly worse than the endpoint not working.
    expect(authorizeGraphProxy(`Bearer ${SECRET}`, undefined)).toBe(false);
    expect(authorizeGraphProxy(`Bearer ${SECRET}`, "")).toBe(false);
  });

  it("REFUSES a too-short secret rather than accepting a weak one", () => {
    const weak = "short";
    expect(authorizeGraphProxy(`Bearer ${weak}`, weak)).toBe(false);
  });

  it("refuses a wrong, absent, or malformed credential", () => {
    expect(authorizeGraphProxy(`Bearer ${"x".repeat(40)}`, SECRET)).toBe(false);
    expect(authorizeGraphProxy(null, SECRET)).toBe(false);
    expect(authorizeGraphProxy(SECRET, SECRET)).toBe(false); // no "Bearer " prefix
    expect(authorizeGraphProxy(`Bearer ${SECRET}x`, SECRET)).toBe(false); // length mismatch must not throw
  });
});

describe("graphChatTarget — the console's model wins", () => {
  it("builds an OpenAI-compatible target from an OpenRouter backend, carrying its headers", () => {
    const t = graphChatTarget({
      kind: "openrouter",
      provider: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      model: "openai/gpt-4o",
      apiKey: "or-key",
      headers: { "HTTP-Referer": "https://aios" },
    });
    expect(isRefusal(t)).toBe(false);
    if (isRefusal(t)) return;
    expect(t.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(t.model).toBe("openai/gpt-4o");
    expect(t.headers.Authorization).toBe("Bearer or-key");
    expect(t.headers["HTTP-Referer"]).toBe("https://aios");
  });

  it("tolerates a trailing slash on the base URL", () => {
    const t = graphChatTarget({
      kind: "openai-compatible",
      provider: "local",
      baseUrl: "http://localhost:11434/v1/",
      model: "llama3.1",
      apiKey: null,
    });
    if (isRefusal(t)) throw new Error("expected a target");
    expect(t.url).toBe("http://localhost:11434/v1/chat/completions");
    expect(t.headers.Authorization).toBeUndefined(); // keyless local servers
  });

  it("REFUSES Anthropic instead of half-translating it", () => {
    // Graphiti extracts with an OpenAI structured-output call. Approximating that against a
    // different wire format would degrade extraction silently, which is the failure mode this whole
    // change exists to end — so it refuses with something an operator can act on.
    const t = graphChatTarget({ kind: "anthropic", provider: "anthropic", model: "claude-opus-4-8", apiKey: "k" });
    expect(isRefusal(t)).toBe(true);
    if (!isRefusal(t)) return;
    expect(t.status).toBe(501);
    expect(t.message).toMatch(/Admin → Integrations/);
  });
});

describe("graphEmbeddingTarget — pinned to the graph's vector width", () => {
  const ok = { provider: "openrouter" as const, baseUrl: "https://openrouter.ai/api/v1", model: "openai/text-embedding-3-small", apiKey: "k", dim: EMBEDDING_DIM };

  it("builds a target when the dimension matches", () => {
    const t = graphEmbeddingTarget(ok);
    if (isRefusal(t)) throw new Error("expected a target");
    expect(t.url).toBe("https://openrouter.ai/api/v1/embeddings");
    expect(t.model).toBe("openai/text-embedding-3-small");
  });

  it("REFUSES a different dimension — swapping it would invalidate every vector in Neo4j", () => {
    // Graphiti built its index at one width and has no migration path. The damage from a mismatch
    // is invisible at write time and shows up later as bad search, so this must fail at the boundary.
    const t = graphEmbeddingTarget({ ...ok, dim: 768 });
    expect(isRefusal(t)).toBe(true);
    if (!isRefusal(t)) return;
    expect(t.status).toBe(501);
    expect(t.message).toContain("768");
  });

  it("refuses when nothing is configured, naming where to fix it", () => {
    const t = graphEmbeddingTarget(null);
    if (!isRefusal(t)) throw new Error("expected a refusal");
    expect(t.status).toBe(503);
    expect(t.message).toMatch(/Admin → Integrations/);
  });
});

describe("forwardBody — one place decides the model", () => {
  it("REPLACES the client's model with the console's", () => {
    // Graphiti sends its own MODEL_NAME. Honouring it would recreate the second source of truth this
    // proxy removes, so it is discarded — deliberately, and documented in the module header.
    const out = forwardBody({ model: "whatever-graphiti-was-told", messages: [] }, "openai/gpt-4o");
    if (isRefusal(out)) throw new Error("expected a body");
    expect(out.model).toBe("openai/gpt-4o");
  });

  it("passes structured-output fields through untouched", () => {
    // `response_format` IS the extraction contract — Graphiti calls `.parse()` with a JSON schema.
    // Dropping or rewriting it would produce unparseable output and an empty graph.
    const schema = { type: "json_schema", json_schema: { name: "entities", schema: { type: "object" } } };
    const out = forwardBody({ messages: [{ role: "user", content: "hi" }], response_format: schema, temperature: 0 }, "m");
    if (isRefusal(out)) throw new Error("expected a body");
    expect(out.response_format).toEqual(schema);
    expect(out.temperature).toBe(0);
    expect(out.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("refuses streaming rather than silently ignoring it", () => {
    // A silently-dropped `stream: true` leaves the caller waiting for chunks that never arrive.
    const out = forwardBody({ stream: true, messages: [] }, "m");
    expect(isRefusal(out)).toBe(true);
  });

  it("does not mutate the caller's body", () => {
    const body = { model: "original", messages: [] };
    forwardBody(body, "replaced");
    expect(body.model).toBe("original");
  });
});
