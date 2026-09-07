import { encodeNeo4jValue } from "./neo4j-codec.mjs";

export const GRAPH_CODEC_VERSION = 1;
export const SUPPORTED_NODE_LABELS = new Set(["Entity", "Episodic", "Person", "Organization", "Location", "Event", "Product", "Topic", "Community"]);
export const SUPPORTED_RELATIONSHIP_TYPES = new Set(["RELATES_TO", "MENTIONS", "HAS_MEMBER"]);
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

function cloneProperties(properties) {
  return { ...(properties ?? {}) };
}

export function validateGraphShape(graph) {
  const ids = new Set();
  for (const node of graph?.nodes ?? []) {
    if (!node.exportId || ids.has(node.exportId)) throw new Error("duplicate or missing export-local node identity");
    ids.add(node.exportId);
    if (!Array.isArray(node.labels) || node.labels.some((label) => !IDENTIFIER.test(label) || !SUPPORTED_NODE_LABELS.has(label))) {
      throw new Error(`unsupported graph node label on ${node.exportId}`);
    }
  }
  for (const rel of graph?.relationships ?? []) {
    if (!SUPPORTED_RELATIONSHIP_TYPES.has(rel.type) || !IDENTIFIER.test(rel.type)) throw new Error(`unsupported graph relationship type ${rel.type}`);
    if (!ids.has(rel.start) || !ids.has(rel.end)) throw new Error("graph relationship has a dangling endpoint");
  }
}

export function sanitizeGraphExport(graph, { episodeAllowed }) {
  validateGraphShape(graph);
  const original = new Map(graph.nodes.map((node) => [node.exportId, node]));
  // TWO indexes, deliberately. Membership is export-local; provenance is (group, uuid).
  //
  // A single UUID-keyed map conflated them, and the spec explicitly forbids assuming UUID
  // uniqueness across groups — the replay schema indexes on `(group_id, uuid)` for exactly that
  // reason. Measured on the recovered source: two eligible episodes with equal UUIDs in different
  // groups produced ONE sanitized node with `excludedEpisodes: 0` (silent loss inside the helper),
  // and the exporter's ledger validation then refused to publish a valid export.
  const retainedEpisodes = new Map();          // exportId → node
  const retainedByGroup = new Map();           // group_id → Map<uuid, node>  (nested, so no delimiter can be forged)
  let excludedCommunities = 0;
  let excludedEpisodes = 0;
  for (const node of graph.nodes) {
    if (node.labels.includes("Community")) { excludedCommunities += 1; continue; }
    if (node.labels.includes("Episodic")) {
      if (!episodeAllowed(node)) { excludedEpisodes += 1; continue; }
      const uuid = node.properties?.uuid;
      if (typeof uuid !== "string" || !uuid) throw new Error("retained episode is missing uuid");
      const group = node.properties?.group_id;
      if (typeof group !== "string" || !group) throw new Error(`retained episode ${node.exportId} carries no group identity; refusing to place it in the provenance index`);
      retainedEpisodes.set(node.exportId, node);
      let byUuid = retainedByGroup.get(group);
      if (!byUuid) { byUuid = new Map(); retainedByGroup.set(group, byUuid); }
      // WITHIN one group a UUID must name exactly one episode: two would make every fact citing it
      // ambiguous. Refuse rather than overwrite — overwriting is precisely the defect above.
      if (byUuid.has(uuid)) throw new Error(`two retained episodes share uuid ${uuid} within group ${group}; refusing an ambiguous provenance index`);
      byUuid.set(uuid, node);
    }
  }

  const relationships = [];
  const incident = new Set(retainedEpisodes.keys());
  let excludedMixedProvenanceFacts = 0;
  let excludedEmptyProvenanceFacts = 0;
  for (const rel of graph.relationships) {
    if (rel.type === "HAS_MEMBER") continue;
    if (rel.type === "RELATES_TO") {
      const provenance = rel.properties?.episodes;
      if (!Array.isArray(provenance) || provenance.length === 0) { excludedEmptyProvenanceFacts += 1; continue; }
      const start = original.get(rel.start);
      const end = original.get(rel.end);
      const group = rel.properties?.group_id;
      // Ownership is established FIRST, because the provenance lookup below is scoped by it: a fact
      // whose group cannot be established has no scope to resolve within, and guessing one is how a
      // node from another group gets published. Missing or inconsistent identity refuses.
      if (typeof group !== "string" || !group || start?.properties?.group_id !== group || end?.properties?.group_id !== group) {
        throw new Error(`fact ${rel.properties?.uuid ?? "unknown"} has inconsistent group ownership`);
      }
      // Provenance resolves ONLY inside this fact's own group. An equal UUID in another group —
      // retained or excluded — never authorises it, so authorisation cannot be borrowed across
      // groups even when the two episodes are indistinguishable by UUID.
      const withinGroup = retainedByGroup.get(group);
      if (provenance.some((uuid) => typeof uuid !== "string" || !withinGroup?.has(uuid))) { excludedMixedProvenanceFacts += 1; continue; }
      relationships.push({ ...rel, properties: cloneProperties(rel.properties) });
      incident.add(rel.start); incident.add(rel.end);
    }
  }
  // MENTIONS is episode→entity provenance, and it is the ONE edge that can pull a node into the
  // bundle that no retained fact vouches for. Eligibility is therefore stated on the edge itself,
  // not inherited from `incident`: a generic "start is already incident" test admits an ENTITY start
  // (an entity becomes incident via any retained fact) and then copies whatever that entity mentions
  // — including a node in another group. Require: a RETAINED EPISODIC start, an Entity end, and one
  // non-empty group shared by both.
  const retainedEpisodeIds = new Set(retainedEpisodes.keys());
  let excludedIneligibleMentions = 0;
  for (const rel of graph.relationships) {
    if (rel.type !== "MENTIONS") continue;
    if (!retainedEpisodeIds.has(rel.start)) { excludedIneligibleMentions += 1; continue; }
    const start = original.get(rel.start);
    const end = original.get(rel.end);
    if (!end) throw new Error("MENTIONS relationship has a dangling endpoint");
    if (!end.labels.includes("Entity")) throw new Error(`MENTIONS from ${start?.properties?.name ?? rel.start} does not point at an Entity`);
    const group = start?.properties?.group_id;
    if (!group || end.properties?.group_id !== group) {
      throw new Error(`MENTIONS from ${start?.properties?.name ?? rel.start} crosses group ownership`);
    }
    relationships.push({ ...rel, properties: cloneProperties(rel.properties) });
    incident.add(rel.end);
  }

  const nodes = graph.nodes.filter((node) => incident.has(node.exportId) && !node.labels.includes("Community")).map((node) => {
    const properties = cloneProperties(node.properties);
    if (node.labels.includes("Entity")) {
      delete properties.summary;
      delete properties.summary_embedding;
    }
    return { ...node, properties };
  });
  return {
    codecVersion: GRAPH_CODEC_VERSION,
    nodes,
    relationships,
    sanitation: { excludedCommunities, excludedEpisodes, excludedMixedProvenanceFacts, excludedEmptyProvenanceFacts, excludedIneligibleMentions },
  };
}

