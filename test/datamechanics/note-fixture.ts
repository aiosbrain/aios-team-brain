import { randomUUID } from "node:crypto";
import { authenticateApiKey } from "@/lib/api/auth";
import { issueApiKey } from "@/lib/admin/keys";
import { ensureAccessBootstrap } from "@/lib/access/bootstrap";
import { ensureProjectGraphPointer } from "@/lib/graph/project-pointer";
import { getPool } from "@/lib/db/pg/pool";
import type { SubmitRequest } from "@/lib/actions/governed/contract";
import { db, placeMemberByTier, seedTeam, type Seed } from "./helpers";

export const noteSql = (text: string, values: unknown[] = []) => getPool().query(text, values);
export type NoteRequest = Extract<SubmitRequest, { type: "note.append" }>;

export function noteRequest(projectId: string, title = "Note title", body = "Note body"): NoteRequest {
  return { contract_version: "mcp-next/1", type: "note.append", destination: { project_id: projectId }, params: { title, body } };
}

export async function noteKey(seed: Seed, memberId = seed.memberId) {
  const { key } = await issueApiKey(db(), seed.teamId, memberId, "Disposable note fixture");
  const headers = { Authorization: `Bearer ${key}`, "X-AIOS-Team": seed.teamSlug, "Content-Type": "application/json" };
  const auth = await authenticateApiKey(new Request("http://fixture.local", { headers }), {
    recordUsage: false, preserveErrors: true,
  });
  if (!auth) throw new Error("fixture credential did not authenticate");
  return { key, headers, auth };
}

export async function noteMember(seed: Seed, role = "member", tier = "team") {
  const id = randomUUID();
  await noteSql(
    "insert into members(id,team_id,email,display_name,actor_handle,role,tier,status) values($1,$2,$3,'Note reader',$4,$5,$6,'active')",
    [id, seed.teamId, `${id}@test.local`, `reader-${id.slice(0, 8)}`, role, tier],
  );
  await placeMemberByTier(seed.teamId, id, tier);
  return { id, ...(await noteKey(seed, id)) };
}

export async function noteProject(seed: Seed, groupId: string) {
  const id = randomUUID();
  const slug = `notes-${id.slice(0, 8)}`;
  await noteSql("insert into projects(id,team_id,slug,name,kind) values($1,$2,$3,'Note destination','initiative')", [id, seed.teamId, slug]);
  const pointer = await ensureProjectGraphPointer(db(), { teamId: seed.teamId, projectId: id });
  if (!pointer.ok) throw new Error(pointer.error);
  await noteSql("insert into project_groups(team_id,project_id,group_id) values($1,$2,$3)", [seed.teamId, id, groupId]);
  return { id, slug };
}

export async function noteFixture(effect = "allow") {
  const seed = await seedTeam();
  const bootstrap = await ensureAccessBootstrap(db(), seed.teamId);
  if (!bootstrap.ok) throw new Error(bootstrap.error);
  const groupId = randomUUID();
  await noteSql("insert into groups(id,team_id,slug,name) values($1,$2,$3,'Note destination members')", [groupId, seed.teamId, `notes-${groupId.slice(0, 8)}`]);
  await noteSql("insert into group_members(team_id,group_id,member_id) values($1,$2,$3)", [seed.teamId, groupId, seed.memberId]);
  const project = await noteProject(seed, groupId);
  const policyId = randomUUID();
  await noteSql("insert into policies(id,team_id,action,resource,effect) values($1,$2,'note.append','*',$3)", [policyId, seed.teamId, effect]);
  const credential = await noteKey(seed);
  return { ...seed, ...credential, groupId, projectId: project.id, projectSlug: project.slug, policyId, request: noteRequest(project.id) };
}

export async function noteCounts(teamId: string) {
  return (await noteSql(`select
    (select count(*)::int from items where team_id=$1 and kind::text='note') notes,
    (select count(*)::int from item_versions v join items i on i.id=v.item_id where i.team_id=$1 and i.kind::text='note') versions,
    (select count(*)::int from governed_item_origins where team_id=$1 and kind='note') origins,
    (select count(*)::int from governed_action_identities where team_id=$1) identities,
    (select count(*)::int from governed_actions a join governed_action_identities i on i.id=a.identity_id where i.team_id=$1 and a.status='succeeded') succeeded`, [teamId])).rows[0];
}
