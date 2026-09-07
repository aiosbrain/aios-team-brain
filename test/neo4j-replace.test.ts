import neo4j from "neo4j-driver";
import { describe, expect, it, vi } from "vitest";
import {
  IMPORT_LABEL,
  IMPORT_PROPERTY,
  allowlistedSchemaStatements,
  assertReplaceTarget,
  neoInt,
  replaceNeo4jGraph,
} from "../scripts/staging-ops/neo4j-replace.mjs";

const GOOD = {
  actualEnvironmentId: "staging-env",
  pinnedEnvironmentId: "staging-env",
  tokenEnvironmentId: "staging-env",
  neo4jHost: "neo4j-staging.railway.internal",
  pinnedNeo4jService: "neo4j-staging",
  database: "neo4j",
  pinnedDatabase: "neo4j",
  targetCredentialFingerprint: "target-fingerprint",
  sourceCredentialFingerprint: "source-fingerprint",
  electionLockHeld: true,
  exclusiveDataLockHeld: true,
  pinnedAppServiceId: "app-service",
  pinnedGraphitiServiceId: "graph-service",
  stopMeasurement: { stopped: true, environmentId: "staging-env", services: ["app-service", "graph-service"], observedDeploymentIds: ["app-1", "graph-1"] },
};

const GRAPH = {
  codecVersion: 1,
  nodes: [
    { exportId: "a", labels: ["Entity", "Person"], properties: { uuid: "shared-uuid", group_id: "g1" } },
    { exportId: "b", labels: ["Entity"], properties: { uuid: "shared-uuid", group_id: "g2" } },
    { exportId: "e", labels: ["Episodic"], properties: { uuid: "e", name: "items:x", group_id: "g1" } },
  ],
  relationships: [{ start: "e", end: "a", type: "MENTIONS", properties: { created_at: "x" } }],
};

/** A session double that answers the counting queries the replayer checks. */
function fakeSession({ deletes = [2, 0] }: { deletes?: number[] } = {}) {
  const queue = [...deletes];
  const run = vi.fn(async (cypher: string, params?: Record<string, unknown>) => {
    if (cypher.includes("DETACH DELETE")) return { records: [{ get: () => queue.shift() ?? 0 }] };
    if (cypher.includes(`REMOVE n:\`${IMPORT_LABEL}\``)) return { records: [{ get: () => 0 }] };
    if (cypher.includes("RETURN count(r) AS created")) {
      const rows = (params?.rows as unknown[] | undefined) ?? [];
      return { records: [{ get: () => rows.length }] };
    }
    return { records: [] };
  });
  return { run };
}

describe("staging Neo4j replacement owner", () => {
  it("accepts only the exact stopped, locked, distinct-credential internal staging target", () => {
    expect(assertReplaceTarget(GOOD)).toBe(true);
  });

  it.each([
    ["environment", { actualEnvironmentId: "production" }],
    ["token", { tokenEnvironmentId: "production" }],
    ["host", { neo4jHost: "public.example.com" }],
    ["database", { database: "other" }],
    ["credentials", { targetCredentialFingerprint: "source-fingerprint" }],
    ["election", { electionLockHeld: false }],
    ["exclusive", { exclusiveDataLockHeld: false }],
    ["deployments", { stopMeasurement: { stopped: false } }],
  ])("refuses wrong %s before emitting delete", async (_label, changed) => {
    const session = { run: vi.fn() };
    await expect(replaceNeo4jGraph({ session, graph: { codecVersion: 1, nodes: [], relationships: [] }, facts: { ...GOOD, ...changed } })).rejects.toThrow();
    expect(session.run).not.toHaveBeenCalled();
  });

  it("replays only validated labels/types with parameterized properties", async () => {
    const session = fakeSession();
    await replaceNeo4jGraph({ session, graph: GRAPH, facts: GOOD, batchSize: 2 });
    const calls = session.run.mock.calls;
    expect(calls[0][0]).toMatch(/LIMIT \$limit DETACH DELETE/);
    expect(calls.some(([q]) => q.includes("CREATE (n:`Entity`:`Person`"))).toBe(true);
    expect(calls.some(([q]) => q.includes("CREATE (a)-[r:`MENTIONS`]->(b)"))).toBe(true);
    // Content is always a parameter, never interpolated into a statement.
    expect(calls.map(([q]) => q).join("\n")).not.toContain("items:x");
  });
});

describe("LIMIT is sent as a Bolt Integer", () => {
  it("converts a validated batch size through the driver", () => {
    // A plain JS number serialises as a Bolt Float, and Cypher's LIMIT requires an integer. The
    // recovered helper validated the value and then returned the raw Number, so the type contract
    // it claimed to satisfy was never actually applied.
    const limit = neoInt(1000);
    expect(neo4j.isInt(limit)).toBe(true);
    expect(limit.toString()).toBe("1000");
  });

  it.each([[0], [-1], [10_001], [1.5], [Number.NaN]])("refuses %s before conversion", (value) => {
    expect(() => neoInt(value as number)).toThrow(/1\.\.10000/);
  });

  it("passes the driver Integer into the actual delete statement", async () => {
    const session = fakeSession();
    await replaceNeo4jGraph({ session, graph: GRAPH, facts: GOOD, batchSize: 500 });
    const deleteCall = session.run.mock.calls.find(([q]) => q.includes("DETACH DELETE"));
    expect(neo4j.isInt(deleteCall?.[1]?.limit)).toBe(true);
    expect(deleteCall?.[1]?.limit.toString()).toBe("500");
  });
});

