import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbClient } from "@/lib/db/types";

// AIO-1167 R66 — the captured revocation epoch is TRUSTED only when `capture` built it, is CONSISTENT
// with the graph facts the context carries, and is re-checked before every dispatch of captured
// source text: the answer (`streamAnswer`, each attempt) and a configured reranker.
// (The two real query routes, the retry backoff and the real PostgreSQL retirement are pinned in
// test/datamechanics/query-revocation-dispatch.datamechanics.test.ts.)

const epochs = vi.hoisted(() => ({ value: 1 as number | Error }));
vi.mock("@/lib/access/authorization-epoch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/access/authorization-epoch")>()),
  revocationEpoch: async () => {
    if (epochs.value instanceof Error) throw epochs.value;
    return epochs.value;
  },
}));
const graph = vi.hoisted(() => ({ epoch: 1 as number | null }));
vi.mock("@/lib/graph/provenance-read", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/graph/provenance-read")>()),
  readAuthorizedGraphFactsResult: async () => ({
    facts: [{ id: "f", fact: "certified fact", at: "2026-01-01T00:00:00Z", subjectType: "T", subject: "a", object: "b", episodeUuids: [] }],
    incomplete: false, nextOffset: null, checked: 1, epoch: graph.epoch,
  }),
}));

const DB = {} as DbClient;
const SOURCES = [
  { sid: "S1", text: "first captured text" },
  { sid: "S2", text: "second captured text" },
] as unknown as import("@/lib/query/retrieve").Source[];

beforeEach(() => {
  epochs.value = 1;
  graph.epoch = 1;
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("ContextAuthorization — trusted capture, consistency, current at dispatch", () => {
  it("rejects a hand-built authorization and a context of another team as inconsistent", async () => {
    const { ContextAuthorization, requireContextAuthorization, QueryContextAuthorizationChangedError } =
      await import("@/lib/query/context-authorization");
    const forged = { authorization: { teamId: "team-1", epoch: 1, assertCurrent: async () => undefined } };
    expect(() => requireContextAuthorization(forged)).toThrow(QueryContextAuthorizationChangedError);
    expect(() => requireContextAuthorization({})).toThrow(QueryContextAuthorizationChangedError);
    const captured = await ContextAuthorization.capture(DB, "team-1");
    expect(requireContextAuthorization({ authorization: captured }, "team-1")).toBe(captured);
    expect(() => requireContextAuthorization({ authorization: captured }, "team-2")).toThrow(/authorization changed/);
  });

  it("fails closed when the epoch changed or cannot be read, and passes while unchanged", async () => {
    const { ContextAuthorization } = await import("@/lib/query/context-authorization");
    const captured = await ContextAuthorization.capture(DB, "team-1");
    await expect(captured.assertCurrent()).resolves.toBeUndefined();
    epochs.value = 2;
    await expect(captured.assertCurrent()).rejects.toMatchObject({ reason: "changed", retryable: true });
    epochs.value = new Error("connection refused");
    await expect(captured.assertCurrent()).rejects.toMatchObject({ reason: "unreadable" });
    await expect(ContextAuthorization.capture(DB, "team-1")).rejects.toMatchObject({ reason: "unreadable" });
  });

  it("refuses graph facts certified under a different epoch than the context's capture", async () => {
    const { ContextAuthorization } = await import("@/lib/query/context-authorization");
    const { fetchGraphFactsForGroups } = await import("@/lib/query/retrieve");
    const authorization = await ContextAuthorization.capture(DB, "team-1");
    expect(await fetchGraphFactsForGroups("q", ["g"], undefined, { db: DB, teamId: "team-1", authorization }))
      .toHaveLength(1);
    graph.epoch = 2; // read after a revocation the capture never saw
    await expect(fetchGraphFactsForGroups("q", ["g"], undefined, { db: DB, teamId: "team-1", authorization }))
      .rejects.toMatchObject({ name: "QueryContextAuthorizationChangedError", reason: "changed" });
  });

  it("never sends captured text to a configured reranker after the epoch changed", async () => {
    vi.stubEnv("RERANK_URL", "http://rerank.test/rerank");
    const fetchMock = vi.fn(async () => ({
      ok: true, json: async () => ({ results: [{ index: 1, relevance_score: 0.9 }, { index: 0, relevance_score: 0.1 }] }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const { ContextAuthorization } = await import("@/lib/query/context-authorization");
    const { rerankSources } = await import("@/lib/query/retrieve");
    const authorization = await ContextAuthorization.capture(DB, "team-1");

    const ranked = await rerankSources("q", SOURCES, authorization);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(ranked.map((source) => source.text)).toEqual(["second captured text", "first captured text"]);

    epochs.value = 2;
    await expect(rerankSources("q", SOURCES, authorization)).rejects.toMatchObject({ reason: "changed" });
    await expect(rerankSources("q", SOURCES)).rejects.toMatchObject({ reason: "inconsistent" });
    expect(fetchMock, "no dispatch after the change, nor without a capture").toHaveBeenCalledTimes(1);
  });

  it("streamAnswer refuses a context without a trusted capture before any provider request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { streamAnswer } = await import("@/lib/query/claude");
    const ctx = {
      sources: SOURCES, structured: "", grounded: true,
      authorization: { teamId: "team-1", epoch: 1 },
    } as unknown as import("@/lib/query/retrieve").RetrievedContext;
    const drain = async () => {
      for await (const _event of streamAnswer(ctx, "q", { openrouterKey: "k", openrouterModel: "m" }, [], undefined, "UTC", { sleep: async () => undefined })) {
        void _event;
      }
    };
    await expect(drain()).rejects.toMatchObject({ name: "QueryContextAuthorizationChangedError", reason: "inconsistent" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("the refusal is sanitized for the client and never retried as a transient stream error", async () => {
    const { QueryContextAuthorizationChangedError, CONTEXT_AUTHORIZATION_CLIENT_MESSAGE } =
      await import("@/lib/query/context-authorization");
    const { clientErrorMessage, isRetryableStreamError } = await import("@/lib/query/stream-retry");
    const refusal = new QueryContextAuthorizationChangedError("changed");
    expect(isRetryableStreamError(refusal)).toBe(false);
    expect(clientErrorMessage(refusal)).toBe(CONTEXT_AUTHORIZATION_CLIENT_MESSAGE);
    expect(CONTEXT_AUTHORIZATION_CLIENT_MESSAGE).not.toMatch(/epoch|item|graph/i);
  });
});
