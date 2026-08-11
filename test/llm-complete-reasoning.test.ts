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

  it("the reasoning role leaves reasoning ON and uses the reasoning model", async () => {
    const fetchMock = mock('{"arcs":[]}');
    await completeText(
      { system: "s", prompt: "p" },
      {
        role: "reasoning",
        keys: {
          openrouterKey: "or",
          openrouterModel: "openai/gpt-4o-mini",
          reasoningModel: "qwen/qwen3.7-plus",
          activeProvider: "openrouter",
        },
      }
    );
    const body = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body));
    expect(body.reasoning).toBeUndefined(); // NOT disabled — reasoning is the point of this role
    expect(body.model).toBe("qwen/qwen3.7-plus"); // the reasoning model, not the query model
  });
});

/**
 * TOKEN BUDGET (ARCHEAD-1). `max_tokens` caps hidden reasoning + visible answer TOGETHER, so a
 * reasoning-role call needs far more headroom than a "this model might reason" hedge.
 *
 * Measured on prod before this change: arc synthesis asks for 4096, the flat 6000 headroom capped it at
 * 10,096, and across 19 runs every single failure sat AT that cap (10,096/10,098) while the best success
 * cleared it by 226 tokens — 30% of runs billed ~1.5¢ to return nothing.
 */
describe("completeText token budget by role", () => {
  const budgetOf = (m: ReturnType<typeof mock>) =>
    JSON.parse(String((m.mock.calls[0] as [string, RequestInit])[1].body)).max_tokens as number;

  it("a REASONING-role call gets the large headroom — enough to clear the ceiling that was eating arcs", async () => {
    const fetchMock = mock('{"arcs":[]}');
    await completeText(
      { system: "s", prompt: "p" },
      {
        role: "reasoning",
        maxTokens: 4096, // what arc synthesis asks for
        keys: { openrouterKey: "or", openrouterModel: "openai/gpt-4o-mini", reasoningModel: "qwen/qwen3.7-plus", activeProvider: "openrouter" },
      }
    );
    // 4096 + 16000. The specific number matters less than the property: comfortably past the 10,098
    // the model actually reached, with room for a heavier fact set.
    expect(budgetOf(fetchMock)).toBe(20096);
    expect(budgetOf(fetchMock)).toBeGreaterThan(10098);
  });

  it("a NON-reasoning call keeps the small headroom — the blast radius stays off every other path", async () => {
    // The control. Raising the global default instead would have lifted max_tokens on every OpenRouter
    // call, including small models whose ceiling then trips the token-limit retry on every request.
    const fetchMock = mock('{"ok":true}');
    await completeText(
      { system: "s", prompt: "p" },
      { maxTokens: 4096, keys: { openrouterKey: "or", openrouterModel: "qwen/qwen3.7-max", activeProvider: "openrouter" } }
    );
    expect(budgetOf(fetchMock)).toBe(10096); // 4096 + 6000, unchanged
  });

  it("the reasoning role WITHOUT a distinct reasoning model does not get the large headroom", async () => {
    // `reasoningActive` is false here (no `reasoningModel`), so the call fell back to the query model and
    // reasoning is turned OFF — giving it the big budget would be sizing for reasoning that won't happen.
    const fetchMock = mock('{"ok":true}');
    await completeText(
      { system: "s", prompt: "p" },
      { role: "reasoning", maxTokens: 4096, keys: { openrouterKey: "or", openrouterModel: "qwen/qwen3.7-max", activeProvider: "openrouter" } }
    );
    expect(budgetOf(fetchMock)).toBe(10096);
  });
});

/**
 * THE LADDER (ARCHEAD-1, Fable HIGH). A token-limit refusal must step DOWN one rung, not fall to the
 * bare answer budget. With the reasoning rung at 20,096, a provider whose ceiling sits between the rungs
 * would refuse the top ask and land the retry on 4,096 — with reasoning still ON, that is BELOW the 3,892
 * minimum any successful arc run has ever needed, so a 30% failure rate would become ~100%.
 */
describe("completeText token-limit ladder", () => {
  const REFUSAL = { status: 400, body: JSON.stringify({ error: { message: "max_tokens exceeds the model's limit" } }) };

  /** Refuse the first `refuseCount` requests with a token-limit 400, then succeed. */
  function laddered(refuseCount: number) {
    let n = 0;
    const fetchMock = vi.fn(async () => {
      if (n++ < refuseCount) return new Response(REFUSAL.body, { status: REFUSAL.status });
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"arcs":[]}' }, finish_reason: "stop" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }
  const budgets = (m: ReturnType<typeof laddered>) =>
    m.mock.calls.map((c) => JSON.parse(String((c as [string, RequestInit])[1].body)).max_tokens as number);

  const reasoningOpts = {
    role: "reasoning" as const,
    maxTokens: 4096,
    keys: { openrouterKey: "or", openrouterModel: "openai/gpt-4o-mini", reasoningModel: "qwen/qwen3.7-plus", activeProvider: "openrouter" as const },
  };

  it("steps DOWN to the known-accepted rung instead of collapsing to the bare answer budget", async () => {
    const fetchMock = laddered(1);
    await completeText({ system: "s", prompt: "p" }, reasoningOpts);
    // 20,096 refused → retry at 10,096 (what prod ran on for months), NOT 4,096.
    expect(budgets(fetchMock)).toEqual([20096, 10096]);
  });

  it("only reaches the bare budget after the middle rung is ALSO refused", async () => {
    const fetchMock = laddered(2);
    await completeText({ system: "s", prompt: "p" }, reasoningOpts);
    expect(budgets(fetchMock)).toEqual([20096, 10096, 4096]);
  });

  it("does NOT retry a non-token-limit error — a real fault must surface, not be re-sent", async () => {
    // The control: without this, a 500 or an auth failure would be hammered three times.
    const fetchMock = vi.fn(async () => new Response("upstream exploded", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(completeText({ system: "s", prompt: "p" }, reasoningOpts)).rejects.toThrow(/500/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a NON-reasoning call has no duplicate rung — it starts at 10,096 and drops to the budget", async () => {
    const fetchMock = laddered(1);
    await completeText(
      { system: "s", prompt: "p" },
      { maxTokens: 4096, keys: { openrouterKey: "or", openrouterModel: "qwen/qwen3.7-max", activeProvider: "openrouter" } }
    );
    expect(budgets(fetchMock)).toEqual([10096, 4096]); // deduped — no pointless repeat of 10,096
  });
});
