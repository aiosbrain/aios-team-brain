import { describe, expect, it } from "vitest";
import { readBoundedJson, type BoundedJsonResult } from "@/lib/api/bounded-json";
import { MAX_SCAN_BODY_BYTES } from "@/lib/api/codebase-request-limits";

/**
 * AUDITFIX-17 / AIO-1136 — AC17-03 (early return, no retention, lock release) and AC17-04
 * (decoding), plus the reader half of AC17-02 (the literal byte boundary and the
 * `Content-Length` rules). Spec: docs/design/auditfix17-request-bounds.md.
 *
 * WHY THIS TIER. These are properties of the READ, not of the response: how many times the
 * application called `read()`, whether the crossing chunk was kept, whether the lock came back,
 * whether the answer arrived before EOF. A real socket cannot see any of them — the HTTP tier
 * (test/http/codebases-request-bounds.http.test.ts) proves the wire outcome and that a rejected
 * scan writes nothing; this file proves the algorithm underneath it.
 *
 * The `Request` doubles below expose exactly what the reader consumes — `headers` and a `body`
 * with `getReader()` — so a read count is an APPLICATION read count. Driving a platform
 * `Request` instead would fold in whatever undici prefetches, which is not the thing under test.
 * The two real-`ReadableStream` cases exist for the one property a double cannot honestly
 * report: `stream.locked`.
 *
 * Every case that could hang if the reader kept going is wrapped in `within()`, which REJECTS
 * with a diagnostic rather than stalling the suite — "awaited EOF" must be a visible failure,
 * not a timeout somebody later marks flaky.
 */

const encoder = new TextEncoder();
const encode = (text: string) => encoder.encode(text);

/** A bounded wait that fails loudly. An absent answer is the exact bug these cases rule out. */
async function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what}: nothing settled within ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

interface ReaderProbe {
  /** `read()` calls the APPLICATION made. */
  reads: number;
  releases: number;
  cancels: number;
}

/**
 * A `Request` double whose reader is instrumented.
 *
 * `afterQueue: "stay-open"` models a client that has crossed the limit and is still sending: the
 * read after the queue never settles, so an implementation that waited for EOF would never
 * answer — and `within()` turns that into a named failure.
 */
function stubRequest(options: {
  chunks: readonly Uint8Array[];
  headers?: Record<string, string>;
  afterQueue?: "close" | "stay-open";
  failAtRead?: number;
}): { req: Request; probe: ReaderProbe } {
  const { chunks, headers = {}, afterQueue = "close", failAtRead } = options;
  const probe: ReaderProbe = { reads: 0, releases: 0, cancels: 0 };
  let next = 0;

  const reader = {
    read(): Promise<{ done: boolean; value?: Uint8Array }> {
      const nth = probe.reads++;
      if (failAtRead !== undefined && nth === failAtRead) {
        return Promise.reject(new Error("connection reset"));
      }
      if (next < chunks.length) {
        return Promise.resolve({ done: false, value: chunks[next++] });
      }
      if (afterQueue === "stay-open") return new Promise<never>(() => {});
      return Promise.resolve({ done: true, value: undefined });
    },
    releaseLock(): void {
      probe.releases++;
    },
    cancel(): Promise<void> {
      probe.cancels++;
      return Promise.resolve();
    },
  };

  const req = {
    headers: new Headers(headers),
    body: { getReader: () => reader },
  } as unknown as Request;
  return { req, probe };
}

/** A REAL stream, for the one thing a double cannot report honestly: `locked`. */
function realStreamRequest(chunks: readonly Uint8Array[], close: boolean) {
  const cancelled = { called: false };
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      if (close) controller.close();
    },
    cancel() {
      cancelled.called = true;
    },
  });
  const req = { headers: new Headers(), body: stream } as unknown as Request;
  return { req, stream, cancelled };
}

/** Split `bytes` into fixed-size chunks so a body genuinely streams. */
function chunked(bytes: Uint8Array, size: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let i = 0; i < bytes.byteLength; i += size) out.push(bytes.slice(i, i + size));
  return out;
}

