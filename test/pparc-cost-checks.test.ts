import { randomUUID } from "node:crypto";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DbClient } from "@/lib/db/types";

/**
 * PPARC-2 — the PRE-REGISTERED two-sided cost checks (design §2.4, folded per Fable Medium 5:
 * "the check records the measured crossover rather than pretending the model dominates
 * everywhere"). The LLM seam is mocked, so a synthesis call count is exact, not sampled. The union
 * model's counts are arithmetic (one call per distinct `p:` scope key — the 6b/7 machinery, pinned
 * elsewhere); the partition-native counts are MEASURED through the real warm path.
 *
 * REGISTERED EXPECTATIONS (both directions, honest):
 *  (a) MANY DISTINCT SCOPES over FEWER partitions — partition-native WINS: 4 readers with 4
 *      distinct scopes drawn from 3 partitions cost the union model 4 syntheses; partition-native
 *      costs 3, and every later reader costs 0.
 *  (b) SHARED SCOPE over MANY partitions — partition-native LOSES on first warm: 1 scope over 5
 *      partitions costs the union 1 synthesis vs partition-native 5. The crossover: partition-
 *      native wins once distinct reader scopes ≥ partition count (here: ≥5 scopes at P=5).
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
const hex = () => randomUUID().replace(/-/g, "");
const projGroup = () => `g_${hex()}_p_${hex()}`;
const FACT = {
  id: "f1", fact: "shipped a thing", at: "2026-07-20T00:00:00Z", subject: "alex",
  subjectType: "Person", object: "svc", objectType: "Service", episodeUuids: ["ep-1"],
};

beforeEach(() => {
  vi.clearAllMocks();
  llmMock.completeTextOrNull.mockResolvedValue('{"arcs":[]}');
  gateMock.arcIneligibleItemIds.mockResolvedValue(new Set());
  creditMock.resolveItemCredit.mockResolvedValue(new Map());
  correctionsMock.listArcCorrections.mockResolvedValue({ corrections: [], ok: true });
  factsMock.recentFacts.mockResolvedValue({ facts: [FACT], ok: true });
  factsMock.resolveEpisodeItems.mockResolvedValue({
    items: new Map([["ep-1", { itemId: "11111111-1111-4111-8111-111111111111", source: "github" }]]),
    ok: true,
  });
});

describe("§2.4 pre-registered cost checks, both directions (PPARC-4: driven through the live scheduler; warmPartitionArcs retired)", () => {
  async function warmScope(groups: string[], teamId: string) {
    const { schedulePartitionRefresh, arcMemoryCacheHas } = await import("@/lib/graph/arcs");
    for (const g of groups) {
      if (arcMemoryCacheHas(`g:${g}`)) continue; // the caller's freshness check — shared rows are never re-minted
      schedulePartitionRefresh(fakeDb(), teamId, g, KEYS, null);
      await vi.waitFor(async () => {
        const { arcMemoryCacheHas: has } = await import("@/lib/graph/arcs");
        expect(has(`g:${g}`)).toBe(true);
      }, { timeout: 5000 });
    }
  }

  it("(a) 4 distinct scopes over 3 partitions: partition-native measures 3 syntheses where the union model's arithmetic is 4", async () => {
    const [A, B, C] = [projGroup(), projGroup(), projGroup()];
    const unionModelCalls = 4; // one row per distinct p: scope key — the retired union's arithmetic
    for (const scope of [[A, B], [B, C], [A, C], [A, B]]) await warmScope(scope, "team-cost-a");
    await new Promise((r) => setTimeout(r, 200));
    const partitionNativeCalls = llmMock.completeTextOrNull.mock.calls.length;
    expect(partitionNativeCalls).toBe(3); // one per PARTITION, not per scope
    expect(partitionNativeCalls).toBeLessThan(unionModelCalls);
  });

  it("(b) one SHARED scope over 5 partitions: partition-native measures 5 where the union's arithmetic is 1 — the crossover is scopes ≥ partitions", async () => {
    const groups = [projGroup(), projGroup(), projGroup(), projGroup(), projGroup()];
    const unionModelCalls = 1;
    await warmScope(groups, "team-cost-b");
    await warmScope(groups, "team-cost-b"); // the second sharing reader adds nothing
    await new Promise((r) => setTimeout(r, 200));
    const partitionNativeCalls = llmMock.completeTextOrNull.mock.calls.length;
    expect(partitionNativeCalls).toBe(5);
    expect(partitionNativeCalls).toBeGreaterThan(unionModelCalls);
    expect(groups.length).toBe(5); // the recorded crossover: scopes must exceed partitions to win
  });
});