describe("M7 — the allowlisted replay schema is group-aware and never globally unique", () => {
  const statements = allowlistedSchemaStatements();

  it("declares no uniqueness constraint at all", () => {
    // Identity here is (group_id, uuid). The SAME uuid legitimately exists in different groups, so
    // a global unique constraint on uuid would either refuse a valid copy or merge two groups'
    // nodes into one — a tier leak wearing a schema's clothes.
    expect(statements.join("\n")).not.toMatch(/CONSTRAINT|IS UNIQUE|NODE KEY/i);
  });

  it("indexes group_id first on both node labels and on facts", () => {
    expect(statements).toContain("CREATE INDEX aios_entity_group_uuid IF NOT EXISTS FOR (n:`Entity`) ON (n.group_id, n.uuid)");
    expect(statements).toContain("CREATE INDEX aios_episodic_group_uuid IF NOT EXISTS FOR (n:`Episodic`) ON (n.group_id, n.uuid)");
    expect(statements).toContain("CREATE INDEX aios_relates_to_group_uuid IF NOT EXISTS FOR ()-[r:`RELATES_TO`]-() ON (r.group_id, r.uuid)");
  });

  it("carries a duplicate uuid across two groups through replay unchanged", async () => {
    const session = fakeSession();
    await replaceNeo4jGraph({ session, graph: GRAPH, facts: GOOD, batchSize: 10 });
    const created = session.run.mock.calls
      .filter(([q]) => q.includes("CREATE (n:"))
      .flatMap(([, params]) => (params?.rows as { properties: Record<string, string> }[]) ?? []);
    const shared = created.filter((row) => row.properties.uuid === "shared-uuid");
    expect(shared.map((row) => row.properties.group_id).sort()).toEqual(["g1", "g2"]);
  });
});

describe("M7 — the export-local replay identity is indexed and then removed", () => {
  it("indexes the temporary identity and awaits it before replaying", async () => {
    const session = fakeSession();
    await replaceNeo4jGraph({ session, graph: GRAPH, facts: GOOD, batchSize: 10 });
    const cypher = session.run.mock.calls.map(([q]) => String(q));
    const indexAt = cypher.findIndex((q) => q.includes(`FOR (n:\`${IMPORT_LABEL}\`) ON (n.${IMPORT_PROPERTY})`));
    const awaitAt = cypher.findIndex((q) => q.includes("db.awaitIndexes"));
    const firstCreate = cypher.findIndex((q) => q.includes("CREATE (n:"));
    expect(indexAt).toBeGreaterThan(-1);
    expect(awaitAt).toBeGreaterThan(indexAt);
    expect(firstCreate).toBeGreaterThan(awaitAt);
  });

  it("strips the temporary label and property, and drops the temporary index", async () => {
    const session = fakeSession();
    await replaceNeo4jGraph({ session, graph: GRAPH, facts: GOOD, batchSize: 10 });
    const cypher = session.run.mock.calls.map(([q]) => String(q));
    expect(cypher.some((q) => q.includes(`REMOVE n:\`${IMPORT_LABEL}\``) && q.includes(`REMOVE n.${IMPORT_PROPERTY}`))).toBe(true);
    expect(cypher.at(-1)).toBe("DROP INDEX aios_import_identity IF EXISTS");
  });

  it("cleans the temporary identity up even when replay FAILS", async () => {
    // An abandoned `__aios_import_id` would become a property of the copied dataset, and an
    // abandoned index would be schema this design never declared.
    const session = fakeSession();
    session.run.mockImplementation(async (cypher: string) => {
      if (cypher.includes("DETACH DELETE")) return { records: [{ get: () => 0 }] };
      if (cypher.includes("CREATE (n:")) throw new Error("replay exploded");
      if (cypher.includes(`REMOVE n:\`${IMPORT_LABEL}\``)) return { records: [{ get: () => 0 }] };
      return { records: [] };
    });
    await expect(replaceNeo4jGraph({ session, graph: GRAPH, facts: GOOD, batchSize: 10 })).rejects.toThrow(/replay exploded/);
    const cypher = session.run.mock.calls.map(([q]) => String(q));
    expect(cypher.at(-1)).toBe("DROP INDEX aios_import_identity IF EXISTS");
  });

  it("refuses a replay that silently created fewer relationships than the batch held", async () => {
    const session = fakeSession();
    session.run.mockImplementation(async (cypher: string) => {
      if (cypher.includes("DETACH DELETE")) return { records: [{ get: () => 0 }] };
      if (cypher.includes("RETURN count(r) AS created")) return { records: [{ get: () => 0 }] };
      if (cypher.includes(`REMOVE n:\`${IMPORT_LABEL}\``)) return { records: [{ get: () => 0 }] };
      return { records: [] };
    });
    await expect(replaceNeo4jGraph({ session, graph: GRAPH, facts: GOOD, batchSize: 10 }))
      .rejects.toThrow(/created 0 of 1 MENTIONS relationships/);
  });
});
