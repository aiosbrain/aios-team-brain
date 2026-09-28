import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGovernedActionService, GovernedError, DomainFailure, type ActionStatus, type GovernedConsumer } from "@/lib/actions/governed";
import { operationKey } from "@/lib/actions/governed/contract";
import { noteConsumer } from "@/lib/actions/governed/consumers/note";
import { noteCounts, noteFixture, noteKey, noteMember, noteProject, noteRequest, noteSql, type NoteRequest } from "./note-fixture";
import { sha } from "./helpers";

const service = (consumer: GovernedConsumer = noteConsumer, enabled = () => true) =>
  createGovernedActionService({ consumers: [consumer], enabled });
type Fixture = Awaited<ReturnType<typeof noteFixture>>;
type Success = Extract<ActionStatus, { status: "succeeded" }>;

async function complete(f: Fixture, request: NoteRequest = f.request): Promise<Success> {
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const result = await service().submit(f.auth, request);
      if (result.status === "succeeded") return result;
      expect(["requested", "running"]).toContain(result.status);
    } catch (e) {
      if (!(e instanceof GovernedError) || e.code !== "unavailable") throw e;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("note did not converge after concurrent retries");
}

async function stored(id: string) {
  return (await noteSql(`select i.*,o.entity_id,o.identity_key,o.revision from items i
    join governed_item_origins o on o.item_id=i.id where i.id=$1`, [id])).rows[0];
}

function approval(f: Fixture, result: ActionStatus, memberId: string) {
  if (result.status !== "pending_approval") throw new Error("approval expected");
  return { teamId: f.teamId, deciderMemberId: memberId, approvalRequestId: result.approval_request_id, decision: "approved" as const };
}

afterEach(() => vi.useRealTimers());

