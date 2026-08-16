import { randomUUID } from "node:crypto";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DbClient } from "@/lib/db/types";

/**
 * PPARC-2 — partition-native (`g:`) synthesis scope (design §2.1/§2.3; acceptance criterion 1's
 * input-isolation half — the full dm binding lands with PPARC-3's read path). Same mocked-seam
 * harness as test/arcs-correction-scope.test.ts.
 */

const factsMock = vi.hoisted(() => ({ recentFacts: vi.fn(), resolveEpisodeItems: vi.fn() }));
const llmMock = vi.hoisted(() => ({ completeTextOrNull: vi.fn() }));
const gateMock = vi.hoisted(() => ({ arcIneligibleItemIds: vi.fn() }));
const creditMock = vi.hoisted(() => ({ resolveItemCredit: vi.fn() }));
const correctionsMock = vi.hoisted(() => ({ listArcCorrections: vi.fn(), recordArcCorrections: vi.fn() }));

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

function fakeDb() {
  return {
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
}

const KEYS = { anthropic: "k" } as unknown as Parameters<typeof import("@/lib/graph/arcs").getArcs>[5];
const slug = () => `acme${randomUUID().slice(0, 8)}`;
const hex = () => randomUUID().replace(/-/g, "");
const projGroup = () => `g_${hex()}_p_${hex()}`;

beforeEach(() => {
  vi.clearAllMocks();
  llmMock.completeTextOrNull.mockResolvedValue('{"arcs":[]}');
  gateMock.arcIneligibleItemIds.mockResolvedValue(new Set());
  creditMock.resolveItemCredit.mockResolvedValue(new Map());
  correctionsMock.listArcCorrections.mockResolvedValue({ corrections: [], ok: true });
  factsMock.recentFacts.mockResolvedValue({ facts: [], ok: true });
  factsMock.resolveEpisodeItems.mockResolvedValue({ items: new Map(), ok: true });
});

describe("PPARC-2 — the warming call site is PINNED (Fable High: deletable-with-green-suite otherwise)", () => {
  it("a p:-scoped union read fires g:-scoped background warming — the rollout mechanism PPARC-3 depends on", async () => {
    const { getArcs, partitionArcScopeKey } = await import("@/lib/graph/arcs");
    const t = slug();
    const groups = [projGroup(), projGroup()];
    const scopeKey = partitionArcScopeKey("team-1", groups);
    await getArcs(fakeDb(), "team-1", t, "team", groups, KEYS, { scopeKey });
    // The piggyback is fire-and-forget; the observable is a g:-scoped corrections read arriving.
    await vi.waitFor(() => {
      const gCalls = correctionsMock.listArcCorrections.mock.calls.filter((c) =>
        String(c[2]?.groupKey ?? "").startsWith("g:")
      );
      expect(gCalls.length).toBeGreaterThan(0);
    }, { timeout: 5000 });
  });
});

describe("PPARC-2 — the purge-generation fence (Codex High 1)", () => {
  it("an in-flight g: refresh overtaken by a purge DROPS its commit — the poisoned row is never resurrected", async () => {
    const { warmPartitionArcs, evictPartitionArcMemory } = await import("@/lib/graph/arcs");
    const group = projGroup();
    // THIS test needs real facts — the file's beforeEach mocks an empty pool, and an empty
    // synthesis short-circuits BEFORE the LLM (it committed an empty row before the eviction and
    // made the first version of this pin fail for the wrong reason — found by instrumentation).
    factsMock.recentFacts.mockResolvedValue({
      facts: [{ id: "f1", fact: "pre-purge fact", at: "2026-07-20T00:00:00Z", subject: "alex", subjectType: "Person", object: "svc", objectType: "Service", episodeUuids: ["ep-1"] }],
      ok: true,
    });
    factsMock.resolveEpisodeItems.mockResolvedValue({
      items: new Map([["ep-1", { itemId: "11111111-1111-4111-8111-111111111111", source: "github" }]]),
      ok: true,
    });
    // Block the synthesis at the LLM so the purge can land mid-flight.
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((r) => (release = r));
    llmMock.completeTextOrNull.mockImplementation(async () => {
      await blocked;
      return '{"arcs":[{"id":"x","title":"t","confidence":"high","summary":"pre-purge prose","participants":[],"supporting_sources":[],"evidence":[]}]}';
    });
    const upserts: Array<Record<string, unknown>> = [];
    const capturingDb = {
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({ maybeSingle: async () => ({ data: null }) }),
            maybeSingle: async () => ({ data: null }),
            order: () => ({ limit: async () => ({ data: [] }) }),
            limit: async () => ({ data: [] }),
          }),
        }),
        upsert: async (row: Record<string, unknown>) => {
          upserts.push(row);
          return { error: null };
        },
      }),
    } as unknown as DbClient;

    const { arcMemoryCacheHas } = await import("@/lib/graph/arcs");
    const scheduled = await warmPartitionArcs(capturingDb, "team-fence", [group], KEYS, 1);
    expect(scheduled).toBe(1);
    await new Promise((r) => setTimeout(r, 100)); // let the refresh reach the blocked LLM call
    evictPartitionArcMemory(group); // the purge door's mem half — bumps the key's generation
    release!();
    await new Promise((r) => setTimeout(r, 400)); // let the refresh settle
    // The observable is the MODULE's own memory cache: the background refresh commits through
    // adminClient (a capturing db never sees it — the first version of this pin was
    // green-by-construction on exactly that, caught by its surviving mutation), and commitArcs
    // memCacheSets unconditionally before the swallowed DB write. Fence held ⇒ key absent.
    expect(arcMemoryCacheHas(`g:${group}`)).toBe(false);
    expect(upserts.filter((u) => u.group_key === `g:${group}`)).toHaveLength(0); // and nothing through OUR db either
  });
});

describe("PPARC-2 — a g:-scoped synthesis reads ONLY its own partition (criterion 1, input half)", () => {
  it("the fact read receives exactly [group] — never a union, never a tier pair", async () => {
    const { getArcs } = await import("@/lib/graph/arcs");
    const t = slug();
    const group = projGroup();
    await getArcs(fakeDb(), "team-1", t, "team", [group], KEYS, { scopeKey: `g:${group}` });
    expect(factsMock.recentFacts).toHaveBeenCalledTimes(1);
    expect(factsMock.recentFacts.mock.calls[0][0]).toEqual([group]);
  });

  it("corrections load for EXACTLY the g: scope, legacy rows refused", async () => {
    const { getArcs } = await import("@/lib/graph/arcs");
    const t = slug();
    const group = projGroup();
    await getArcs(fakeDb(), "team-1", t, "team", [group], KEYS, { scopeKey: `g:${group}` });
    expect(correctionsMock.listArcCorrections).toHaveBeenCalledTimes(1);
    expect(correctionsMock.listArcCorrections.mock.calls[0][2]).toMatchObject({
      groupKey: `g:${group}`,
      includeLegacy: false,
    });
  });

  it("an EXTERNAL-SHAPED partition's g: synthesis still loads its own corrections (stored + prompt-fed; the graph write-back refusal is separate)", async () => {
    const { getArcs } = await import("@/lib/graph/arcs");
    const t = slug();
    const group = `${t}_external`;
    await getArcs(fakeDb(), "team-1", t, "team", [group], KEYS, { scopeKey: `g:${group}` });
    expect(correctionsMock.listArcCorrections).toHaveBeenCalledTimes(1);
    expect(correctionsMock.listArcCorrections.mock.calls[0][2]).toMatchObject({
      groupKey: `g:${group}`,
      includeLegacy: false,
    });
  });
});
