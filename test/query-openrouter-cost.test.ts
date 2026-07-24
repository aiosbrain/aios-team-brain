import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { streamOpenAICompatible } from "@/lib/query/claude";
import type { QueryUsage } from "@/lib/query/claude";
import type { LlmBackend } from "@/lib/query/llm-backend";

/**
 * Spec: the streamed answer must report the REAL generation cost so the dashboard "Brain spend" KPI
 * isn't stuck at $0. The team answers via OpenRouter (an OpenAI-compatible endpoint), whose streamed
 * `usage` frame carries a `cost` field (USD). The old code hard-coded `cost_usd: 0` on this path, so
 * every query_log row logged $0 and the Pulse spend metric read "$0.00" — "not working". Derived from
 * the product contract (spend must reflect actual charges), not the implementation.
 */

const openrouter = {
  kind: "openrouter",
  provider: "openrouter",
  baseUrl: "https://openrouter.ai/api/v1",
  model: "qwen/qwen3.7-plus",
  apiKey: "or-test-key",
  headers: { "X-Title": "AIOS Team Brain" },
} as unknown as Extract<LlmBackend, { kind: "openrouter" | "openai-compatible" }>;

const localCompat = {
  kind: "openai-compatible",
  provider: "local",
  baseUrl: "https://ollama.local/v1",
  model: "llama3.1",
  apiKey: null,
} as unknown as Extract<LlmBackend, { kind: "openrouter" | "openai-compatible" }>;

function streamResponse(frames: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      const enc = new TextEncoder();
      for (const f of frames) c.enqueue(enc.encode(f));
      c.close();
    },
  });
  return { ok: true, status: 200, body, text: async () => "" } as unknown as Response;
}
const delta = (s: string) => `data: ${JSON.stringify({ choices: [{ delta: { content: s } }] })}\n\n`;
const usageFrame = (u: Record<string, unknown>) => `data: ${JSON.stringify({ usage: u })}\n\n`;

async function drainUsage(
  gen: AsyncGenerator<{ type: string; text?: string; usage?: QueryUsage }>
): Promise<QueryUsage> {
  let usage: QueryUsage | undefined;
  for await (const ev of gen) if (ev.type === "done") usage = ev.usage;
  if (!usage) throw new Error("stream never yielded a done frame");
  return usage;
}

describe("streamOpenAICompatible — cost reporting", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("reports OpenRouter's real generation cost (not $0)", async () => {
    fetchMock.mockResolvedValue(
      streamResponse([
        delta("Answer."),
        usageFrame({ prompt_tokens: 1200, completion_tokens: 340, cost: 0.01234 }),
        "data: [DONE]\n\n",
      ])
    );
    const usage = await drainUsage(streamOpenAICompatible(openrouter, "", "", "", "", "", "q", "UTC"));
    expect(usage.cost_usd).toBe(0.01234);
    expect(usage.input_tokens).toBe(1200);
    expect(usage.output_tokens).toBe(340);
  });

  it("asks OpenRouter to include usage/cost in the request body", async () => {
    fetchMock.mockResolvedValue(
      streamResponse([delta("ok"), usageFrame({ cost: 0.5 }), "data: [DONE]\n\n"])
    );
    await drainUsage(streamOpenAICompatible(openrouter, "", "", "", "", "", "q", "UTC"));
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.usage).toEqual({ include: true });
  });

  it("rounds cost to the query_log numeric(10,5) scale", async () => {
    fetchMock.mockResolvedValue(
      streamResponse([delta("ok"), usageFrame({ cost: 0.123456789 }), "data: [DONE]\n\n"])
    );
    const usage = await drainUsage(streamOpenAICompatible(openrouter, "", "", "", "", "", "q", "UTC"));
    expect(usage.cost_usd).toBe(0.12346);
  });

  it("stays $0 (and omits the usage-include param) for a plain local endpoint that reports no cost", async () => {
    fetchMock.mockResolvedValue(
      streamResponse([delta("ok"), usageFrame({ prompt_tokens: 10, completion_tokens: 5 }), "data: [DONE]\n\n"])
    );
    const usage = await drainUsage(streamOpenAICompatible(localCompat, "", "", "", "", "", "q", "UTC"));
    expect(usage.cost_usd).toBe(0);
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.usage).toBeUndefined();
  });
});
