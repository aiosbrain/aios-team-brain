import { ensureAccessBootstrap } from "@/lib/access/bootstrap";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { BASE_URL, db, seedTeam, issueKeyFor, keyHeaders } from "./http-helpers";

async function fixture(role = "admin", effect = "allow") {
  const seed = await seedTeam();
  expect((await ensureAccessBootstrap(db(), seed.teamId)).ok).toBe(true);
  await db().from("members").update({ role }).eq("id", seed.memberId);
  const { data: project, error } = await db().from("projects").insert({
    team_id: seed.teamId, slug: `decision-${randomUUID().slice(0, 8)}`, kind: "initiative", graph_group_id: `decision-${randomUUID()}`,
  }).select("id").single();
  if (error || !project) throw new Error("fixture project failed");
  const { data: group } = await db().from("groups").select("id").eq("team_id", seed.teamId).eq("slug", "everyone").single();
  const grant = await db().from("project_groups").insert({ team_id: seed.teamId, project_id: project.id, group_id: group!.id });
  if (grant.error) throw new Error("fixture grant failed");
  await db().from("policies").insert({ team_id: seed.teamId, action: "decision.record", resource: "*", effect });
  const { key } = await issueKeyFor(seed, "team");
  const headers = keyHeaders(key, seed.teamSlug);
  const request = { contract_version: "mcp-next/1", type: "decision.record", destination: { project_id: project.id },
    params: { operation_id: randomUUID(), title: "HTTP orbit", rationale: "Durable rationale", impact: "" } };
  return { seed, request, headers };
}
const post = (body: unknown, headers: Record<string, string>) => fetch(`${BASE_URL}/api/v1/actions/submit`, { method: "POST", headers, body: JSON.stringify(body) });
// This suite is required in the enabled production HTTP acceptance job; no skipped fixture route.
describe("decision.record production HTTP", () => {
  it("returns committed identity and rationale writeback and repeats the original result", async () => {
    const f = await fixture();
    const identity = await fetch(`${BASE_URL}/api/v1/me`, { headers: f.headers });
    expect(identity.status).toBe(200);
    expect((await identity.json()).capabilities).toMatchObject({
      contract_versions: ["mcp-next/1"], actions: expect.arrayContaining(["decision.record"]), task_revisions: false,
    });
    const response = await post(f.request, f.headers);
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result).toMatchObject({ status: "succeeded", entity: { kind: "decision" }, audit_ref: expect.any(String) });
    expect(await (await post(f.request, f.headers)).json()).toEqual(result);
    const status = await fetch(`${BASE_URL}/api/v1/actions/${result.action_id}`, { headers: f.headers });
    expect(status.status).toBe(200); expect(await status.json()).toEqual(result);
    const { data } = await db().from("decisions").select("id,created_by,source_item_id").eq("team_id", f.seed.teamId);
    expect(data).toHaveLength(1); expect(data![0]).toMatchObject({ id: result.entity.id, created_by: f.seed.memberId });
    const feed = await fetch(`${BASE_URL}/api/v1/decisions`, { headers: f.headers });
    expect(feed.status).toBe(200);
    expect((await feed.json()).decisions[0].rows[0]).toMatchObject({ rationale: f.request.params.rationale });
    const conflict = await post({ ...f.request, params: { ...f.request.params, rationale: "different" } }, f.headers);
    expect(conflict.status).toBe(409); expect(await conflict.json()).toMatchObject({ error: { code: "operation_id_conflict" } });
  });
  it("does not lend domain privilege through an allow policy", async () => {
    const f = await fixture("member"); const response = await post(f.request, f.headers);
    expect(response.status).toBe(403); expect(await response.json()).toMatchObject({ status: "denied", error: { code: "forbidden" } });
    expect((await db().from("decisions").select("id").eq("team_id", f.seed.teamId)).data).toEqual([]);
  });
  it("reports pending approval truthfully without an entity", async () => {
    const f = await fixture("admin", "require_approval"); const response = await post(f.request, f.headers);
    expect(response.status).toBe(202);
    const result = await response.json(); expect(result.status).toBe("pending_approval"); expect(result.entity).toBeUndefined();
    expect((await db().from("decisions").select("id").eq("team_id", f.seed.teamId)).data).toEqual([]);
  });
  it("rejects forged attribution and read-only credentials without writes", async () => {
    const f = await fixture();
    const forged = await post({ ...f.request, params: { ...f.request.params, decided_by: "Someone else" } }, f.headers);
    expect(forged.status).toBe(422);
    const delegated = await post(f.request, { ...f.headers, Authorization: `Bearer aiosd_${randomUUID()}_synthetic` });
    expect(delegated.status).toBe(401);
    const external = await issueKeyFor(f.seed, "external");
    const refused = await post(f.request, keyHeaders(external.key, f.seed.teamSlug));
    expect([403, 404]).toContain(refused.status);
    expect((await db().from("decisions").select("id").eq("team_id", f.seed.teamId)).data).toEqual([]);
  });
  it("denies replay and status after the initiating key is revoked", async () => {
    const f = await fixture(); const response = await post(f.request, f.headers); expect(response.status).toBe(200);
    const result = await response.json();
    await db().from("api_keys").update({ revoked_at: new Date().toISOString() }).eq("member_id", f.seed.memberId);
    expect((await post(f.request, f.headers)).status).toBe(401);
    expect((await fetch(`${BASE_URL}/api/v1/actions/${result.action_id}`, { headers: f.headers })).status).toBe(401);
    expect((await db().from("decisions").select("id").eq("team_id", f.seed.teamId)).data).toHaveLength(1);
  });
});
