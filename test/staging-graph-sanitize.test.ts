import { describe, expect, it } from "vitest";
import { sanitizeGraphExport } from "../scripts/staging-ops/graph-bundle.mjs";
import { validateLedgerAgainstSanitizedGraph } from "../scripts/staging-ops/exporter.mjs";

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

/**
 * The same UUID legitimately exists in two groups: it is unique per group, and the replay schema
 * indexes `(group_id, uuid)` precisely because a global unique would either refuse a valid copy or
 * merge two groups' nodes. The recovered sanitizer keyed retained episodes by UUID alone, so one of
 * the two was silently overwritten — measured as two eligible episodes in, one node out,
 * `excludedEpisodes: 0`, after which the exporter's ledger validator refused to publish a VALID
 * export.
 */
describe("group-scoped episode identity", () => {
  const twoGroups = {
    nodes: [
      { exportId: "episode-one", labels: ["Episodic"], properties: { uuid: "shared-uuid", name: "items:one", group_id: "group-one" } },
      { exportId: "episode-two", labels: ["Episodic"], properties: { uuid: "shared-uuid", name: "items:two", group_id: "group-two" } },
      { exportId: "entity-one", labels: ["Entity"], properties: { uuid: "e1", name: "One", group_id: "group-one" } },
      { exportId: "entity-one-b", labels: ["Entity"], properties: { uuid: "e1b", name: "One B", group_id: "group-one" } },
      { exportId: "entity-two", labels: ["Entity"], properties: { uuid: "e2", name: "Two", group_id: "group-two" } },
      { exportId: "entity-two-b", labels: ["Entity"], properties: { uuid: "e2b", name: "Two B", group_id: "group-two" } },
    ],
    relationships: [
      { type: "RELATES_TO", start: "entity-one", end: "entity-one-b", properties: { uuid: "fact-one", group_id: "group-one", episodes: ["shared-uuid"] } },
      { type: "RELATES_TO", start: "entity-two", end: "entity-two-b", properties: { uuid: "fact-two", group_id: "group-two", episodes: ["shared-uuid"] } },
      { type: "MENTIONS", start: "episode-one", end: "entity-one", properties: {} },
      { type: "MENTIONS", start: "episode-two", end: "entity-two", properties: {} },
    ],
  };

  it("retains BOTH episodes, both facts and both MENTIONS", () => {
    const out = sanitizeGraphExport(twoGroups, { episodeAllowed: () => true });
    expect(out.nodes.filter((n) => n.labels.includes("Episodic")).map((n) => n.exportId).sort())
      .toEqual(["episode-one", "episode-two"]);
    expect(out.relationships.filter((r) => r.type === "RELATES_TO").map((r) => r.properties.uuid).sort())
      .toEqual(["fact-one", "fact-two"]);
    expect(out.relationships.filter((r) => r.type === "MENTIONS")).toHaveLength(2);
    expect(out.sanitation.excludedEpisodes).toBe(0);
  });

  it("gives the same answer with the input order reversed", () => {
    // The last-writer-wins bug was asymmetric: whichever duplicate arrived last survived, so one
    // direction alone could look correct.
    const key = (out: { nodes: { exportId: string }[]; relationships: { type: string; start: string; end: string }[]; sanitation: unknown }) => ({
      nodes: out.nodes.map((n) => n.exportId).sort(),
      relationships: out.relationships.map((r) => `${r.type}:${r.start}->${r.end}`).sort(),
      sanitation: out.sanitation,
    });
    const forward = sanitizeGraphExport(twoGroups, { episodeAllowed: () => true });
    const reversed = sanitizeGraphExport({
      nodes: [...twoGroups.nodes].reverse(), relationships: [...twoGroups.relationships].reverse(),
    }, { episodeAllowed: () => true });
    expect(key(reversed)).toEqual(key(forward));
  });

  it("does not let an EXCLUDED group's fact borrow the other group's retained UUID", () => {
    // `group-two`'s episode is not eligible, so `fact-two` has no provenance of its own — and the
    // equal UUID retained in `group-one` must not authorise it.
    const out = sanitizeGraphExport(twoGroups, {
      episodeAllowed: (ep: { properties: { group_id: string } }) => ep.properties.group_id === "group-one",
    });
    expect(out.relationships.map((r) => r.properties.uuid).filter(Boolean)).toEqual(["fact-one"]);
    expect(out.sanitation.excludedMixedProvenanceFacts).toBe(1);
    expect(out.nodes.map((n) => n.exportId)).not.toContain("entity-two");
    expect(out.nodes.map((n) => n.exportId)).not.toContain("episode-two");
  });

  it("refuses two retained episodes sharing a UUID WITHIN one group instead of overwriting one", () => {
    const ambiguous = {
      nodes: [
        twoGroups.nodes[0],
        { exportId: "episode-twin", labels: ["Episodic"], properties: { uuid: "shared-uuid", name: "items:twin", group_id: "group-one" } },
      ],
      relationships: [],
    };
    expect(() => sanitizeGraphExport(ambiguous, { episodeAllowed: () => true }))
      .toThrow(/share uuid shared-uuid within group group-one/);
  });

  it("refuses a retained episode with no group identity rather than indexing it under nothing", () => {
    const ungrouped = {
      nodes: [{ exportId: "episode-nogroup", labels: ["Episodic"], properties: { uuid: "u", name: "items:x" } }],
      relationships: [],
    };
    expect(() => sanitizeGraphExport(ungrouped, { episodeAllowed: () => true }))
      .toThrow(/carries no group identity/);
  });

  it("satisfies the exporter's ledger validator, which is where the loss surfaced as a refusal", () => {
    // The loss was invisible in the sanitizer's own counters; what the operator saw was the NEXT
    // stage refusing to publish. So the pairing is the assertion: sanitize, then run the real
    // validator over the real ledger rows those two episodes project from.
    const facts = {
      excluded: new Set<string>(),
      ledger: [
        { source_table: "items", source_id: "one", group_id: "group-one", episodeName: "items:one", episode_uuid: "shared-uuid", chunk_shas: ["sha-one"], content_sha256: "sha-one", deferred: false },
        { source_table: "items", source_id: "two", group_id: "group-two", episodeName: "items:two", episode_uuid: "shared-uuid", chunk_shas: ["sha-two"], content_sha256: "sha-two", deferred: false },
      ],
    };
    const out = sanitizeGraphExport(twoGroups, { episodeAllowed: () => true });
    expect(() => validateLedgerAgainstSanitizedGraph(out, facts)).not.toThrow();
    // Negative control: the validator DOES speak up when an episode really is missing, so the
    // assertion above is not green merely because the validator never rejects anything.
    const missing = { ...facts, ledger: [...facts.ledger, { source_table: "items", source_id: "three", group_id: "group-three", episodeName: "items:three", episode_uuid: "missing-uuid", chunk_shas: ["sha-three"], content_sha256: "sha-three", deferred: false }] };
    expect(() => validateLedgerAgainstSanitizedGraph(out, missing)).toThrow(/does not satisfy current projection ledger/);
  });
});

