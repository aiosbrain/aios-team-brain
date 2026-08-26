import { describe, expect, it } from "vitest";
import { diagnoseProviderFault, faultSentence, providerNameFrom } from "@/lib/llm/provider-fault";
import { degradedNote, type LlmTaskHealth } from "@/lib/query/llm-health";

/**
 * LLMCREDIT-3 — spec `docs/design/llmcredit3-provider-fault-diagnosis.md`.
 *
 * The operator's words: *"the error message should be smart enough to tell me that openrouter needs to
 * be topped up (or whatever model provider we are using) instead of the downstream errors."*
 *
 * Every body below is pasted from a real production screenshot or `llm_failures` row. A paraphrase
 * would test the paraphrase.
 */

/** Pulse, 2026-08-26 — what `doc_task_infer` and task suggestions actually showed. */
const OUT_OF_CREDIT =
  'every worker failed — LLM qwen/qwen3.7-max @ https://openrouter.ai/api/v1: 402 {"error":{"message":' +
  '"This request requires more credits, or fewer max_tokens. You requested up to 900 tokens, but can ' +
  'only afford 840. To increase, visit https://openrouter.ai/settings/credits and add more credits",' +
  '"code":402,"metadata":{"limit_source":"openrouter_credits","remedy_hint":"Add credits at ' +
  'https://openrouter.ai/settings/credits, or lower max_tokens / prompt size to fit your remaining ' +
  'balance."},"provider_name":null},"user_id":';

/** Pulse, 2026-08-25 — the other 402, whose remedy is the opposite. */
const IN_FLIGHT =
  'LLM qwen/qwen3.7-plus @ https://openrouter.ai/api/v1: 402 {"error":{"message":"This request would ' +
  'exceed your available credits given your current in-flight requests. Retry after in-flight requests ' +
  'settle, or add credits.","code":402,"metadata":{"reason":"in_flight_budget_exhausted",' +
  '"limit_source":"openrouter_in_flight_budget"}}}';

/** Pulse, 2026-08-26 — sat directly BESIDE the credit failure, and is not one. */
const STARVED = "LLM returned empty content (model=qwen/qwen3.7-plus, finish_reason=length)";

describe("LLMCREDIT-3: the operator reads a diagnosis, not the provider's JSON", () => {
  it("AC1: the real out-of-credit body names OpenRouter and says to top up", () => {
    const f = diagnoseProviderFault(OUT_OF_CREDIT);
    expect(f?.kind).toBe("out_of_credit");
    expect(f!.headline).toContain("OpenRouter");
    expect(`${f!.headline} ${f!.action}`.toLowerCase()).toMatch(/out of credit|top up/);
    // …and it does not make the operator read the JSON to get there.
    expect(f!.headline).not.toContain('{"error"');
  });

  it("AC2: the in-flight body is a DIFFERENT kind, with a different remedy", () => {
    const f = diagnoseProviderFault(IN_FLIGHT);
    expect(f?.kind).toBe("in_flight_budget");
    expect(f!.kind).not.toBe(diagnoseProviderFault(OUT_OF_CREDIT)!.kind);
    // LLMCREDIT-2 already retries these, and saying so stops an operator chasing a one-off blip.
    expect(f!.action.toLowerCase()).toMatch(/retr|in-flight/);
  });

  it("AC3: reasoning starvation is NOT a credit problem", () => {
    const f = diagnoseProviderFault(STARVED);
    expect(f?.kind).toBe("reasoning_starved");
    // ⚠️ THE POINT OF THIS CRITERION: it was on screen next to a credit failure. Telling someone to
    // top up an account that is fine is worse than showing them the raw string.
    expect(f!.action.toLowerCase()).not.toMatch(/top up|add credit/);
    expect(f!.action).toContain("Admin → Active answering model");
  });

  it("AC4: an unrecognised failure returns null — no confident guess", () => {
    for (const t of [
      "timeout after 20000ms",
      "fetch failed: ECONNRESET",
      "",
      "   ",
      null,
      undefined,
    ]) {
      expect(diagnoseProviderFault(t), String(t)).toBeNull();
      expect(faultSentence(t), String(t)).toBeNull();
    }
  });

  it("AC5: the provider is DERIVED from the failure text, never assumed", () => {
    expect(providerNameFrom(OUT_OF_CREDIT)).toBe("OpenRouter");
    expect(providerNameFrom("LLM gpt-5 @ https://api.openai.com/v1: 402 insufficient_quota")).toBe("OpenAI");
    expect(providerNameFrom("claude @ https://api.anthropic.com/v1: 401")).toBe("Anthropic");
    // Unidentifiable → a generic noun, NOT a guess. The operator asked for provider-agnostic.
    expect(providerNameFrom("402 payment required")).toBe("the model provider");
    const selfHosted = diagnoseProviderFault('402 {"error":{"message":"can only afford 10 tokens"}}');
    expect(selfHosted!.headline).toContain("the model provider");
    expect(selfHosted!.headline).not.toContain("OpenRouter");
  });

  it("AC6: degradedNote LEADS with the diagnosis and keeps what only it knows", () => {
    const tasks: LlmTaskHealth[] = [
      task("doc-task-infer", "degraded", OUT_OF_CREDIT),
      task("timeline-summary", "healthy", null),
    ];
    const note = degradedNote(tasks);

    // The first sentence is the answer, not the symptom.
    expect(note.startsWith("OpenRouter is out of credit"), note.slice(0, 80)).toBe(true);
    // WHICH features are dark is not derivable from the provider's complaint, so it is still named…
    // ("doc-task-infer" is labelled "task suggestions" for humans — the same words the banner used.)
    expect(note).toContain("task suggestions");
    // …and so is the part that stops a partial outage reading as a total one.
    expect(note).toContain("Still working:");
    // The raw text survives, clipped, at the end — a real outage must stay diagnosable.
    expect(note).toContain("…");
    expect(note.indexOf('{"error"')).toBeGreaterThan(note.indexOf("out of credit"));
  });

  it("AC6b: an UNRECOGNISED failure keeps the old wording exactly", () => {
    const note = degradedNote([task("arcs", "degraded", "fetch failed: ECONNRESET")]);
    expect(note.startsWith("The answering model is failing for")).toBe(true);
    expect(note).toContain("ECONNRESET");
  });
});

function task(name: string, state: LlmTaskHealth["state"], lastError: string | null): LlmTaskHealth {
  return {
    task: name,
    state,
    model: null,
    lastError,
    lastFailedAt: lastError ? new Date().toISOString() : null,
    lastRunAt: new Date().toISOString(),
    calls: 1,
    failures: lastError ? 1 : 0,
  } as unknown as LlmTaskHealth;
}
