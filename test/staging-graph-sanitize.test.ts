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

describe("M5 — MENTIONS eligibility is stated on the edge, not inherited", () => {
  const crossGroupEntity = { exportId: "x", labels: ["Entity"], properties: { uuid: "x", name: "Other team entity", group_id: "private" } };

  it("copies a MENTIONS whose start is a retained episode in the same group", () => {
    const out = sanitizeGraphExport(graph, { episodeAllowed: (ep) => ep.properties.uuid === "ep-ok" });
    expect(out.relationships.filter((r) => r.type === "MENTIONS")).toHaveLength(1);
    expect(out.nodes.map((n) => n.exportId)).toContain("a");
  });

  it("does not let an ENTITY-rooted MENTIONS pull a node from another group into the bundle", () => {
    // The defect: `incident` accumulates the endpoints of every retained FACT, so an Entity became
    // "incident" and an `incident.has(rel.start)` test admitted an Entity-rooted MENTIONS — copying
    // whatever that entity mentioned, including a node owned by a different group.
    const out = sanitizeGraphExport({
      nodes: [...graph.nodes, crossGroupEntity],
      relationships: [graph.relationships[0], { type: "MENTIONS", start: "a", end: "x", properties: {} }],
    }, { episodeAllowed: (ep) => ep.properties.uuid === "ep-ok" });
    expect(out.nodes.map((n) => n.exportId)).not.toContain("x");
    expect(out.relationships.some((r) => r.type === "MENTIONS" && r.end === "x")).toBe(false);
    expect(out.sanitation.excludedIneligibleMentions).toBe(1);
  });

  it("refuses when a retained EPISODE mentions an entity owned by a different group", () => {
    expect(() => sanitizeGraphExport({
      nodes: [...graph.nodes, crossGroupEntity],
      relationships: [graph.relationships[0], { type: "MENTIONS", start: "ep-ok", end: "x", properties: {} }],
    }, { episodeAllowed: (ep) => ep.properties.uuid === "ep-ok" })).toThrow(/crosses group ownership/);
  });

  it("counts an ineligible MENTIONS whose start is simply not a retained episode", () => {
    const out = sanitizeGraphExport({
      nodes: graph.nodes,
      relationships: [graph.relationships[0], { type: "MENTIONS", start: "ep-secret", end: "a", properties: {} }],
    }, { episodeAllowed: (ep) => ep.properties.uuid === "ep-ok" });
    expect(out.relationships.filter((r) => r.type === "MENTIONS")).toHaveLength(0);
    expect(out.sanitation.excludedIneligibleMentions).toBe(1);
  });

  it("refuses a MENTIONS that points at something other than an Entity", () => {
    expect(() => sanitizeGraphExport({
      nodes: graph.nodes,
      relationships: [graph.relationships[0], { type: "MENTIONS", start: "ep-ok", end: "ep-secret", properties: {} }],
    }, { episodeAllowed: (ep) => ep.properties.uuid === "ep-ok" })).toThrow(/does not point at an Entity/);
  });
});
