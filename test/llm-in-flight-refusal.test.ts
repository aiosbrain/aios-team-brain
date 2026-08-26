import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  looksLikeBudgetRefusal,
  looksLikeInFlightRefusal,
  looksLikeSizeRefusal,
  looksLikeTokenLimit,
} from "@/lib/query/claude";

vi.mock("@/lib/query/llm-backend", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/query/llm-backend")>()),
  selectLlmBackend: () => ({
    kind: "openrouter" as const,
    provider: "openrouter" as const,
    baseUrl: "https://openrouter.ai/api/v1",
    model: "qwen/qwen3.7-plus",
    apiKey: "test-key",
    headers: {},
  }),
}));

import { completeText, inFlightWaitMs, IN_FLIGHT_RETRIES, IN_FLIGHT_MAX_WAIT_MS } from "@/lib/llm/complete";

/**
 * LLMCREDIT-2 — spec `docs/design/llmcredit2-in-flight-refusal.md`.
 *
 * The SECOND 402, uncovered once LLMCREDIT-1 fixed the first. OpenRouter reserves credit per IN-FLIGHT
 * request, so a burst of parallel calls against a small balance has some members refused — and the
 * remedy is the opposite of the size refusal's: wait, do not shrink. Measured on prod: 41 of 43
 * timeline-summary failures inside one minute, while a 45-item person-day succeeded and a 40-item one
 * did not. Position in the burst was the discriminator, not size.
 */

/** The body prod actually returned, verbatim — a paraphrase would test the paraphrase. */
const IN_FLIGHT_402 =
  '{"error":{"message":"This request would exceed your available credits given your current in-flight ' +
  'requests. Retry after in-flight requests settle, or add credits.","code":402,"metadata":' +
  '{"reason":"in_flight_budget_exhausted","limit_source":"openrouter_in_flight_budget","remedy_hint":' +
  '"Retry after your in-flight requests settle (see the Retry-After header). Adding credits at ' +
  'https://openrouter.ai/settings/credits raises your in-flight budget"}},"user_id":"u"}';

/** LLMCREDIT-1's body, for the disjointness criterion. */
const SIZE_402 =
  '{"error":{"message":"This request requires more credits, or fewer max_tokens. You requested up to ' +
  '6900 tokens, but can only afford 3116.","code":402,"metadata":{"limit_source":"openrouter_credits"}}}';

