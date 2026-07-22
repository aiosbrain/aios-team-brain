import { afterEach, describe, expect, it, vi } from "vitest";
import { callMeetingsLLM } from "@/lib/meetings/llm-extract";
import { completeText } from "@/lib/llm/complete";

/**
 * Spec (the OpenRouter attribution fix): every non-streaming LLM task (meetings, arcs, social, …)
 * routes through the SAME settings-aware primitive as the Query box — so a team whose
 * `answering_provider` is OpenRouter gets those tasks from OpenRouter's model, not silently from
 * OpenAI. Before the fix each feature had a bespoke `LLM_BASE_URL ? openai : anthropic` transport
 * that ignored the setting entirely.
 *
 * We assert at the transport boundary: given resolved keys carrying `activeProvider: "openrouter"` +
 * an OpenRouter key/model, the outbound request goes to OpenRouter with THAT model.
 */

const OPENROUTER_KEYS = {
  openrouterKey: "or-test-key",
  openrouterModel: "qwen/qwen3.7-plus",
  activeProvider: "openrouter" as const,
};

function mockOpenAICompatible(content: string) {
  const fetchMock = vi.fn(async () =>
    new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("meetings + arcs LLM routing honors the answering-provider setting", () => {
  it("meetings extraction posts to OpenRouter with the configured model", async () => {
    const fetchMock = mockOpenAICompatible('{"summary":"ok","attendees":[]}');
    const out = await callMeetingsLLM("system", "user", OPENROUTER_KEYS);

    expect(out).toContain("summary");
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe("qwen/qwen3.7-plus");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer or-test-key");
  });

  it("the shared primitive (used by arcs/social/title) posts to OpenRouter with the configured model", async () => {
    const fetchMock = mockOpenAICompatible('{"arcs":[]}');
    const out = await completeText({ system: "s", prompt: "p" }, { keys: OPENROUTER_KEYS, jsonObject: true });

    expect(out).toContain("arcs");
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe("qwen/qwen3.7-plus");
    expect(body.response_format).toEqual({ type: "json_object" });
  });
});
