import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { looksLikeBudgetRefusal, looksLikeSizeRefusal, looksLikeTokenLimit } from "@/lib/query/claude";

// Same stub shape as `test/llm-complete.test.ts`: only the backend resolver is mocked, so the token
// ladder stays real. A mock-shaped budget would make every assertion below decorative.
vi.mock("@/lib/query/llm-backend", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/query/llm-backend")>()),
  selectLlmBackend: () => ({
    kind: "openrouter" as const,
    provider: "openrouter" as const,
    baseUrl: "https://openrouter.ai/api/v1",
    model: "qwen/qwen3.7-max",
    apiKey: "test-key",
    headers: {},
  }),
}));

import { completeText, completeTextOrNull } from "@/lib/llm/complete";
import { docTaskInferFailureReason } from "@/lib/dashboard/doc-task-infer-run";

/**
 * LLMCREDIT-1 — spec `docs/design/llmcredit1-budget-refusal-ladder.md`.
 *
 * OpenRouter prices a request by its `max_tokens` CEILING, so a nearly-empty balance refuses a big ask
 * while still affording a small one. On 2026-08-25 every generation task on prod was failing with
 * `http_402` — 36 timeline summaries among them, which is why per-person summaries vanished from the
 * timeline — while their real budgets (200 tokens for a summary) were far inside what the account
 * could still afford. We were asking for 6,200: the reasoning HEADROOM is added on top, and the ladder
 * that exists to walk it back only fired on 400/422.
 */

/** The body prod actually returned, kept verbatim — a paraphrase would test the paraphrase. */
const REAL_402 =
  '{"error":{"message":"This request requires more credits, or fewer max_tokens. You requested up to ' +
  '6900 tokens, but can only afford 3116. To increase, visit https://openrouter.ai/settings/credits ' +
  'and add more credits","code":402,"metadata":{"limit_source":"openrouter_credits","remedy_hint":' +
  '"Add credits at https://openrouter.ai/settings/credits, or lower max_tokens / prompt size to fit ' +
  'your remaining balance."},"provider_name":null},"user_id":"u"}';

describe("LLMCREDIT-1: a budget-shaped 402 is a SIZE refusal, not a dead account", () => {
  it("AC1: the real production body is recognised", () => {
    expect(looksLikeBudgetRefusal(402, REAL_402)).toBe(true);
    expect(looksLikeSizeRefusal(402, REAL_402)).toBe(true);
    // Each phrasing on its own, so a provider dropping one sentence does not silently un-recognise it.
    for (const phrase of [
      "requires more credits, or fewer max_tokens",
      "you requested up to 900 tokens, but can only afford 300",
      "lower max_tokens / prompt size",
      "to fit your remaining balance",
    ]) {
      expect(looksLikeBudgetRefusal(402, phrase), phrase).toBe(true);
    }
  });

  it("AC2: a 402 with NO size language is not retried — a dead account must fail fast", () => {
    for (const body of [
      '{"error":{"message":"Payment required","code":402}}',
      '{"error":{"message":"Your account has been suspended for non-payment","code":402}}',
      "",
    ]) {
      expect(looksLikeBudgetRefusal(402, body), body).toBe(false);
      expect(looksLikeSizeRefusal(402, body), body).toBe(false);
    }
  });

  it("AC3: the two predicates do not overlap — 400/422 stay the token-limit predicate's business", () => {
    // Same words, wrong status: this is not a budget refusal.
    expect(looksLikeBudgetRefusal(400, REAL_402)).toBe(false);
    expect(looksLikeBudgetRefusal(429, REAL_402)).toBe(false);
    // And the classic ceiling refusal is not claimed by the new predicate.
    const ceiling = '{"error":{"message":"max_tokens is too large: maximum context length is 4096"}}';
    expect(looksLikeTokenLimit(400, ceiling)).toBe(true);
    expect(looksLikeBudgetRefusal(400, ceiling)).toBe(false);
    expect(looksLikeSizeRefusal(400, ceiling)).toBe(true);
  });
});

