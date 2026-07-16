import { afterEach, describe, expect, it, vi } from "vitest";
import { completeText } from "@/lib/llm/complete";

/**
 * Spec (Learning-blank incident): the shared completion primitive runs structured extraction/short-
 * generation tasks (arcs, meeting summaries, social, titles) — NOT chain-of-thought. A reasoning
 * model (e.g. OpenRouter's qwen/qwen3.7-plus) otherwise spends its whole token budget on hidden
 * reasoning and returns empty content, blanking the panel. So the OpenRouter request must turn
 * reasoning OFF; a plain OpenAI-compatible endpoint must NOT get the field (it would reject it).
 */

function mock(content: string) {
  const fetchMock = vi.fn(async () =>
    new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: "stop" }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

describe("completeText reasoning control", () => {
  it("disables reasoning on the OpenRouter path", async () => {
    const fetchMock = mock('{"ok":true}');
    await completeText(
      { system: "s", prompt: "p" },
      { keys: { openrouterKey: "or", openrouterModel: "qwen/qwen3.7-plus", activeProvider: "openrouter" }, jsonObject: true }
    );
    const body = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body));
    expect(body.reasoning).toEqual({ enabled: false });
  });

  it("does NOT send a reasoning field to a plain OpenAI-compatible endpoint", async () => {
    const fetchMock = mock('{"ok":true}');
    await completeText(
      { system: "s", prompt: "p" },
      { keys: { openaiKey: "sk", openaiModel: "gpt-4o", activeProvider: "openai" } }
    );
    const body = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body));
    expect(body.reasoning).toBeUndefined();
  });
});
