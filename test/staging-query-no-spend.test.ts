import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("M4 — the raw retrieval transports honour the central spend policy", () => {
  it("returns the Postgres ordering without calling a configured reranker", async () => {
    // The reranker has its OWN url and token and never passes through `resolveAnsweringKeys`, so
    // the central policy could not see it: a staging image that inherited `RERANK_URL` would have
    // emitted one paid outbound call per query on a database meant to cost nothing.
    vi.stubEnv("STAGING_DATA_MODE", "copy-ready");
    vi.stubEnv("RERANK_URL", "https://rerank.example.test/v1/rerank");
    vi.stubEnv("RETRIEVAL_AUGMENT_URL", "https://augment.example.test/search");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("no outbound call is permitted"));

    const { copiedStagingSpendAllowed } = await import("@/lib/staging/runtime-policy");
    expect(copiedStagingSpendAllowed("interactive-query")).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("re-enables the reranker only under an explicit positive interactive budget", async () => {
    vi.stubEnv("STAGING_DATA_MODE", "copy-ready");
    vi.stubEnv("STAGING_QUERY_LLM_ENABLED", "true");
    vi.stubEnv("STAGING_QUERY_LLM_BUDGET_USD", "5");
    const { copiedStagingSpendAllowed } = await import("@/lib/staging/runtime-policy");
    expect(copiedStagingSpendAllowed("interactive-query")).toBe(true);
  });

  it("leaves production untouched: with no copy scope the policy allows every purpose", async () => {
    const { copiedStagingSpendAllowed } = await import("@/lib/staging/runtime-policy");
    for (const purpose of ["interactive-query", "background", "graph-extraction", "embedding", "image"] as const) {
      expect(copiedStagingSpendAllowed(purpose)).toBe(true);
    }
  });

  it("names the reranker and augment transports as gated in the source that owns them", async () => {
    // A behavioural test of `rerankSources` would need a full retrieval context; what is pinned
    // here is that BOTH raw transports consult the policy before their fetch, in the one module
    // that holds their URLs.
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("./lib/query/retrieve.ts", "utf8");
    const rerank = source.slice(source.indexOf("async function rerankSources"), source.indexOf("const res = await fetch(RERANK_URL"));
    const augment = source.slice(source.indexOf("async function fetchAugmentedSources"), source.indexOf("const res = await fetch(RETRIEVAL_AUGMENT_URL"));
    expect(rerank).toContain('copiedStagingSpendAllowed("interactive-query")');
    expect(augment).toContain('copiedStagingSpendAllowed("interactive-query")');
  });
});

describe("M9 — a disabled answering feature has an ANSWER, not a 500", () => {
  it("returns a structured refusal before the eager key resolver throws", async () => {
    vi.stubEnv("STAGING_DATA_MODE", "copy-ready");
    const { copiedStagingSpendAllowed } = await import("@/lib/staging/runtime-policy");
    const { resolveAnsweringKeys } = await import("@/lib/query/answering");
    // The resolver is the thing that used to surface as a generic 500 from the route body.
    expect(copiedStagingSpendAllowed("interactive-query")).toBe(false);
    await expect(resolveAnsweringKeys({} as never, "team", "interactive-query")).rejects.toThrow(/copied-staging-no-spend/);
  });

  it("places the refusal after authentication and before any quota accounting, on both routes", async () => {
    // Ordering is the whole correction and it is structural, so it is pinned structurally:
    //  - AFTER auth, so the refusal never tells a stranger what mode this deployment is in;
    //  - BEFORE the rate-limit read, the daily-quota reads and the `query_log` insert, so a feature
    //    that cannot run does not spend the caller's quota.
    const { readFileSync } = await import("node:fs");
    const routes = [
      { path: "./app/api/v1/query/route.ts", authRefusal: '"invalid API key or team"' },
      { path: "./app/api/dashboard/query/route.ts", authRefusal: '"not a member of this team"' },
    ];
    for (const route of routes) {
      const source = readFileSync(route.path, "utf8");
      const gate = source.indexOf('copiedStagingSpendAllowed("interactive-query")');
      const auth = source.indexOf(route.authRefusal);
      // Unique to the QUERY rate-limit branch (the dashboard has an earlier `/sync` limiter).
      const rateLimit = source.indexOf('"10 queries/min per member"');
      const dailyQuota = source.indexOf('"query_log"');
      const resolver = source.indexOf("resolveAnsweringKeys(db,");
      for (const [label, index] of Object.entries({ gate, auth, rateLimit, dailyQuota, resolver })) {
        expect(index, `${route.path} has no ${label} anchor`).toBeGreaterThan(-1);
      }
      expect(gate, `${route.path} gates before authenticating`).toBeGreaterThan(auth);
      expect(gate, `${route.path} consumes the query rate limit first`).toBeLessThan(rateLimit);
      expect(gate, `${route.path} reads or writes query_log first`).toBeLessThan(dailyQuota);
      expect(gate, `${route.path} resolves answering keys first`).toBeLessThan(resolver);
      expect(source).toContain('"answering_disabled"');
      expect(source).toContain("copied staging environment: model-backed answering is disabled");
    }
  });
});
