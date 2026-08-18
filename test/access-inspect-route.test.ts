import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Phase B slice 6 — the permission-inspector ROUTE gate. The primitive (explainItemVisibility /
// auditVisibilityAgainstItemIds) is proven against real Postgres in the dm tier; this unit test
// EXERCISES the route's security gate: admin-only (role=admin AND team tier), team-validated target
// member, param validation. Mocked session/db so the branches run without a database.

const h = vi.hoisted(() => ({
  user: { id: "auth-1" } as { id: string } | null,
  member: { role: "admin", tier: "team" } as { role?: string | null; tier?: string | null } | null,
  memberExists: true,
  explain: vi.fn(async () => ({ itemId: "i1", memberId: "m2", visible: true, chains: [] })),
  audit: vi.fn(async () => ["leak-1"]),
}));

vi.mock("@/lib/auth/session", () => ({ getSessionUser: async () => h.user }));
// PRET-4: the route resolves POSTURE; in this unit harness it follows the member stub's tier.
vi.mock("@/lib/access/posture", () => ({ resolveViewerPosture: async () => h.member?.tier ?? "external" }));
vi.mock("@/lib/db/server", () => ({
  serverClient: async () => ({
    from: (table: string) => {
      const chain = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: async () => {
          if (table === "teams") return { data: { id: "team-1" } };
          if (table === "members") return { data: h.member };
          return { data: null };
        },
      };
      return chain;
    },
  }),
}));
vi.mock("@/lib/db/admin", () => ({
  adminClient: () => ({
    from: () => {
      const chain = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: async () => ({ data: h.memberExists ? { id: "m2" } : null }),
      };
      return chain;
    },
  }),
}));
vi.mock("@/lib/access/inspect", () => ({
  explainItemVisibility: h.explain,
  auditVisibilityAgainstItemIds: h.audit,
}));

import { GET, POST } from "@/app/api/dashboard/access/inspect/route";

const getReq = (qs: string) => new Request(`http://test/api/dashboard/access/inspect?${qs}`) as never;
const postReq = (body: unknown) =>
  new Request("http://test/api/dashboard/access/inspect", { method: "POST", body: JSON.stringify(body) }) as never;

beforeEach(() => {
  h.user = { id: "auth-1" };
  h.member = { role: "admin", tier: "team" };
  h.memberExists = true;
  h.explain.mockClear();
  h.audit.mockClear();
});

describe("permission-inspector route gate", () => {
  it("GET: an admin (team tier) gets the explanation", async () => {
    const res = await GET(getReq("team=t&item=i1&member=m2"));
    expect(res.status).toBe(200);
    expect(h.explain).toHaveBeenCalledOnce();
  });

  it("GET: a non-admin member is 403 (never reaches the primitive)", async () => {
    h.member = { role: "member", tier: "team" };
    const res = await GET(getReq("team=t&item=i1&member=m2"));
    expect(res.status).toBe(403);
    expect(h.explain).not.toHaveBeenCalled();
  });

  it("GET: an EXTERNAL-tier admin is 403 (canAccessAdmin needs an unrestricted tier — fail closed)", async () => {
    h.member = { role: "admin", tier: "external" };
    const res = await GET(getReq("team=t&item=i1&member=m2"));
    expect(res.status).toBe(403);
    expect(h.explain).not.toHaveBeenCalled();
  });

  it("GET: not signed in → 401", async () => {
    h.user = null;
    expect((await GET(getReq("team=t&item=i1&member=m2"))).status).toBe(401);
  });

  it("GET: a target member NOT in the team → 422 (no cross-org topology)", async () => {
    h.memberExists = false;
    const res = await GET(getReq("team=t&item=i1&member=m2"));
    expect(res.status).toBe(422);
    expect(h.explain).not.toHaveBeenCalled();
  });

  it("GET: missing item/member → 422", async () => {
    expect((await GET(getReq("team=t"))).status).toBe(422);
  });

  it("POST: an admin gets the leak subset", async () => {
    const res = await POST(postReq({ team: "t", member: randomUUID(), itemIds: [randomUUID()] }));
    expect(res.status).toBe(200);
    expect((await res.json()).leaks).toEqual(["leak-1"]);
  });

  it("POST: a non-admin is 403 before the leak check runs", async () => {
    h.member = { role: "member", tier: "team" };
    const res = await POST(postReq({ team: "t", member: randomUUID(), itemIds: [] }));
    expect(res.status).toBe(403);
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("POST: a malformed body → 422", async () => {
    expect((await POST(postReq({ team: "t" }))).status).toBe(422);
  });
});
