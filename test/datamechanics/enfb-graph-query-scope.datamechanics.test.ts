import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import { db, seedTeam, ingest, type Seed } from "./helpers";
import { issueApiKey } from "@/lib/admin/keys";
import { backfillTeamContext } from "@/lib/projects/context/backfill";
import { ensureAccessBootstrap } from "@/lib/access/bootstrap";
import { createGroup, grantProjectToGroup, addMemberToGroup } from "@/lib/access/groups";
import { projectGroupId } from "@/lib/graph/group";
import { runSql } from "@/lib/db/pg/pool";

// ENFB-1 AC4 (docs/design/enfb1-body-surfaces-oracle-gate.md §1 graph-query row): the route
// cuts to the ORACLE's stored-pointer partitions. The POSITIVE arm pins the design round-1
// blocker (a stock everyone-member still reaches the grandfathered `<slug>_team` pointer — the
// naive minting swap would have silently emptied the route); the scoped arms pin granted-in /
// ungranted-out; the LOUD arm pins missing-system-pointer = 500, never ordinary empty.

const GRAPH_URL = "http://graphiti.test";

function stubGraphiti() {
  const requests: { group_ids: string[] }[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === `${GRAPH_URL}/search`) {
      requests.push(JSON.parse(String(init?.body)) as { group_ids: string[] });
      return new Response(JSON.stringify({ facts: [{ fact: "stub fact", valid_at: "2026-08-18T00:00:00Z" }] }), { status: 200 });
    }
    return new Response(JSON.stringify({}), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchImpl);
  vi.stubEnv("GRAPHITI_URL", GRAPH_URL);
  return { requests };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function post(seed: Seed, memberId: string): Promise<{ status: number; body: unknown; requests: { group_ids: string[] }[] }> {
  const { POST } = await import("@/app/api/v1/graph-query/route");
  const { key } = await issueApiKey(db(), seed.teamId, memberId, "gq");
  const { requests } = stubGraphiti();
  const req = new Request("http://test/api/v1/graph-query", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ query: "who owns payments?" }),
  }) as unknown as NextRequest;
  const res = await POST(req);
  return { status: res.status, body: await res.json(), requests };
}

async function seedMember(seed: Seed): Promise<string> {
  const { data } = await db()
    .from("members")
    .insert({ team_id: seed.teamId, email: `${randomUUID()}@test.local`, display_name: "M", actor_handle: `h-${randomUUID().slice(0, 10)}`, role: "member", tier: "team", status: "active" })
    .select("id")
    .single();
  const { placeMemberByTier } = await import("./helpers");
  await placeMemberByTier(seed.teamId, data!.id as string, "team");
  return data!.id as string;
}