describe("LLMCREDIT-2: an in-flight refusal is a throttle, not a verdict", () => {
  it("AC1: the real production body is recognised", () => {
    expect(looksLikeInFlightRefusal(402, IN_FLIGHT_402)).toBe(true);
    for (const phrase of [
      '"reason":"in_flight_budget_exhausted"',
      "Retry after in-flight requests settle",
      '"limit_source":"openrouter_in_flight_budget"',
    ]) {
      expect(looksLikeInFlightRefusal(402, phrase), phrase).toBe(true);
    }
    // Status still gates it — the same words on another status are somebody else's problem.
    expect(looksLikeInFlightRefusal(429, IN_FLIGHT_402)).toBe(false);
  });

  it("AC2: the three predicates are DISJOINT — overlap would apply the wrong remedy", () => {
    // The in-flight body must NOT look like something to shrink…
    expect(looksLikeBudgetRefusal(402, IN_FLIGHT_402)).toBe(false);
    expect(looksLikeSizeRefusal(402, IN_FLIGHT_402)).toBe(false);
    expect(looksLikeTokenLimit(402, IN_FLIGHT_402)).toBe(false);
    // …and the size body must NOT look like something to wait for.
    expect(looksLikeInFlightRefusal(402, SIZE_402)).toBe(false);
    expect(looksLikeBudgetRefusal(402, SIZE_402)).toBe(true);
  });

  it("AC5: Retry-After is honoured when sane, clamped when not", () => {
    const noJitter = () => 1; // pins the random draw so the assertions are deterministic
    // ⚠️ AT LEAST the header, never exactly it. A review round caught the first version pinning
    // `toBe(2000)` — which PINNED THE BUG: the provider's remedy_hint tells every refused sibling to
    // read the same Retry-After, so honouring it verbatim releases all six together and reproduces
    // the collision. RFC 9110 makes the header a minimum, so the spread goes upward.
    const honoured = inFlightWaitMs("2", 0, noJitter);
    expect(honoured, "the header is honoured as a floor").toBeGreaterThanOrEqual(2000);
    expect(honoured, "and still clamped").toBeLessThanOrEqual(IN_FLIGHT_MAX_WAIT_MS);
    expect(
      inFlightWaitMs("2", 0, () => 0),
      "two siblings handed the SAME header must not wait the same time"
    ).not.toBe(inFlightWaitMs("2", 0, () => 1));
    // Absent / negative / non-numeric / absurd all fall back to the computed backoff.
    for (const bad of [null, "-5", "soon", String(IN_FLIGHT_MAX_WAIT_MS / 1000 + 60)]) {
      const ms = inFlightWaitMs(bad, 0, noJitter);
      expect(ms, `${bad} must not be honoured verbatim`).toBeLessThanOrEqual(IN_FLIGHT_MAX_WAIT_MS);
      expect(ms).toBeGreaterThan(0);
    }
    // Backoff grows with the attempt, and is always clamped.
    expect(inFlightWaitMs(null, 3, noJitter)).toBeLessThanOrEqual(IN_FLIGHT_MAX_WAIT_MS);
    // JITTER IS THE POINT: six siblings refused together must not be released in lockstep.
    expect(inFlightWaitMs(null, 0, () => 0)).not.toBe(inFlightWaitMs(null, 0, () => 1));
  });
});

