import { describe, expect, it, vi } from "vitest";
import { assertReplaceTarget, replaceNeo4jGraph } from "../scripts/staging-ops/neo4j-replace.mjs";

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

  it("deletes in bounded batches and replays only validated labels/types with parameterized properties", async () => {
    const session = { run: vi.fn()
      .mockResolvedValueOnce({ records: [{ get: () => 2 }] })
      .mockResolvedValueOnce({ records: [{ get: () => 0 }] })
      .mockResolvedValue({ records: [] }) };
    const graph = {
      codecVersion: 1,
      nodes: [
        { exportId: "a", labels: ["Entity", "Person"], properties: { uuid: "a", group_id: "g" } },
        { exportId: "e", labels: ["Episodic"], properties: { uuid: "e", name: "items:x", group_id: "g" } },
      ],
      relationships: [{ start: "e", end: "a", type: "MENTIONS", properties: { created_at: "x" } }],
    };
    await replaceNeo4jGraph({ session, graph, facts: GOOD, batchSize: 2 });
    const calls = session.run.mock.calls;
    expect(calls[0][0]).toMatch(/LIMIT \$limit DETACH DELETE/);
    expect(calls.some(([q]) => q.includes("CREATE (n:`Entity`:`Person`)"))).toBe(true);
    expect(calls.some(([q]) => q.includes("CREATE (a)-[r:`MENTIONS`]->(b)"))).toBe(true);
    expect(JSON.stringify(calls)).not.toContain("items:x'");
  });
});
