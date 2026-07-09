import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  memberTier: "team" as "team" | "external",
  rateAllowed: true,
  adminFrom: vi.fn(),
  rateLimit: vi.fn(),
  runManualSync: vi.fn(),
  retrieve: vi.fn(),
  streamAnswer: vi.fn(),
  getProviderKey: vi.fn(),
  audit: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({
  getSessionUser: async () => ({ id: "auth-user-1" }),
}));

vi.mock("@/lib/db/server", () => ({
  serverClient: async () => ({
    from: (table: string) => {
      const chain = {
        select: vi.fn(() => chain),
        eq: vi.fn(() => chain),
        maybeSingle: vi.fn(async () => {
          if (table === "teams") return { data: { id: "team-1" } };
          if (table === "members") return { data: { id: "member-1", tier: h.memberTier } };
          return { data: null };
        }),
      };
      return chain;
    },
  }),
}));

vi.mock("@/lib/db/admin", () => ({
  adminClient: () => ({ from: h.adminFrom }),
}));

vi.mock("@/lib/api/rate-limit", () => ({
  rateLimit: h.rateLimit,
}));

vi.mock("@/lib/ingest/manual-sync", () => ({
  isSyncCommand: (question: string) => question.trim() === "/sync",
  runManualSync: h.runManualSync,
}));

vi.mock("@/lib/query/retrieve", () => ({
  retrieve: h.retrieve,
}));

vi.mock("@/lib/query/claude", () => ({
  streamAnswer: h.streamAnswer,
}));

vi.mock("@/lib/integrations/manage", () => ({
  getProviderKey: h.getProviderKey,
}));

vi.mock("@/lib/api/audit", () => ({
  audit: h.audit,
}));

const { POST } = await import("@/app/api/dashboard/query/route");

function request(question: string): Parameters<typeof POST>[0] {
  return new Request("http://test.local/api/dashboard/query", {
    method: "POST",
    body: JSON.stringify({ team: "acme", question }),
  }) as Parameters<typeof POST>[0];
}

/**
 * Spec for the query-box scrape route: a sync command is privileged ingestion, not a normal LLM
 * question. External users must not be able to trigger it, and successful syncs must not consume the
 * daily query budget or enter retrieval/LLM code paths.
 */
describe("POST /api/dashboard/query sync command", () => {
  beforeEach(() => {
    h.memberTier = "team";
    h.rateAllowed = true;
    h.adminFrom.mockReset();
    h.rateLimit.mockReset().mockImplementation(async () => h.rateAllowed);
    h.runManualSync.mockReset().mockResolvedValue({
      summary: "**Scrape complete**\n\n- **Slack**: +1 new, ~2 updated",
      created: 1,
      updated: 2,
      errors: 0,
    });
    h.retrieve.mockReset();
    h.streamAnswer.mockReset();
    h.getProviderKey.mockReset();
    h.audit.mockReset().mockResolvedValue(undefined);
  });

  it("denies external members before ingestion starts", async () => {
    h.memberTier = "external";

    const res = await POST(request("/sync"));

    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("forbidden");
    expect(h.rateLimit).not.toHaveBeenCalled();
    expect(h.runManualSync).not.toHaveBeenCalled();
    expect(h.retrieve).not.toHaveBeenCalled();
    expect(h.streamAnswer).not.toHaveBeenCalled();
  });

  it("applies the sync-specific rate limit before ingestion starts", async () => {
    h.rateAllowed = false;

    const res = await POST(request("/sync"));

    expect(res.status).toBe(429);
    expect((await res.json()).error.code).toBe("rate_limited");
    expect(h.rateLimit).toHaveBeenCalledWith(expect.anything(), "member-1:sync", 2);
    expect(h.runManualSync).not.toHaveBeenCalled();
    expect(h.retrieve).not.toHaveBeenCalled();
    expect(h.streamAnswer).not.toHaveBeenCalled();
  });

  it("streams the manual sync result without entering the LLM query budget path", async () => {
    const res = await POST(request("/sync"));
    const text = await res.text();

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(text).toContain("event: delta");
    expect(text).toContain("Scrape complete");
    expect(text).toContain("event: sources");
    expect(text).toContain("event: done");
    expect(h.rateLimit).toHaveBeenCalledWith(expect.anything(), "member-1:sync", 2);
    expect(h.runManualSync).toHaveBeenCalledWith("team-1");
    expect(h.audit).toHaveBeenCalledWith(expect.anything(), {
      team_id: "team-1",
      actor_kind: "member",
      member_id: "member-1",
      action: "ingest.manual_sync",
      meta: { created: 1, updated: 2, errors: 0 },
    });
    expect(h.retrieve).not.toHaveBeenCalled();
    expect(h.streamAnswer).not.toHaveBeenCalled();
    expect(h.getProviderKey).not.toHaveBeenCalled();
    expect(h.adminFrom).not.toHaveBeenCalled();
  });
});