describe("LLMCREDIT-2: the retry, against a stubbed transport", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const inFlight = (retryAfter?: string) =>
    ({
      ok: false,
      status: 402,
      headers: { get: (k: string) => (k.toLowerCase() === "retry-after" ? (retryAfter ?? null) : null) },
      text: async () => IN_FLIGHT_402,
      json: async () => ({}),
    }) as unknown as Response;
  const ok = (content: string) =>
    ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ choices: [{ message: { content }, finish_reason: "stop" }] }),
      text: async () => "",
    }) as unknown as Response;

  /**
   * Drives fake timers while the call's internal sleeps resolve.
   *
   * The no-op `catch` marks `p` handled BEFORE we await the timers: without it, a call that rejects
   * while the timers are still advancing has no handler attached yet and vitest reports an unhandled
   * rejection beside an otherwise-passing test. The caller's `await`/`rejects` is still the real
   * handler — this only stops the interval in between from looking like an escape.
   */
  async function settle<T>(p: Promise<T>): Promise<T> {
    p.catch(() => {});
    await vi.advanceTimersByTimeAsync(IN_FLIGHT_MAX_WAIT_MS * (IN_FLIGHT_RETRIES + 2));
    return p;
  }

  it("AC3: refused for in-flight budget, then retried at the SAME rung, and it succeeds", async () => {
    fetchMock.mockResolvedValueOnce(inFlight()).mockResolvedValueOnce(ok("Shipped the access fixes."));

    const out = await settle(completeText({ system: "s", prompt: "p" }, { maxTokens: 200 }));

    expect(out).toBe("Shipped the access fixes.");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const first = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    const second = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string);
    // ⚠️ SAME rung. Shrinking is the wrong remedy here — the problem is the other requests in flight,
    // and a smaller one would be refused for exactly the same reason.
    expect(second.max_tokens, "the retry re-sends the same budget").toBe(first.max_tokens);
    expect(first.max_tokens).toBe(200 + 6000);
  });

  it("AC4: the retry is BOUNDED — a provider refusing forever throws instead of looping", async () => {
    fetchMock.mockResolvedValue(inFlight());

    await expect(settle(completeText({ system: "s", prompt: "p" }, { maxTokens: 200 }))).rejects.toThrow(/402/);
    // EXACTLY the allowance, not "at most twice it". A review round caught the loose `<=` letting a
    // widen-the-bound mutant survive — and corrected the count: the second rung never fires, because
    // an in-flight body is not a SIZE refusal, so the ladder throws instead of stepping down.
    expect(fetchMock.mock.calls.length, "one attempt plus its bounded retries, on one rung").toBe(
      IN_FLIGHT_RETRIES + 1
    );
  });

  it("AC8: the added waiting is bounded by the CALLER's budget, not just the attempt count", async () => {
    // `timeoutMs` does not bound this on its own — the abort signal is built per request, so every
    // attempt gets a fresh one and the wall clock is the sum. A caller that asked for 500ms must not
    // be kept waiting through the full retry allowance.
    fetchMock.mockResolvedValue(inFlight());

    await expect(
      settle(completeText({ system: "s", prompt: "p" }, { maxTokens: 200, timeoutMs: 500 }))
    ).rejects.toThrow(/402/);

    // Strictly fewer requests than the unbounded allowance: the deadline cuts the retry short.
    expect(fetchMock.mock.calls.length).toBeLessThan(IN_FLIGHT_RETRIES + 1);
  });

  it("AC6: the flavours are distinguishable in the ledger", async () => {
    fetchMock.mockResolvedValueOnce(inFlight()).mockResolvedValueOnce(ok("text"));
    const rows: Record<string, unknown>[] = [];
    const db = {
      from: () => ({ insert: async (r: Record<string, unknown>) => { rows.push(r); return { error: null }; } }),
    } as never;

    await settle(
      completeText({ system: "s", prompt: "p" }, { maxTokens: 200, meter: { db, teamId: "t1", source: "arcs" } })
    );

    const reasons = rows.filter((r) => r.failure_reason !== undefined).map((r) => r.failure_reason);
    // Not plain `http_402`: nothing in the database could tell the two causes apart before this.
    expect(reasons).toContain("http_402_in_flight");
  });

  it("AC6b: the row for the failure that actually KILLED the task carries the flavour too", async () => {
    // The retry rows said `http_402_in_flight` while the TERMINAL row said plain `http_402` — so the
    // one row describing the fatal refusal was indistinguishable from a dead account. Review finding.
    fetchMock.mockResolvedValue(inFlight());
    const rows: Record<string, unknown>[] = [];
    const db = {
      from: () => ({ insert: async (r: Record<string, unknown>) => { rows.push(r); return { error: null }; } }),
    } as never;

    await expect(
      settle(completeText({ system: "s", prompt: "p" }, { maxTokens: 200, meter: { db, teamId: "t1", source: "arcs" } }))
    ).rejects.toThrow(/402/);

    const reasons = rows.filter((r) => r.failure_reason !== undefined).map((r) => r.failure_reason);
    expect(reasons.length, "the retries plus the terminal row").toBeGreaterThan(1);
    expect(reasons, "every one of them names the flavour").toEqual(reasons.map(() => "http_402_in_flight"));
  });

  it("AC7: a SIZE refusal still steps DOWN rather than waiting in place", async () => {
    const size = () =>
      ({ ok: false, status: 402, headers: { get: () => null }, text: async () => SIZE_402, json: async () => ({}) }) as unknown as Response;
    fetchMock.mockResolvedValueOnce(size()).mockResolvedValueOnce(ok("text"));

    const out = await settle(completeText({ system: "s", prompt: "p" }, { maxTokens: 200 }));

    expect(out).toBe("text");
    const first = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    const second = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string);
    expect(first.max_tokens).toBe(200 + 6000);
    expect(second.max_tokens, "LLMCREDIT-1's ladder is untouched — this one shrinks").toBe(200);
  });
});
