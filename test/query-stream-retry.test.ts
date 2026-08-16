import { describe, it, expect, vi } from "vitest";
import {
  StreamHttpError,
  isRetryableStreamError,
  streamRetryDelayMs,
  clientErrorMessage,
  withStreamRetry,
  RETRYABLE_STATUS,
} from "@/lib/query/stream-retry";

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

  it("retries connection/overloaded-shaped errors that carry no status", () => {
    const conn = new Error("socket hang up");
    conn.name = "APIConnectionError";
    expect(isRetryableStreamError(conn)).toBe(true);
    expect(isRetryableStreamError(new Error("fetch failed"))).toBe(true);
    expect(isRetryableStreamError(new Error("read ECONNRESET"))).toBe(true);
    expect(isRetryableStreamError(new Error("the model is overloaded"))).toBe(true);
  });

  it("does NOT retry a plain non-transient error or a non-object", () => {
    expect(isRetryableStreamError(new Error("nope"))).toBe(false);
    expect(isRetryableStreamError(null)).toBe(false);
    expect(isRetryableStreamError("529")).toBe(false);
    expect(isRetryableStreamError(529)).toBe(false);
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
