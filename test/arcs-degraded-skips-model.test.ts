import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DbClient } from "@/lib/db/types";

/**
 * The one behaviour this PR claims that `test/arcs-commit.test.ts` cannot see: when the synthesis inputs
 * are DEGRADED, the model is never called.
 *
 * I had written that off as untestable — "the fact pool is empty without Graphiti, so synthesis returns
 * at its first guard". That was giving up early: the module boundary is a seam, and `vi.mock` is already
 * used across this tier. Mocking the graph legs lets a degraded synthesis actually be driven.
 *
 * Why it matters enough to test: `degraded` is set by the resolution legs but ACTED ON in `commitArcs`,
 * so it is entirely possible to wire it correctly and still pay for every refused synthesis — which is
 * what the first cut of this change did. With a persistent failure that is one reasoning-model call per
 * retry, forever, for output nothing will ever publish.
 */

const factsMock = vi.hoisted(() => ({
  recentFacts: vi.fn(),
  resolveEpisodeItems: vi.fn(),
}));
const llmMock = vi.hoisted(() => ({ completeTextOrNull: vi.fn() }));
// The other two legs synthesis depends on. Both hit a real DB, so without mocks they fail in a unit
// test and mark the run degraded — which would make the assertion below pass for the wrong reason.
// (The control case caught exactly that.)
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

/** Enough of a DbClient for the arc-cache read/write and the answering-key lookups to no-op. */
function fakeDb() {
  const upserts: Record<string, unknown>[] = [];
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
      upsert: async (row: Record<string, unknown>) => {
        upserts.push(row);
        return { error: null };
      },
    }),
  } as unknown as DbClient;
  return { db, upserts };
}

/** Any non-empty key set — the LLM transport is mocked, so the values are never used. */
const KEYS = { anthropic: "test-key", openai: null, openrouter: null } as unknown as Parameters<
  typeof import("@/lib/graph/arcs").getArcs
>[5];

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

