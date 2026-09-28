import { describe, expect, it, vi, afterEach } from "vitest";
import { createGovernedActionService } from "@/lib/actions/governed";
import { noteConsumer } from "@/lib/actions/governed/consumers/note";
import { canSeeItem, visibleItemIds } from "@/lib/access/enforce";
import { backfillTeamContext } from "@/lib/projects/context/backfill";
import { reconcileItemContext } from "@/lib/projects/context/reconcile-item";
import { rankedFtsSearch } from "@/lib/query/fts-search";
import { retrieve } from "@/lib/query/retrieve";
import { projectItemsToGraph, MAX_EPISODE_CHUNKS } from "@/lib/graph/project";
import { db } from "./helpers";
import { FakeGraphiti, client } from "./fake-graphiti";
import { noteFixture, noteMember, noteRequest, noteSql } from "./note-fixture";

const service = () => createGovernedActionService({ consumers: [noteConsumer], enabled: () => true });
afterEach(() => vi.unstubAllEnvs());

describe("note retrieval and projection with real Postgres", () => {
  it("retrieves exact note content by title or body using the member's current visibility", async () => {
    vi.stubEnv("GRAPHITI_URL", "");
    vi.stubEnv("CONTEXT_PROVIDER", "native");
    vi.stubEnv("EMBEDDINGS_URL", "");
    const f = await noteFixture();
    const request = noteRequest(f.projectId, "Zephyrlantern planning", "The body mentions obsidianharbor.");
    const result = await service().submit(f.auth, request);
    if (result.status !== "succeeded") throw new Error(result.status);
    const view = await visibleItemIds(db(), { teamId: f.teamId, memberId: f.memberId });
    expect(view.error).toBeFalsy();
    expect(view.ids.has(result.entity.id)).toBe(true);
    for (const term of ["Zephyrlantern", "obsidianharbor"]) {
      const hits = await rankedFtsSearch(f.teamId, "team", term, 20, null, [...view.ids], { metadata: true });
      expect(hits).toEqual(expect.arrayContaining([expect.objectContaining({ id: result.entity.id, kind: "note", body: request.params.body, title: request.params.title })]));
      const retrieved = await retrieve(db(), f.teamId, "team", term, f.projectSlug, {
        visibleItemIds: view.ids, principal: "member", graphProjectIds: view.projectIds,
      });
      expect(retrieved.sources).toEqual(expect.arrayContaining([expect.objectContaining({ item_id: result.entity.id, kind: "note" })]));
    }
  });

  it("never grants a General-only member visibility, including after reconcile/backfill", async () => {
    const f = await noteFixture();
    const reader = await noteMember(f);
    const result = await service().submit(f.auth, f.request);
    if (result.status !== "succeeded") throw new Error(result.status);
    const principal = { teamId: f.teamId, memberId: reader.id };
    const check = async () => {
      expect(await canSeeItem(db(), { teamId: f.teamId, memberId: f.memberId }, result.entity.id)).toBe(true);
      expect(await canSeeItem(db(), principal, result.entity.id)).toBe(false);
      const view = await visibleItemIds(db(), principal);
      expect(await rankedFtsSearch(f.teamId, "team", "note", 20, null, [...view.ids])).toEqual([]);
      const placements = await noteSql(`select m.project_id from project_context_memberships m
        join project_context_units u on u.id=m.context_unit_id
        where u.source_item_id=$1 and m.valid_to is null and m.decision='include'`, [result.entity.id]);
      expect(placements.rows.map((r) => r.project_id)).toEqual([f.projectId]);
    };
    await check();
    expect(await reconcileItemContext(db(), f.teamId, result.entity.id)).toMatchObject({ ok: true });
    expect(await backfillTeamContext(db(), f.teamId)).toMatchObject({ ok: true });
    await check();
  });

  it("refuses a team note in an externally visible destination with no partial item", async () => {
    const f = await noteFixture();
    await noteSql(`insert into project_groups(team_id,project_id,group_id)
      select $1,$2,id from groups where team_id=$1 and slug='external'`, [f.teamId, f.projectId]);
    expect(await service().submit(f.auth, f.request)).toMatchObject({ status: "denied", error: { code: "forbidden" } });
    expect((await noteSql("select count(*)::int n from items where team_id=$1", [f.teamId])).rows[0].n).toBe(0);
  });

  it("projects initially and after a sweep only into the destination, without duplicate extraction", async () => {
    const f = await noteFixture();
    const result = await service().submit(f.auth, f.request);
    if (result.status !== "succeeded") throw new Error(result.status);
    const group = (await noteSql("select graph_group_id from projects where id=$1", [f.projectId])).rows[0].graph_group_id;
    const fake = new FakeGraphiti();
    await projectItemsToGraph(db(), { teamId: f.teamId, teamSlug: f.teamSlug, client: client(fake) });
    expect(fake.pushes).toHaveLength(0); // Cold destinations retain deferred extraction.
    expect((await noteSql("select group_id,deferred from graph_episodes where source_id=$1", [result.entity.id])).rows)
      .toEqual([{ group_id: group, deferred: true }]);
    await noteSql("update graph_episodes set deferred=false where source_id=$1", [result.entity.id]);
    await projectItemsToGraph(db(), { teamId: f.teamId, teamSlug: f.teamSlug, client: client(fake) });
    expect(fake.pushes.length).toBeGreaterThan(0);
    expect(new Set(fake.pushes.map((p) => p.groupId))).toEqual(new Set([group]));
    expect(fake.pushedEpisodes.some((e) => e.sourceDescription.includes("Note"))).toBe(true);
    const firstPushCount = fake.pushes.length;
    expect(await service().submit(f.auth, f.request)).toEqual(result);
    expect(await backfillTeamContext(db(), f.teamId)).toMatchObject({ ok: true });
    await projectItemsToGraph(db(), { teamId: f.teamId, teamSlug: f.teamSlug, client: client(fake) });
    expect(fake.pushes).toHaveLength(firstPushCount);
    expect((await noteSql("select distinct group_id from graph_episodes where source_id=$1", [result.entity.id])).rows.map((r) => r.group_id)).toEqual([group]);
  });

  it("bounds maximum note extraction while preserving the tail sentinel", async () => {
    const f = await noteFixture();
    const tail = " LAST_NOTE_TOKEN!";
    const body = "x".repeat(25000 - tail.length) + tail;
    expect([...body].length).toBe(25000);
    const result = await service().submit(f.auth, noteRequest(f.projectId, "Maximum note", body));
    if (result.status !== "succeeded") throw new Error(result.status);
    const fake = new FakeGraphiti();
    await projectItemsToGraph(db(), { teamId: f.teamId, teamSlug: f.teamSlug, client: client(fake) });
    await noteSql("update graph_episodes set deferred=false where source_id=$1", [result.entity.id]);
    await projectItemsToGraph(db(), { teamId: f.teamId, teamSlug: f.teamSlug, client: client(fake) });
    expect(fake.pushedEpisodes.length).toBeGreaterThan(0);
    expect(fake.pushedEpisodes.length).toBeLessThanOrEqual(MAX_EPISODE_CHUNKS);
    expect(fake.pushedEpisodes.map((e) => e.content).join("")).toContain("LAST_NOTE_TOKEN!");
  });
});