describe("ENFB-1 AC4 — graph-query serves the oracle's STORED-pointer partitions", () => {
  it("a stock everyone-member reaches the grandfathered <slug>_team pointer (the silently-empty blocker's positive pin); an ungranted initiative's pointer never appears", async () => {
    const seed = await seedTeam();
    await ingest(seed, { path: "g.md", body: "graph seed", access: "team", project: "src" });
    expect((await ensureAccessBootstrap(db(), seed.teamId)).ok).toBe(true);
    await backfillTeamContext(db(), seed.teamId);
    const member = await seedMember(seed);

    // An initiative the member is NOT granted, with an armed, ready pointer.
    const { data: proj } = await db().from("projects").insert({ team_id: seed.teamId, slug: `init-${randomUUID().slice(0, 6)}`, name: "I", kind: "initiative" }).select("id").single();
    const g = projectGroupId(seed.teamId, proj!.id as string);
    await runSql("update projects set graph_group_id = $1 where id = $2", [g, proj!.id]);

    const r = await post(seed, member);
    expect(r.status).toBe(200);
    expect(r.requests).toHaveLength(1);
    const groups = r.requests[0].group_ids;
    expect(groups, "the grandfathered team pointer must be present").toContain(`${seed.teamSlug}_team`);
    expect(groups, "an ungranted initiative's partition must never appear").not.toContain(g);
  });

  it("a GRANTED armed initiative's pointer joins the member's scope", async () => {
    const seed = await seedTeam();
    const item = await ingest(seed, { path: "i.md", body: "init content", access: "team", project: "src" });
    expect((await ensureAccessBootstrap(db(), seed.teamId)).ok).toBe(true);
    await backfillTeamContext(db(), seed.teamId);
    const member = await seedMember(seed);

    const { data: proj } = await db().from("projects").insert({ team_id: seed.teamId, slug: `init-${randomUUID().slice(0, 6)}`, name: "I", kind: "initiative" }).select("id").single();
    const gid = projectGroupId(seed.teamId, proj!.id as string);
    await runSql("update projects set graph_group_id = $1 where id = $2", [gid, proj!.id]);
    const grp = await createGroup(db(), seed.teamId, `ig-${randomUUID().slice(0, 6)}`, "IG", seed.memberId);
    await addMemberToGroup(db(), seed.teamId, grp.groupId!, member, seed.memberId);
    await grantProjectToGroup(db(), seed.teamId, proj!.id as string, grp.groupId!, seed.memberId);
    // Move content in + arm + confirm readiness (the leak-suite's fixture shape).
    const { data: unit } = await db().from("project_context_units").select("id").eq("source_item_id", item.id).single();
    await db().from("project_context_memberships").update({ valid_to: new Date().toISOString() }).eq("context_unit_id", unit!.id).is("valid_to", null);
    await db().from("project_context_memberships").insert({ team_id: seed.teamId, project_id: proj!.id as string, context_unit_id: unit!.id, method: "manual" });
    const { armProjectsForPrincipal } = await import("@/lib/graph/arming");
    await armProjectsForPrincipal(db(), { teamId: seed.teamId, projectIds: [proj!.id as string] });
    await runSql("update graph_episodes set content_sha256 = 'x', episode_uuid = 'ep-1' where team_id = $1 and group_id = $2", [seed.teamId, gid]);

    const r = await post(seed, member);
    expect(r.status).toBe(200);
    expect(r.requests[0].group_ids, "the granted armed initiative joins the scope").toContain(gid);
  });

  it("LOUD: a member with a visible SYSTEM project whose stored pointer is MISSING gets 500, never ordinary empty facts", async () => {
    const seed = await seedTeam();
    await ingest(seed, { path: "l.md", body: "x", access: "team", project: "src" });
    expect((await ensureAccessBootstrap(db(), seed.teamId)).ok).toBe(true);
    await backfillTeamContext(db(), seed.teamId);
    const member = await seedMember(seed);
    // Sever the stored pointers — the wiring fault the loud arm exists for.
    await runSql("update projects set graph_group_id = null where team_id = $1 and kind = 'system'", [seed.teamId]);

    const r = await post(seed, member);
    expect(r.status, "missing system pointers must be LOUD").toBe(500);
  });
});

describe("ENFB-1 AC4 — the external member's scope (the graph-tier route arms' successor)", () => {
  it("an external-posture member resolves exactly external-shared's grandfathered pointer", async () => {
    const seed = await seedTeam();
    await ingest(seed, { path: "e.md", body: "ext", access: "external", project: "src" });
    expect((await ensureAccessBootstrap(db(), seed.teamId)).ok).toBe(true);
    await backfillTeamContext(db(), seed.teamId);
    const { externalMember } = await import("./helpers");
    const ext = await externalMember(seed);

    const r = await post(seed, ext);
    expect(r.status).toBe(200);
    expect(r.requests).toHaveLength(1);
    expect(r.requests[0].group_ids, "exactly the external-shared legacy pointer — never the team partition").toEqual([`${seed.teamSlug}_external`]);
  });
});
