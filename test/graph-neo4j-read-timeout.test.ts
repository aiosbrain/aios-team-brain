import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const captured: { config?: unknown }[] = [];
vi.mock("neo4j-driver", () => {
  const session = {
    executeRead: async (fn: (tx: { run: (c: string, p: unknown) => Promise<{ records: never[] }> }) => Promise<unknown>, config?: unknown) => {
      captured.push({ config });
      return fn({ run: async () => ({ records: [] }) });
    },
    close: async () => {},
  };
  const driver = { session: () => session, close: async () => {} };
  const neo4j = { driver: () => driver, auth: { basic: () => ({}) }, session: { READ: "READ" } };
  return { default: neo4j, ...neo4j };
});

import { readTxConfig, runRead, NEO4J_READ_TIMEOUT_MS_DEFAULT } from "@/lib/graph/neo4j";

// GRAPHSAT-1 (Codex diff review H1): the bolt read runs inside the projector's lease + single-flight;
// a read with no deadline could strand both. Pins the config AND the call site (runRead must pass it).
describe("Neo4j read transaction deadline", () => {
  it("defaults to 30s; env overrides; 0/blank/garbage never mean 'no deadline'", () => {
    expect(readTxConfig({})).toEqual({ timeout: NEO4J_READ_TIMEOUT_MS_DEFAULT });
    expect(readTxConfig({ NEO4J_READ_TIMEOUT_MS: "5000" })).toEqual({ timeout: 5000 });
    expect(readTxConfig({ NEO4J_READ_TIMEOUT_MS: "0" })).toEqual({ timeout: NEO4J_READ_TIMEOUT_MS_DEFAULT });
    expect(readTxConfig({ NEO4J_READ_TIMEOUT_MS: "" })).toEqual({ timeout: NEO4J_READ_TIMEOUT_MS_DEFAULT });
    expect(readTxConfig({ NEO4J_READ_TIMEOUT_MS: "soon" })).toEqual({ timeout: NEO4J_READ_TIMEOUT_MS_DEFAULT });
  });

  it("runRead passes the deadline to executeRead (the call-site pin)", async () => {
    process.env.NEO4J_URL = "bolt://mock:7687";
    await runRead("MATCH (n) RETURN n");
    expect(captured.at(-1)?.config).toEqual({ timeout: NEO4J_READ_TIMEOUT_MS_DEFAULT });
  });
});
