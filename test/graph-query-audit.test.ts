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
 *
 * AIO-1167 R51 — two route decisions on top:
 *  - Revocation barrier (accepted spec §Revocation barriers; the events route's last-await rule). The
 *    audit write is an await AFTER the read's own last epoch check, so the route re-checks the epoch
 *    the facts were read under as its LAST await: a revocation processed while the audit is written
 *    withholds the candidate as the retryable 503 — no fact reaches the response, and the candidate is
 *    audited once, never re-read and audited again.
 *  - The missing-pointer wiring check reads only the member's VISIBLE system projects: an invisible
 *    broken system project must not fail a healthy visible partition; a visible one still does.
 */
type SystemRow = { id: string; graph_group_id: string | null };
const HEALTHY_VISIBLE: SystemRow = { id: "project-1", graph_group_id: "g" };

const h = vi.hoisted(() => ({
  audits: [] as Record<string, unknown>[],
  read: null as null | (() => Promise<unknown>),
  projects: ["project-1"] as string[],
  groups: ["group-1", "group-2"] as string[],
  systems: [] as Array<{ id: string; graph_group_id: string | null }>,
  /** The durable revocation epoch the route reads; `null` makes the read fail. */
  epoch: 7 as number | null,
  /** Runs while the audit write is in flight — the gap the barrier closes. */
  duringAudit: null as null | (() => Promise<void>),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/api/auth", () => ({
  authenticateApiKey: async () => ({
    teamId: "team-1", memberId: "member-1", apiKeyId: "key-1", memberTier: "team", memberRole: "member",
    actorHandle: "m", displayName: null, email: null, isConnector: false,
  }),
}));
vi.mock("@/lib/api/rate-limit", () => ({ rateLimit: async () => true }));
vi.mock("@/lib/api/audit", () => ({
  audit: async (_db: unknown, row: Record<string, unknown>) => {
    h.audits.push(row);
    if (h.duringAudit) await h.duringAudit();
  },
}));
vi.mock("@/lib/access/authorization-epoch", () => ({
  revocationEpoch: async () => {
    if (h.epoch === null) throw new Error("authorization epoch read failed");
    return h.epoch;
  },
}));
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
    const chain = (rows: Array<Record<string, unknown>>) => {
      const builder: Record<string, unknown> = {
        // `in` filters for real, so a query that forgets to scope by visible ids reads every row.
        select: () => builder, eq: () => builder,
        in: (column: string, values: unknown[]) => chain(rows.filter((row) => values.includes(row[column]))),
        maybeSingle: async () => ({ data: { slug: "acme" }, error: null }),
        then: (resolve: (value: unknown) => unknown) => resolve({ data: rows, error: null }),
      };
      return builder;
    };
    return { from: (table: string) => chain(table === "projects" ? h.systems : []) };
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
  h.systems = [HEALTHY_VISIBLE];
  h.epoch = 7;
  h.duringAudit = null;
  h.read = async () => ({
    facts: [{ id: "f1", fact: "SECRET-FACT-MARKER", at: null, subject: "a", object: "b" }],
    incomplete: false, nextOffset: null, checked: 3, epoch: 7,
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

describe("graph-query revocation barrier across the audit await (R51)", () => {
  it("an unchanged epoch publishes the facts (the positive control)", async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect((await response.json()).facts).toHaveLength(1);
    expect(h.audits).toHaveLength(1);
  });

  it("a revocation processed while the audit is written withholds the facts: 503, audited once", async () => {
    let reads = 0;
    const read = h.read!;
    h.read = async () => { reads += 1; return read(); };
    // Pause inside the audit write and advance the epoch there — a final claim revoked in the gap.
    h.duringAudit = async () => { h.epoch = 8; };
    const response = await POST(request());
    expect(response.status).toBe(503);
    // Exactly the sanitized retryable error: no facts, continuation or count field at all. The
    // request id is random hex, so it is matched by type only and never substring-searched.
    const body = await response.json() as { error: Record<string, unknown> };
    expect(Object.keys(body)).toEqual(["error"]);
    expect(body.error).toEqual({
      code: "temporarily_unavailable",
      message: "graph provenance authorization is temporarily unavailable",
      request_id: expect.any(String),
    });
    const { request_id: _requestId, ...error } = body.error;
    expect(JSON.stringify(error)).not.toMatch(/SECRET-FACT-MARKER|f1/);
    // One read, one audit: the withheld candidate is never re-read and audited a second time.
    expect(reads).toBe(1);
    expect(h.audits).toHaveLength(1);
  });

  it("an epoch that cannot be read after the audit fails closed as the retryable 503", async () => {
    h.duringAudit = async () => { h.epoch = null; };
    const response = await POST(request());
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain("SECRET-FACT-MARKER");
    expect(h.audits).toHaveLength(1);
  });
});

describe("graph-query missing-pointer check reads only visible system projects (R51)", () => {
  it("an invisible broken system project does not fail a healthy visible partition", async () => {
    h.systems = [HEALTHY_VISIBLE, { id: "hidden-system", graph_group_id: null }];
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect((await response.json()).facts).toHaveLength(1);
  });

  it("a VISIBLE system project missing its pointer is still the loud 500", async () => {
    h.systems = [{ id: "project-1", graph_group_id: null }];
    expect((await POST(request())).status).toBe(500);
    expect(h.audits).toEqual([]);
  });
});
