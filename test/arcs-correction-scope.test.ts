import { randomUUID } from "node:crypto";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DbClient } from "@/lib/db/types";

/**
 * Corrections are SCOPE-KEYED (PCCC6B-1 origin; PPARC-4 as-built: the per-oracle `p:` namespace
 * is RETIRED — `g:` is the one partition scope, and test/guards/no-per-oracle-arc-keys.test.ts
 * pins that nothing re-mints `p:`). This file pins the g:-era rules: the write-back targeting,
 * exact-scope correction loads, the memory bound, the eviction callers, and the purge-generation
 * fence. The seam is the vi.mock harness test/arcs-degraded-skips-model.test.ts established.
 */

const factsMock = vi.hoisted(() => ({ recentFacts: vi.fn(), resolveEpisodeItems: vi.fn() }));
const llmMock = vi.hoisted(() => ({ completeTextOrNull: vi.fn() }));
const gateMock = vi.hoisted(() => ({ arcIneligibleItemIds: vi.fn() }));
const creditMock = vi.hoisted(() => ({ resolveItemCredit: vi.fn() }));
const correctionsMock = vi.hoisted(() => ({ listArcCorrections: vi.fn(), recordArcCorrections: vi.fn() }));
const graphitiMock = vi.hoisted(() => ({ addEpisodes: vi.fn() }));

vi.mock("@/lib/graph/learning", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/graph/learning")>()),
  recentFacts: factsMock.recentFacts,
  resolveEpisodeItems: factsMock.resolveEpisodeItems,
}));
vi.mock("@/lib/graph/arc-eligibility", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/graph/arc-eligibility")>()),
  arcIneligibleItemIds: gateMock.arcIneligibleItemIds,
}));
vi.mock("@/lib/attribution/contributor-credit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/attribution/contributor-credit")>()),
  resolveItemCredit: creditMock.resolveItemCredit,
}));
vi.mock("@/lib/graph/arc-corrections", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/graph/arc-corrections")>()),
  listArcCorrections: correctionsMock.listArcCorrections,
  recordArcCorrections: correctionsMock.recordArcCorrections,
}));
vi.mock("@/lib/llm/complete", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/llm/complete")>()),
  completeTextOrNull: llmMock.completeTextOrNull,
}));
vi.mock("@/lib/graph/graphiti-client", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/graph/graphiti-client")>();
  class MockClient {
    get configured() {
      return true;
    }
    addEpisodes = graphitiMock.addEpisodes;
  }
  return { ...orig, GraphitiClient: MockClient };
});

function fakeDb(projectGroups: string[] = []) {
  return {
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: null }) }),
          maybeSingle: async () => ({ data: null }),
          order: () => ({ limit: async () => ({ data: [] }) }),
          limit: async () => ({ data: [] }),
          not: () => Promise.resolve({ data: table === "projects" ? projectGroups.map((g) => ({ graph_group_id: g })) : [] }),
        }),
      }),
      upsert: async () => ({ error: null }),
    }),
  } as unknown as DbClient;
}

const KEYS = { anthropic: "test-key", openai: null, openrouter: null } as unknown as Parameters<
  typeof import("@/lib/graph/arcs").getArcs
>[5];
const slug = () => `acme${randomUUID().slice(0, 8)}`;
const projGroup = () => `g_${randomUUID().replace(/-/g, "")}_p_${randomUUID().replace(/-/g, "")}`;
const FACT = {
  id: "f1", fact: "shipped the payments retry", at: "2026-07-20T00:00:00Z", subject: "alex",
  subjectType: "Person", object: "payments", objectType: "Service", episodeUuids: ["ep-1"],
};
const CORRECTION = { arc_id: "a1", arc_title: "Payments", corrected_text: "actually shipped in June" };

beforeEach(() => {
  vi.clearAllMocks();
  llmMock.completeTextOrNull.mockResolvedValue('{"arcs":[]}');
  gateMock.arcIneligibleItemIds.mockResolvedValue(new Set());
  creditMock.resolveItemCredit.mockResolvedValue(new Map());
  correctionsMock.listArcCorrections.mockResolvedValue({ corrections: [], ok: true });
  correctionsMock.recordArcCorrections.mockResolvedValue(undefined);
  factsMock.recentFacts.mockResolvedValue({ facts: [FACT], ok: true });
  factsMock.resolveEpisodeItems.mockResolvedValue({
    items: new Map([["ep-1", { itemId: "11111111-1111-4111-8111-111111111111", source: "github" }]]),
    ok: true,
  });
  graphitiMock.addEpisodes.mockResolvedValue(undefined);
});

