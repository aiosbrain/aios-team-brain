import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { getPool } from "@/lib/db/pg/pool";
import { authenticateApiKey } from "@/lib/api/auth";
import { createGovernedActionService } from "@/lib/actions/governed";
import { decisionConsumer } from "@/lib/actions/governed/consumers/decision";
import { ensureAccessBootstrap } from "@/lib/access/bootstrap";
import { purgeItemIds, purgeItemsByPathPrefix } from "@/lib/ingest/purge";
import { ImmutableOriginError } from "@/lib/ingest/governed-origin";
import { IN_CLAUSE_BATCH } from "@/lib/db/batch";
import type { GraphitiClient } from "@/lib/graph/graphiti-client";
import { db, seedTeam, ingest, sha } from "./helpers";

const sql = (q: string, values: unknown[] = []) => getPool().query(q, values);
async function fixture() {
  const seed = await seedTeam();
  expect((await ensureAccessBootstrap(db(), seed.teamId)).ok).toBe(true);
  await sql("update members set role='admin' where id=$1", [seed.memberId]);
  const project = (await sql("select id,graph_group_id from projects where team_id=$1 and kind='system' and slug='general'", [seed.teamId])).rows[0];
  await sql("insert into policies(team_id,action,resource,effect) values($1,'decision.record','*','allow')", [seed.teamId]);
  const keyId = randomUUID().replaceAll("-", "");
  await sql("insert into api_keys(team_id,member_id,key_id,key_hash) values($1,$2,$3,$4)", [seed.teamId, seed.memberId, keyId, sha("synthetic")]);
  const auth = (await authenticateApiKey(new Request("http://local", { headers: { authorization: `Bearer aios_${keyId}_synthetic` } }), { recordUsage: false, preserveErrors: true }))!;
  const result = await createGovernedActionService({ consumers: [decisionConsumer], enabled: () => true }).submit(auth, {
    contract_version: "mcp-next/1", type: "decision.record", destination: { project_id: project.id },
    params: { operation_id: randomUUID(), title: "Keep this canonical decision", rationale: "Its accepted rationale must remain in the graph and database.", impact: "" },
  });
  expect(result.status).toBe("succeeded");
  const decision = (await sql("select * from decisions where team_id=$1", [seed.teamId])).rows[0];
  const regular = await ingest(seed, { path: "2-work/ordinary.md", body: "ordinary content", access: "team" });
  const episodes = [decision.source_item_id, regular.id].map(id => ({ uuid: randomUUID(), name: `items:${id}` }));
  for (const [index, id] of [decision.source_item_id, regular.id].entries()) {
    await sql("insert into graph_episodes(team_id,source_table,source_id,group_id,content_sha256,episode_uuid) values($1,'items',$2,$3,$4,$5)", [seed.teamId, id, project.graph_group_id, sha("projected"), episodes[index].uuid]);
  }
  const listEpisodes = vi.fn(async () => episodes);
  const deleteEpisode = vi.fn(async () => {});
  const client = { configured: true, listEpisodes, deleteEpisode } as unknown as GraphitiClient;
  return { seed, decision, regular, client, listEpisodes, deleteEpisode };
}
async function snapshot(teamId: string) {
  const out: Record<string, unknown> = {};
  for (const table of ["items", "decisions", "governed_item_origins", "graph_episodes", "audit_log"]) {
    out[table] = (await sql(`select * from ${table} where team_id=$1 order by 1`, [teamId])).rows;
  }
  out.versions = (await sql("select v.* from item_versions v join items i on i.id=v.item_id where i.team_id=$1 order by v.id", [teamId])).rows;
  return out;
}

describe("governed source purge preflight", () => {
  it.each(["id", "prefix", "mixed-late-batch"])("refuses %s selection before provider or database effects", async mode => {
    const f = await fixture();
    const before = await snapshot(f.seed.teamId);
    const ids = mode === "mixed-late-batch"
      ? [f.regular.id, ...Array.from({ length: IN_CLAUSE_BATCH - 1 }, () => randomUUID()), f.decision.source_item_id]
      : [f.decision.source_item_id];
    const purge = mode === "prefix"
      ? purgeItemsByPathPrefix(db(), f.seed.teamId, "1-inbox/governed/", "purge probe", { client: f.client })
      : purgeItemIds(db(), f.seed.teamId, ids, "purge probe", { client: f.client });
    await expect(purge).rejects.toThrow(ImmutableOriginError);
    expect(f.listEpisodes).not.toHaveBeenCalled();
    expect(f.deleteEpisode).not.toHaveBeenCalled();
    expect(await snapshot(f.seed.teamId)).toEqual(before);
  });

  it("does not treat another team's origin as protection for an ordinary local selection", async () => {
    const f = await fixture();
    const other = await seedTeam();
    const ordinary = await ingest(other, { path: "ordinary.md", body: "remove local ordinary", access: "team" });
    await expect(purgeItemIds(db(), other.teamId, [f.decision.source_item_id, ordinary.id], "local purge", { client: f.client })).resolves.toMatchObject({ episodes: 0 });
    expect((await sql("select id from items where id=$1", [ordinary.id])).rows).toEqual([]);
    expect((await sql("select id from items where id=$1", [f.decision.source_item_id])).rows).toHaveLength(1);
    expect(f.listEpisodes).not.toHaveBeenCalled();
    expect(f.deleteEpisode).not.toHaveBeenCalled();
  });
});