describe("a degraded synthesis never reaches the model", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    llmMock.completeTextOrNull.mockResolvedValue('{"arcs":[]}');
    gateMock.arcIneligibleItemIds.mockResolvedValue(new Set());
    creditMock.resolveItemCredit.mockResolvedValue(new Map());
    correctionsMock.listArcCorrections.mockResolvedValue([]);
    correctionsMock.recordArcCorrections.mockResolvedValue(undefined);
  });

  it("skips the LLM entirely when the episode→item leg failed", async () => {
    // Facts exist, so this is NOT the quiet-window early return — synthesis genuinely has material and
    // would previously have run the model, produced an unattributed set, and had it refused downstream.
    factsMock.recentFacts.mockResolvedValue({ facts: [FACT], ok: true });
    factsMock.resolveEpisodeItems.mockResolvedValue({ items: new Map(), ok: false });

    const { getArcs } = await import("@/lib/graph/arcs");
    const { db } = fakeDb();
    await getArcs(db, "team-1", "acme", "external", [`acme_degraded_${Math.random()}`], KEYS);

    expect(llmMock.completeTextOrNull).not.toHaveBeenCalled();
  });

  it("skips the LLM when the eligibility gate is unavailable", async () => {
    // The gate THROWS rather than guessing (#400). Synthesis must convert that to degraded and stop —
    // running the model over an unfiltered pool is how backlog noise reaches the arcs.
    factsMock.recentFacts.mockResolvedValue({ facts: [FACT], ok: true });
    factsMock.resolveEpisodeItems.mockResolvedValue({
      items: new Map([["ep-1", { itemId: "11111111-1111-4111-8111-111111111111", source: "github" }]]),
      ok: true,
    });
    gateMock.arcIneligibleItemIds.mockRejectedValue(new Error("arc-eligibility lookup failed"));

    const { getArcs } = await import("@/lib/graph/arcs");
    const { db } = fakeDb();
    await getArcs(db, "team-1", "acme", "external", [`acme_gate_${Math.random()}`], KEYS);

    expect(llmMock.completeTextOrNull).not.toHaveBeenCalled();
  });

  it("a FAILED fact read is not a quiet week: the row is short-lived, not fresh for 4h", async () => {
    // The leg that still conflated the two until this PR. `recentFacts` returning [] because Neo4j is
    // down looked byte-identical to a genuinely quiet window, so on a cold miss it wrote a blank panel
    // stamped fresh for the full TTL with no retry — H12's shape, on the last leg that had it.
    const { ARC_CACHE_TTL_MS } = await import("@/lib/graph/arc-cache");
    factsMock.recentFacts.mockResolvedValue({ facts: [], ok: false });

    const { getArcs } = await import("@/lib/graph/arcs");
    const { db, upserts } = fakeDb();
    await getArcs(db, "team-1", "acme", "external", [`acme_factsdown_${Math.random()}`], KEYS);

    expect(llmMock.completeTextOrNull).not.toHaveBeenCalled();
    expect(upserts).toHaveLength(1);
    const remaining = ARC_CACHE_TTL_MS - (Date.now() - Date.parse(upserts[0].computed_at as string));
    expect(remaining).toBeGreaterThan(0); // not already stale — a persistent outage must not thrash
    expect(remaining).toBeLessThanOrEqual(10 * 60_000); // …retried in minutes, not hours
  });

  it("still reaches the model when the same legs are healthy", async () => {
    // The control. Without it, the assertion above would pass just as happily if arcs never called the
    // model at all under this harness — which is the way a mocked test quietly stops testing anything.
    factsMock.recentFacts.mockResolvedValue({ facts: [FACT], ok: true });
    factsMock.resolveEpisodeItems.mockResolvedValue({
      items: new Map([["ep-1", { itemId: "11111111-1111-4111-8111-111111111111", source: "github" }]]),
      ok: true,
    });

    const { getArcs } = await import("@/lib/graph/arcs");
    const { db } = fakeDb();
    await getArcs(db, "team-1", "acme", "external", [`acme_healthy_${Math.random()}`], KEYS);

    expect(llmMock.completeTextOrNull).toHaveBeenCalled();
  });
});


describe("H13: a stored correction reaches synthesis even with the graph wiped", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    llmMock.completeTextOrNull.mockResolvedValue('{"arcs":[]}');
    gateMock.arcIneligibleItemIds.mockResolvedValue(new Set());
    creditMock.resolveItemCredit.mockResolvedValue(new Map());
    correctionsMock.recordArcCorrections.mockResolvedValue(undefined);
  });

  it("puts the correction in the prompt on an ORDINARY synthesis, not just the recompute that made it", async () => {
    // The rebuild test the review report asked for. A correction used to influence later synthesis only
    // by having become a Graphiti fact, so resetting the graph didn't just lose the record — it lost the
    // influence, and arcs quietly reverted to the version a human had already rejected. Reading the
    // corrections from Postgres on every synthesis is what makes a rebuilt graph still produce corrected
    // arcs. Nothing here goes near Graphiti: the facts leg is mocked and GRAPHITI_URL is unset.
    correctionsMock.listArcCorrections.mockResolvedValue([
      { arc_id: "a1", arc_title: "Payments", corrected_text: "Dana led this, not Alex.", created_by: null, updated_at: "" },
    ]);
    factsMock.recentFacts.mockResolvedValue({ facts: [FACT], ok: true });
    factsMock.resolveEpisodeItems.mockResolvedValue({
      items: new Map([["ep-1", { itemId: "11111111-1111-4111-8111-111111111111", source: "github" }]]),
      ok: true,
    });

    const { getArcs } = await import("@/lib/graph/arcs");
    const { db } = fakeDb();
    await getArcs(db, "team-1", "acme", "external", [`acme_h13_${Math.random()}`], KEYS);

    expect(llmMock.completeTextOrNull).toHaveBeenCalled();
    const prompt = JSON.stringify(llmMock.completeTextOrNull.mock.calls[0]);
    expect(prompt).toContain("Dana led this, not Alex.");
  });
});