/** Valid ASCII JSON of EXACTLY `targetBytes`, padded with insignificant whitespace. */
function jsonOfExactBytes(payload: unknown, targetBytes: number): string {
  const base = JSON.stringify(payload);
  const padding = targetBytes - base.length;
  if (padding < 0) throw new Error(`payload is already ${base.length} B > ${targetBytes} B`);
  const body = `{${" ".repeat(padding)}${base.slice(1)}`;
  if (Buffer.byteLength(body, "utf8") !== targetBytes) {
    throw new Error(`padding failed: ${Buffer.byteLength(body, "utf8")} != ${targetBytes}`);
  }
  return body;
}

/** What `Request.json()` — the behaviour this reader must not diverge from — does with `bytes`. */
async function requestJsonOutcome(
  bytes: Uint8Array,
): Promise<{ ok: true; value: unknown } | { ok: false }> {
  try {
    const reference = new Request("https://brain.example.com/api/v1/codebases", {
      method: "POST",
      body: bytes as unknown as BodyInit,
    });
    return { ok: true, value: await reference.json() };
  } catch {
    return { ok: false };
  }
}

const value = (result: BoundedJsonResult) => (result.ok ? result.value : undefined);

describe("AC17-02 (reader) — the literal byte boundary", () => {
  // The route's cap and the number these cases use are the same number, asserted rather than
  // assumed. The cases below then use the LITERAL, so this file cannot drift into comparing an
  // exported constant with itself.
  it("the scan cap is 2,400,000 bytes", () => {
    expect(MAX_SCAN_BODY_BYTES).toBe(2_400_000);
  });

  it("admits a chunked body of exactly 2,400,000 bytes", async () => {
    const body = jsonOfExactBytes({ scan: "at-the-ceiling" }, 2_400_000);
    const { req } = stubRequest({ chunks: chunked(encode(body), 64_000) });

    const result = await within(readBoundedJson(req, 2_400_000), 10_000, "at-the-ceiling read");

    expect(result.ok).toBe(true);
    expect(value(result)).toEqual({ scan: "at-the-ceiling" });
  });

  it("rejects a chunked body of 2,400,001 bytes", async () => {
    const body = jsonOfExactBytes({ scan: "one-over" }, 2_400_001);
    const { req } = stubRequest({ chunks: chunked(encode(body), 64_000) });

    const result = await within(readBoundedJson(req, 2_400_000), 10_000, "one-over read");

    expect(result).toEqual({ ok: false, failure: "payload_too_large" });
  });

  it("rejects a Content-Length above the cap without reading a single byte", async () => {
    const { req, probe } = stubRequest({
      chunks: [encode("{}")],
      headers: { "content-length": String(2_400_001) },
    });

    const result = await readBoundedJson(req, 2_400_000);

    expect(result).toEqual({ ok: false, failure: "payload_too_large" });
    // The declaration is an OPTIMIZATION: its whole value is that the body is never consumed.
    expect(probe.reads).toBe(0);
  });

  it("a declared length AT the cap is admitted — the bound is inclusive", async () => {
    const body = jsonOfExactBytes({ scan: "declared-at-limit" }, 2_400_000);
    const { req } = stubRequest({
      chunks: chunked(encode(body), 64_000),
      headers: { "content-length": String(2_400_000) },
    });

    const result = await within(readBoundedJson(req, 2_400_000), 10_000, "declared-at-limit read");

    expect(result.ok).toBe(true);
  });

  it("a misleadingly LOW declaration cannot buy admission", async () => {
    // The header says 10 bytes; the stream delivers 2,400,001. The counter is the measurement,
    // so the request is refused on what actually arrived.
    const body = jsonOfExactBytes({ scan: "lying-header" }, 2_400_001);
    const { req } = stubRequest({
      chunks: chunked(encode(body), 64_000),
      headers: { "content-length": "10" },
    });

    const result = await within(readBoundedJson(req, 2_400_000), 10_000, "low-declaration read");

    expect(result).toEqual({ ok: false, failure: "payload_too_large" });
  });

  // NOT included: a value with surrounding whitespace. `Headers` normalises that away before the
  // reader ever sees it, so "2400001 " is a USABLE declaration, not an unusable one.
  it.each(["", "abc", "-1", "+2400001", "2,400,001", "0x10", "2.4e6"])(
    "ignores the unusable Content-Length %j and measures instead",
    async (declared) => {
      // No new Content-Length syntax contract: an unusable declaration is not an error of its
      // own, it is simply not evidence. A small valid body must still be admitted.
      const { req } = stubRequest({
        chunks: [encode('{"ok":true}')],
        headers: { "content-length": declared },
      });

      const result = await readBoundedJson(req, 2_400_000);

      expect(result).toEqual({ ok: true, value: { ok: true } });
    },
  );
});

