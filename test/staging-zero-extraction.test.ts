import { afterEach, describe, expect, it, vi } from "vitest";
import { GraphitiClient } from "@/lib/graph/graphiti-client";
import { copiedStagingSpendAllowed, isCopiedStagingRuntime } from "@/lib/staging/runtime-policy";
import { resolveGraphChatTargets, resolveGraphEmbeddingTarget, isRefusal } from "@/lib/llm/graph-proxy";
import { completeText } from "@/lib/llm/complete";

afterEach(() => vi.unstubAllEnvs());

describe("copied staging zero-extraction backstops", () => {
  it("refuses Graphiti mutations before network even with manual calls and enabled poll flags", async () => {
    vi.stubEnv("STAGING_DATA_MODE", "copy-ready");
    vi.stubEnv("INGEST_POLL_ENABLED", "true");
    vi.stubEnv("SOCIAL_JOBS_ENABLED", "true");
    const fetchImpl = vi.fn();
    const client = new GraphitiClient({ baseUrl: "http://graphiti.internal", fetchImpl });
    await expect(client.addEpisodes("g", [{ content: "x", timestamp: new Date().toISOString(), sourceDescription: "manual" }])).rejects.toThrow(/read-only/);
    await expect(client.deleteEpisode("episode")).rejects.toThrow(/read-only/);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(isCopiedStagingRuntime()).toBe(true);
  });

  it("refuses graph proxy chat and embeddings before resolving keys", async () => {
    vi.stubEnv("STAGING_DATA_MODE", "copy-ready");
    const db = { from: vi.fn(() => { throw new Error("DB must not be touched"); }) } as never;
    const chat = await resolveGraphChatTargets(db, "team");
    const embedding = await resolveGraphEmbeddingTarget(db, "team");
    expect(isRefusal(chat.strong)).toBe(true);
    expect(isRefusal(embedding)).toBe(true);
  });

  it("allows only an explicit positive interactive budget and still denies background/image/embedding", async () => {
    vi.stubEnv("STAGING_DATA_MODE", "copy-ready");
    vi.stubEnv("STAGING_QUERY_LLM_ENABLED", "true");
    vi.stubEnv("STAGING_QUERY_LLM_BUDGET_USD", "5");
    expect(copiedStagingSpendAllowed("interactive-query")).toBe(true);
    for (const purpose of ["background", "graph-extraction", "embedding", "image"] as const) expect(copiedStagingSpendAllowed(purpose)).toBe(false);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await expect(completeText({ system: "x", prompt: "x" })).rejects.toThrow(/no-spend/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
