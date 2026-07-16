import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  audit: vi.fn(),
  key: null as null | Record<string, unknown>,
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/api/audit", () => ({ audit: h.audit }));
vi.mock("@/lib/db/admin", () => ({
  adminClient: () => ({
    from: (table: string) => {
      const chain: Record<string, unknown> = {};
      chain.select = vi.fn(() => chain);
      chain.eq = vi.fn(() => chain);
      chain.update = vi.fn(() => chain);
      chain.maybeSingle = vi.fn(async () => ({
        data: table === "api_keys" ? h.key : null,
      }));
      chain.then = (resolve: (value: unknown) => unknown) =>
        Promise.resolve(resolve({ data: null }));
      return chain;
    },
  }),
}));

const { authenticateApiKey } = await import("@/lib/api/auth");
const { GET: getMe } = await import("@/app/api/v1/me/route");

const TEAM_ID = "11111111-2222-3333-4444-555555555555";
const SECRET = "secret_value";

function request(team?: string) {
  const headers = new Headers({ Authorization: `Bearer aios_key1_${SECRET}` });
  if (team !== undefined) headers.set("X-AIOS-Team", team);
  return new Request("https://brain.example.com/api/v1/me", { headers });
}

describe("member API key team identity", () => {
  beforeEach(() => {
    h.audit.mockReset().mockResolvedValue(undefined);
    h.key = {
      id: "api-key-row-1",
      team_id: TEAM_ID,
      member_id: "member-1",
      key_hash: createHash("sha256").update(SECRET).digest("hex"),
      revoked_at: null,
      members: {
        actor_handle: "alex",
        tier: "team",
        status: "active",
        role: "lead",
        display_name: "Alex Example",
        email: "alex@example.com",
      },
      teams: { slug: "acme" },
    };
  });

  it("accepts a valid key without X-AIOS-Team", async () => {
    const auth = await authenticateApiKey(request());
    expect(auth?.teamId).toBe(TEAM_ID);
    expect(auth?.actorHandle).toBe("alex");
    expect(h.audit).not.toHaveBeenCalled();
  });

  it.each([TEAM_ID, "acme"])(
    "accepts a matching team UUID or slug: %s",
    async (team) => {
      const auth = await authenticateApiKey(request(team));
      expect(auth?.teamId).toBe(TEAM_ID);
      expect(h.audit).not.toHaveBeenCalled();
    },
  );

  it("rejects and audits a mismatching team header", async () => {
    await expect(authenticateApiKey(request("other-team"))).resolves.toBeNull();
    expect(h.audit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "auth.failed",
        meta: { reason: "team_mismatch", team_header: "other-team" },
      }),
    );
  });

  it("GET /api/v1/me preserves the authenticated key identity fields", async () => {
    const response = await getMe(request() as Parameters<typeof getMe>[0]);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      actor: "alex",
      role: "lead",
      tier: "team",
      team: TEAM_ID,
    });
  });
});
