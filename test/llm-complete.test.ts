import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the backend resolver so we exercise the OpenAI-compatible/OpenRouter path deterministically.
vi.mock("@/lib/query/llm-backend", () => ({
  selectLlmBackend: () => ({
    kind: "openai-compatible" as const,
    provider: "openai" as const,
    baseUrl: "https://api.example.com/v1",
    model: "reasoning-model",
    apiKey: "test-key",
    headers: {},
  }),
}));

import { completeText, completeTextOrNull } from "@/lib/llm/complete";

const okResponse = (content: string, finish = "stop") =>
  ({
    ok: true,
    json: async () => ({ choices: [{ message: { content }, finish_reason: finish }] }),
    text: async () => "",
  }) as unknown as Response;

describe("completeText (OpenAI-compatible path)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("adds reasoning headroom on top of the caller's answer budget so a reasoning model isn't starved", async () => {
    fetchMock.mockResolvedValue(okResponse('{"ok":true}'));
    await completeText({ system: "s", prompt: "p" }, { maxTokens: 2048 });
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    // 2048 answer budget + 6000 default headroom — the whole point of the fix: a reasoning model can
    // burn thousands of hidden tokens and still have the 2048 left to actually answer.
    expect(body.max_tokens).toBe(2048 + 6000);
    expect(body.model).toBe("reasoning-model");
  });

  it("throws NAMING finish_reason when content is empty — the reasoning-starvation signature, made loud", async () => {
    // 200 OK but empty content + finish_reason:length = all of max_tokens went to hidden reasoning.
    fetchMock.mockResolvedValue(okResponse("", "length"));
    await expect(completeText({ system: "s", prompt: "p" }, { maxTokens: 100 })).rejects.toThrow(
      /empty content.*finish_reason=length/
    );
  });

  it("completeTextOrNull degrades empty content to null (best-effort callers) and logs the reason", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    fetchMock.mockResolvedValue(okResponse("", "length"));
    const out = await completeTextOrNull({ system: "s", prompt: "p" });
    expect(out).toBeNull();
    expect(err).toHaveBeenCalledWith(expect.stringContaining("[llm]"), expect.stringMatching(/finish_reason=length/));
    err.mockRestore();
  });

  it("returns trimmed content on a normal completion", async () => {
    fetchMock.mockResolvedValue(okResponse("  hello  "));
    expect(await completeText({ system: "s", prompt: "p" })).toBe("hello");
  });
});
