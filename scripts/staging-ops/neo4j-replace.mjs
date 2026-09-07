import { decodeNeo4jValue } from "./neo4j-codec.mjs";
import { GRAPH_CODEC_VERSION, validateGraphShape } from "./graph-bundle.mjs";

const INTERNAL = /(?:^|\.)railway\.internal$/i;
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function assertReplaceTarget(facts) {
  if (!facts?.pinnedEnvironmentId || facts.actualEnvironmentId !== facts.pinnedEnvironmentId) throw new Error("Neo4j replace environment is not the pinned staging environment");
  if (facts.tokenEnvironmentId !== facts.pinnedEnvironmentId) throw new Error("Neo4j replace project token belongs to the wrong environment");
  if (!INTERNAL.test(String(facts.neo4jHost ?? ""))) throw new Error("Neo4j replace requires the pinned internal host");
  if (!facts.pinnedNeo4jService || !String(facts.neo4jHost).startsWith(`${facts.pinnedNeo4jService}.`)) throw new Error("Neo4j host does not identify the pinned staging service");
  if (!facts.pinnedDatabase || facts.database !== facts.pinnedDatabase) throw new Error("Neo4j database identity mismatch");
  if (!facts.targetCredentialFingerprint || facts.targetCredentialFingerprint === facts.sourceCredentialFingerprint) throw new Error("staging and production graph credentials must differ");
  if (facts.electionLockHeld !== true) throw new Error("coordinator election lock is not held by the replace session");
  if (facts.exclusiveDataLockHeld !== true) throw new Error("exclusive data-use lock is not held by the replace session");
  const stop = facts.stopMeasurement;
  if (stop?.stopped !== true || stop.environmentId !== facts.pinnedEnvironmentId || !Array.isArray(stop.services) ||
      !stop.services.includes(facts.pinnedAppServiceId) || !stop.services.includes(facts.pinnedGraphitiServiceId)) {
    throw new Error("current staging app and Graphiti deployments are not measured stopped");
  }
  return true;
}

function escapedIdentifier(value) {
  if (!IDENTIFIER.test(value)) throw new Error(`unsupported graph identifier ${value}`);
  return `\`${value}\``;
}

export async function replaceNeo4jGraph({ session, graph, facts, batchSize = 1000 }) {
  assertReplaceTarget(facts);
  if (graph?.codecVersion !== GRAPH_CODEC_VERSION) throw new Error(`unsupported graph codec version ${graph?.codecVersion}`);
  validateGraphShape(graph);
  let deleted;
  do {
    // Re-check every load-bearing fact before the first delete and before every retry batch.
    assertReplaceTarget(facts);
    const result = await session.run("MATCH (n) WITH n LIMIT $limit DETACH DELETE n RETURN count(n) AS deleted", { limit: neoInt(batchSize) });
    deleted = Number(result.records[0]?.get("deleted")?.toString?.() ?? result.records[0]?.get("deleted") ?? 0);
  } while (deleted > 0);

  for (const node of graph.nodes) {
    const labels = node.labels.map(escapedIdentifier).join(":");
    await session.run(`CREATE (n:${labels}) SET n = $properties, n.__aios_import_id = $exportId`, {
      properties: decodeNeo4jValue(node.properties),
      exportId: node.exportId,
    });
  }
  for (const rel of graph.relationships) {
    const type = escapedIdentifier(rel.type);
    await session.run(`MATCH (a {__aios_import_id: $start}), (b {__aios_import_id: $end}) CREATE (a)-[r:${type}]->(b) SET r = $properties`, {
      start: rel.start,
      end: rel.end,
      properties: decodeNeo4jValue(rel.properties),
    });
  }
  await session.run("MATCH (n) REMOVE n.__aios_import_id");
}

// neo4j-driver accepts a safe JS integer for bounded LIMIT; kept behind one seam for fixture spies.
function neoInt(value) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 10_000) throw new Error("Neo4j delete batch must be 1..10000");
  return value;
}
