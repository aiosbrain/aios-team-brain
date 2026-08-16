import { describe, it, expect, vi, afterEach } from "vitest";
import {
  StreamHttpError,
  isRetryableStreamError,
  streamRetryDelayMs,
  clientErrorMessage,
  withStreamRetry,
  classifyErrorFrame,
  RETRYABLE_STATUS,
} from "@/lib/query/stream-retry";
import { streamAnswer, streamOpenAICompatible, type StreamAnswerEvent } from "@/lib/query/claude";
import type { LlmBackend } from "@/lib/query/llm-backend";
import type { RetrievedContext } from "@/lib/query/retrieve";

type Ev = { type: "delta"; text: string } | { type: "done" };
const isCommitted = (e: Ev): boolean => e.type === "delta";

async function collect(gen: AsyncGenerator<Ev>): Promise<Ev[]> {
  const out: Ev[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

describe("isRetryableStreamError", () => {
  it("retries the transient HTTP statuses (rate-limit, overloaded, 5xx) by .status", () => {
    for (const s of [408, 409, 429, 500, 502, 503, 504, 529]) {
      expect(RETRYABLE_STATUS.has(s)).toBe(true);
      expect(isRetryableStreamError(new StreamHttpError(s, `err ${s}`))).toBe(true);
    }
  });

  it("does NOT retry auth/validation/token-limit errors", () => {
    for (const s of [400, 401, 403, 404, 422]) {
      expect(isRetryableStreamError(new StreamHttpError(s, `err ${s}`))).toBe(false);
    }
  });

  it("reads .status and .statusCode off plain error-shaped objects", () => {
    expect(isRetryableStreamError({ status: 529 })).toBe(true);
    expect(isRetryableStreamError({ statusCode: 503 })).toBe(true);
    expect(isRetryableStreamError({ status: 401 })).toBe(false);
  });

  it("retries statusless connection/timeout/overloaded errors — using the SHAPES the Anthropic SDK really throws", () => {
    // Real SDK shapes: APIConnectionError → message "Connection error.", name "Error", status undefined;
    // APIConnectionTimeoutError → message "Request timed out.". (Not a hand-set .name.)
    expect(isRetryableStreamError(new Error("Connection error."))).toBe(true);
    expect(isRetryableStreamError(new Error("Request timed out."))).toBe(true);
    expect(isRetryableStreamError(new Error("fetch failed"))).toBe(true);
    expect(isRetryableStreamError(new Error("read ECONNRESET"))).toBe(true);
    // A statusless body carrying Anthropic's canonical overloaded shape.
    expect(isRetryableStreamError(new Error('{"type":"overloaded_error"}'))).toBe(true);
    // A hand-tagged APIConnectionError (some SDK versions) still classifies by name.
    const conn = new Error("socket hang up");
    conn.name = "APIConnectionError";
    expect(isRetryableStreamError(conn)).toBe(true);
  });

  it("does NOT let a connection-shaped BODY rescue a permanent status (status-first short-circuit)", () => {
    // StreamHttpError embeds the provider body; a permanent 403 whose body says "connection closed"
    // must stay non-retryable — the status decides, the message is never consulted when a status exists.
    expect(isRetryableStreamError(new StreamHttpError(403, "403 error 1020 connection closed by policy"))).toBe(false);
    expect(isRetryableStreamError(new StreamHttpError(401, "401 request timed out per the proxy"))).toBe(false);
    expect(isRetryableStreamError(new StreamHttpError(422, "422 network error in the payload text"))).toBe(false);
  });

  it("does NOT retry a plain non-transient error or a non-object", () => {
    expect(isRetryableStreamError(new Error("nope"))).toBe(false);
    expect(isRetryableStreamError(null)).toBe(false);
    expect(isRetryableStreamError("529")).toBe(false);
    expect(isRetryableStreamError(529)).toBe(false);
  });
});

describe("classifyErrorFrame — string codes must not all become retryable 502", () => {
  it("keeps a numeric or numeric-string code as its status", () => {
    expect(classifyErrorFrame({ code: 429 }).status).toBe(429);
    expect(classifyErrorFrame({ code: "429" }).status).toBe(429);
    expect(classifyErrorFrame({ code: 503 }).status).toBe(503);
  });

  it("maps a known-permanent STRING code/type to 401 (non-retryable) — the OpenAI/OpenRouter shape", () => {
    for (const frame of [
      { code: "invalid_api_key" },
      { code: "insufficient_quota" },
      { type: "authentication_error" },
      { code: "401" },
      { message: "You have no credits remaining. Add credits to continue." },
    ]) {
      const { status } = classifyErrorFrame(frame);
      expect(status).toBe(401);
      expect(isRetryableStreamError(new StreamHttpError(status, "x"))).toBe(false);
    }
  });

  it("defaults an unknown / transient-worded frame to retryable 502", () => {
    expect(classifyErrorFrame({ message: "the model is momentarily overloaded" }).status).toBe(502);
    expect(classifyErrorFrame({}).status).toBe(502);
    expect(isRetryableStreamError(new StreamHttpError(502, "x"))).toBe(true);
  });

  it("tolerates a non-object frame (bare string / true) without throwing, keeping its text", () => {
    expect(classifyErrorFrame("overloaded, retry")).toEqual({ status: 502, detail: "overloaded, retry" });
    expect(classifyErrorFrame(true).status).toBe(502);
    expect(classifyErrorFrame(null).status).toBe(502);
  });
});

describe("streamRetryDelayMs", () => {
  it("grows exponentially from the base and is capped", () => {
    expect(streamRetryDelayMs(1)).toBe(400);
    expect(streamRetryDelayMs(2)).toBe(800);
    expect(streamRetryDelayMs(3)).toBe(1600);
    expect(streamRetryDelayMs(20)).toBe(5000); // capped
    expect(streamRetryDelayMs(1000)).toBe(5000); // no overflow past the cap
  });

  it("is monotonic non-decreasing and treats sub-1 attempts as the first", () => {
    expect(streamRetryDelayMs(0)).toBe(400);
    let prev = 0;
    for (let n = 1; n <= 25; n++) {
      const d = streamRetryDelayMs(n);
      expect(d).toBeGreaterThanOrEqual(prev);
      expect(d).toBeLessThanOrEqual(5000);
      prev = d;
    }
  });
});

describe("clientErrorMessage — sanitized + friendly", () => {
  it("gives a 'model was busy, try again' line for transient errors", () => {
    expect(clientErrorMessage(new StreamHttpError(529, "overloaded"))).toMatch(/busy|try again in a moment/i);
  });

  it("gives a generic line for a non-transient error", () => {
    const msg = clientErrorMessage(new StreamHttpError(401, "invalid api key"));
    expect(msg).toMatch(/something went wrong|try again/i);
    expect(msg).not.toMatch(/busy/i);
  });

  it("NEVER leaks the internal model or base URL from the raw error", () => {
    const raw = new StreamHttpError(529, "LLM secret-model-x @ https://internal.openrouter.ai/api/v1: 529 overloaded");
    const msg = clientErrorMessage(raw);
    expect(msg).not.toContain("openrouter.ai");
    expect(msg).not.toContain("secret-model-x");
    expect(msg).not.toContain("internal");
  });
});

describe("withStreamRetry — retry only before the first delta", () => {
  /** A factory that throws `err()` on its first `failCount` invocations, then streams delta+done. */
  function failingThenOk(failCount: number, err: () => unknown) {
    let calls = 0;
    const factory = (): AsyncGenerator<Ev> => {
      calls += 1;
      const shouldFail = calls <= failCount;
      return (async function* () {
        if (shouldFail) throw err();
        yield { type: "delta", text: "hi" } as Ev;
        yield { type: "done" } as Ev;
      })();
    };
    return { factory, calls: () => calls };
  }

  it("retries a transient pre-delta failure, then yields the full stream", async () => {
    const { factory, calls } = failingThenOk(2, () => new StreamHttpError(529, "overloaded"));
    const sleep = vi.fn(async () => {});
    const onRetry = vi.fn();
    const out = await collect(
      withStreamRetry(factory, isCommitted, { maxAttempts: 3, sleep, onRetry, delayMs: (n) => n * 10 })
    );
    expect(out).toEqual([{ type: "delta", text: "hi" }, { type: "done" }]);
    expect(calls()).toBe(3); // 2 failures + 1 success
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenNthCalledWith(1, 10);
    expect(sleep).toHaveBeenNthCalledWith(2, 20);
    expect(onRetry.mock.calls.map((c) => c[0].attempt)).toEqual([1, 2]);
  });

  it("does NOT retry a non-retryable pre-delta failure", async () => {
    const { factory, calls } = failingThenOk(1, () => new StreamHttpError(401, "401 invalid api key"));
    const sleep = vi.fn(async () => {});
    await expect(collect(withStreamRetry(factory, isCommitted, { sleep }))).rejects.toThrow(/401/);
    expect(calls()).toBe(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("does NOT retry once a delta has already been emitted (no duplication)", async () => {
    const yielded: Ev[] = [];
    const factory = (): AsyncGenerator<Ev> =>
      (async function* () {
        yield { type: "delta", text: "partial" } as Ev;
        throw new StreamHttpError(529, "overloaded"); // transient, but mid-stream
      })();
    const sleep = vi.fn(async () => {});
    await expect(
      (async () => {
        for await (const e of withStreamRetry(factory, isCommitted, { sleep })) yielded.push(e);
      })()
    ).rejects.toThrow(/overloaded/);
    expect(yielded).toEqual([{ type: "delta", text: "partial" }]); // emitted exactly once
    expect(sleep).not.toHaveBeenCalled();
  });

  it("throws the last error after exhausting the attempt budget", async () => {
    const { factory, calls } = failingThenOk(99, () => new StreamHttpError(503, "503 boom"));
    const sleep = vi.fn(async () => {});
    await expect(
      collect(withStreamRetry(factory, isCommitted, { maxAttempts: 2, sleep }))
    ).rejects.toThrow(/503/);
    expect(calls()).toBe(2);
    expect(sleep).toHaveBeenCalledTimes(1); // one retry between the two attempts
  });
});

// --- Integration over the real claude.ts stream (fetch-mocked) -----------------------------------

const OPENAI_BACKEND = {
  kind: "openai-compatible",
  provider: "openai",
  baseUrl: "https://api.example.com/v1",
  model: "test-model",
  apiKey: "test-key",
  headers: {},
} as unknown as Extract<LlmBackend, { kind: "openrouter" | "openai-compatible" }>;

/** A mock streamed SSE Response from pre-formatted `data: …\n\n` frames. */
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
const deltaFrame = (s: string) => `data: ${JSON.stringify({ choices: [{ delta: { content: s } }] })}\n\n`;

async function drainDeltas(gen: AsyncGenerator<StreamAnswerEvent>): Promise<string> {
  let out = "";
  for await (const ev of gen) if (ev.type === "delta") out += ev.text;
  return out;
}

describe("streamOpenAICompatible — a 200 stream carrying only an error frame (the HIGH)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("throws a classified error (not a silent empty answer) so the retry can fire", async () => {
    const errFrame = `data: ${JSON.stringify({ error: { code: 429, message: "provider overloaded" } })}\n\n`;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(streamResponse([errFrame, "data: [DONE]\n\n"])));
    let caught: unknown;
    try {
      await drainDeltas(streamOpenAICompatible(OPENAI_BACKEND, "", "", "", "", "", "q", "UTC"));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(StreamHttpError);
    expect((caught as StreamHttpError).status).toBe(429);
    expect(isRetryableStreamError(caught)).toBe(true); // → withStreamRetry will retry it
  });

  it("a permanent STRING-code error frame throws a NON-retryable error (broken key surfaces, not retried)", async () => {
    const errFrame = `data: ${JSON.stringify({ error: { code: "invalid_api_key", message: "bad key" } })}\n\n`;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(streamResponse([errFrame, "data: [DONE]\n\n"])));
    let caught: unknown;
    try {
      await drainDeltas(streamOpenAICompatible(OPENAI_BACKEND, "", "", "", "", "", "q", "UTC"));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(StreamHttpError);
    expect((caught as StreamHttpError).status).toBe(401);
    expect(isRetryableStreamError(caught)).toBe(false); // → withStreamRetry will NOT retry it
  });

  it("still yields a clean empty done (no throw) when the blank has NO error frame (reasoning starvation)", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const usageOnly = `data: ${JSON.stringify({ usage: { completion_tokens: 4096 } })}\n\n`;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(streamResponse([usageOnly, "data: [DONE]\n\n"])));
    const text = await drainDeltas(streamOpenAICompatible(OPENAI_BACKEND, "", "", "", "", "", "q", "UTC"));
    expect(text).toBe(""); // an empty answer, but NOT thrown — retrying wouldn't help a starved model
    err.mockRestore();
  });
});

describe("streamAnswer — the retry wiring is actually connected (call-site pin)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("retries a transient pre-delta failure end-to-end and streams the answer once", async () => {
    const fetchMock = vi
      .fn()
      // First attempt: a retryable 503 (non-token-limit) → StreamHttpError → wrapper retries.
      .mockResolvedValueOnce({ ok: false, status: 503, text: async () => "service unavailable", body: null })
      // Retry: a clean stream.
      .mockResolvedValueOnce(streamResponse([deltaFrame("hello"), "data: [DONE]\n\n"]));
    vi.stubGlobal("fetch", fetchMock);
    const sleep = vi.fn(async () => {});
    const ctx = { sources: [], structured: "", grounded: true } as unknown as RetrievedContext;
    const keys = { openrouterKey: "k", openrouterModel: "test-model" };
    const out = await drainDeltas(
      streamAnswer(ctx, "q", keys, [], undefined, "UTC", { sleep, delayMs: () => 1 })
    );
    expect(out).toBe("hello");
    expect(fetchMock).toHaveBeenCalledTimes(2); // failed once, retried once
    expect(sleep).toHaveBeenCalledTimes(1); // deleting withStreamRetry from streamAnswer reddens this
  });
});