describe("the g: write-back follows the scope (PCCC6B rules, g:-era)", () => {
  it("a SINGLE-group g: recompute writes back to THAT group", async () => {
    const { recomputeArcs } = await import("@/lib/graph/arcs");
    const t = slug();
    const group = projGroup();
    await recomputeArcs(fakeDb(), "team-1", t, "team", [group], [CORRECTION], KEYS, null, { scopeKey: `g:${group}` });
    expect(graphitiMock.addEpisodes).toHaveBeenCalledTimes(1);
    expect(graphitiMock.addEpisodes.mock.calls[0][0]).toBe(group);
  });

  it("a MULTI-group g: scope writes NOTHING — a target narrower than the derivation scope launders (the route never sends multi; the function rule holds anyway)", async () => {
    const { recomputeArcs } = await import("@/lib/graph/arcs");
    const t = slug();
    const groups = [`${t}_team`, projGroup()];
    await recomputeArcs(fakeDb(), "team-1", t, "team", groups, [CORRECTION], KEYS, null, { scopeKey: `g:${groups.join(",")}` });
    expect(graphitiMock.addEpisodes).not.toHaveBeenCalled();
  });

  it("an EXTERNAL-shaped g: group refuses the write-back but still LOADS its own corrections", async () => {
    const { recomputeArcs, getArcs } = await import("@/lib/graph/arcs");
    const t = slug();
    const group = `${t}_external`;
    await recomputeArcs(fakeDb(), "team-1", t, "team", [group], [CORRECTION], KEYS, null, { scopeKey: `g:${group}` });
    expect(graphitiMock.addEpisodes).not.toHaveBeenCalled();

    const t2 = slug();
    const group2 = `${t2}_external`;
    await getArcs(fakeDb(), "team-1", t2, "team", [group2], KEYS, { scopeKey: `g:${group2}` });
    const scoped = correctionsMock.listArcCorrections.mock.calls.filter((c) => c[2]?.groupKey === `g:${group2}`);
    expect(scoped).toHaveLength(1);
    expect(scoped[0][2]).toMatchObject({ groupKey: `g:${group2}`, includeLegacy: false });
  });

  it("the TIER path keeps today's <slug>_team target", async () => {
    const { recomputeArcs } = await import("@/lib/graph/arcs");
    const t = slug();
    await recomputeArcs(fakeDb(), "team-1", t, "team", [`${t}_team`, `${t}_external`], [CORRECTION], KEYS, null);
    expect(graphitiMock.addEpisodes).toHaveBeenCalledTimes(1);
    expect(graphitiMock.addEpisodes.mock.calls[0][0]).toBe(`${t}_team`);
  });

  it("the recorded correction carries the g: scope key it was made in", async () => {
    const { recomputeArcs } = await import("@/lib/graph/arcs");
    const t = slug();
    const group = projGroup();
    await recomputeArcs(fakeDb(), "team-1", t, "team", [group], [CORRECTION], KEYS, null, { scopeKey: `g:${group}` });
    expect(correctionsMock.recordArcCorrections).toHaveBeenCalledTimes(1);
    expect(correctionsMock.recordArcCorrections.mock.calls[0][4]).toBe(`g:${group}`);
  });
});

describe("the in-memory arc cache is bounded (PCCC-7 rule, g:-era)", () => {
  it("insertion past the bound evicts the oldest; per-key g: eviction works", async () => {
    const { memCacheSet, arcMemoryCacheSize, evictPartitionArcMemory, arcMemoryCacheHas } = await import("@/lib/graph/arcs");
    const entry = { arcs: [], at: Date.now(), factsHash: null, degraded: false };
    for (let i = 0; i < 600; i++) memCacheSet(`g:bound-${i}`, entry);
    expect(arcMemoryCacheSize()).toBeLessThanOrEqual(512);
    memCacheSet("g:evict-me", entry);
    evictPartitionArcMemory("evict-me");
    expect(arcMemoryCacheHas("g:evict-me")).toBe(false);
  });
});

describe("the eviction callers reach g: keys (PPARC-2 rule; Fable Medium 1 lineage)", () => {
  it("bustTeamLearningCaches and purgeExternalTierCaches evict a team's g: memory entries via the pointer list", async () => {
    const { memCacheSet, arcMemoryCacheHas } = await import("@/lib/graph/arcs");
    const { bustTeamLearningCaches } = await import("@/lib/ingest/reconcile-attribution");
    const { purgeExternalTierCaches } = await import("@/lib/cache/tier-invalidation");
    const entry = { arcs: [], at: Date.now(), factsHash: null, degraded: false };

    const gA = projGroup();
    memCacheSet(`g:${gA}`, entry);
    await bustTeamLearningCaches(fakeDb([gA]), "evict-a", "some-slug");
    expect(arcMemoryCacheHas(`g:${gA}`)).toBe(false);

    const gB = projGroup();
    memCacheSet(`g:${gB}`, entry);
    await purgeExternalTierCaches(fakeDb([gB]), "evict-b", "some-slug");
    expect(arcMemoryCacheHas(`g:${gB}`)).toBe(false);
  });
});

describe("the purge-generation fence (g:-era wiring)", () => {
  it("an in-flight g: refresh overtaken by a purge DROPS its commit", async () => {
    const { schedulePartitionRefresh, evictPartitionArcMemory, arcMemoryCacheHas } = await import("@/lib/graph/arcs");
    const group = projGroup();
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((r) => (release = r));
    llmMock.completeTextOrNull.mockImplementation(async () => {
      await blocked;
      return '{"arcs":[{"id":"x","title":"t","confidence":"high","summary":"pre-purge prose","participants":[],"supporting_sources":[],"evidence":[]}]}';
    });
    const fired = schedulePartitionRefresh(fakeDb(), "team-fence", group, KEYS, null);
    expect(fired).toBe(true);
    await new Promise((r) => setTimeout(r, 100)); // reach the blocked LLM
    evictPartitionArcMemory(group); // the purge door's mem half — bumps the generation
    release!();
    await new Promise((r) => setTimeout(r, 400));
    expect(arcMemoryCacheHas(`g:${group}`)).toBe(false); // the commit was dropped
  });
});
