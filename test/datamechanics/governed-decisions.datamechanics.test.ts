import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getPool } from "@/lib/db/pg/pool";
import { authenticateApiKey } from "@/lib/api/auth";
import { createGovernedActionService, type ActionStatus, type SubmitRequest } from "@/lib/actions/governed";
import { decisionConsumer } from "@/lib/actions/governed/consumers/decision";
import { ensureAccessBootstrap } from "@/lib/access/bootstrap";
import { visibleItemIds } from "@/lib/access/enforce";
import { getDecisionWriteback } from "@/lib/sync/decisions";
import { retrieve } from "@/lib/query/retrieve";
import { matchingDecisions } from "@/lib/query/structured-extras";
import { projectItemsToGraph } from "@/lib/graph/project";
import { FakeGraphiti, client } from "./fake-graphiti";
import { backfillTeamContext } from "@/lib/projects/context/backfill";
import { materializeDecisions } from "@/lib/ingest/decisions";
import { db, seedTeam, sha, placeMemberByTier } from "./helpers";

const sql = (q: string, v: unknown[] = []) => getPool().query(q, v);
const service = (enabled = () => true) => createGovernedActionService({ consumers: [decisionConsumer], enabled });
async function fixture(effect = "allow", role = "admin", bootstrap = true) {
  const f = await seedTeam();
  if (bootstrap) expect((await ensureAccessBootstrap(db(), f.teamId)).ok).toBe(true);
  await sql("update members set role=$2 where id=$1", [f.memberId, role]);
  const projectId = randomUUID();
  await sql("insert into projects(id,team_id,slug,kind,graph_group_id) values($1,$2,'orbit','initiative',$3)", [projectId, f.teamId, `fixture-${projectId}`]);
  const group = (await sql("insert into groups(team_id,slug,name) values($1,$2,'Authors') returning id", [f.teamId, `authors-${randomUUID()}`])).rows[0].id;
  await sql("insert into group_members(team_id,group_id,member_id) values($1,$2,$3)", [f.teamId, group, f.memberId]);
  await sql("insert into project_groups(team_id,project_id,group_id) values($1,$2,$3)", [f.teamId, projectId, group]);
  const policyId = (await sql("insert into policies(team_id,action,resource,effect) values($1,'decision.record','*',$2) returning id", [f.teamId, effect])).rows[0].id;
  const keyId = randomUUID().replaceAll("-", "");
  await sql("insert into api_keys(team_id,member_id,key_id,key_hash) values($1,$2,$3,$4)", [f.teamId, f.memberId, keyId, sha("synthetic")]);
  const auth = (await authenticateApiKey(new Request("http://local", { headers: { authorization: `Bearer aios_${keyId}_synthetic` } }), { preserveErrors: true, recordUsage: false }))!;
  const admin = (await sql("insert into members(team_id,email,display_name,actor_handle,role,tier,status) values($1,$2,'Approver','approver','admin','team','active') returning id", [f.teamId, `${randomUUID()}@test.local`])).rows[0].id;
  await placeMemberByTier(f.teamId, admin, "team");
  const request: Extract<SubmitRequest, { type: "decision.record" }> = {
    contract_version: "mcp-next/1", type: "decision.record", destination: { project_id: projectId },
    params: { operation_id: randomUUID(), title: "Orbit choice", rationale: "Heliotropic boundary reasoning", impact: "" },
  };
  return { ...f, projectId, request, auth, admin, policyId };
}
function approve(f: Awaited<ReturnType<typeof fixture>>, r: ActionStatus, decision: "approved" | "denied" = "approved") {
  if (r.status !== "pending_approval") throw new Error("approval required");
  return { teamId: f.teamId, deciderMemberId: f.admin, approvalRequestId: r.approval_request_id, decision };
}
const decisionRows = (teamId: string) => sql("select * from decisions where team_id=$1", [teamId]);

