import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import {
  db, seedTeam, ingest, externalMember, placeMemberByTier, convergeIdentityAttribution, type Seed,
} from "./helpers";
import { issueApiKey } from "@/lib/admin/keys";
import { backfillTeamContext } from "@/lib/projects/context/backfill";
import { ensureAccessBootstrap, EXTERNAL_SHARED_SLUG, GENERAL_SLUG } from "@/lib/access/bootstrap";
import { createGroup, grantProjectToGroup, addMemberToGroup } from "@/lib/access/groups";
import { projectGroupId } from "@/lib/graph/group";
import { episodeName } from "@/lib/graph/episode-name";
import { runSql } from "@/lib/db/pg/pool";

// AIO-1167: the POSITIVE path of the provenance-complete graph read. The unavailable arms (no
// Neo4j → 503, no provider request) stay pinned in enfb-graph-query-scope; this file proves that a
// configured graph actually serves authorized facts through the real route, with the oracle's
// partition scope and item authorization read from real Postgres. Only the Neo4j transport is
// controlled: an in-memory graph that honours the `$groups` / `$uuids` scope each query carries, and
// records every scope it was asked for. Provenance-free Graphiti `/search` is never involved.

type Edge = { id: string; fact: string; at: string; groupId: string; episodeUuids: string[] };
type Episode = { uuid: string; groupId: string; name: string };

const graph = vi.hoisted(() => ({
  edges: [] as Edge[],
  episodes: [] as Episode[],
  factScopes: [] as string[][],
  episodeScopes: [] as string[][],
}));

vi.mock("@/lib/graph/neo4j", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/graph/neo4j")>()),
  neo4jConfigured: () => true,
  runRead: async (cypher: string, params: Record<string, unknown> = {}) => {
    const groups = (params.groups as string[] | undefined) ?? [];
    if (cypher.includes("RELATES_TO")) {
      graph.factScopes.push([...groups].sort());
      const terms = (params.terms as string[] | undefined) ?? [];
      const rows = graph.edges
        .filter((edge) => groups.includes(edge.groupId))
        .filter((edge) => terms.length === 0 || terms.some((term) => edge.fact.toLowerCase().includes(term)))
        .sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id));
      const offset = Number(params.offset ?? 0);
      const limit = Number(params.limit ?? rows.length);
      return rows.slice(offset, offset + limit).map((edge) => ({
        id: edge.id, fact: edge.fact, at: edge.at, subjectType: "Person", subject: "Alex",
        object: "payments", episodeUuids: edge.episodeUuids, groupId: edge.groupId,
      }));
    }
    if (cypher.includes("Episodic")) {
      graph.episodeScopes.push([...groups].sort());
      const uuids = (params.uuids as string[] | undefined) ?? [];
      return graph.episodes
        .filter((episode) => groups.includes(episode.groupId) && uuids.includes(episode.uuid))
        .map((episode) => ({ uuid: episode.uuid, name: episode.name, source: "notion" }));
    }
    throw new Error(`unexpected graph read in this suite: ${cypher.slice(0, 80)}`);
  },
}));

beforeEach(() => {
  graph.edges = [];
  graph.episodes = [];
  graph.factScopes = [];
  graph.episodeScopes = [];
});

async function seedMember(seed: Seed): Promise<string> {
  const { data } = await db()
    .from("members")
    .insert({
      team_id: seed.teamId, email: `${randomUUID()}@test.local`, display_name: "M",
      actor_handle: `h-${randomUUID().slice(0, 10)}`, role: "member", tier: "team", status: "active",
    })
    .select("id")
    .single();
  await placeMemberByTier(seed.teamId, data!.id as string, "team");
  return data!.id as string;
}

async function moveInto(seed: Seed, itemId: string, projectId: string): Promise<void> {
  const { data: unit } = await db().from("project_context_units").select("id").eq("source_item_id", itemId).single();
  await db().from("project_context_memberships").update({ valid_to: new Date().toISOString() })
    .eq("context_unit_id", unit!.id).is("valid_to", null);
  await db().from("project_context_memberships").insert({
    team_id: seed.teamId, project_id: projectId, context_unit_id: unit!.id, method: "manual",
  });
}

async function initiative(seed: Seed): Promise<{ id: string; group: string }> {
  const { data: project } = await db().from("projects").insert({
    team_id: seed.teamId, slug: `init-${randomUUID().slice(0, 6)}`, name: "I", kind: "initiative",
  }).select("id").single();
  const id = project!.id as string;
  const group = projectGroupId(seed.teamId, id);
  await runSql("update projects set graph_group_id = $1 where id = $2", [group, id]);
  return { id, group };
}

async function systemGroup(seed: Seed, slug: string): Promise<string> {
  const { data } = await db().from("projects").select("graph_group_id")
    .eq("team_id", seed.teamId).eq("slug", slug).single();
  return (data as { graph_group_id: string }).graph_group_id;
}

async function post(seed: Seed, memberId: string): Promise<{ status: number; ids: string[]; body: Record<string, unknown> }> {
  const { POST } = await import("@/app/api/v1/graph-query/route");
  const { key } = await issueApiKey(db(), seed.teamId, memberId, "gq-provenance");
  const req = new Request("http://test/api/v1/graph-query", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ query: "who owns payments?", maxFacts: 50 }),
  }) as unknown as NextRequest;
  const res = await POST(req);
  const body = await res.json() as Record<string, unknown>;
  const facts = (body.facts as Array<{ uuid: string }> | undefined) ?? [];
  return { status: res.status, ids: facts.map((fact) => fact.uuid).sort(), body };
}

