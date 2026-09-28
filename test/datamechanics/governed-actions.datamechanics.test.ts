import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { getPool } from "@/lib/db/pg/pool";
import { authenticateApiKey } from "@/lib/api/auth";
import {
  createGovernedActionService,
  canonicalRequest,
  GovernedError,
  DomainFailure,
  type GovernedConsumer,
  type ActionStatus,
  type GovernedContext,
  type SubmitRequest,
} from "@/lib/actions/governed";
import { seedTeam, sha, placeMemberByTier } from "./helpers";
import { createGovernedActionHttp } from "@/lib/actions/governed/http";
const sql = (text: string, values: unknown[] = []) =>
  getPool().query(text, values);
const effect: GovernedConsumer = {
  type: "task.create",
  async execute(ctx) {
    const id = randomUUID();
    await ctx.query(
      "insert into governed_fixture_effects(id,team_id) values($1,$2)",
      [id, ctx.teamId],
    );
    return {
      entity: { kind: "task", id, revision: "r1" },
      sync: { state: "not_applicable", providers: [] },
    };
  },
};
const service = (consumer: GovernedConsumer = effect, enabled = () => true) =>
  createGovernedActionService({ consumers: [consumer], enabled });
async function keyFor(teamId: string, memberId: string) {
  const keyId = randomUUID().replaceAll("-", ""),
    secret = "synthetic";
  await sql(
    "insert into api_keys(team_id,member_id,key_id,key_hash) values($1,$2,$3,$4)",
    [teamId, memberId, keyId, sha(secret)],
  );
  const req = new Request("http://local", {
    headers: { authorization: `Bearer aios_${keyId}_${secret}` },
  });
  return (await authenticateApiKey(req, {
    preserveErrors: true,
    recordUsage: false,
  }))!;
}
async function fixture(policy = "allow") {
  const s = await seedTeam();
  const projectId = randomUUID();
  await sql("insert into projects(id,team_id,slug) values($1,$2,$3)", [
    projectId,
    s.teamId,
    "fixture",
  ]);
  await sql(
    "insert into project_groups(team_id,project_id,group_id) select $1,$2,id from groups where team_id=$1 and slug='everyone'",
    [s.teamId, projectId],
  );
  const p = await sql(
    "insert into policies(team_id,action,resource,effect) values($1,'*','*',$2) returning id",
    [s.teamId, policy],
  );
  const auth = await keyFor(s.teamId, s.memberId);
  const admin = (
    await sql(
      "insert into members(team_id,email,display_name,actor_handle,role,tier,status) values($1,$2,'Approver','approver','admin','team','active') returning id",
      [s.teamId, randomUUID() + "@test.local"],
    )
  ).rows[0].id;
  await placeMemberByTier(s.teamId, admin, "team");
  const request: SubmitRequest = {
    contract_version: "mcp-next/1",
    type: "task.create",
    destination: { project_id: projectId },
    params: {
      operation_id: "operation",
      title: "Fixture",
      assignee: null,
      status: "ready",
      due: null,
    },
  };
  return { ...s, auth, admin, projectId, request, policyId: p.rows[0].id };
}
async function counts() {
  return (
    await sql(
      "select (select count(*)::int from governed_fixture_effects) effects,(select count(*)::int from governed_actions) actions,(select count(*)::int from governed_action_identities) identities",
    )
  ).rows[0];
}
function decision(
  f: Awaited<ReturnType<typeof fixture>>,
  r: ActionStatus,
  value: "approved" | "denied" = "approved",
) {
  if (r.status !== "pending_approval") throw new Error("pending required");
  return {
    teamId: f.teamId,
    deciderMemberId: f.admin,
    approvalRequestId: r.approval_request_id,
    decision: value,
  };
}
function latch() {
  let release!: () => void;
  const wait = new Promise<void>((r) => (release = r));
  return { wait, release };
}
beforeAll(async () => {
  await sql(
    "create table if not exists governed_fixture_effects(id uuid primary key,team_id uuid not null references teams(id) on delete cascade)",
  );
});
afterAll(async () => {
  await sql("drop table if exists governed_fixture_effects");
});
describe("durable governed actions: real Postgres", () => {
  it("commits one effect/audit/result across concurrent submission and reconstructed retry", async () => {
    const f = await fixture();
    const s = service();
    const attempts = await Promise.allSettled(
      Array.from({ length: 6 }, () => s.submit(f.auth, f.request)),
    );
    expect(attempts.some(result => result.status === "fulfilled")).toBe(true);
    const results = await Promise.all(attempts.map(async result => {
      if (result.status === "fulfilled") return result.value;
      expect(result.reason).toBeInstanceOf(GovernedError);
      expect(result.reason).toMatchObject({ code: "unavailable", status: 503, detail: { retryable: true } });
      return service().submit(f.auth, f.request);
    }));
    const final = await service().submit(f.auth, f.request);
    expect(final.status).toBe("succeeded");
    expect(results.every((r) => r.action_id === final.action_id)).toBe(true);
    expect(await counts()).toEqual({ effects: 1, actions: 1, identities: 1 });
    expect(await s.status(f.auth, final.action_id)).toEqual(final);
    const audit = await sql(
      "select action,target_id from audit_log where id=$1",
      [final.audit_ref],
    );
    expect(audit.rows[0]).toEqual({
      action: "governed.succeeded",
      target_id: final.action_id,
    });
    await expect(
      s.submit(f.auth, {
        ...f.request,
        params: { ...f.request.params, title: "Changed" },
      }),
    ).rejects.toMatchObject({ code: "operation_id_conflict" });
    await expect(
      s.submit(f.auth, {
        ...f.request,
        type: "decision.record",
        params: {
          operation_id: "operation",
          title: "Changed",
          rationale: "why",
          impact: "",
        },
      }),
    ).rejects.toMatchObject({ code: "operation_id_conflict" });
    expect(await s.status(f.auth, final.action_id)).toEqual(final);
  });
  it("returns retryable unavailable before acceptance commits and recovers the same identity", async () => {
    const f = await fixture();
    const blocker = await getPool().connect();
    try {
      await blocker.query("BEGIN");
      const identity = canonicalRequest([f.teamId, f.memberId, f.projectId, "operation"]);
      await blocker.query("select pg_advisory_xact_lock(hashtextextended($1,0))", ["governed:" + identity]);
      await expect(service().submit(f.auth, f.request)).rejects.toMatchObject({
        code: "unavailable", status: 503, detail: { retryable: true },
      });
      expect(await counts()).toEqual({ effects: 0, actions: 0, identities: 0 });
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
    }
    const result = await service().submit(f.auth, f.request);
    expect(result.status).toBe("succeeded");
    expect(await service().submit(f.auth, f.request)).toEqual(result);
    expect(await counts()).toEqual({ effects: 1, actions: 1, identities: 1 });
  });
  it("returns requested during a claim and never runs a concurrent callback", async () => {
    const f = await fixture(),
      entered = latch(),
      release = latch();
    const s = service({
      ...effect,
      async execute(c, r) {
        entered.release();
        await release.wait;
        return effect.execute(c, r);
      },
    });
    const first = s.submit(f.auth, f.request);
    await entered.wait;
    try {
      const replay = await service().submit(f.auth, f.request);
      expect(replay.status).toBe("requested");
      expect((await service().status(f.auth, replay.action_id)).status).toBe(
        "requested",
      );
    } finally {
      release.release();
    }
    expect((await first).status).toBe("succeeded");
    expect((await counts()).effects).toBe(1);
  });
  it.each(["conflict", "failed"] as const)(
    "rolls back callback writes before terminal %s while preserving the claim",
    async (status) => {
      const f = await fixture(),
        entered = latch(),
        release = latch();
      const s = service({
        ...effect,
        async execute(c, r) {
          await effect.execute(c, r);
          entered.release();
          await release.wait;
          throw new DomainFailure(
            status === "conflict" ? "stale_revision" : "execution_failed",
            status,
          );
        },
      });
      const first = s.submit(f.auth, f.request);
      await entered.wait;
      try {
        expect((await service().submit(f.auth, f.request)).status).toBe(
          "requested",
        );
      } finally {
        release.release();
      }
      const result = await first;
      expect(result.status).toBe(status);
      expect((await counts()).effects).toBe(0);
      expect(await service().submit(f.auth, f.request)).toEqual(result);
    },
  );
  it("unexpected SQL/outbox failure rolls back effect and remains recoverable", async () => {
    const f = await fixture();
    const broken = service({
      ...effect,
      async execute(c, r) {
        await effect.execute(c, r);
        await c.query("insert into governed_missing_outbox values(1)");
        throw new Error("unreachable");
      },
    });
    await expect(broken.submit(f.auth, f.request)).rejects.toMatchObject({
      code: "unavailable",
      status: 503,
    });
    expect(await counts()).toEqual({ effects: 0, actions: 1, identities: 1 });
    const row = (await sql("select result from governed_actions")).rows[0]
      .result;
    expect(row.status).toBe("requested");
    expect((await service().submit(f.auth, f.request)).status).toBe(
      "succeeded",
    );
    expect((await counts()).effects).toBe(1);
  });
  it("required final audit failure rolls back mutation and retry recovers", async () => {
    const f = await fixture();
    await sql(
      "create or replace function governed_test_audit_fail() returns trigger language plpgsql as $$ begin if new.action='governed.succeeded' then raise exception 'fixture audit fault'; end if; return new; end $$",
    );
    await sql(
      "create trigger governed_test_audit_fail before insert on audit_log for each row execute function governed_test_audit_fail()",
    );
    try {
      await expect(service().submit(f.auth, f.request)).rejects.toMatchObject({
        code: "unavailable",
      });
      expect((await counts()).effects).toBe(0);
      expect(
        (await sql("select status from governed_actions")).rows[0].status,
      ).toBe("requested");
    } finally {
      await sql("drop trigger governed_test_audit_fail on audit_log");
      await sql("drop function governed_test_audit_fail()");
    }
    expect((await service().submit(f.auth, f.request)).status).toBe(
      "succeeded",
    );
  });
  it("an interrupted database transaction cannot settle; fresh executor recovers", async () => {
    const f = await fixture();
    const bad = service({
      ...effect,
      async execute(c, r) {
        await effect.execute(c, r);
        await c.query("select 1/0");
        throw new Error("unreachable");
      },
    });
    await expect(bad.submit(f.auth, f.request)).rejects.toMatchObject({
      code: "unavailable",
    });
    expect((await counts()).effects).toBe(0);
    expect((await service().submit(f.auth, f.request)).status).toBe(
      "succeeded",
    );
  });
  it("human approval and competing decisions admit only one terminal result", async () => {
    const f = await fixture("require_approval"),
      s = service();
    const pending = await s.submit(f.auth, f.request);
    expect(pending.status).toBe("pending_approval");
    expect((await counts()).effects).toBe(0);
    const a = decision(f, pending);
    const results = await Promise.allSettled([
      s.decide(a),
      s.decide({ ...a, decision: "denied" }),
    ]);
    expect(results.some((r) => r.status === "fulfilled")).toBe(true);
    const final = await s.status(f.auth, pending.action_id);
    expect(["succeeded", "denied"]).toContain(final.status);
    expect((await counts()).effects).toBe(final.status === "succeeded" ? 1 : 0);
    expect(await s.decide({ ...a, decision: "denied" })).toEqual(final);
    expect(await s.submit(f.auth, f.request)).toEqual(final);
  });
  it.each(["edit", "replacement", "unrelated", "actor"] as const)(
    "changed %s policy fingerprint invalidates recorded approval and permits new operation",
    async (change) => {
      const f = await fixture("require_approval"),
        s = service();
      const pending = await s.submit(f.auth, f.request);
      if (change === "edit")
        await sql("update policies set priority=priority+1 where id=$1", [
          f.policyId,
        ]);
      if (change === "replacement") {
        await sql("delete from policies where id=$1", [f.policyId]);
        await sql(
          "insert into policies(team_id,action,effect) values($1,'*','require_approval')",
          [f.teamId],
        );
      }
      if (change === "unrelated")
        await sql(
          "insert into policies(team_id,action,effect) values($1,'irrelevant','deny')",
          [f.teamId],
        );
      if (change === "actor")
        await sql("update members set actor_handle='changed' where id=$1", [
          f.memberId,
        ]);
      const result = await s.decide(decision(f, pending));
      expect(result).toMatchObject({
        status: "denied",
        error: { code: "revoked_authorization" },
      });
      expect((await counts()).effects).toBe(0);
      expect(await s.submit(f.auth, f.request)).toEqual(result);
      const next = await s.submit(f.auth, {
        ...f.request,
        params: { ...f.request.params, operation_id: "new-operation" },
      });
      expect(next.status).toBe("pending_approval");
      expect((await s.decide(decision(f, next))).status).toBe("succeeded");
    },
  );
  it.each(["credential", "member", "project", "posture"] as const)(
    "revoked %s is checked inside delayed execution",
    async (change) => {
      const f = await fixture("require_approval"),
        s = service(),
        pending = await s.submit(f.auth, f.request);
      if (change === "credential")
        await sql("update api_keys set revoked_at=now() where id=$1", [
          f.auth.apiKeyId,
        ]);
      if (change === "member")
        await sql("update members set status='disabled' where id=$1", [
          f.memberId,
        ]);
      if (change === "project")
        await sql("delete from project_groups where project_id=$1", [
          f.projectId,
        ]);
      if (change === "posture")
        await sql("delete from group_members where member_id=$1", [f.memberId]);
      expect(await s.decide(decision(f, pending))).toMatchObject({
        status: "denied",
        error: { code: "revoked_authorization" },
      });
      expect((await counts()).effects).toBe(0);
    },
  );
  it("scopes deciders inside service and status by live owner access", async () => {
    const f = await fixture("require_approval"),
      s = service(),
      pending = await s.submit(f.auth, f.request),
      other = await fixture();
    await expect(
      s.decide({ ...decision(f, pending), teamId: other.teamId }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      s.decide({ ...decision(f, pending), deciderMemberId: other.admin }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      s.decide({ ...decision(f, pending), deciderMemberId: f.memberId }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(s.status(other.auth, pending.action_id)).rejects.toMatchObject(
      { code: "not_found" },
    );
    // Even a same-team administrator with project visibility is not the owner.
    const sameTeamAdminKey = await keyFor(f.teamId, f.admin);
    await expect(s.status(sameTeamAdminKey, pending.action_id)).rejects.toMatchObject({
      code: "not_found",
    });
    await sql("delete from project_groups where project_id=$1", [f.projectId]);
    await expect(s.status(f.auth, pending.action_id)).rejects.toMatchObject({
      code: "not_found",
    });
  });
  it("capability off preserves history and blocks pending approval execution", async () => {
    const f = await fixture("require_approval");
    let on = true;
    const s = service(effect, () => on),
      pending = await s.submit(f.auth, f.request);
    on = false;
    expect(await s.status(f.auth, pending.action_id)).toEqual(pending);
    await expect(s.decide(decision(f, pending))).rejects.toMatchObject({
      code: "capability_unavailable",
    });
    expect((await counts()).effects).toBe(0);
    on = true;
    const final = await s.decide(decision(f, pending));
    on = false;
    expect(await s.status(f.auth, final.action_id)).toEqual(final);
    expect(await s.submit(f.auth, f.request)).toEqual(final);
  });
  it("rotated credential can read terminal history but cannot execute an older request", async () => {
    const f = await fixture(),
      s = service(),
      final = await s.submit(f.auth, f.request);
    await sql("update api_keys set revoked_at=now() where id=$1", [
      f.auth.apiKeyId,
    ]);
    const rotated = await keyFor(f.teamId, f.memberId);
    expect(await s.status(rotated, final.action_id)).toEqual(final);
    expect(await s.submit(rotated, f.request)).toEqual(final);
    await expect(s.status(f.auth, final.action_id)).rejects.toMatchObject({
      code: "unauthorized",
    });
  });
  it.each(["title", "body"] as const)("rejects NUL in note %s with 422 before any durable acceptance", async field => {
    const f = await fixture();
    const keyId = (await sql("select key_id from api_keys where id=$1", [f.auth.apiKeyId])).rows[0].key_id;
    const response = await createGovernedActionHttp(service({ ...effect, type: "note.append" })).submit(
      new Request("http://local/api/v1/actions/submit", {
        method: "POST",
        headers: { authorization: `Bearer aios_${keyId}_synthetic`, "content-type": "application/json" },
        body: JSON.stringify({ contract_version: "mcp-next/1", type: "note.append",
          destination: { project_id: f.projectId }, params: { title: "Note", body: "Content", [field]: "exact\u0000content" } }),
      }),
    );
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: { code: "invalid_payload" } });
    expect(await counts()).toEqual({ effects: 0, actions: 0, identities: 0 });
    expect((await sql(`select
      (select count(*)::int from audit_log where team_id=$1 and action like 'governed.%') audits,
      (select count(*)::int from approval_requests where team_id=$1) approvals,
      (select count(*)::int from items where team_id=$1) items,
      (select count(*)::int from governed_item_origins where team_id=$1) origins`, [f.teamId])).rows[0])
      .toEqual({ audits: 0, approvals: 0, items: 0, origins: 0 });
  });
  it("notes reuse active/succeeded attempts and retain denied history before fresh authorization", async () => {
    const f = await fixture("deny");
    const note: SubmitRequest = {
      contract_version: "mcp-next/1",
      type: "note.append",
      destination: { project_id: f.projectId },
      params: { title: "same", body: "exact\tcontent\r\n" },
    };
    const consumer: GovernedConsumer = {
      ...effect,
      type: "note.append",
      async execute(c, r) {
        const e = await effect.execute(c, r);
        return { ...e, entity: { ...e.entity, kind: "note" } };
      },
    };
    const s = service(consumer),
      denied = await s.submit(f.auth, note);
    expect(denied.status).toBe("denied");
    await sql("update policies set effect='allow' where id=$1", [f.policyId]);
    const succeeded = await s.submit(f.auth, note);
    expect(succeeded.status).toBe("succeeded");
    expect(succeeded.action_id).not.toBe(denied.action_id);
    expect(await s.status(f.auth, denied.action_id)).toEqual(denied);
    expect(await s.submit(f.auth, note)).toEqual(succeeded);
    expect(await counts()).toEqual({ effects: 1, actions: 2, identities: 1 });
  });
  it("unrelated identities execute concurrently without deadlock and bound adapters see own writes", async () => {
    const f = await fixture();
    const both = latch();
    let entered = 0;
    const s = service({
      ...effect,
      async execute(c, r) {
        const result = await effect.execute(c, r);
        const own = await c.db
          .from("governed_fixture_effects")
          .select("id", { count: "exact" })
          .eq("id", result.entity.id);
        expect(own.error).toBeNull();
        expect(own.count).toBe(1);
        if (++entered === 2) both.release();
        await both.wait;
        return result;
      },
    });
    const results = await Promise.all([
      s.submit(f.auth, f.request),
      s.submit(f.auth, {
        ...f.request,
        params: { ...f.request.params, operation_id: "other" },
      }),
    ]);
    expect(results.map((r) => r.status)).toEqual(["succeeded", "succeeded"]);
    expect((await counts()).effects).toBe(2);
  });
  it("request audit failure rolls back the identity and leaves no accepted request", async () => {
    const f = await fixture();
    await sql(
      "create or replace function governed_test_request_fail() returns trigger language plpgsql as $$ begin if new.action='governed.requested' then raise exception 'fixture fault'; end if; return new; end $$",
    );
    await sql(
      "create trigger governed_test_request_fail before insert on audit_log for each row execute function governed_test_request_fail()",
    );
    try {
      await expect(service().submit(f.auth, f.request)).rejects.toMatchObject({
        code: "unavailable",
      });
      expect(await counts()).toEqual({ effects: 0, actions: 0, identities: 0 });
    } finally {
      await sql("drop trigger governed_test_request_fail on audit_log");
      await sql("drop function governed_test_request_fail()");
    }
  });
  it("invalid consumer outcome rolls back effects instead of recording success", async () => {
    const f = await fixture();
    const s = service({
      ...effect,
      async execute(c, r) {
        const result = await effect.execute(c, r);
        return { ...result, entity: { ...result.entity, revision: "" } };
      },
    });
    await expect(s.submit(f.auth, f.request)).rejects.toMatchObject({
      code: "unavailable",
    });
    expect((await counts()).effects).toBe(0);
    expect((await service().submit(f.auth, f.request)).status).toBe(
      "succeeded",
    );
  });
  it("credential in-place rotation denies an unresolved original execution", async () => {
    const f = await fixture();
    await expect(
      service({
        ...effect,
        async execute() {
          throw new Error("interrupt");
        },
      }).submit(f.auth, f.request),
    ).rejects.toMatchObject({ code: "unavailable" });
    await sql("update api_keys set key_hash=$2 where id=$1", [
      f.auth.apiKeyId,
      sha("rotated"),
    ]);
    const auth = { ...f.auth, credentialFingerprint: sha("rotated") };
    expect(await service().submit(auth, f.request)).toMatchObject({
      status: "denied",
      error: { code: "revoked_authorization" },
    });
    expect((await counts()).effects).toBe(0);
  });
  it("deadline destroys the connection and fences a late callback before recovery", async () => {
    const f = await fixture(),
      entered = latch(),
      release = latch(),
      late = latch();
    let lateError: unknown;
    let backendId: number | undefined;
    const s = createGovernedActionService({
      enabled: () => true,
      transactionTimeoutMs: 100,
      consumers: [
        {
          ...effect,
          async execute(c, r) {
            backendId = (
              await c.query<{ pid: number }>("select pg_backend_pid() pid")
            ).rows[0].pid;
            await effect.execute(c, r);
            entered.release();
            await release.wait;
            try {
              await c.query(
                "insert into governed_fixture_effects(id,team_id) values($1,$2)",
                [randomUUID(), c.teamId],
              );
            } catch (e) {
              lateError = e;
            } finally {
              late.release();
            }
            return {
              entity: { kind: "task", id: randomUUID(), revision: "late" },
              sync: { state: "not_applicable", providers: [] },
            };
          },
        },
      ],
    });
    const result = s.submit(f.auth, f.request);
    const failed = expect(result).rejects.toMatchObject({
      code: "unavailable",
    });
    await entered.wait;
    await failed;
    expect((await counts()).effects).toBe(0);
    const recovered = await service().submit(f.auth, f.request);
    expect(recovered.status).toBe("succeeded");
    expect(
      (
        await sql("select count(*)::int n from pg_stat_activity where pid=$1", [
          backendId,
        ])
      ).rows[0].n,
    ).toBe(0);
    release.release();
    await late.wait;
    expect(lateError).toMatchObject({ code: "unavailable" });
    expect((await counts()).effects).toBe(1);
    expect(await service().status(f.auth, recovered.action_id)).toEqual(
      recovered,
    );
  });
  it("never executes from an approval changed outside the governed transaction", async () => {
    const f = await fixture("require_approval"),
      s = service(),
      pending = await s.submit(f.auth, f.request);
    const d = decision(f, pending);
    await sql(
      "update approval_requests set status='approved',decided_by=$2,decided_at=now() where id=$1",
      [d.approvalRequestId, f.admin],
    );
    const result = await s.decide(d);
    expect(result).toMatchObject({
      status: "denied",
      error: { code: "revoked_authorization" },
    });
    expect((await counts()).effects).toBe(0);
    expect(await s.submit(f.auth, f.request)).toEqual(result);
    expect(
      (
        await sql("select action from audit_log where id=$1", [
          result.audit_ref,
        ])
      ).rows[0].action,
    ).toBe("governed.inconsistent_approval");
  });
  it("a context from a completed transaction cannot write through a reused connection", async () => {
    const f = await fixture();
    let stale: GovernedContext | undefined;
    const first = service({
      ...effect,
      async execute(c, r) {
        stale = c;
        return effect.execute(c, r);
      },
    });
    await first.submit(f.auth, f.request);
    const entered = latch(),
      release = latch();
    const second = service({
      ...effect,
      async execute(c, r) {
        entered.release();
        await release.wait;
        return effect.execute(c, r);
      },
    }).submit(f.auth, {
      ...f.request,
      params: { ...f.request.params, operation_id: "second" },
    });
    await entered.wait;
    try {
      await expect(
        stale!.query(
          "insert into governed_fixture_effects(id,team_id) values($1,$2)",
          [randomUUID(), f.teamId],
        ),
      ).rejects.toMatchObject({ code: "unavailable" });
    } finally {
      release.release();
    }
    expect((await second).status).toBe("succeeded");
    expect((await counts()).effects).toBe(2);
  });
  it("server termination while callback is idle rolls back, recovers and fences old work", async () => {
    const f = await fixture(),
      entered = latch(),
      release = latch(),
      late = latch();
    let pid = 0;
    let lateError: unknown;
    const s = service({
      ...effect,
      async execute(c, r) {
        pid = (await c.query<{ pid: number }>("select pg_backend_pid() pid"))
          .rows[0].pid;
        await effect.execute(c, r);
        entered.release();
        await release.wait;
        try {
          await c.query("select 1");
        } catch (e) {
          lateError = e;
        } finally {
          late.release();
        }
        return {
          entity: { kind: "task", id: randomUUID(), revision: "late" },
          sync: { state: "not_applicable", providers: [] },
        };
      },
    });
    const result = s.submit(f.auth, f.request);
    const failed = expect(result).rejects.toMatchObject({
      code: "unavailable",
    });
    await entered.wait;
    await sql("select pg_terminate_backend($1)", [pid]);
    await failed;
    expect((await counts()).effects).toBe(0);
    const recovered = await service().submit(f.auth, f.request);
    expect(recovered.status).toBe("succeeded");
    release.release();
    await late.wait;
    expect(lateError).toMatchObject({ code: "unavailable" });
    expect((await counts()).effects).toBe(1);
  });
  it("live oracle faults are unavailable, never durable denials", async () => {
    const f = await fixture();
    await sql("alter table project_groups rename to governed_hidden_grants");
    try {
      await expect(service().submit(f.auth, f.request)).rejects.toMatchObject({
        code: "unavailable",
      });
      expect((await counts()).actions).toBe(0);
    } finally {
      await sql("alter table governed_hidden_grants rename to project_groups");
    }
    expect((await service().submit(f.auth, f.request)).status).toBe(
      "succeeded",
    );
  });
});