describe("LLMCREDIT-1: the ladder steps down on a budget refusal", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  const refusal = () =>
    ({ ok: false, status: 402, text: async () => REAL_402, json: async () => ({}) }) as unknown as Response;
  const ok = (content: string) =>
    ({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content }, finish_reason: "stop" }] }),
      text: async () => "",
    }) as unknown as Response;

  it("AC4: refused at the headroom rung, accepted at the answer budget — the caller gets its text", async () => {
    // Exactly the prod shape: 200-token summary budget, 6,200 asked for, 3,116 affordable.
    fetchMock.mockResolvedValueOnce(refusal()).mockResolvedValueOnce(ok("Chetan shipped three fixes."));

    const out = await completeText({ system: "s", prompt: "p" }, { maxTokens: 200 });

    expect(out).toBe("Chetan shipped three fixes.");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const first = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    const second = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string);
    expect(first.max_tokens, "the top rung carries the reasoning headroom").toBe(200 + 6000);
    expect(second.max_tokens, "and the step-down is the bare answer budget").toBe(200);
  });

  it("AC5: the refusal is FILED even though the call then succeeded", async () => {
    fetchMock.mockResolvedValueOnce(refusal()).mockResolvedValueOnce(ok("text"));
    const rows: Record<string, unknown>[] = [];
    const db = {
      from: () => ({ insert: async (row: Record<string, unknown>) => { rows.push(row); return { error: null }; } }),
    } as never;

    const out = await completeText(
      { system: "s", prompt: "p" },
      { maxTokens: 200, meter: { db, teamId: "t1", source: "timeline-summary" } }
    );

    // The whole point: service resumed AND the operator can still see the account is nearly empty.
    // A silent recovery is the worse bug — it is how a draining balance stays invisible until zero.
    expect(out).toBe("text");
    const failures = rows.filter((r) => r.failure_reason !== undefined);
    expect(failures.length, "one refusal, filed once").toBe(1);
    expect(failures[0].failure_reason).toBe("http_402");
    expect(failures[0].source).toBe("timeline-summary");
  });

  it("AC6: a 402 at EVERY rung still throws — a truly empty account is not swallowed", async () => {
    fetchMock.mockResolvedValue(refusal());
    await expect(completeText({ system: "s", prompt: "p" }, { maxTokens: 200 })).rejects.toThrow(/402/);
    // And the best-effort wrapper still degrades to null rather than exploding into its caller.
    fetchMock.mockResolvedValue(refusal());
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await completeTextOrNull({ system: "s", prompt: "p" }, { maxTokens: 200 })).toBeNull();
    err.mockRestore();
  });

  it("a NON-size 402 is not re-sent — one attempt, then the honest error", async () => {
    const dead = { ok: false, status: 402, text: async () => "Payment required", json: async () => ({}) } as unknown as Response;
    fetchMock.mockResolvedValue(dead);
    await expect(completeText({ system: "s", prompt: "p" }, { maxTokens: 200 })).rejects.toThrow(/402/);
    expect(fetchMock, "retrying a dead account buys nothing and delays the real error").toHaveBeenCalledTimes(1);
  });
});

describe("LLMCREDIT-1: the leg reports the provider's reason, not 'model returned null'", () => {
  it("AC7: a 402 reaches the operator's copy", () => {
    const reason = docTaskInferFailureReason(`LLM qwen/qwen3.7-max @ https://openrouter.ai/api/v1: 402 ${REAL_402}`);
    expect(reason).toContain("402");
    expect(reason).toContain("more credits");
    // ⚠️ And it must NOT be the old sentence, which is the one that sent an operator hunting a model bug.
    expect(reason).not.toBe("model returned null for every worker");
  });

  it("AC7b: and the old sentence survives for the case it was actually true of", () => {
    // No provider error recorded at all — the model really did return nothing. Losing this branch
    // would trade one misleading message for another.
    expect(docTaskInferFailureReason(null)).toBe("model returned null for every worker");
  });
});

describe("LLMCREDIT-1: the wiring, not just the helper", () => {
  it("AC7c: the leg CALLS docTaskInferFailureReason — reverting it to the literal is otherwise invisible", () => {
    // ⚠️ THE CALL SITE IS THE PART THAT SHIPS, and nothing else pins it: `tsc` stays green if the site
    // reverts to the hardcoded sentence, because the helper is exported and imported HERE, so no
    // unused-symbol error ever fires. The dm tier cannot reach the model either (a seeded team has no
    // answering key), so a behavioural criterion is not available at incident speed. This is the
    // repo's "pin the call site, not just the function" class, closed the cheap way.
    const src = readFileSync(join(import.meta.dirname, "..", "lib", "dashboard", "doc-task-infer-run.ts"), "utf8");
    const withoutComments = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
    expect(
      withoutComments.includes("docTaskInferFailureReason(pass.firstError)"),
      "the failure path must go through the helper — a bare string here is the misleading message again"
    ).toBe(true);
    // Comments are stripped first: a guard that reads prose is not checking anything.
    expect(withoutComments).not.toContain('["model returned null for every worker"]');
  });
});
