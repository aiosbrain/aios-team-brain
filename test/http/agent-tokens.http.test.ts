import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { BASE_URL, db, keyHeaders, seedTeam, type Seed } from "./http-helpers";
import { mintAgentToken } from "@/lib/access/agent-tokens";
import { addMemberToGroup, createGroup, grantProjectToGroup } from "@/lib/access/groups";
import { ingestItem } from "@/lib/ingest";
import { createHash } from "node:crypto";

// §14's delegation rows at their NAMED tier: the wire, over a real socket — the in-process
// handler tests (test/datamechanics/access-agent-tokens) prove the logic; this tier is what
// catches a wire-format/serialization break the type system can't (the Response.json blind
// spot). Phase A surface only: items GET honored + filtered, query 403, items POST rejected.

async function seedAgentWithItem(seed: Seed): Promise<{ token: string; visiblePath: string; hiddenPath: string }> {
  const body = (t: string) => `delegated ${t} content ${randomUUID().slice(0, 6)}`;
  const mk = async (path: string, project: string, text: string) =>
    ingestItem(
      db(),
      { teamId: seed.teamId, memberId: seed.memberId, apiKeyId: randomUUID() },
      { project, kind: "deliverable", actor: "t", frontmatter: {}, path, body: text, content_sha256: createHash("sha256").update(text).digest("hex") },
      "team"
    );
  await mk("agent/visible.md", "agentside", body("visible"));
  await mk("agent/hidden.md", "hiddenside", body("hidden"));
  const { data: projects } = await db().from("projects").select("id, slug").eq("team_id", seed.teamId);
  const bySlug = new Map(((projects ?? []) as { id: string; slug: string }[]).map((p) => [p.slug, p.id]));

  const { data: agentRow } = await db()
    .from("members")
    .insert({
      team_id: seed.teamId,
      email: `${randomUUID()}@test.local`,
      display_name: "Agent",
      actor_handle: `a-${randomUUID().slice(0, 10)}`,
      role: "member",
      tier: "team",
      status: "active",
      kind: "agent",
    })
    .select("id")
    .single();
  const agent = agentRow!.id as string;
  const g = await createGroup(db(), seed.teamId, `ag-${randomUUID().slice(0, 6)}`, "AG", seed.memberId);
  await addMemberToGroup(db(), seed.teamId, g.groupId!, agent, seed.memberId);
  await grantProjectToGroup(db(), seed.teamId, bySlug.get("agentside")!, g.groupId!, seed.memberId);

  const minted = await mintAgentToken(db(), seed.teamId, { memberId: agent }, seed.memberId);
  if (!minted.ok || !minted.token) throw new Error(`mint failed: ${minted.error}`);
  return { token: minted.token, visiblePath: "agent/visible.md", hiddenPath: "agent/hidden.md" };
}

describe("delegated tokens over the wire (Phase A surface)", () => {
  it("GET /api/v1/items honors an aiosd token, oracle-filtered to its effective projects", async () => {
    const seed = await seedTeam();
    const { token, visiblePath, hiddenPath } = await seedAgentWithItem(seed);
    const res = await fetch(`${BASE_URL}/api/v1/items`, { headers: keyHeaders(token, seed.teamSlug) });
    expect(res.status).toBe(200);
    const paths = ((await res.json()).items as { path: string }[]).map((i) => i.path);
    expect(paths).toContain(visiblePath);
    expect(paths, "out-of-set items must not cross the wire").not.toContain(hiddenPath);
  });

  it("POST /api/v1/query answers 403 delegation_not_supported for any aiosd bearer", async () => {
    const seed = await seedTeam();
    const res = await fetch(`${BASE_URL}/api/v1/query`, {
      method: "POST",
      headers: { ...keyHeaders("aiosd_deadbeef_bogus", seed.teamSlug), "Content-Type": "application/json" },
      body: JSON.stringify({ question: "anything" }),
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("delegation_not_supported");
  });

  it("POST /api/v1/items rejects an aiosd bearer (401 — writes are not on the Phase A surface)", async () => {
    const seed = await seedTeam();
    const { token } = await seedAgentWithItem(seed);
    const res = await fetch(`${BASE_URL}/api/v1/items`, {
      method: "POST",
      headers: { ...keyHeaders(token, seed.teamSlug), "Content-Type": "application/json" },
      body: JSON.stringify({ items: [] }),
    });
    expect(res.status).toBe(401);
  });
});