describe("M6 — projection ledger UUID correspondence", () => {
  const episode = (exportId: string, uuid: string, name: string, group_id: string) => ({
    exportId, labels: ["Episodic"], properties: { uuid, name, group_id },
  });
  const row = (over: Record<string, unknown> = {}) => ({
    source_table: "items", source_id: "item", group_id: "team", episodeName: "items:item",
    episode_uuid: "ep-1", chunk_shas: ["sha-0", "sha-1"], content_sha256: "c".repeat(64),
    deferred: false, ...over,
  });
  const facts = (ledger: Record<string, unknown>[]) => ({ excluded: new Set<string>(), ledger });

  it("accepts a legitimate nonzero chunk UUID while requiring every chunk name", () => {
    const graph = { nodes: [
      episode("zero", "ep-0", "items:item#0", "team"),
      episode("one", "ep-1", "items:item#1", "team"),
    ] };
    expect(() => validateLedgerAgainstSanitizedGraph(graph, facts([row()]))).not.toThrow();
  });

  it("refuses a substituted UUID even when all expected names and groups are present", () => {
    const graph = { nodes: [
      episode("zero", "ep-0", "items:item#0", "team"),
      episode("one", "ep-1", "items:item#1", "team"),
      episode("other", "substituted", "items:other", "team"),
    ] };
    expect(() => validateLedgerAgainstSanitizedGraph(graph, facts([row({ episode_uuid: "substituted" })])))
      .toThrow(/does not satisfy current projection ledger/);
  });

  it("does not borrow the ledger UUID from another group", () => {
    const graph = { nodes: [
      episode("zero", "ep-0", "items:item#0", "team"),
      episode("one", "different", "items:item#1", "team"),
      episode("wrong-group", "ep-1", "items:other", "private"),
    ] };
    expect(() => validateLedgerAgainstSanitizedGraph(graph, facts([row()])))
      .toThrow(/does not satisfy current projection ledger/);
  });

  it("preserves pending, deferred, and blank-content rows without inventing confirmation", () => {
    expect(() => validateLedgerAgainstSanitizedGraph({ nodes: [] }, facts([
      row({ episode_uuid: null }),
      row({ source_id: "deferred", deferred: true }),
      row({ source_id: "blank", content_sha256: "" }),
    ]))).not.toThrow();
  });
});
