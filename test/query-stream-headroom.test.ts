import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { streamOpenAICompatible, looksLikeTokenLimit } from "@/lib/query/claude";
import type { LlmBackend } from "@/lib/query/llm-backend";

const backend = {
  kind: "openai-compatible",
  provider: "openai",
  baseUrl: "https://api.example.com/v1",
  model: "reasoning-model",
  apiKey: "test-key",
  headers: {},
} as unknown as Extract<LlmBackend, { kind: "openrouter" | "openai-compatible" }>;

/** A mock streamed (SSE) completion response from `frames` (each an already-formatted `data: …\n\n`). */
function streamResponse(frames: string[], init: { ok?: boolean; status?: number } = {}): Response {
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      const enc = new TextEncoder();
      for (const f of frames) c.enqueue(enc.encode(f));
      c.close();
    },
  });
  return { ok: init.ok ?? true, status: init.status ?? 200, body, text: async () => "" } as unknown as Response;
}
const delta = (s: string) => `data: ${JSON.stringify({ choices: [{ delta: { content: s } }] })}\n\n`;
const usage = (n: number) => `data: ${JSON.stringify({ usage: { completion_tokens: n } })}\n\n`;

// Derive the headroom the SAME way the module does, so the assertion holds whether or not the CI env
// exports LLM_REASONING_HEADROOM_TOKENS (the module captures it at import; process.env is stable here).
const HEADROOM = (() => {
  const n = Number(process.env.LLM_REASONING_HEADROOM_TOKENS);
  return Number.isFinite(n) && n >= 0 ? n : 6000;
})();

async function drain(gen: AsyncGenerator<{ type: string; text?: string }>): Promise<string> {
  let out = "";
  for await (const ev of gen) if (ev.type === "delta") out += ev.text ?? "";
  return out;
}

describe("looksLikeTokenLimit", () => {
  it("matches 400/422 token-ceiling errors, not other failures", () => {
    expect(looksLikeTokenLimit(400, "max_tokens is greater than the maximum")).toBe(true);
    expect(looksLikeTokenLimit(422, "maximum context length is 8192")).toBe(true);
    expect(looksLikeTokenLimit(401, "invalid api key")).toBe(false);
    expect(looksLikeTokenLimit(429, "rate limited")).toBe(false);
  });
});

describe("streamOpenAICompatible — reasoning headroom (the streaming Query answer path)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("sends the answer budget PLUS reasoning headroom so a reasoning model isn't starved", async () => {
    fetchMock.mockResolvedValue(streamResponse([delta("Hello"), delta(" world"), usage(3), "data: [DONE]\n\n"]));
    const text = await drain(streamOpenAICompatible(backend, "", "", "", "", "", "q", "UTC"));
    expect(text).toBe("Hello world");
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.max_tokens).toBe(4096 + HEADROOM); // answer budget + reasoning headroom
    expect(body.stream).toBe(true);
  });

  it("logs when the stream yields ZERO answer text (starvation / mid-stream error), instead of a silent blank", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    // Usage present (model ran) but no content deltas — reasoning ate the whole budget.
    fetchMock.mockResolvedValue(streamResponse([usage(4096), "data: [DONE]\n\n"]));
    const text = await drain(streamOpenAICompatible(backend, "", "", "", "", "", "q", "UTC"));
    expect(text).toBe("");
    expect(err).toHaveBeenCalledWith(expect.stringMatching(/streamed answer was EMPTY/));
    err.mockRestore();
  });

  it("retries WITHOUT headroom when the headroom'd request hits the model's token ceiling", async () => {
    const ceiling = { ok: false, status: 400, text: async () => "max_tokens exceeds the model maximum", body: null } as unknown as Response;
    fetchMock.mockResolvedValueOnce(ceiling).mockResolvedValueOnce(streamResponse([delta("ok"), "data: [DONE]\n\n"]));
    const text = await drain(streamOpenAICompatible(backend, "", "", "", "", "", "q", "UTC"));
    expect(text).toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string).max_tokens).toBe(4096); // no headroom
  });

  it("surfaces a non-ceiling error immediately without retrying", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401, text: async () => "invalid api key", body: null } as unknown as Response);
    await expect(drain(streamOpenAICompatible(backend, "", "", "", "", "", "q", "UTC"))).rejects.toThrow(/401/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
