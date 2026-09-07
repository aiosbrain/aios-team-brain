import { describe, expect, it } from "vitest";
import { sanitizeGraphExport } from "../scripts/staging-ops/graph-bundle.mjs";

const graph = {
  nodes: [
    { exportId: "ep-ok", labels: ["Episodic"], properties: { uuid: "ep-ok", name: "items:item-ok", group_id: "team" } },
    { exportId: "ep-secret", labels: ["Episodic"], properties: { uuid: "ep-secret", name: "items:item-secret", group_id: "private" } },
    { exportId: "a", labels: ["Entity", "Person"], properties: { uuid: "a", name: "Alice", group_id: "team", summary: "mentions secret", summary_embedding: [1, 2] } },
    { exportId: "b", labels: ["Entity"], properties: { uuid: "b", name: "Roadmap", group_id: "team", name_embedding: [0.1] } },
    { exportId: "c", labels: ["Community"], properties: { uuid: "c", summary: "secret community cache", group_id: "team" } },
  ],
  relationships: [
    { type: "RELATES_TO", start: "a", end: "b", properties: { uuid: "fact-ok", fact: "safe", group_id: "team", episodes: ["ep-ok"] } },
    { type: "RELATES_TO", start: "a", end: "b", properties: { uuid: "fact-mixed", fact: "blended secret", group_id: "team", episodes: ["ep-ok", "ep-secret"] } },
    { type: "MENTIONS", start: "ep-ok", end: "a", properties: {} },
  ],
};

describe("graph sanitation", () => {
  it("drops a mixed-provenance fact whole, omits Community caches and clears entity summaries", () => {
    const out = sanitizeGraphExport(graph, {
      episodeAllowed: (ep) => ep.properties.uuid === "ep-ok",
    });
    expect(out.relationships.map((r) => r.properties.uuid).filter(Boolean)).toEqual(["fact-ok"]);
    expect(out.nodes.some((n) => n.labels.includes("Community"))).toBe(false);
    const alice = out.nodes.find((n) => n.exportId === "a")!;
    expect(alice.properties.summary).toBeUndefined();
    expect(alice.properties.summary_embedding).toBeUndefined();
    expect(out.sanitation).toMatchObject({ excludedMixedProvenanceFacts: 1, excludedCommunities: 1 });
  });

  it("excludes empty-provenance facts and refuses wrong-group endpoints", () => {
    const empty = sanitizeGraphExport({
      nodes: graph.nodes,
      relationships: [{ type: "RELATES_TO", start: "a", end: "b", properties: { uuid: "empty", group_id: "team", episodes: [] } }],
    }, { episodeAllowed: () => true });
    expect(empty.relationships).toEqual([]);
    expect(empty.sanitation.excludedEmptyProvenanceFacts).toBe(1);
    expect(() => sanitizeGraphExport({
      nodes: graph.nodes.map((n) => n.exportId === "b" ? { ...n, properties: { ...n.properties, group_id: "other" } } : n),
      relationships: [graph.relationships[0]],
    }, { episodeAllowed: () => true })).toThrow(/group/i);
  });
});