describe("AC17-03 — the reader stops at the crossing chunk and lets go", () => {
  it("stops reading the moment the running total crosses the cap", async () => {
    // Eight chunks of 10 bytes against a 25-byte cap: the third crosses it (30 > 25). Chunks
    // four through eight are still queued and must never be read.
    const chunks = Array.from({ length: 8 }, () => encode("0123456789"));
    const { req, probe } = stubRequest({ chunks });

    const result = await within(readBoundedJson(req, 25), 5_000, "overflow read");

    expect(result).toEqual({ ok: false, failure: "payload_too_large" });
    expect(probe.reads).toBe(3);
    expect(probe.releases).toBe(1);
    // Release-only. Cancelling a server request body is the runtime's business, not this
    // reader's — see the module header.
    expect(probe.cancels).toBe(0);
  });

  it("never parses the oversized prefix, even when the prefix is a complete document", async () => {
    // The first chunk is EXACTLY the cap and is valid JSON on its own; the second chunk is one
    // trailing byte. A reader that answered from what it had already accumulated would return
    // that document. The whole request is rejected instead — no silent truncation.
    const prefix = jsonOfExactBytes({ truncated: "would-be-accepted" }, 64);
    const { req, probe } = stubRequest({ chunks: [encode(prefix), encode(" ")] });

    const result = await within(readBoundedJson(req, 64), 5_000, "prefix read");

    expect(result).toEqual({ ok: false, failure: "payload_too_large" });
    expect(probe.reads).toBe(2);
  });

  it("answers without waiting for EOF on a source that stays open", async () => {
    // The client crossed the limit and is still sending: after the queued chunks, `read()` never
    // settles. The 413 must not be hostage to the client finishing.
    const { req, probe } = stubRequest({
      chunks: [encode("0".repeat(20)), encode("0".repeat(20))],
      afterQueue: "stay-open",
    });

    const result = await within(
      readBoundedJson(req, 25),
      3_000,
      "413 on a still-open source (the reader awaited EOF)",
    );

    expect(result).toEqual({ ok: false, failure: "payload_too_large" });
    expect(probe.reads).toBe(2);
    expect(probe.releases).toBe(1);
    expect(probe.cancels).toBe(0);
  });

  it("leaves a real stream UNLOCKED and uncancelled after an overflow", async () => {
    // A double can only report that `releaseLock()` was called. `locked` is the actual property
    // the runtime cares about, so one case asserts it against a real ReadableStream — one that
    // is deliberately never closed, so the reader must stop on its own.
    const { req, stream, cancelled } = realStreamRequest(
      [encode("0".repeat(20)), encode("0".repeat(20))],
      false,
    );

    const result = await within(readBoundedJson(req, 25), 3_000, "real-stream overflow");

    expect(result).toEqual({ ok: false, failure: "payload_too_large" });
    expect(stream.locked).toBe(false);
    expect(cancelled.called).toBe(false);
  });

  it("leaves a real stream unlocked after a SUCCESSFUL read too", async () => {
    const { req, stream } = realStreamRequest(chunked(encode('{"ok":true}'), 3), true);

    const result = await within(readBoundedJson(req, 2_400_000), 3_000, "real-stream success");

    expect(result).toEqual({ ok: true, value: { ok: true } });
    expect(stream.locked).toBe(false);
  });

  it("releases the lock when the read itself fails, and reports an unreadable body", async () => {
    const { req, probe } = stubRequest({
      chunks: [encode('{"ok":')],
      failAtRead: 1,
    });

    const result = await within(readBoundedJson(req, 2_400_000), 3_000, "failed read");

    // A dropped connection is not a payload-size verdict: it takes the existing invalid-body
    // path, which the route answers as 422.
    expect(result).toEqual({ ok: false, failure: "unreadable_body" });
    expect(probe.releases).toBe(1);
  });
});

