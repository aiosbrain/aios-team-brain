import { describe, expect, it, vi, beforeEach } from "vitest";

// Dense-leg access enforcement (Codex B3 Medium): the membership filter must be IN-QUERY —
// `limit` ranks over VISIBLE chunks only, and an invisible-only match can't flip grounding.
// The data-mechanics tier can't exercise this leg (no embedding backend there), so the SQL
// contract is pinned here with the transport mocked. Dropping the `= any(` clause in
// dense-search.ts reddens the first test; dropping the empty-set short-circuit reddens the second.

const captured: { sql: string; params: unknown[] }[] = [];

vi.mock("@/lib/db/pg/pool", () => ({
  runSql: vi.fn(async (sql: string, params: unknown[]) => {
    captured.push({ sql, params });
    return { rows: [] };
  }),
}));
vi.mock("@/lib/query/dense-index", () => ({ itemChunksTablePresent: vi.fn(async () => true) }));
vi.mock("@/lib/query/embeddings", async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  return { ...real, embed: vi.fn(async () => [[0.1, 0.2, 0.3]]) };
});

import { denseSearch } from "@/lib/query/dense-search";

const BACKEND = { url: "http://mock", model: "m", apiKey: null, provider: "local" } as never;

describe("denseSearch membership enforcement (in-query)", () => {
  beforeEach(() => {
    captured.length = 0;
  });

  it("visibleIds present → the filter is part of the SQL and the ids are bound", async () => {
    const ids = ["11111111-1111-1111-1111-111111111111"];
    await denseSearch("team-1", "team", "question", null, 20, BACKEND, ids);
    expect(captured).toHaveLength(1);
    expect(captured[0].sql, "the membership conjunct must be IN-QUERY").toContain("i.id = any(");
    expect(captured[0].params).toContainEqual(ids);
  });

  it("visibleIds [] (enforcing, sees nothing) → zero rows WITHOUT querying (fail closed)", async () => {
    const hits = await denseSearch("team-1", "team", "question", null, 20, BACKEND, []);
    expect(hits).toEqual([]);
    expect(captured, "no SQL may run for an empty visible set").toHaveLength(0);
  });

  it("visibleIds absent (permissive) → the SQL carries NO membership clause (byte-identical to today)", async () => {
    await denseSearch("team-1", "team", "question", null, 20, BACKEND);
    expect(captured).toHaveLength(1);
    expect(captured[0].sql).not.toContain("= any(");
  });
});