describe("AIO-1167 provenance-complete graph read — positive path (real Postgres, controlled Neo4j)", () => {
  it("serves authorized facts and keeps granted, ungranted and external partitions distinct", async () => {
    const seed = await seedTeam();
    const teamItem = await ingest(seed, { path: "team.md", body: "team payments", access: "team", project: "src" });
    const externalItem = await ingest(seed, { path: "ext.md", body: "external payments", access: "external", project: "src-ext" });
    const grantedItem = await ingest(seed, { path: "granted.md", body: "granted payments", access: "team", project: "src" });
    const ungrantedItem = await ingest(seed, { path: "ungranted.md", body: "ungranted payments", access: "team", project: "src" });
    expect((await ensureAccessBootstrap(db(), seed.teamId)).ok).toBe(true);
    await backfillTeamContext(db(), seed.teamId);
    const member = await seedMember(seed);

    // A granted, armed and ready initiative (the leak-suite's fixture shape), and one never granted.
    const granted = await initiative(seed);
    const grp = await createGroup(db(), seed.teamId, `ig-${randomUUID().slice(0, 6)}`, "IG", seed.memberId);
    await addMemberToGroup(db(), seed.teamId, grp.groupId!, member, seed.memberId);
    await grantProjectToGroup(db(), seed.teamId, granted.id, grp.groupId!, seed.memberId);
    await moveInto(seed, grantedItem.id, granted.id);
    const { armProjectsForPrincipal } = await import("@/lib/graph/arming");
    await armProjectsForPrincipal(db(), { teamId: seed.teamId, projectIds: [granted.id] });
    await runSql(
      "update graph_episodes set content_sha256 = 'x', episode_uuid = 'ep-ready' where team_id = $1 and group_id = $2",
      [seed.teamId, granted.group],
    );
    const ungranted = await initiative(seed);
    await moveInto(seed, ungrantedItem.id, ungranted.id);

    const general = await systemGroup(seed, GENERAL_SLUG);
    const externalShared = await systemGroup(seed, EXTERNAL_SHARED_SLUG);
    const at = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
    const episode = (uuid: string, groupId: string, itemId: string) =>
      graph.episodes.push({ uuid, groupId, name: episodeName(itemId, 0, 1) });
    episode("ep-team", general, teamItem.id);
    episode("ep-granted", granted.group, grantedItem.id);
    episode("ep-ungranted", ungranted.group, ungrantedItem.id);
    // The same restricted item, recorded under the granted partition: it is not in that partition.
    episode("ep-ungranted-in-granted", granted.group, ungrantedItem.id);
    episode("ep-external", externalShared, externalItem.id);
    // Team content recorded under external-shared: not external-shared's content.
    episode("ep-team-in-external", externalShared, teamItem.id);
    graph.edges.push(
      { id: "f-team", fact: "Alex owns payments (team)", at: at(1), groupId: general, episodeUuids: ["ep-team"] },
      { id: "f-granted", fact: "Alex owns payments (granted)", at: at(2), groupId: granted.group, episodeUuids: ["ep-granted"] },
      { id: "f-ungranted", fact: "Alex owns payments (ungranted)", at: at(3), groupId: ungranted.group, episodeUuids: ["ep-ungranted"] },
      {
        id: "f-laundered", fact: "Alex owns payments (laundered)", at: at(4), groupId: granted.group,
        episodeUuids: ["ep-granted", "ep-ungranted-in-granted"],
      },
      { id: "f-external", fact: "Alex owns payments (external)", at: at(5), groupId: externalShared, episodeUuids: ["ep-external"] },
      {
        id: "f-team-as-external", fact: "Alex owns payments (team as external)", at: at(6), groupId: externalShared,
        episodeUuids: ["ep-team-in-external"],
      },
    );

    // The raw roster write above leaves identity attribution repair pending, and the authorization
    // epoch refuses to serve until it converges — exactly as `externalMember` already does below.
    await convergeIdentityAttribution(seed);

    // The member: authorized facts from General and the granted initiative survive.
    const forMember = await post(seed, member);
    expect(forMember.status, JSON.stringify(forMember.body)).toBe(200);
    expect(forMember.ids).toEqual(expect.arrayContaining(["f-team", "f-granted"]));
    // Never the ungranted partition, never a fact one of whose sources is outside its partition.
    for (const hidden of ["f-ungranted", "f-laundered", "f-team-as-external"]) {
      expect(forMember.ids).not.toContain(hidden);
    }
    expect(forMember.body.incomplete).toBe(false);
    // The ungranted partition was never even asked about.
    expect([...graph.factScopes, ...graph.episodeScopes].flat()).not.toContain(ungranted.group);
    expect(graph.factScopes.flat()).toEqual(expect.arrayContaining([general, granted.group]));

    // The external member: external-shared's authorized fact only, from its scope only.
    graph.factScopes = [];
    graph.episodeScopes = [];
    const external = await externalMember(seed);
    const forExternal = await post(seed, external);
    expect(forExternal.status, JSON.stringify(forExternal.body)).toBe(200);
    expect(forExternal.ids).toEqual(["f-external"]);
    const asked = new Set([...graph.factScopes, ...graph.episodeScopes].flat());
    expect([...asked]).toEqual([externalShared]);
  });
});
