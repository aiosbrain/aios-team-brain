import { afterEach, describe, expect, it, vi } from "vitest";
import { retrieve } from "@/lib/query/retrieve";
import { db, seedTeam, memberRetrieveEnforce } from "./helpers";

const GRAPH_URL = "http://graphiti.test";

type GraphitiSearchBody = {
  query: string;
  group_ids: string[];
  max_facts: number;
};

function stubGraphiti(facts = [{ fact: "Alex owns payments", valid_at: "2026-06-25T00:00:00Z" }]) {
  const requests: GraphitiSearchBody[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === `${GRAPH_URL}/search`) {
      requests.push(JSON.parse(String(init?.body)) as GraphitiSearchBody);
      return new Response(JSON.stringify({ facts }), { status: 200 });
    }
    return new Response(JSON.stringify({ results: [] }), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchImpl);
  vi.stubEnv("GRAPHITI_URL", GRAPH_URL);
  return { requests, fetchImpl };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("Graphiti tier scoping (real routes/retrieval, stubbed Graphiti)", () => {
  // Deleted WITH their subject (ENFB-1): the two route arms pinned the LEGACY tier-suffixed
  // partition scheme ("only external group_ids for an external key" / "both tier groups for a
  // team key") — the route now serves the ORACLE's stored-pointer partitions, and that behavior
  // incl. the external-member arm is pinned in test/datamechanics/enfb-graph-query-scope.

  it("retrieve() excludes provenance-free Graphiti facts for an external member", async () => {
    const seed = await seedTeam();
    const enforce = await memberRetrieveEnforce(seed, "external");
    const { requests } = stubGraphiti();

    const ctx = await retrieve(db(), seed.teamId, "external", "who owns payments?", null, enforce);

    expect(ctx.structured).not.toContain("## Graph memory");
    expect(ctx.structured).not.toContain("Alex owns payments");
    expect(requests).toHaveLength(0);
  });
});
