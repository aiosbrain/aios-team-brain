import { describe, expect, it } from "vitest";
import { diagnoseProviderFault, faultSentence, providerNameFrom } from "@/lib/llm/provider-fault";
import { degradedNote, type LlmTaskHealth } from "@/lib/query/llm-health";
import { diagnosisForLeg, legDetail, RAW_ERROR_CLIP } from "@/lib/ingest/pipeline-health";

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

  it("AC4b: a TOKEN COUNT in the HTTP status range is not an HTTP status", () => {
    // ⚠️ FOUND BY ATTACKING THIS FUNCTION, not by design, and it is the exact risk the spec names.
    // These strings are full of three-digit numbers. The first version read any of them as a status:
    //   "you requested up to 429 tokens" -> rate_limited
    //   "only afford 403 tokens"         -> bad_key   <-- the OUT-OF-CREDIT body's own phrasing,
    //                                                      diagnosed as a key problem, which sends
    //                                                      the operator to the wrong console entirely.
    expect(diagnoseProviderFault("LLM x @ y: you requested up to 429 tokens")).toBeNull();
    expect(diagnoseProviderFault("only afford 403 tokens, retry")).toBeNull();
    expect(diagnoseProviderFault("budget 500 tokens exhausted")).toBeNull();
    // A REAL status still parses, from both shapes the codebase actually produces.
    expect(diagnoseProviderFault("HTTP 429 rate limit exceeded")?.kind).toBe("rate_limited");
    expect(diagnoseProviderFault('402 {"error":{"message":"can only afford 10 tokens"}}')?.kind).toBe(
      "out_of_credit"
    );
    // And the two UNOBSERVED kinds need the words as well as the number — a status alone is not
    // evidence when no production body has ever backed the branch.
    expect(diagnoseProviderFault("LLM x @ y: 401 something odd")).toBeNull();
    expect(diagnoseProviderFault("LLM x @ y: 401 unauthorized")?.kind).toBe("bad_key");

    // ⚠️ THE CASE ONLY THE ANCHOR STOPS. A mutation reverting `statusIn` to any-bare-number SURVIVED
    // the assertions above, because the corroboration gates were quietly doing all the work — the
    // "defence in depth masks the mutation" shape. This string corroborates ("quota") AND carries a
    // mid-sentence 429 that is a token count, so ONLY the anchored parse keeps it out of a confident
    // rate-limit diagnosis.
    expect(
      diagnoseProviderFault("daily quota note: you may use up to 429 tokens per request"),
      "a token count that happens to sit beside a corroborating word is still not a status"
    ).toBeNull();
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

describe("LLMCREDIT-3: the two surfaces, not just the classifier", () => {
  it("AC4c: graph_extract's PROSE is never mistaken for a provider response", () => {
    // ⚠️ THE SHARPEST FINDING OF THE DIFF REVIEW. `PipelineLeg.diagnosis` also runs over the synthetic
    // graph_extract leg, whose reason is PROSE built from a corpus count — and whose template opens
    // with that count (lib/graph/extraction-health.ts). A team with 402 items would have read "the
    // model provider refused the call for payment" on the graph leg, for days, with the real cause
    // clipped underneath. A status is only a status where a RECORDER puts one.
    for (const items of [401, 402, 403, 429, 500]) {
      const prose =
        `${items} items have been projected for this team, but the graph holds 0 extracted facts in ` +
        `this team's graph groups. Check the graphiti service logs for the actual error.`;
      expect(diagnoseProviderFault(prose), prose.slice(0, 40)).toBeNull();
    }
    expect(
      diagnoseProviderFault("The graph does hold 402 facts in those groups — arc corrections write facts")
    ).toBeNull();
  });

  it("AC4d: a 429 carrying insufficient_quota is a BALANCE problem, not a burst limit", () => {
    // OpenAI reports an exhausted billing quota as 429 insufficient_quota — this repo's own shipped
    // fixture. The first draft answered it with "the account's rate tier is the limit, not its
    // balance", a confident inversion that sends the operator to the wrong console.
    const f = diagnoseProviderFault("LLM gpt-5 @ https://api.openai.com/v1: 429 insufficient_quota");
    expect(f?.kind).toBe("out_of_credit");
    expect(f!.action.toLowerCase()).toMatch(/top up|quota/);
    // A genuine burst limit still reads as one.
    const rl = diagnoseProviderFault("HTTP 429 rate limit exceeded, please slow down");
    expect(rl?.kind).toBe("rate_limited");
  });

  it("AC6c: two DIFFERENT faults at once are never filed under one another", () => {
    // The 2026-08-26 fleet, exactly: doc-task-infer on a 402 while arcs starved, concurrently.
    const note = degradedNote([
      task("doc-task-infer", "degraded", OUT_OF_CREDIT),
      task("arcs", "degraded", STARVED),
    ]);
    // Neither diagnosis may lead, because leading would file the other task under it — and which one
    // led used to depend on Map insertion order, so the banner could change between page loads.
    expect(note.startsWith("The answering model is failing for")).toBe(true);
    expect(note).not.toContain("Affected:");
    // Both tasks are still named, which is what the operator needs.
    expect(note).toContain("task suggestions");
    expect(note).toContain("Learning arcs");
  });

  it("AC7: the LEG carries its diagnosis, computed from the error TEXT", () => {
    expect(diagnosisForLeg(OUT_OF_CREDIT)?.headline).toContain("OpenRouter");
    // …and from the text, NOT the leg's name: an unrecognisable error yields nothing to say.
    expect(diagnosisForLeg("connection reset")).toBeNull();
    expect(diagnosisForLeg(null)).toBeNull();
  });

  it("AC8: the banner's line LEADS with the diagnosis and keeps the raw text underneath", () => {
    // ⚠️ PINNING THE CALL SITE, NOT THE CLASSIFIER. The component itself is unreachable from this tier
    // (the unit config includes only `*.test.ts` and there is no DOM harness), so the composition was
    // extracted into `legDetail` rather than left as JSX nothing could observe — the review found that
    // the specced AC7/AC8 did not exist at all, so reverting the banner to render `l.error` first
    // would have left every test green.
    const withFault = legDetail({ error: OUT_OF_CREDIT, diagnosis: diagnosisForLeg(OUT_OF_CREDIT) });
    expect(withFault.lead).toContain("Top up the account");
    expect(withFault.lead).not.toContain('{"error"');
    // The provider's own words survive, clipped — a real outage must stay diagnosable.
    expect(withFault.raw!.length).toBeLessThanOrEqual(RAW_ERROR_CLIP + 1);
    expect(withFault.raw!.endsWith("…")).toBe(true);

    // An UNRECOGNISED error has no lead at all, so the banner falls back to the raw string.
    const unknown = legDetail({ error: "connection reset by peer", diagnosis: null });
    expect(unknown.lead).toBeNull();
    expect(unknown.raw).toBe("connection reset by peer");
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
