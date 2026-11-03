import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

/**
 * AIO-1167 R44 C14 — `POST /api/v1/graph-query` audits a SUCCESSFUL authorized read again.
 *
 * Spec. The base route recorded `graph.query` (actor, team, tier, group and result counts) after a
 * successful search; moving retrieval behind the provenance owner dropped it. Restore it, sanitized:
 * counts only — never the query text or any fact content. A refused/unavailable read must not be
 * recorded as a success, and the empty-scope answer keeps its existing (unaudited) behaviour.
 *
 * Every collaborator is a fake, so this pins the route's own audit decision.
 */
const h = vi.hoisted(() => ({
  audits: [] as Record<string, unknown>[],
  read: null as null | (() => Promise<unknown>),
  projects: ["project-1"] as string[],
  groups: ["group-1", "group-2"] as string[],
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/api/auth", () => ({
  authenticateApiKey: async () => ({
    teamId: "team-1", memberId: "member-1", apiKeyId: "key-1", memberTier: "team", memberRole: "member",
    actorHandle: "m", displayName: null, email: null, isConnector: false,
  }),
}));
vi.mock("@/lib/api/rate-limit", () => ({ rateLimit: async () => true }));
vi.mock("@/lib/api/audit", () => ({ audit: async (_db: unknown, row: Record<string, unknown>) => { h.audits.push(row); } }));
vi.mock("@/lib/graph/neo4j", () => ({ neo4jConfigured: () => true }));
vi.mock("@/lib/access/oracle", () => ({ visibleProjects: async () => ({ projectIds: new Set(h.projects) }) }));
vi.mock("@/lib/graph/partition-read", () => ({ selectEnforcedGraphPartitions: async () => ({ groups: h.groups }) }));
vi.mock("@/lib/graph/provenance-read", async () => {
  class GraphProvenanceUnavailableError extends Error {}
  return {
    GraphProvenanceUnavailableError,
    readAuthorizedGraphFactsResult: async () => h.read!(),
  };
});
vi.mock("@/lib/db/admin", () => ({
  adminClient: () => {
    const chain = (rows: unknown[]) => {
      const builder: Record<string, unknown> = {
        select: () => builder, eq: () => builder, in: () => builder,
        maybeSingle: async () => ({ data: { slug: "acme" }, error: null }),
        then: (resolve: (value: unknown) => unknown) => resolve({ data: rows, error: null }),
      };
      return builder;
    };
    return { from: (table: string) => chain(table === "projects" ? [{ id: "project-1", graph_group_id: "g" }] : []) };
  },
}));

const { POST } = await import("@/app/api/v1/graph-query/route");
const { GraphProvenanceUnavailableError } = await import("@/lib/graph/provenance-read");

const QUERY = "who owns the SECRET-QUERY-MARKER rollout?";
function request(): NextRequest {
  return new Request("http://test/api/v1/graph-query", {
    method: "POST",
    headers: { authorization: "Bearer aios_x_y", "content-type": "application/json" },
    body: JSON.stringify({ query: QUERY }),
  }) as unknown as NextRequest;
}

beforeEach(() => {
  h.audits = [];
  h.projects = ["project-1"];
  h.groups = ["group-1", "group-2"];
  h.read = async () => ({
    facts: [{ id: "f1", fact: "SECRET-FACT-MARKER", at: null, subject: "a", object: "b" }],
    incomplete: false, nextOffset: null, checked: 3,
  });
});

describe("graph-query audit (R44 C14)", () => {
  it("a successful authorized read records one sanitized graph.query audit", async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(h.audits).toEqual([{
      team_id: "team-1", actor_kind: "api_key", member_id: "member-1", api_key_id: "key-1",
      action: "graph.query",
      meta: { tier: "team", groups: 2, results: 1, checked: 3, incomplete: false },
    }]);
    expect(JSON.stringify(h.audits)).not.toMatch(/SECRET-QUERY-MARKER|SECRET-FACT-MARKER/);
  });

  it("an unavailable provenance read is a 503 and is never audited as a success", async () => {
    h.read = async () => { throw new GraphProvenanceUnavailableError("down"); };
    const response = await POST(request());
    expect(response.status).toBe(503);
    expect(h.audits).toEqual([]);
  });

  it("a failed read is a 502 and is never audited as a success", async () => {
    h.read = async () => { throw new Error("neo4j exploded"); };
    expect((await POST(request())).status).toBe(502);
    expect(h.audits).toEqual([]);
  });

  it("the empty-scope answer keeps its existing unaudited behaviour", async () => {
    h.groups = [];
    h.projects = [];
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ facts: [] });
    expect(h.audits).toEqual([]);
  });
});
