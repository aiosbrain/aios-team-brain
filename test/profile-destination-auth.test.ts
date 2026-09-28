import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ keyError: false, postureError: false, oracleError: false }));
vi.mock("@/lib/access/posture", () => ({ resolveViewerPosture: async () => {
  if (h.postureError) throw new Error("private substrate detail");
  return "team";
} }));
vi.mock("@/lib/api/audit", () => ({ audit: async () => undefined }));
vi.mock("@/lib/access/oracle", () => ({ visibleProjectsWithError: async () => ({
  error: h.oracleError, set: { projectIds: new Set(["11111111-1111-4111-8111-111111111111"]) },
}) }));
vi.mock("@/lib/db/admin", () => ({ adminClient: () => ({ from: (table: string) => {
  const q: Record<string, unknown> = {};
  q.select = q.eq = q.update = () => q;
  q.maybeSingle = async () => table === "api_keys" ? ({
    error: h.keyError ? { message: "private database detail" } : null,
    data: h.keyError ? null : {
      id: "key1", team_id: "22222222-2222-4222-8222-222222222222", member_id: "member1",
      key_hash: createHash("sha256").update("synthetic").digest("hex"), revoked_at: null,
      members: { actor_handle: "member", status: "active", role: "member", tier: "team" },
      teams: { slug: "test" },
    },
  }) : ({ data: { id: "11111111-1111-4111-8111-111111111111", team_id: "22222222-2222-4222-8222-222222222222" }, error: null });
  q.then = (resolve: (v: unknown) => unknown) => Promise.resolve(resolve({ data: null, error: null }));
  return q;
} }) }));
const { GET } = await import("@/app/api/v1/projects/[project_id]/route");
describe("profile binding distinguishes unavailable authorization from invalid identity", () => {
  beforeEach(() => { h.keyError = h.postureError = h.oracleError = false; });
  it.each(["keyError", "postureError", "oracleError"] as const)("%s returns a safe uncached503", async (failure) => {
    h[failure] = true;
    const response = await GET(new Request("https://brain.example/api/v1/projects/11111111-1111-4111-8111-111111111111", {
      headers: { Authorization: "Bearer aios_key1_synthetic" },
    }) as Parameters<typeof GET>[0], { params: Promise.resolve({ project_id: "11111111-1111-4111-8111-111111111111" }) });
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.text();
    expect(JSON.parse(body)).toMatchObject({ error: { code: "unavailable" } });
    expect(body).not.toContain("private");
  });
});