describe("AC17-04 — decoding matches Request.json()", () => {
  /** Our result and `Request.json()`'s must be the same OUTCOME on the same bytes. */
  async function expectMatchesRequestJson(bytes: Uint8Array, chunkSize = 1) {
    const reference = await requestJsonOutcome(bytes);
    const { req } = stubRequest({ chunks: chunked(bytes, chunkSize) });
    const mine = await within(readBoundedJson(req, 2_400_000), 5_000, "decode read");

    expect(mine.ok, `Request.json() ${reference.ok ? "parsed" : "threw"}`).toBe(reference.ok);
    if (mine.ok && reference.ok) expect(mine.value).toEqual(reference.value);
    return { mine, reference };
  }

  it("round-trips multibyte characters split across chunk boundaries", async () => {
    // One byte per chunk, so EVERY multibyte character is split. Decoding per chunk would turn
    // each half into U+FFFD; decoding the concatenation is what makes this work.
    const document = { note: "héllo — café 🚀 日本語", tail: "ok" };
    const bytes = encode(JSON.stringify(document));
    expect(bytes.byteLength).toBeGreaterThan(JSON.stringify(document).length);

    const { mine } = await expectMatchesRequestJson(bytes, 1);

    // Non-vacuity: the reference agreeing is worth nothing if both simply failed.
    expect(mine.ok).toBe(true);
    expect(value(mine)).toEqual(document);
  });

  it("counts BYTES, not characters", async () => {
    // 16 characters, 24 bytes — built rather than typed, so the two counts below are exact by
    // construction. Under a 20-byte cap a CHARACTER count would admit this document.
    const accented = "é".repeat(8);
    const body = `{"s":"${accented}"}`;
    const bytes = encode(body);
    expect(body.length).toBe(16);
    expect(bytes.byteLength).toBe(24);

    const over = stubRequest({ chunks: chunked(bytes, 5) });
    expect(await within(readBoundedJson(over.req, 20), 3_000, "byte-count read")).toEqual({
      ok: false,
      failure: "payload_too_large",
    });

    // Same document, a cap equal to its true byte length: admitted. Without this half the case
    // above would pass against a reader that rejected everything.
    const exact = stubRequest({ chunks: chunked(bytes, 5) });
    const admitted = await within(readBoundedJson(exact.req, 24), 3_000, "byte-count read");
    expect(admitted.ok).toBe(true);
    expect(value(admitted)).toEqual({ s: accented });
  });

  it("handles a UTF-8 BOM exactly as Request.json() does", async () => {
    const bom = Uint8Array.from([0xef, 0xbb, 0xbf]);
    const json = encode('{"a":1}');
    const bytes = new Uint8Array(bom.byteLength + json.byteLength);
    bytes.set(bom, 0);
    bytes.set(json, bom.byteLength);

    await expectMatchesRequestJson(bytes, 2);
  });

  it("applies ordinary replacement to invalid UTF-8, rather than a new strict rejection", async () => {
    // A lone 0xFF inside a JSON string. The gateway reader's `fatal: true` decoder would reject
    // this; the platform's would not, and bounding a body must not smuggle in a new error class.
    const bytes = Uint8Array.from([
      ...encode('{"s":"'),
      0xff,
      ...encode('"}'),
    ]);

    const { mine } = await expectMatchesRequestJson(bytes, 3);

    const REPLACEMENT = String.fromCharCode(0xfffd);
    expect(mine.ok).toBe(true);
    expect(value(mine)).toEqual({ s: REPLACEMENT });
  });

  it.each([
    ["malformed JSON", '{"a":'],
    ["a bare fragment", "not json at all"],
    ["an empty body", ""],
  ])("reports %s as an unreadable body", async (label, text) => {
    const { req } = stubRequest({ chunks: text ? [encode(text)] : [] });

    const result = await within(readBoundedJson(req, 2_400_000), 3_000, "invalid-body read");

    expect(result, label).toEqual({ ok: false, failure: "unreadable_body" });
  });

  it("reports an absent body as unreadable, not as an empty object", async () => {
    const req = { headers: new Headers(), body: null } as unknown as Request;

    expect(await readBoundedJson(req, 2_400_000)).toEqual({
      ok: false,
      failure: "unreadable_body",
    });
  });
});