describe("governed decisions durable domain outcomes", () => {
  it.each(["admin", "lead"])("records one canonical attributed decision for %s", async role => {
    const f = await fixture("allow", role);
    const r = await service().submit(f.auth, f.request);
    expect(r.status).toBe("succeeded");
    if (r.status !== "succeeded") throw new Error("success required");
    const rows = (await decisionRows(f.teamId)).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: r.entity.id, project_id: f.projectId, created_by: f.memberId, audience: "team", title: f.request.params.title, rationale: f.request.params.rationale, impact: "" });
    expect(rows[0].decided_by).toBe((await sql("select actor_handle from members where id=$1", [f.memberId])).rows[0].actor_handle);
    expect(rows[0].source_item_id).toBeTruthy();
    const origin = (await sql("select * from governed_item_origins where item_id=$1", [rows[0].source_item_id])).rows[0];
    expect(origin).toMatchObject({ entity_id: r.entity.id, kind: "decision", revision: r.entity.revision });
    const source = (await sql("select kind,body,access,member_id from items where id=$1", [rows[0].source_item_id])).rows[0];
    expect(source).toMatchObject({ kind: "decision", access: "team", member_id: f.memberId });
    expect(source.body).toContain(f.request.params.rationale);
    expect((await sql("select action,target_id from audit_log where id=$1", [r.audit_ref])).rows[0]).toEqual({ action: "governed.succeeded", target_id: r.action_id });
  });
  it.each(["source", "custom-system", "unbootstrapped", "missing-pointer", "empty-pointer"])("refuses unsupported %s destination without domain effects", async variant => {
    const f = await fixture("allow", "admin", variant !== "unbootstrapped");
    if (variant === "source") await sql("update projects set kind='source' where id=$1", [f.projectId]);
    if (variant === "custom-system") await sql("update projects set kind='system' where id=$1", [f.projectId]);
    if (variant === "missing-pointer") await sql("update projects set graph_group_id=null where team_id=$1 and kind='system' and slug='general'", [f.teamId]);
    if (variant === "empty-pointer") await sql("update projects set graph_group_id='' where team_id=$1 and kind='system' and slug='general'", [f.teamId]);
    expect(await service().submit(f.auth, f.request)).toMatchObject({ status: "denied", error: { code: "forbidden" } });
    expect((await decisionRows(f.teamId)).rows).toEqual([]);
    expect((await sql("select id from items where team_id=$1", [f.teamId])).rows).toEqual([]);
    expect((await sql("select item_id from governed_item_origins where team_id=$1", [f.teamId])).rows).toEqual([]);
  });
  it("accepts the initialized system General destination", async () => {
    const f = await fixture();
    const general = (await sql("select id from projects where team_id=$1 and kind='system' and slug='general'", [f.teamId])).rows[0];
    const request = { ...f.request, destination: { project_id: general.id } };
    expect(await service().submit(f.auth, request)).toMatchObject({ status: "succeeded" });
    expect((await decisionRows(f.teamId)).rows[0].project_id).toBe(general.id);
  });
  it("recovers a lost response by replay/status and refuses changed rationale", async () => {
    const f = await fixture();
    const first = await service().submit(f.auth, f.request); // committed response deliberately discarded by caller
    expect(await service().submit(f.auth, f.request)).toEqual(first);
    expect(await service().status(f.auth, first.action_id)).toEqual(first);
    await expect(service().submit(f.auth, { ...f.request, params: { ...f.request.params, rationale: "changed" } })).rejects.toMatchObject({ code: "operation_id_conflict" });
    expect((await decisionRows(f.teamId)).rows).toHaveLength(1);
  });
  it("concurrent identical operations converge on one decision", async () => {
    const f = await fixture();
    const results = await Promise.allSettled(Array.from({ length: 4 }, () => service().submit(f.auth, f.request)));
    expect(results.some(r => r.status === "fulfilled")).toBe(true);
    for (const r of results) if (r.status === "rejected") expect(r.reason).toMatchObject({ code: "unavailable" });
    const final = await service().submit(f.auth, f.request);
    expect(final.status).toBe("succeeded");
    expect((await decisionRows(f.teamId)).rows).toHaveLength(1);
  });
  it("policy allow does not give an ordinary member domain privilege", async () => {
    const f = await fixture("allow", "member");
    expect(await service().submit(f.auth, f.request)).toMatchObject({ status: "denied", error: { code: "forbidden" } });
    expect((await decisionRows(f.teamId)).rows).toHaveLength(0);
    expect((await sql("select id from items where team_id=$1", [f.teamId])).rows).toHaveLength(0);
  });
  it("approval creates nothing early and executes once through human decision", async () => {
    const f = await fixture("require_approval"); const s = service();
    const pending = await s.submit(f.auth, f.request);
    expect(pending.status).toBe("pending_approval");
    expect(await s.status(f.auth, pending.action_id)).toEqual(pending);
    expect((await decisionRows(f.teamId)).rows).toHaveLength(0);
    const done = await s.decide(approve(f, pending));
    expect(done.status).toBe("succeeded");
    expect(await s.decide(approve(f, pending))).toEqual(done);
    expect((await decisionRows(f.teamId)).rows).toHaveLength(1);
  });
  it.each(["role", "key", "membership", "policy"])("rechecks %s revocation after approval wait", async change => {
    const f = await fixture("require_approval"); const s = service();
    const pending = await s.submit(f.auth, f.request);
    if (change === "role") await sql("update members set role='member' where id=$1", [f.memberId]);
    if (change === "key") await sql("update api_keys set revoked_at=now() where id=$1", [f.auth.apiKeyId]);
    if (change === "membership") await sql("delete from project_groups where project_id=$1", [f.projectId]);
    if (change === "policy") await sql("update policies set effect='deny' where id=$1", [f.policyId]);
    expect(await s.decide(approve(f, pending))).toMatchObject({ status: "denied" });
    expect((await decisionRows(f.teamId)).rows).toHaveLength(0);
  });
  it("denied approval creates no item or decision", async () => {
    const f = await fixture("require_approval"); const s = service();
    const pending = await s.submit(f.auth, f.request);
    expect(await s.decide(approve(f, pending, "denied"))).toMatchObject({ status: "denied" });
    expect((await decisionRows(f.teamId)).rows).toHaveLength(0);
    expect((await sql("select id from items where team_id=$1", [f.teamId])).rows).toHaveLength(0);
  });
  it("retrieves rationale and writeback through source membership after later sweep", async () => {
    const f = await fixture(); await service().submit(f.auth, f.request);
    await backfillTeamContext(db(), f.teamId);
    const vis = await visibleItemIds(db(), { teamId: f.teamId, memberId: f.memberId });
    const enforce = { visibleItemIds: vis.ids, teamPosture: true, principal: "member" as const };
    expect(await matchingDecisions(f.teamId, "team", "heliotropic", 10, enforce)).toEqual(expect.arrayContaining([expect.objectContaining({ rationale: f.request.params.rationale })]));
    const feed = await getDecisionWriteback(db(), f.teamId, "team", "1970-01-01", enforce);
    expect(feed[0].rows[0]).toMatchObject({ rationale: f.request.params.rationale });
    const other = await visibleItemIds(db(), { teamId: f.teamId, memberId: f.admin });
    expect(await matchingDecisions(f.teamId, "team", "heliotropic", 10, { ...enforce, visibleItemIds: other.ids })).toEqual([]);
    expect(await getDecisionWriteback(db(), f.teamId, "team", "1970-01-01", { ...enforce, visibleItemIds: other.ids })).toEqual([]);
  });
  it("protects source identity against changed echoes and omission", async () => {
    const f = await fixture(); await service().submit(f.auth, f.request);
    const row = (await decisionRows(f.teamId)).rows[0];
    await expect(materializeDecisions(db(), f.teamId, f.projectId, row.source_item_id, [{ row_key: row.row_key, title: "changed", rationale: row.rationale, impact: row.impact, decided_by: row.decided_by, audience: "team" }], new Date().toISOString())).rejects.toMatchObject({ code: "immutable_origin" });
    await materializeDecisions(db(), f.teamId, f.projectId, row.source_item_id, [], new Date().toISOString());
    expect((await decisionRows(f.teamId)).rows[0]).toMatchObject({ id: row.id, title: row.title, source_item_id: row.source_item_id });
  });
  it("projects decision kind into only its destination after a later context sweep", async () => {
    const f = await fixture(); await service().submit(f.auth, f.request);
    expect((await backfillTeamContext(db(), f.teamId)).ok).toBe(true);
    const row = (await decisionRows(f.teamId)).rows[0];
    const memberships = await sql(`select m.project_id from project_context_memberships m join project_context_units u on u.id=m.context_unit_id
      where u.source_item_id=$1 and m.valid_to is null and m.decision='include'`, [row.source_item_id]);
    expect(memberships.rows).toEqual([{ project_id: f.projectId }]);
    const fake = new FakeGraphiti();
    await projectItemsToGraph(db(), { teamId: f.teamId, teamSlug: f.teamSlug, kinds: ["decision"], client: client(fake) });
    expect(fake.pushes).toHaveLength(0); // Cold destination retains the existing deferred extraction lifecycle.
    expect((await sql("select group_id,deferred from graph_episodes where team_id=$1", [f.teamId])).rows)
      .toEqual([{ group_id: `fixture-${f.projectId}`, deferred: true }]);
    await sql("update graph_episodes set deferred=false where team_id=$1 and source_id=$2", [f.teamId, row.source_item_id]);
    await projectItemsToGraph(db(), { teamId: f.teamId, teamSlug: f.teamSlug, kinds: ["decision"], client: client(fake) });
    expect(fake.pushes).toHaveLength(1);
    expect(fake.pushes[0].groupId).toBe(`fixture-${f.projectId}`);
    expect(fake.pushedEpisodes[0].sourceDescription).toContain("Decision");
    expect(fake.pushedEpisodes[0].content).toContain(f.request.params.rationale);
    const ledger = await sql("select source_id,group_id from graph_episodes where team_id=$1", [f.teamId]);
    expect(ledger.rows).toEqual([{ source_id: row.source_item_id, group_id: `fixture-${f.projectId}` }]);
    const again = new FakeGraphiti();
    await projectItemsToGraph(db(), { teamId: f.teamId, teamSlug: f.teamSlug, kinds: ["decision"], client: client(again) });
    expect(again.pushes).toHaveLength(0);
  });
  it("retrieves a rationale older than the recent decision window", async () => {
    const f = await fixture(); await service().submit(f.auth, f.request);
    const row = (await decisionRows(f.teamId)).rows[0];
    // Synthetic newer legacy rows force the keyword path, preserving realistic provenance.
    await sql(`insert into decisions(team_id,project_id,row_key,title,decided_at,created_by)
      select $1,$2,'recent-'||n,'Newer decision',current_date+1,$3 from generate_series(1,55) n`, [f.teamId, f.projectId, f.memberId]);
    const vis = await visibleItemIds(db(), { teamId: f.teamId, memberId: f.memberId });
    const context = await retrieve(db(), f.teamId, "team", "heliotropic", null, { visibleItemIds: vis.ids, principal: "member", graphProjectIds: [] });
    expect(context.structured).toContain("Older decisions matching this query");
    expect(context.structured).toContain(row.row_key);
    expect(context.structured).toContain(f.request.params.rationale);
  });
  it("echoes maximum Unicode content without truncation or replacing canonical source", async () => {
    const f = await fixture(); f.request.params.rationale = "😀".repeat(25000); f.request.params.impact = "🌍".repeat(5000);
    const done = await service().submit(f.auth, f.request); expect(done.status).toBe("succeeded");
    const row = (await decisionRows(f.teamId)).rows[0];
    const vis = await visibleItemIds(db(), { teamId: f.teamId, memberId: f.memberId });
    const feed = await getDecisionWriteback(db(), f.teamId, "team", "1970-01-01", { visibleItemIds: vis.ids, teamPosture: true, principal: "member" });
    const { decisionRowSchema } = await import("@/lib/api/item-payload-schema");
    const echo = decisionRowSchema.parse(feed[0].rows[0]);
    await materializeDecisions(db(), f.teamId, f.projectId, randomUUID(), [echo], new Date().toISOString());
    expect((await decisionRows(f.teamId)).rows[0]).toMatchObject({ id: row.id, rationale: f.request.params.rationale, impact: f.request.params.impact, source_item_id: row.source_item_id });
  });
  it.each(["audit", "origin"] as const)("rolls back decision/item/origin when %s persistence fails and safely retries", async fault => {
    const f = await fixture();
    const table = fault === "audit" ? "audit_log" : "governed_item_origins";
    const condition = fault === "audit" ? "new.action='governed.succeeded'" : "true";
    await sql(`create function decision_test_reject_write() returns trigger language plpgsql as $$ begin
      if ${condition} then raise exception 'synthetic persistence fault'; end if;
      return new; end $$`);
    await sql(`create trigger decision_test_write before insert on ${table} for each row execute function decision_test_reject_write()`);
    try {
      await expect(service().submit(f.auth, f.request)).rejects.toThrow();
      expect((await decisionRows(f.teamId)).rows).toHaveLength(0);
      expect((await sql("select item_id from governed_item_origins where team_id=$1", [f.teamId])).rows).toHaveLength(0);
      expect((await sql("select id from items where team_id=$1", [f.teamId])).rows).toHaveLength(0);
      expect((await sql("select status from governed_actions a join governed_action_identities i on i.id=a.identity_id where i.team_id=$1", [f.teamId])).rows).toEqual([{ status: "requested" }]);
    } finally {
      await sql(`drop trigger decision_test_write on ${table}`); await sql("drop function decision_test_reject_write()");
    }
    expect(await service().submit(f.auth, f.request)).toMatchObject({ status: "succeeded" });
    expect((await decisionRows(f.teamId)).rows).toHaveLength(1);
  });
  it("capability off stops new writes and preserves status/readback", async () => {
    const f = await fixture(); const done = await service().submit(f.auth, f.request);
    expect(await service(() => false).status(f.auth, done.action_id)).toEqual(done);
    expect(await service(() => false).submit(f.auth, f.request)).toEqual(done);
    await expect(service(() => false).submit(f.auth, { ...f.request, params: { ...f.request.params, operation_id: randomUUID() } })).rejects.toMatchObject({ code: "capability_unavailable" });
    expect((await decisionRows(f.teamId)).rows).toHaveLength(1);
  });
});
