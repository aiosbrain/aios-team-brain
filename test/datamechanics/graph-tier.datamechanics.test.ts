import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { issueApiKey } from "@/lib/admin/keys";
import { retrieve } from "@/lib/query/retrieve";
import { db, seedTeam, memberRetrieveEnforce, type Seed } from "./helpers";

const GRAPH_URL = "http://graphiti.test";
const ROUTE_URL = "http://test/api/v1/graph-query";

type GraphitiSearchBody = {
  query: string;
  group_ids: string[];
  max_facts: number;
};

/** Issue a key for the seeded team member (tier=team) or a fresh external member. */
async function issueKeyFor(seed: Seed, tier: "team" | "external") {
  let memberId = seed.memberId;
  if (tier === "external") {
    const { data, error } = await db()
      .from("members")
      .insert({
        team_id: seed.teamId,
        email: `ext-${randomUUID().slice(0, 8)}@test.local`,
        display_name: "External",
        actor_handle: `ext-${randomUUID().slice(0, 8)}`,
        role: "member",
        tier: "external",
        status: "active",
      })
      .select("id")
      .single();
    if (error || !data) throw new Error(`external member seed failed: ${error?.message}`);
    memberId = (data as { id: string }).id;
  }
  const { key } = await issueApiKey(db(), seed.teamId, memberId, `${tier} graph key`);
  return key;
}

function post(key: string, teamSlug: string, body: unknown) {
  const req = new Request(ROUTE_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "X-AIOS-Team": teamSlug,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
  return req;
}

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

  it("retrieve() blends graph facts but scopes an external MEMBER to their granted partitions only (PRET-6: the oracle, not a tier lens)", async () => {
    const seed = await seedTeam();
    const enforce = await memberRetrieveEnforce(seed, "external");
    const { requests } = stubGraphiti();

    const ctx = await retrieve(db(), seed.teamId, "external", "who owns payments?", null, enforce);

    expect(ctx.structured).toContain("## Graph memory");
    expect(ctx.structured).toContain("Alex owns payments");
    expect(requests).toHaveLength(1);
    // The external member's oracle admits external-shared only, whose STORED pointer is the
    // grandfathered legacy id — so the graph scope is exactly that one partition.
    expect(requests[0]?.group_ids).toEqual([`${seed.teamSlug}_external`]);
  });
});
