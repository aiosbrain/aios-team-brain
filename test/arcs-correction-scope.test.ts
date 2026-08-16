import { randomUUID } from "node:crypto";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DbClient } from "@/lib/db/types";

/**
 * PCCC6B-1 — corrections are SCOPE-KEYED (design §2.4 step 4 as built; spec: "cross-project
 * synthesis is never computed"). The laundering vector this pins closed: corrections were
 * team-global, so a correction whose prose derived from one visibility scope fed EVERY team-tier
 * synthesis, including ones served to principals who cannot see that scope. Spec-first: written
 * against the scope-keyed API before it existed.
 *
 * The seam is the same one test/arcs-degraded-skips-model.test.ts established: vi.mock the module
 * boundaries, drive the real synthesis pipeline.
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

function fakeDb() {
  const db = {
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: null }) }),
          maybeSingle: async () => ({ data: null }),
          order: () => ({ limit: async () => ({ data: [] }) }),
          limit: async () => ({ data: [] }),
        }),
      }),
      upsert: async () => ({ error: null }),
    }),
  } as unknown as DbClient;
  return { db };
}

const KEYS = { anthropic: "test-key", openai: null, openrouter: null } as unknown as Parameters<
  typeof import("@/lib/graph/arcs").getArcs
>[5];

// randomUUID, not Math.random — same uniqueness job, and Codacy's weak-RNG security rule fires on
// Math.random even in a test fixture (observed on this PR; the neighboring older file predates the rule).
const slug = () => `acme${randomUUID().slice(0, 8)}`;

const FACT = {
  id: "f1",
  fact: "shipped the payments retry",
  at: "2026-07-20T00:00:00Z",
  subject: "alex",
  subjectType: "Person",
  object: "payments",
  objectType: "Service",
  episodeUuids: ["ep-1"],
};

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

describe("PCCC6B-1 — synthesis loads corrections for EXACTLY its own scope", () => {
  it("a PARTITION-scope synthesis requests its scope key and REFUSES legacy rows", async () => {
    const { getArcs, partitionArcScopeKey } = await import("@/lib/graph/arcs");
    const { db } = fakeDb();
    const t = slug();
    const groups = [`${t}_team`, `g_${"a".repeat(32)}_p_${"b".repeat(32)}`];
    const scopeKey = partitionArcScopeKey("team-1", groups);
    await getArcs(db, "team-1", t, "team", groups, KEYS, { scopeKey });

    // PPARC-2's warming piggyback fires g:-scoped background reads alongside — the pin targets
    // THE p:-scoped call specifically, not a global count.
    const scoped = correctionsMock.listArcCorrections.mock.calls.filter((c) => c[2]?.groupKey === scopeKey);
    expect(scoped).toHaveLength(1);
    expect(scoped[0][2]).toMatchObject({ groupKey: scopeKey, includeLegacy: false });
  });

  it("the TIER path requests its own sorted-set key WITH legacy rows — pre-6b corrections were tier-scope by construction", async () => {
    const { getArcs } = await import("@/lib/graph/arcs");
    const { db } = fakeDb();
    const t = slug();
    const groups = [`${t}_team`, `${t}_external`];
    await getArcs(db, "team-1", t, "team", groups, KEYS);

    expect(correctionsMock.listArcCorrections).toHaveBeenCalledTimes(1);
    const args = correctionsMock.listArcCorrections.mock.calls[0];
    expect(args[2]).toMatchObject({ groupKey: groups.slice().sort().join(","), includeLegacy: true });
  });

  it("an EXTERNAL-only synthesis still loads no corrections at all (the standing tier gate)", async () => {
    const { getArcs } = await import("@/lib/graph/arcs");
    const { db } = fakeDb();
    const t = slug();
    await getArcs(db, "team-1", t, "external", [`${t}_external`], KEYS);
    expect(correctionsMock.listArcCorrections).not.toHaveBeenCalled();
  });
});

describe("PCCC6B-1 — the graph write-back follows the scope", () => {
  const CORRECTION = { arc_id: "a1", arc_title: "Payments", corrected_text: "actually shipped in June" };

  it("a SINGLE-group partition scope writes the correction episode to THAT group", async () => {
    const { recomputeArcs, partitionArcScopeKey } = await import("@/lib/graph/arcs");
    const { db } = fakeDb();
    const t = slug();
    const group = `g_${"a".repeat(32)}_p_${"b".repeat(32)}`;
    await recomputeArcs(db, "team-1", t, "team", [group], [CORRECTION], KEYS, null, {
      scopeKey: partitionArcScopeKey("team-1", [group]),
    });
    expect(graphitiMock.addEpisodes).toHaveBeenCalledTimes(1);
    expect(graphitiMock.addEpisodes.mock.calls[0][0]).toBe(group);
  });

  it("a MULTI-group partition scope writes NOTHING to the graph — any single target narrower than the derivation scope launders", async () => {
    const { recomputeArcs, partitionArcScopeKey } = await import("@/lib/graph/arcs");
    const { db } = fakeDb();
    const t = slug();
    const groups = [`${t}_team`, `g_${"a".repeat(32)}_p_${"b".repeat(32)}`];
    await recomputeArcs(db, "team-1", t, "team", groups, [CORRECTION], KEYS, null, {
      scopeKey: partitionArcScopeKey("team-1", groups),
    });
    expect(graphitiMock.addEpisodes).not.toHaveBeenCalled();
  });

  it("the TIER path keeps today's <slug>_team target", async () => {
    const { recomputeArcs } = await import("@/lib/graph/arcs");
    const { db } = fakeDb();
    const t = slug();
    await recomputeArcs(db, "team-1", t, "team", [`${t}_team`, `${t}_external`], [CORRECTION], KEYS, null);
    expect(graphitiMock.addEpisodes).toHaveBeenCalledTimes(1);
    expect(graphitiMock.addEpisodes.mock.calls[0][0]).toBe(`${t}_team`);
  });

  it("an EXTERNAL-shaped single-group scope writes NOTHING to the graph — a restriction-debt window's scope is exactly [<slug>_external] (Fable 6b High 1)", async () => {
    const { recomputeArcs, partitionArcScopeKey } = await import("@/lib/graph/arcs");
    const { db } = fakeDb();
    const t = slug();
    const group = `${t}_external`;
    await recomputeArcs(db, "team-1", t, "team", [group], [CORRECTION], KEYS, null, {
      scopeKey: partitionArcScopeKey("team-1", [group]),
    });
    expect(graphitiMock.addEpisodes).not.toHaveBeenCalled();
  });

  it("…but that scope still LOADS its own corrections — refusing would silently revert an edit made during the window (Fable 6b Medium 4)", async () => {
    const { getArcs, partitionArcScopeKey } = await import("@/lib/graph/arcs");
    const { db } = fakeDb();
    const t = slug();
    const groups = [`${t}_external`];
    const scopeKey = partitionArcScopeKey("team-1", groups);
    await getArcs(db, "team-1", t, "team", groups, KEYS, { scopeKey });
    const scoped = correctionsMock.listArcCorrections.mock.calls.filter((c) => c[2]?.groupKey === scopeKey);
    expect(scoped).toHaveLength(1);
    expect(scoped[0][2]).toMatchObject({ groupKey: scopeKey, includeLegacy: false });
  });

  it("the recorded correction carries the scope key it was made in", async () => {
    const { recomputeArcs, partitionArcScopeKey } = await import("@/lib/graph/arcs");
    const { db } = fakeDb();
    const t = slug();
    const group = `g_${"a".repeat(32)}_p_${"b".repeat(32)}`;
    const scopeKey = partitionArcScopeKey("team-1", [group]);
    await recomputeArcs(db, "team-1", t, "team", [group], [CORRECTION], KEYS, null, { scopeKey });
    expect(correctionsMock.recordArcCorrections).toHaveBeenCalledTimes(1);
    expect(correctionsMock.recordArcCorrections.mock.calls[0][4]).toBe(scopeKey);
  });
});

describe("PCCC-7 — the in-memory arc cache is bounded", () => {
  it("insertion past the bound evicts the oldest entry; scoped eviction removes a team's p: keys", async () => {
    const { memCacheSet, arcMemoryCacheSize, evictScopedArcMemory } = await import("@/lib/graph/arcs");
    const entry = { arcs: [], at: Date.now(), factsHash: null, degraded: false };
    for (let i = 0; i < 600; i++) memCacheSet(`p:bound-team:${i}`, entry);
    expect(arcMemoryCacheSize()).toBeLessThanOrEqual(512); // the bound holds under churn
    const before = arcMemoryCacheSize();
    evictScopedArcMemory("bound-team");
    expect(arcMemoryCacheSize()).toBeLessThan(before); // id-keyed eviction finds the p: entries
  });
});

describe("PCCC-7 — the eviction call sites reach the id-namespaced keys (Fable Medium 1)", () => {
  it("bustTeamLearningCaches and purgeExternalTierCaches evict a team's p: memory entries", async () => {
    const { memCacheSet, arcMemoryCacheSize } = await import("@/lib/graph/arcs");
    const { bustTeamLearningCaches } = await import("@/lib/ingest/reconcile-attribution");
    const { purgeExternalTierCaches } = await import("@/lib/cache/tier-invalidation");
    const { db } = fakeDb();
    const entry = { arcs: [], at: Date.now(), factsHash: null, degraded: false };

    // Observe the CALLER's effect directly — the first version of this test called
    // evictScopedArcMemory itself "idempotently" and thereby masked its own mutation (caught when
    // severing the caller's eviction reddened nothing).
    memCacheSet("p:evict-a:g1", entry);
    const beforeA = arcMemoryCacheSize();
    await bustTeamLearningCaches(db, "evict-a", "some-slug");
    expect(arcMemoryCacheSize()).toBe(beforeA - 1);

    memCacheSet("p:evict-b:g1", entry);
    const beforeB = arcMemoryCacheSize();
    await purgeExternalTierCaches(db, "evict-b", "some-slug");
    expect(arcMemoryCacheSize()).toBe(beforeB - 1);
  });
});

describe("PCCC6B-1 — the partition scope key is its own cache namespace", () => {
  it("partitionArcScopeKey namespaces on the IMMUTABLE team id, never collides with a tier key, and eviction finds it by id", async () => {
    const { partitionArcScopeKey, arcKeyBelongsToTeam } = await import("@/lib/graph/arcs");
    const t = slug();
    const tierPair = [`${t}_team`, `${t}_external`];
    const key = partitionArcScopeKey("team-1", tierPair);
    // A built-ins-only oracle scope must NOT share a cache row with the tier path: same groups,
    // different corrections rule — a shared row would poison across the boundary.
    expect(key).not.toBe(tierPair.slice().sort().join(","));
    // PCCC-7: the NAMESPACE segment is the IMMUTABLE team id — group segments may carry the slug
    // (built-in pointers are frozen under it), but a rename must not change the key's namespace.
    expect(key.startsWith("p:team-1:")).toBe(true);
    expect(arcKeyBelongsToTeam(key, t, "team-1")).toBe(true);
    expect(arcKeyBelongsToTeam(key, t, "team-2")).toBe(false);
    expect(arcKeyBelongsToTeam(key, t)).toBe(false); // no id supplied -> a p: key is never claimed
    // Project-group segments carry no slug — the p: namespace is what keeps eviction exact.
    const projKey = partitionArcScopeKey("team-1", [`g_${"a".repeat(32)}_p_${"b".repeat(32)}`]);
    expect(arcKeyBelongsToTeam(projKey, t, "team-1")).toBe(true);
    expect(arcKeyBelongsToTeam(projKey, "other", "team-2")).toBe(false);
  });
});