describe("governed notes with real Postgres", () => {
  it("commits exact strings, authenticated attribution, item/version/origin and stable audit IDs", async () => {
    const f = await noteFixture();
    const request = noteRequest(f.projectId, "  Cafe\u0301 📝\r\n", "\r\nBody 📝\n  ");
    const first = await complete(f, request);
    const row = await stored(first.entity.id);
    expect(row).toMatchObject({ team_id: f.teamId, project_id: f.projectId, member_id: f.memberId,
      kind: "note", access: "team", body: request.params.body, frontmatter: { title: request.params.title },
      content_sha256: sha(request.params.body), entity_id: first.entity.id, revision: first.entity.revision,
      identity_key: operationKey(request, f.memberId, f.teamId, f.projectId) });
    expect(row.actor).toBe(f.auth.actorHandle);
    expect(first.entity.revision).toMatch(/^[a-f0-9-]{36}$/);
    expect(first.sync).toEqual({ state: "not_applicable", providers: [] });
    expect(await service().submit(f.auth, request)).toEqual(first);
    expect(await service().status(f.auth, first.action_id)).toEqual(first);
    expect(await noteCounts(f.teamId)).toEqual({ notes: 1, versions: 1, origins: 1, identities: 1, succeeded: 1 });
    const audit = (await noteSql("select member_id,action,target_id,meta from audit_log where id=$1", [first.audit_ref])).rows[0];
    expect(audit).toEqual({ member_id: f.memberId, action: "governed.succeeded", target_id: first.action_id, meta: {} });
    const version = (await noteSql("select body,frontmatter,member_id from item_versions where item_id=$1", [first.entity.id])).rows[0];
    expect(version).toMatchObject({ body: request.params.body, frontmatter: { title: request.params.title }, member_id: f.memberId });
  });

  it("accepts explicit suitable General placement without creating or altering authority", async () => {
    const f = await noteFixture();
    const general = (await noteSql("select id from projects where team_id=$1 and slug='general' and kind='system'", [f.teamId])).rows[0];
    const authority = () => noteSql(`select
      (select jsonb_agg(to_jsonb(p) order by p.id) from projects p where p.team_id=$1) projects,
      (select jsonb_agg(to_jsonb(g) order by g.id) from groups g where g.team_id=$1) groups,
      (select jsonb_agg(to_jsonb(g) order by g.project_id,g.group_id) from project_groups g where g.team_id=$1) grants`, [f.teamId]);
    const before = (await authority()).rows[0];
    const result = await complete(f, noteRequest(general.id));
    expect((await stored(result.entity.id)).project_id).toBe(general.id);
    expect((await authority()).rows[0]).toEqual(before);
  });

  it("converges independent concurrent submitters on one durable note", async () => {
    const f = await noteFixture();
    const results = await Promise.all(Array.from({ length: 8 }, () => complete(f)));
    for (const result of results) expect(result).toEqual(results[0]);
    expect(await noteCounts(f.teamId)).toEqual({ notes: 1, versions: 1, origins: 1, identities: 1, succeeded: 1 });
  });

  it("replays after midnight, a reconstructed service and credential rotation without redating", async () => {
    const f = await noteFixture();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-28T23:59:59.999Z"));
    const first = await complete(f);
    const before = await stored(first.entity.id);
    vi.setSystemTime(new Date("2026-09-29T00:00:00.001Z"));
    const replacement = await noteKey(f);
    await noteSql("update api_keys set revoked_at=now() where id=$1", [f.auth.apiKeyId]);
    await noteSql("update members set actor_handle='renamed-note-author' where id=$1", [f.memberId]);
    expect(await service().submit(replacement.auth, f.request)).toEqual(first);
    expect(await stored(first.entity.id)).toEqual(before);
    expect(await noteCounts(f.teamId)).toMatchObject({ notes: 1, versions: 1, origins: 1, succeeded: 1 });
  });

  it("separates title/body edits, accepted normalization forms, members and destinations", async () => {
    const f = await noteFixture();
    const other = await noteMember(f);
    await noteSql("insert into group_members(team_id,group_id,member_id) values($1,$2,$3)", [f.teamId, f.groupId, other.id]);
    const destination = await noteProject(f, f.groupId);
    const results = [
      await complete(f), await complete(f, noteRequest(f.projectId, "Edited title")),
      await complete(f, noteRequest(f.projectId, "Note title", "Edited body")),
      await complete(f, noteRequest(f.projectId, "Café")), await complete(f, noteRequest(f.projectId, "Cafe\u0301")),
      await complete({ ...f, auth: other.auth }), await complete(f, noteRequest(destination.id)),
    ];
    expect(new Set(results.map((r) => r.entity.id)).size).toBe(7);
    expect(await noteCounts(f.teamId)).toMatchObject({ notes: 7, versions: 7, origins: 7, succeeded: 7 });
  });

  it("accepts the Unicode maximum and rejects one additional code point without persistence", async () => {
    const f = await noteFixture();
    const request = noteRequest(f.projectId, "📝".repeat(200), "📝".repeat(25000));
    const result = await complete(f, request);
    expect((await stored(result.entity.id)).body).toBe(request.params.body);
    for (const params of [
      { ...request.params, title: request.params.title + "x" },
      { ...request.params, body: request.params.body + "x" },
      { ...request.params, body: "nonblank\u0000" },
      { ...request.params, actor: "forged" },
    ]) await expect(service().submit(f.auth, { ...request, params })).rejects.toMatchObject({ code: "invalid_payload", status: 422 });
    expect(await noteCounts(f.teamId)).toMatchObject({ notes: 1, identities: 1 });
  });

  it("creates no item while pending and applies one human approval once", async () => {
    const f = await noteFixture("require_approval");
    const approver = await noteMember(f, "admin");
    const pending = await service().submit(f.auth, f.request);
    expect(pending.status).toBe("pending_approval");
    expect(await noteCounts(f.teamId)).toMatchObject({ notes: 0, versions: 0, origins: 0 });
    const input = approval(f, pending, approver.id);
    const result = await service().decide(input);
    expect(result.status).toBe("succeeded");
    expect(await service().decide(input)).toEqual(result);
    expect(await service().submit(f.auth, f.request)).toEqual(result);
    expect(await noteCounts(f.teamId)).toMatchObject({ notes: 1, versions: 1, origins: 1, succeeded: 1 });
  });

  it("retains pending approval while disabled and executes it once after re-enable", async () => {
    const f = await noteFixture("require_approval");
    const approver = await noteMember(f, "admin");
    const pending = await service().submit(f.auth, f.request);
    const input = approval(f, pending, approver.id);
    const disabled = service(noteConsumer, () => false);
    await expect(disabled.decide(input)).rejects.toMatchObject({ code: "capability_unavailable" });
    expect(await disabled.status(f.auth, pending.action_id)).toEqual(pending);
    expect(await noteCounts(f.teamId)).toMatchObject({ notes: 0, versions: 0, origins: 0 });
    const result = await service().decide(input);
    expect(result.status).toBe("succeeded");
    expect(result.action_id).toBe(pending.action_id);
    expect(await service().decide(input)).toEqual(result);
    expect(await noteCounts(f.teamId)).toMatchObject({ notes: 1, versions: 1, origins: 1, succeeded: 1 });
  });

  it.each(["key", "member", "project", "policy"])("rechecks %s before delayed approval and leaves no note", async (change) => {
    const f = await noteFixture("require_approval");
    const approver = await noteMember(f, "admin");
    const pending = await service().submit(f.auth, f.request);
    if (change === "key") await noteSql("update api_keys set revoked_at=now() where id=$1", [f.auth.apiKeyId]);
    if (change === "member") await noteSql("update members set status='disabled' where id=$1", [f.memberId]);
    if (change === "project") await noteSql("delete from project_groups where project_id=$1", [f.projectId]);
    if (change === "policy") await noteSql("update policies set priority=priority+1 where id=$1", [f.policyId]);
    expect(await service().decide(approval(f, pending, approver.id))).toMatchObject({ status: "denied", error: { code: "revoked_authorization" } });
    expect(await noteCounts(f.teamId)).toMatchObject({ notes: 0, versions: 0, origins: 0, succeeded: 0 });
  });

  it("allows a fresh authorized content attempt after denial while retaining the old attempt", async () => {
    const f = await noteFixture("deny");
    const denied = await service().submit(f.auth, f.request);
    expect(denied.status).toBe("denied");
    await noteSql("update policies set effect='allow' where id=$1", [f.policyId]);
    const result = await complete(f);
    expect(result.action_id).not.toBe(denied.action_id);
    expect(await service().status(f.auth, denied.action_id)).toEqual(denied);
    expect(await noteCounts(f.teamId)).toMatchObject({ notes: 1, identities: 1, succeeded: 1 });
  });

  it("rolls back the real note effect on domain failure and allows a fresh attempt", async () => {
    const f = await noteFixture();
    const failed = await service({ type: "note.append", async execute(ctx, request) {
      await noteConsumer.execute(ctx, request);
      throw new DomainFailure("execution_failed");
    } }).submit(f.auth, f.request);
    expect(failed.status).toBe("failed");
    expect(await noteCounts(f.teamId)).toMatchObject({ notes: 0, versions: 0, origins: 0 });
    const result = await complete(f);
    expect(result.action_id).not.toBe(failed.action_id);
    expect(await service().status(f.auth, failed.action_id)).toEqual(failed);
    expect(await noteCounts(f.teamId)).toMatchObject({ notes: 1, succeeded: 1 });
  });

  it("rolls back note/version/origin/context if final audit fails, then recovers the same accepted action", async () => {
    const f = await noteFixture();
    // A test-only constraint faults the final audit after the actual consumer has completed.
    await noteSql("alter table audit_log add constraint notes_test_audit_failure check (action <> 'governed.succeeded')");
    try {
      await expect(service().submit(f.auth, f.request)).rejects.toMatchObject({ code: "unavailable" });
      expect(await noteCounts(f.teamId)).toMatchObject({ notes: 0, versions: 0, origins: 0, succeeded: 0 });
      expect((await noteSql("select count(*)::int n from project_context_units where team_id=$1", [f.teamId])).rows[0].n).toBe(0);
    } finally {
      await noteSql("alter table audit_log drop constraint notes_test_audit_failure");
    }
    const accepted = (await noteSql("select a.id from governed_actions a join governed_action_identities i on i.id=a.identity_id where i.team_id=$1", [f.teamId])).rows[0].id;
    expect((await complete(f)).action_id).toBe(accepted);
    expect(await noteCounts(f.teamId)).toMatchObject({ notes: 1, versions: 1, origins: 1, identities: 1, succeeded: 1 });
  });

  it("denies external credentials, inaccessible destinations and uninitialized destination context", async () => {
    const f = await noteFixture();
    const external = await noteMember(f, "member", "external");
    await noteSql("insert into group_members(team_id,group_id,member_id) values($1,$2,$3)", [f.teamId, f.groupId, external.id]);
    await expect(service().submit(external.auth, f.request)).rejects.toMatchObject({ code: "forbidden" });
    await expect(service().submit(f.auth, noteRequest(randomUUID()))).rejects.toMatchObject({ code: "not_found" });
    await noteSql("update projects set graph_group_id=null where id=$1", [f.projectId]);
    expect(await service().submit(f.auth, f.request)).toMatchObject({ status: "denied" });
    expect(await noteCounts(f.teamId)).toMatchObject({ notes: 0, origins: 0 });
  });

  it("protects accepted note content and provenance against legacy database mutation", async () => {
    const f = await noteFixture();
    const result = await complete(f);
    const before = await stored(result.entity.id);
    for (const statement of [
      "update items set body='replacement' where id=$1",
      "update items set frontmatter=jsonb_set(frontmatter,'{title}','\"replacement\"') where id=$1",
      "update items set kind='artifact' where id=$1",
      "update items set access='external' where id=$1",
      "update items set actor='forged' where id=$1",
      "update items set path='replacement.md' where id=$1",
      "delete from items where id=$1",
      "update governed_item_origins set revision=gen_random_uuid() where item_id=$1",
      "delete from governed_item_origins where item_id=$1",
    ]) await expect(noteSql(statement, [result.entity.id])).rejects.toMatchObject({ code: "23514", message: "immutable_origin" });
    expect(await stored(result.entity.id)).toEqual(before);
    expect(await noteCounts(f.teamId)).toMatchObject({ notes: 1, versions: 1, origins: 1 });
  });

  it("reauthorizes successful replay/status and keeps committed history when capability is disabled", async () => {
    const f = await noteFixture();
    const result = await complete(f);
    const disabled = service(noteConsumer, () => false);
    expect(await disabled.status(f.auth, result.action_id)).toEqual(result);
    expect(await disabled.submit(f.auth, f.request)).toEqual(result);
    await expect(disabled.submit(f.auth, noteRequest(f.projectId, "New content"))).rejects.toMatchObject({ code: "capability_unavailable" });
    await noteSql("delete from project_groups where project_id=$1", [f.projectId]);
    await expect(service().submit(f.auth, f.request)).rejects.toMatchObject({ code: "not_found" });
    await expect(service().status(f.auth, result.action_id)).rejects.toMatchObject({ code: "not_found" });
    expect(await noteCounts(f.teamId)).toMatchObject({ notes: 1, versions: 1, origins: 1 });
  });
});