/** Export uses fixed READ statements only; no caller-supplied Cypher enters. */
export async function exportGraph(session) {
  const nodeResult = await session.run("MATCH (n) RETURN elementId(n) AS exportId, labels(n) AS labels, properties(n) AS properties");
  const relResult = await session.run("MATCH (a)-[r]->(b) RETURN elementId(a) AS start, elementId(b) AS end, type(r) AS type, properties(r) AS properties");
  return {
    codecVersion: GRAPH_CODEC_VERSION,
    nodes: nodeResult.records.map((record) => ({ exportId: record.get("exportId"), labels: record.get("labels"), properties: encodeNeo4jValue(record.get("properties")) })),
    relationships: relResult.records.map((record) => ({ start: record.get("start"), end: record.get("end"), type: record.get("type"), properties: encodeNeo4jValue(record.get("properties")) })),
  };
}

/** Census-only fixed reads: aggregate shapes and name prefixes, never graph prose or raw names. */
export async function graphCensus(session) {
  const labels = await session.run("MATCH (n) UNWIND labels(n) AS label RETURN label, count(*) AS count ORDER BY label");
  const types = await session.run("MATCH ()-[r]->() RETURN type(r) AS type, count(*) AS count ORDER BY type");
  const episodes = await session.run("MATCH (n:Episodic) RETURN CASE WHEN n.name STARTS WITH 'items:' THEN 'items' WHEN n.name STARTS WITH 'correction:' THEN 'correction' ELSE 'unsupported' END AS pattern, count(*) AS count ORDER BY pattern");
  const rows = (result, key) => result.records.map((record) => ({ [key]: record.get(key), count: Number(record.get("count").toString()) }));
  const out = { labels: rows(labels, "label"), relationshipTypes: rows(types, "type"), episodeNamePatterns: rows(episodes, "pattern") };
  const unsupportedLabels = out.labels.filter(({ label }) => !SUPPORTED_NODE_LABELS.has(label));
  const unsupportedTypes = out.relationshipTypes.filter(({ type }) => !SUPPORTED_RELATIONSHIP_TYPES.has(type));
  const unsupportedPatterns = out.episodeNamePatterns.filter(({ pattern }) => pattern === "unsupported");
  return { ...out, unsupported: { labels: unsupportedLabels, relationshipTypes: unsupportedTypes, episodeNamePatterns: unsupportedPatterns } };
}
