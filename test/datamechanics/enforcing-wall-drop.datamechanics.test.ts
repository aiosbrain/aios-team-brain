import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { db, ingest, seedTeam, type Seed } from "./helpers";
import { GET as itemsGET } from "@/app/api/v1/items/route";
import { issueApiKey } from "@/lib/admin/keys";
import { createMember } from "@/lib/admin/members";
import { createGroup, addMemberToGroup, grantProjectToGroup } from "@/lib/access/groups";
import { setAccessEnforcement } from "@/lib/admin/access-enforcement";
import { backfillTeamContext } from "@/lib/projects/context/backfill";
import { visibleItemIds } from "@/lib/access/enforce";
import { retrieve } from "@/lib/query/retrieve";

// PRET-4 AC2 (docs/design/pret4-tier-wall-teardown.md §4.2): the ENFORCING wall-conjunct drop —
// ruling 2 lands. An external member granted project X reads X's access='team' rows through the
// v1 items route and the retrieve item legs (the legacy conjunct was the ONLY thing blocking
// this); sees NOTHING of project Y (absence, mutation-verified in the PR); and a delegated
// token's posture is untouched. TERMs are rare words so FTS grounds deterministically.

const TERM_X = "quixoticmarble";
const TERM_Y = "zephyrgranite";

async function seedEnforcedTeamWithExternalMember(): Promise<{
  seed: Seed;
  external: string;
  projectXId: string;
}> {
  const seed = await seedTeam();
  const x = await ingest(seed, { path: "x.md", body: `alpha ${TERM_X}`, access: "team", project: "src" });
  await ingest(seed, { path: "y.md", body: `beta ${TERM_Y}`, access: "team", project: "src" });
  await backfillTeamContext(db(), seed.teamId);

  // Move x.md into a restricted initiative (the established vault pattern — the backfill homes
  // team items under General, so the grantable project must receive the membership explicitly).
  const restricted = await db()
    .from("projects")
    .insert({ team_id: seed.teamId, slug: "proj-x", name: "Project X", kind: "initiative" })
    .select("id")
    .single();
  const projectXId = restricted.data!.id as string;
  const { data: unit } = await db().from("project_context_units").select("id").eq("source_item_id", x.id).single();
  await db()
    .from("project_context_memberships")
    .update({ valid_to: new Date().toISOString() })
    .eq("context_unit_id", unit!.id);
  await db()
    .from("project_context_memberships")
    .insert({ team_id: seed.teamId, project_id: projectXId, context_unit_id: unit!.id, method: "manual" });

  const flip = await setAccessEnforcement(db(), seed.teamId, "enforcing");
  expect(flip.ok, flip.error).toBe(true);

  const m = await createMember(db(), seed.teamId, {
    email: `${randomUUID()}@test.local`,
    displayName: "Collaborator",
    actorHandle: `c-${randomUUID().slice(0, 8)}`,
    role: "member",
    tier: "external",
  });
  await db().from("members").update({ status: "active" }).eq("id", m.id).eq("team_id", seed.teamId);

  // Deliberate membership: a group granted project X, with the external member in it.
  const g = await createGroup(db(), seed.teamId, "clients-x", "Clients X", seed.memberId);
  expect(g.ok, g.error).toBe(true);
  const add = await addMemberToGroup(db(), seed.teamId, g.groupId!, m.id, seed.memberId);
  expect(add.ok, add.error).toBe(true);
  const grant = await grantProjectToGroup(db(), seed.teamId, projectXId, g.groupId!, seed.memberId);
  expect(grant.ok, grant.error).toBe(true);
  return { seed, external: m.id, projectXId };
}

describe("PRET-4 AC2 — an external member's membership serves team rows of granted projects (enforcing)", () => {
  it("v1 items GET: X's access='team' item is served; Y's is absent (the wall conjunct is gone; the oracle is the gate)", async () => {
    const { seed, external } = await seedEnforcedTeamWithExternalMember();
    const { key } = await issueApiKey(db(), seed.teamId, external, "test");
    const req = new NextRequest("http://test.local/api/v1/items?all=1", {
      headers: { authorization: `Bearer ${key}` },
    });
    const res = await itemsGET(req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ path: string; access: string }> };
    const paths = body.items.map((i) => i.path);
    expect(paths, "ruling 2: the granted project's team row is served").toContain("x.md");
    expect(paths, "the ungranted project's row is absent").not.toContain("y.md");
  });

  it("retrieve item/fts legs: the external member's enforced read grounds X's team item, never Y's", async () => {
    const { seed, external } = await seedEnforcedTeamWithExternalMember();
    const vis = await visibleItemIds(db(), { teamId: seed.teamId, memberId: external });
    const enforce = { visibleItemIds: vis.ids, principal: "member" as const };
    // The boundary passes POSTURE — for this member, "external". Pre-PRET-4 that value alone
    // forced access='external' on every leg and served NOTHING; now the oracle decides.
    const ctx = await retrieve(db(), seed.teamId, "external", `tell me about ${TERM_X}`, null, enforce);
    const paths = ctx.sources.map((s) => s.path);
    expect(paths, "the granted team row grounds the answer").toContain("x.md");

    const ctxY = await retrieve(db(), seed.teamId, "external", `tell me about ${TERM_Y}`, null, enforce);
    expect(ctxY.sources.map((s) => s.path), "the ungranted project never grounds").not.toContain("y.md");
  });

  it("a delegated token's read stays attenuated — the wall drop never widens tokens", async () => {
    const { seed } = await seedEnforcedTeamWithExternalMember();
    // Token semantics are pinned extensively in access-agent-tokens dm; here the AC2 arm:
    // a token-principal enforce gets no org-structural legs regardless of the posture value.
    const enforce = { visibleItemIds: [] as string[], principal: "token" as const };
    const ctx = await retrieve(db(), seed.teamId, "team", `who reports to whom`, null, enforce);
    expect(ctx.sources.length).toBe(0);
    expect(JSON.stringify(ctx.structured ?? {})).not.toMatch(/REPORTS_TO/);
  });
});
