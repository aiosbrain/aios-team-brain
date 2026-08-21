import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/graph/neo4j", () => ({ neo4jConfigured: () => true, runRead: vi.fn() }));

import { lookupItemEpisodes, LOOKUP_BATCH, ITEM_EPISODES_CYPHER, type BatchRead } from "@/lib/graph/episode-lookup";
import { deepRequeueEnabledFromEnv } from "@/lib/graph/reconcile";

// GRAPHSAT-1 AC4 (unit): the lookup's fail direction is pinned at the LAYER where a partial set could be
// manufactured — an implementation that caught batch 2's error and returned batch 1 would read every
// unfetched item as never-landed (Codex design round 1 M1).

describe("lookupItemEpisodes — batch atomicity, chunking, scope", () => {
  const ids = (n: number) => Array.from({ length: n }, (_, i) => `id-${String(i).padStart(4, "0")}`);

  it("REJECTS when a later batch fails — no rows from earlier batches are surfaced", async () => {
    let call = 0;
    const read: BatchRead = async () => {
      call++;
      if (call === 1) return [{ uuid: "u1", name: "items:id-0000" }];
      throw new Error("bolt reset");
    };
    await expect(lookupItemEpisodes("g", ids(LOOKUP_BATCH + 1), read, () => true)).rejects.toThrow("bolt reset");
    expect(call).toBe(2);
  });

  it("chunks at LOOKUP_BATCH with exact `items:<id>` stems, the group, and the prefix bound on every batch", async () => {
    const seen: { g: string; n: number; first: string; prefix: string }[] = [];
    const read: BatchRead = async (cypher, params) => {
      expect(cypher).toBe(ITEM_EPISODES_CYPHER);
      const names = params.itemNames as string[];
      seen.push({ g: params.g as string, n: names.length, first: names[0], prefix: params.prefix as string });
      return [{ uuid: `u-${seen.length}`, name: names[0] }];
    };
    const out = await lookupItemEpisodes("grp", ids(LOOKUP_BATCH * 2 + 1), read, () => true);
    expect(seen.map((s) => s.n)).toEqual([LOOKUP_BATCH, LOOKUP_BATCH, 1]);
    expect(seen.every((s) => s.g === "grp" && s.prefix === "items:")).toBe(true);
    expect(seen[1].first).toBe(`items:id-${String(LOOKUP_BATCH).padStart(4, "0")}`);
    expect(out).toHaveLength(3);
  });

  it("returns null when Neo4j is not configured — the caller degrades to today's skip-and-count", async () => {
    const read = vi.fn();
    expect(await lookupItemEpisodes("g", ids(3), read as unknown as BatchRead, () => false)).toBeNull();
    expect(read).not.toHaveBeenCalled();
  });

  it("the Cypher scopes by the group EQUALITY term and the item-stem match (the tier guard pins the source; this pins the string the driver receives)", () => {
    expect(ITEM_EPISODES_CYPHER).toMatch(/e\.group_id = \$g/);
    expect(ITEM_EPISODES_CYPHER).toMatch(/split\(e\.name, '#'\)\[0\] IN \$itemNames/);
    expect(ITEM_EPISODES_CYPHER).toMatch(/STARTS WITH \$prefix/);
  });

  it("a MALFORMED row (a uuid or name that is not a string) REJECTS the lookup — a dropped row would be a partial view (Fable diff review M2)", async () => {
    const read: BatchRead = async () => [{ uuid: "u", name: "items:a" }, { uuid: null, name: "items:b" } as unknown as { uuid: string; name: string }];
    await expect(lookupItemEpisodes("g", ["a", "b"], read, () => true)).rejects.toThrow(/malformed Episodic row/);
  });
});

describe("GRAPH_DEEP_REQUEUE — exact parse (D5b)", () => {
  it('only the string "true" enables; unset, "false", "1", "yes" stay OFF', () => {
    expect(deepRequeueEnabledFromEnv({})).toBe(false);
    expect(deepRequeueEnabledFromEnv({ GRAPH_DEEP_REQUEUE: "false" })).toBe(false);
    expect(deepRequeueEnabledFromEnv({ GRAPH_DEEP_REQUEUE: "1" })).toBe(false);
    expect(deepRequeueEnabledFromEnv({ GRAPH_DEEP_REQUEUE: "yes" })).toBe(false);
    expect(deepRequeueEnabledFromEnv({ GRAPH_DEEP_REQUEUE: "TRUE" })).toBe(false);
    expect(deepRequeueEnabledFromEnv({ GRAPH_DEEP_REQUEUE: "true" })).toBe(true);
  });
});

import { boundDeepRequeueSample, DEEP_REQUEUE_SAMPLE_LIMIT, type DeepRequeueRef } from "@/lib/graph/reconcile";

// Codex diff review M2: D4's enable criterion needs EVERY held candidate enumerable; a fixed oldest-5
// could never show a stable sixth row. Up to the inspectable bound every identity rides; past it the
// caller reports `deepRequeueElided` instead of silently truncating.
describe("boundDeepRequeueSample — enumerable up to the inspectable bound, total order", () => {
  const ref = (i: number, extra: Partial<DeepRequeueRef> = {}): DeepRequeueRef => ({
    teamId: "t", groupId: "g", itemId: `i${String(i).padStart(3, "0")}`, projectedAt: `2020-01-01T00:00:${String(i % 60).padStart(2, "0")}Z`, ...extra,
  });
  it("six held rows → all six identities (oldest first), none elided", () => {
    const six = [5, 3, 1, 4, 2, 0].map((i) => ref(i));
    const out = boundDeepRequeueSample(six);
    expect(out.map((r) => r.itemId)).toEqual(["i000", "i001", "i002", "i003", "i004", "i005"]);
  });
  it("past the bound exactly DEEP_REQUEUE_SAMPLE_LIMIT ride; the caller's elided = held − sample", () => {
    const many = Array.from({ length: DEEP_REQUEUE_SAMPLE_LIMIT + 7 }, (_, i) => ref(i, { projectedAt: "2020-01-01T00:00:00Z" }));
    const out = boundDeepRequeueSample(many);
    expect(out).toHaveLength(DEEP_REQUEUE_SAMPLE_LIMIT);
    expect(many.length - out.length).toBe(7);
  });
  it("a total order: same projectedAt + itemId in two groups/teams sorts deterministically, not by input order", () => {
    const a = ref(1, { groupId: "g-b" }), b = ref(1, { groupId: "g-a" });
    expect(boundDeepRequeueSample([a, b]).map((r) => r.groupId)).toEqual(["g-a", "g-b"]);
    expect(boundDeepRequeueSample([b, a]).map((r) => r.groupId)).toEqual(["g-a", "g-b"]);
  });
});
