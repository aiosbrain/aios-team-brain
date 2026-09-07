import { afterEach, describe, expect, it, vi } from "vitest";
import { GraphitiClient } from "@/lib/graph/graphiti-client";
import {
  BUDGETED_INTERACTIVE_QUERY_SUPPORTED, UNSUPPORTED_BUDGETED_MODE,
  copiedStagingSpendAllowed, interactiveQueryOptIn, isCopiedStagingRuntime,
} from "@/lib/staging/runtime-policy";
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

  it("denies EVERY purpose in copy scope, including an opt-in with a well-formed budget", async () => {
    // The optional budgeted interactive mode is unimplemented: nothing enforces the dollar amount,
    // so a configured amount cannot authorise a call. A well-formed opt-in is the strongest input
    // an operator can supply, and it still buys nothing.
    vi.stubEnv("STAGING_DATA_MODE", "copy-ready");
    vi.stubEnv("STAGING_QUERY_LLM_ENABLED", "true");
    vi.stubEnv("STAGING_QUERY_LLM_BUDGET_USD", "5");
    expect(BUDGETED_INTERACTIVE_QUERY_SUPPORTED).toBe(false);
    for (const purpose of ["interactive-query", "background", "graph-extraction", "embedding", "image"] as const) {
      expect(copiedStagingSpendAllowed(purpose)).toBe(false);
    }
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await expect(completeText({ system: "x", prompt: "x" })).rejects.toThrow(/no-spend/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("denies an unbounded or malformed budget for the same reason, not a different one", () => {
    vi.stubEnv("STAGING_DATA_MODE", "copy-ready");
    vi.stubEnv("STAGING_QUERY_LLM_ENABLED", "true");
    // `Infinity` is the case the old `Number(...) > 0` test admitted: an unbounded authorisation
    // that reads as a configured ceiling.
    for (const budget of ["Infinity", "NaN", "0", "-5", "", "  ", "not-a-number", "1e400"]) {
      vi.stubEnv("STAGING_QUERY_LLM_BUDGET_USD", budget);
      expect(copiedStagingSpendAllowed("interactive-query")).toBe(false);
      expect(interactiveQueryOptIn().status).toBe("invalid-budget");
    }
  });

  it("names the refusal so preflight, health and docs cannot describe it differently", () => {
    vi.stubEnv("STAGING_DATA_MODE", "copy-ready");
    vi.stubEnv("STAGING_QUERY_LLM_ENABLED", "true");
    vi.stubEnv("STAGING_QUERY_LLM_BUDGET_USD", "5");
    const verdict = interactiveQueryOptIn();
    expect(verdict).toMatchObject({ optedIn: true, status: "unsupported", budgetUsd: 5 });
    expect(verdict.reason).toContain(UNSUPPORTED_BUDGETED_MODE);
    // No opt-in is not an error — it is the default, and it must not be reported as one.
    vi.stubEnv("STAGING_QUERY_LLM_ENABLED", "false");
    expect(interactiveQueryOptIn()).toEqual({ optedIn: false, status: "not-requested", budgetUsd: null, reason: null });
  });

  it("leaves production untouched: outside copy scope every purpose is allowed", () => {
    vi.stubEnv("STAGING_DATA_MODE", "");
    vi.stubEnv("STAGING_OPS_ENVIRONMENT_ID", "");
    vi.stubEnv("RAILWAY_ENVIRONMENT_ID", "");
    for (const purpose of ["interactive-query", "background", "graph-extraction", "embedding", "image"] as const) {
      expect(copiedStagingSpendAllowed(purpose)).toBe(true);
    }
  });
});
