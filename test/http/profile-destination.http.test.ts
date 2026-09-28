import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { BASE_URL, db, seedTeam, issueKeyFor, keyHeaders } from "./http-helpers";
import { ensureAccessBootstrap } from "@/lib/access/bootstrap";

async function fixture() {
  const seed = await seedTeam();
  expect((await ensureAccessBootstrap(db(), seed.teamId)).ok).toBe(true);
  const { data: project, error } = await db().from("projects").insert({
    team_id: seed.teamId, slug: `binding-${randomUUID()}`, kind: "initiative", graph_group_id: randomUUID(),
  }).select("id").single();
  if (error || !project) throw new Error("project fixture failed");
  const { data: group } = await db().from("groups").select("id").eq("team_id", seed.teamId).eq("slug", "everyone").single();
  const grant = await db().from("project_groups").insert({ team_id: seed.teamId, project_id: project.id, group_id: group!.id });
  if (grant.error) throw new Error("grant fixture failed");
  const { key } = await issueKeyFor(seed, "team");
  return { seed, projectId: project.id as string, headers: keyHeaders(key, seed.teamSlug) };
}
const get = (id: string, headers?: Record<string, string>) => fetch(`${BASE_URL}/api/v1/projects/${id}`, { headers });
describe("explicit profile destination verification", () => {
  it("returns only the authenticated destination and rechecks live membership", async () => {
    const f = await fixture();
    const first = await get(f.projectId, f.headers);
    expect(first.status).toBe(200); expect(first.headers.get("cache-control")).toBe("no-store");
    expect(await first.json()).toEqual({ project_id: f.projectId, team_id: f.seed.teamId });
    await db().from("project_groups").delete().eq("project_id", f.projectId);
    expect((await get(f.projectId, f.headers)).status).toBe(404);
  });
  it("does not disclose malformed, absent, other-team or ungranted destinations", async () => {
    const f = await fixture(), other = await fixture();
    for (const id of ["not-a-uuid", randomUUID(), other.projectId]) {
      const response = await get(id, f.headers);
      expect(response.status).toBe(404); expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toMatchObject({ error: { code: "not_found" } });
    }
    expect((await get(f.projectId)).status).toBe(401);
  });
  it("does not retain authority after the member key is revoked", async () => {
    const f = await fixture(); expect((await get(f.projectId, f.headers)).status).toBe(200);
    await db().from("api_keys").update({ revoked_at: new Date().toISOString() }).eq("member_id", f.seed.memberId);
    expect((await get(f.projectId, f.headers)).status).toBe(401);
  });
});
