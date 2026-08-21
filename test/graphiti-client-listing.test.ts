import { afterEach, describe, expect, it, vi } from "vitest";
import { GraphitiClient, parseEpisodeListing } from "@/lib/graph/graphiti-client";
import { landedListTimeoutMs } from "@/lib/graph/reconcile";

vi.mock("server-only", () => ({}));

// RECONULL-1: the listing body is validated strictly (a malformed 200 used to read as an EMPTY listing
// and take reconcile's hold-less REST path), and the listing's deadline is a per-call override.

describe("parseEpisodeListing — strict", () => {
  it("accepts a bare array and { episodes: [...] }", () => {
    expect(parseEpisodeListing([{ uuid: "u", name: "items:a" }], "g")).toEqual([{ uuid: "u", name: "items:a" }]);
    expect(parseEpisodeListing({ episodes: [{ uuid: "u", name: "items:a", extra: 1 }] }, "g")).toEqual([{ uuid: "u", name: "items:a" }]);
    expect(parseEpisodeListing([], "g")).toEqual([]);
  });
  it("throws on {}, a scalar, null, { episodes: undefined }, { episodes: 'oops' }", () => {
    for (const bad of [{}, 42, null, "x", { episodes: undefined }, { episodes: "oops" }]) {
      expect(() => parseEpisodeListing(bad, "g"), JSON.stringify(bad)).toThrow(/malformed listing body/);
    }
  });
  it("throws on a ref without a string uuid or name", () => {
    expect(() => parseEpisodeListing([{ name: "items:a" }], "g")).toThrow(/malformed episode ref at index 0/);
    expect(() => parseEpisodeListing([{ uuid: "u" }], "g")).toThrow(/malformed episode ref/);
    expect(() => parseEpisodeListing([{ uuid: 1, name: "x" }], "g")).toThrow(/malformed episode ref/);
  });
});

describe("listEpisodes — per-call deadline", () => {
  afterEach(() => vi.useRealTimers());
  /** An ABORT-AWARE fetch: a pending promise that rejects from the signal's abort listener (a mock
   *  that merely never resolves would not reject when aborted). */
  const hangingFetch = (): typeof fetch =>
    ((_url: string, init?: RequestInit) =>
      new Promise((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" })));
      })) as unknown as typeof fetch;

  it("aborts at the override (5s), not at the client default (30s)", async () => {
    vi.useFakeTimers();
    const client = new GraphitiClient({ baseUrl: "http://g.test", fetchImpl: hangingFetch() });
    const p = client.listEpisodes("grp", 5000, { timeoutMs: 5_000 });
    const outcome = p.then(() => "resolved", (e: Error) => e.name);
    await vi.advanceTimersByTimeAsync(4_999);
    let settled = false;
    void outcome.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    expect(await outcome).toBe("AbortError");
  });

  it("without an override the client default (30s) applies; a non-positive override falls back to it", async () => {
    vi.useFakeTimers();
    const client = new GraphitiClient({ baseUrl: "http://g.test", fetchImpl: hangingFetch() });
    const outcome = client.listEpisodes("grp", 5000, { timeoutMs: 0 }).then(() => "resolved", (e: Error) => e.name);
    await vi.advanceTimersByTimeAsync(29_999);
    let settled = false;
    void outcome.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    expect(await outcome).toBe("AbortError");
  });
});

describe("GRAPH_LANDED_LIST_TIMEOUT_MS — escape hatch parse", () => {
  it("unset / 0 / garbage → undefined (the client default); a positive number → itself", () => {
    expect(landedListTimeoutMs({})).toBeUndefined();
    expect(landedListTimeoutMs({ GRAPH_LANDED_LIST_TIMEOUT_MS: "0" })).toBeUndefined();
    expect(landedListTimeoutMs({ GRAPH_LANDED_LIST_TIMEOUT_MS: "soon" })).toBeUndefined();
    expect(landedListTimeoutMs({ GRAPH_LANDED_LIST_TIMEOUT_MS: "90000" })).toBe(90_000);
  });
});
