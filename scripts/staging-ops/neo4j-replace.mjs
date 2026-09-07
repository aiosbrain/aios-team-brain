import neo4j from "neo4j-driver";
import { decodeNeo4jValue } from "./neo4j-codec.mjs";
import { GRAPH_CODEC_VERSION, SUPPORTED_NODE_LABELS, SUPPORTED_RELATIONSHIP_TYPES, validateGraphShape } from "./graph-bundle.mjs";

const INTERNAL = /(?:^|\.)railway\.internal$/i;
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The temporary label carrying export-local identity during replay. Removed before the run ends. */
export const IMPORT_LABEL = "__AiosImport";
export const IMPORT_PROPERTY = "__aios_import_id";
const IMPORT_INDEX = "aios_import_identity";

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

/**
 * The ALLOWLISTED replay schema (M7). Two properties of this list are load-bearing:
 *
 *  1. It is a fixed allowlist derived from the supported labels/types, NOT Cypher carried in the
 *     bundle. Nothing an exporter can write reaches the database as a schema statement.
 *  2. There is NO uniqueness constraint on `uuid`. Identity in this graph is (group_id, uuid): the
 *     SAME uuid legitimately exists in different groups, and a global unique constraint would
 *     either refuse a valid copy or silently merge two groups' nodes into one — which is a tier
 *     leak wearing a schema's clothes. These are composite RANGE indexes, which make the
 *     group-scoped lookups fast without asserting cross-group equality.
 */
export function allowlistedSchemaStatements() {
  const statements = [];
  for (const label of ["Entity", "Episodic"]) {
    if (!SUPPORTED_NODE_LABELS.has(label)) throw new Error(`replay schema names unsupported label ${label}`);
    const escaped = escapedIdentifier(label);
    statements.push(`CREATE INDEX aios_${label.toLowerCase()}_group_uuid IF NOT EXISTS FOR (n:${escaped}) ON (n.group_id, n.uuid)`);
    statements.push(`CREATE INDEX aios_${label.toLowerCase()}_group IF NOT EXISTS FOR (n:${escaped}) ON (n.group_id)`);
  }
  for (const type of ["RELATES_TO", "MENTIONS"]) {
    if (!SUPPORTED_RELATIONSHIP_TYPES.has(type)) throw new Error(`replay schema names unsupported relationship type ${type}`);
    const escaped = escapedIdentifier(type);
    statements.push(`CREATE INDEX aios_${type.toLowerCase()}_group_uuid IF NOT EXISTS FOR ()-[r:${escaped}]-() ON (r.group_id, r.uuid)`);
  }
  statements.push(`CREATE INDEX aios_episodic_name IF NOT EXISTS FOR (n:${escapedIdentifier("Episodic")}) ON (n.group_id, n.name)`);
  return statements;
}

/**
 * A safe positive integer, sent as a driver Integer.
 *
 * The plain JS number is the bug: neo4j-driver serialises it as a Bolt Float, and Cypher's LIMIT
 * requires an integer. Validation first (the driver would happily wrap an absurd value), conversion
 * second.
 */
export function neoInt(value) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 10_000) throw new Error("Neo4j delete batch must be 1..10000");
  return neo4j.int(value);
}

function chunk(items, size) {
  const out = [];
  for (let index = 0; index < items.length; index += size) out.push(items.slice(index, index + size));
  return out;
}

export async function replaceNeo4jGraph({ session, graph, facts, batchSize = 1000 }) {
  assertReplaceTarget(facts);
  if (graph?.codecVersion !== GRAPH_CODEC_VERSION) throw new Error(`unsupported graph codec version ${graph?.codecVersion}`);
  validateGraphShape(graph);
  const limit = neoInt(batchSize);

  let deleted;
  do {
    // Re-check every load-bearing fact before the first delete and before every retry batch.
    assertReplaceTarget(facts);
    const result = await session.run("MATCH (n) WITH n LIMIT $limit DETACH DELETE n RETURN count(n) AS deleted", { limit });
    deleted = Number(result.records[0]?.get("deleted")?.toString?.() ?? result.records[0]?.get("deleted") ?? 0);
  } while (deleted > 0);

  // A fresh database has no indexes at all, so every relationship MATCH below would be a full scan.
  // The temporary identity index is created with the allowlisted schema and awaited together, so
  // replay never races an index that is still populating.
  const importIndex = `CREATE INDEX ${IMPORT_INDEX} IF NOT EXISTS FOR (n:${escapedIdentifier(IMPORT_LABEL)}) ON (n.${IMPORT_PROPERTY})`;
  for (const statement of [...allowlistedSchemaStatements(), importIndex]) await session.run(statement);
  await session.run("CALL db.awaitIndexes($seconds)", { seconds: neo4j.int(300) });

  try {
    const byLabels = new Map();
    for (const node of graph.nodes) {
      const key = node.labels.map(escapedIdentifier).join(":");
      if (!byLabels.has(key)) byLabels.set(key, []);
      byLabels.get(key).push({ exportId: node.exportId, properties: decodeNeo4jValue(node.properties) });
    }
    for (const [labels, rows] of byLabels) {
      for (const batch of chunk(rows, batchSize)) {
        await session.run(
          `UNWIND $rows AS row CREATE (n:${labels}:${escapedIdentifier(IMPORT_LABEL)}) SET n = row.properties SET n.${IMPORT_PROPERTY} = row.exportId`,
          { rows: batch }
        );
      }
    }

    const byType = new Map();
    for (const rel of graph.relationships) {
      if (!byType.has(rel.type)) byType.set(rel.type, []);
      byType.get(rel.type).push({ start: rel.start, end: rel.end, properties: decodeNeo4jValue(rel.properties) });
    }
    for (const [type, rows] of byType) {
      const escaped = escapedIdentifier(type);
      for (const batch of chunk(rows, batchSize)) {
        const result = await session.run(
          `UNWIND $rows AS row
             MATCH (a:${escapedIdentifier(IMPORT_LABEL)} {${IMPORT_PROPERTY}: row.start})
             MATCH (b:${escapedIdentifier(IMPORT_LABEL)} {${IMPORT_PROPERTY}: row.end})
             CREATE (a)-[r:${escaped}]->(b) SET r = row.properties
             RETURN count(r) AS created`,
          { rows: batch }
        );
        const created = Number(result.records[0]?.get("created")?.toString?.() ?? 0);
        if (created !== batch.length) throw new Error(`graph replay created ${created} of ${batch.length} ${type} relationships`);
      }
    }
  } finally {
    // The temporary identity must not outlive the run in EITHER outcome — an abandoned
    // `__aios_import_id` would become a property of the copied dataset and an abandoned index
    // would be schema this design never declared.
    let removed;
    do {
      const result = await session.run(
        `MATCH (n:${escapedIdentifier(IMPORT_LABEL)}) WITH n LIMIT $limit REMOVE n:${escapedIdentifier(IMPORT_LABEL)} REMOVE n.${IMPORT_PROPERTY} RETURN count(n) AS removed`,
        { limit }
      );
      removed = Number(result.records[0]?.get("removed")?.toString?.() ?? 0);
    } while (removed > 0);
    await session.run(`DROP INDEX ${IMPORT_INDEX} IF EXISTS`);
  }
}
