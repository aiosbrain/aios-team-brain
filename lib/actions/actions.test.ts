import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DbClient } from "@/lib/db/types";
import { LegacyActionPersistenceFault, runAction, resolveApproval } from "@/lib/actions";
import type { ActionHandler, SandboxRunner } from "@/lib/actions";
import { FakeSupabase } from "@/lib/ingest/fake-supabase";
import type { Principal } from "@/lib/policy/evaluate";

const PRINCIPAL: Principal = { role: "member", tier: "team", actor: "agent-x" };
const TEAM = "00000000-0000-4000-8000-00000000feed";
const OTHER_TEAM = "00000000-0000-4000-8000-00000000beef";
const DECISIONS = ["approved", "denied"] as const;

afterEach(() => {
  vi.restoreAllMocks();
});

function seedPolicy(fake: FakeSupabase, over: Record<string, unknown>) {
  fake.tables.policies ??= [];
  fake.tables.policies.push({
    id: `p-${fake.tables.policies.length}`,
    team_id: TEAM,
    priority: 0,
    subject_role: null,
    subject_tier: null,
    subject_actor: null,
    action: "*",
    resource: "*",
    effect: "deny",
    enabled: true,
    ...over,
  });
}

const base = (_fake: FakeSupabase) => ({
  teamId: TEAM,
  principal: PRINCIPAL,
  memberId: "mem-1",
  apiKeyId: "key-1",
});

/** A recording handler, so resumption is observable without the ingest path. */
function probe() {
  const execute = vi.fn(async () => ({ ok: true, output: { done: true } }));
  const handlers: ActionHandler[] = [{ type: "probe.do", execute }];
  return { execute, handlers };
}

// Direct seeds for tuples runAction never produces (a paused producer, contradictory links, a
// standalone approval). Orchestration shape only — the real-Postgres tier owns the durable proof.
function seedApproval(fake: FakeSupabase, over: Record<string, unknown> = {}): string {
  const id = typeof over.id === "string" ? over.id : randomUUID();
  fake.tables.approval_requests ??= [];
  fake.tables.approval_requests.push({ team_id: TEAM, status: "pending", context: {}, ...over, id });
  return id;
}

function seedAction(fake: FakeSupabase, over: Record<string, unknown> = {}): string {
  const id = randomUUID();
  fake.tables.actions ??= [];
  fake.tables.actions.push({
    team_id: TEAM,
    member_id: "mem-1",
    actor: "agent-x",
    action_type: "probe.do",
    resource: "*",
    params: {},
    status: "pending_approval",
    approval_request_id: null,
    ...over,
    id,
  });
  return id;
}

const durable = (fake: FakeSupabase) =>
  structuredClone({
    approvals: fake.tables.approval_requests ?? [],
    actions: fake.tables.actions ?? [],
    items: fake.tables.items,
    audit: fake.tables.audit_log,
  });

describe("runAction gating", () => {
  it("denies when no policy allows (default-deny)", async () => {
    const fake = new FakeSupabase();
    const out = await runAction(fake as unknown as DbClient, {
      ...base(fake),
      request: { type: "note.create", resource: "project:acme/x", params: {} },
    });
    expect(out.status).toBe("denied");
    expect(out.decision).toBe("deny");
    expect(fake.tables.actions[0].status).toBe("denied");
  });

  it("queues for approval when policy requires it", async () => {
    const fake = new FakeSupabase();
    seedPolicy(fake, { effect: "require_approval", action: "note.*", priority: 5 });
    const out = await runAction(fake as unknown as DbClient, {
      ...base(fake),
      request: { type: "note.create", resource: "project:acme/x", params: { project: "acme", path: "p", body: "b" } },
    });
    expect(out.status).toBe("pending_approval");
    expect(out.approvalRequestId).toBeTruthy();
    expect(fake.tables.approval_requests).toHaveLength(1);
    expect(fake.tables.actions[0].approval_request_id).toBe(out.approvalRequestId);
  });

  it("executes note.create when allowed (writes an item via the ingest path)", async () => {
    const fake = new FakeSupabase();
    seedPolicy(fake, { effect: "allow", action: "note.create", priority: 1 });
    const out = await runAction(fake as unknown as DbClient, {
      ...base(fake),
      request: {
        type: "note.create",
        resource: "project:acme/notes/hello.md",
        params: { project: "acme", path: "notes/hello.md", body: "hello world", access: "team" },
      },
    });
    expect(out.status).toBe("succeeded");
    expect(fake.tables.items).toHaveLength(1);
    expect(fake.tables.items[0].body).toBe("hello world");
    expect(out.result?.item_id).toBeTruthy();
  });

  it("fails closed on code.run with no sandbox configured", async () => {
    const fake = new FakeSupabase();
    seedPolicy(fake, { effect: "allow", action: "code.run", priority: 1 });
    const out = await runAction(fake as unknown as DbClient, {
      ...base(fake),
      request: { type: "code.run", resource: "*", params: { code: "print(1)" } },
    });
    expect(out.status).toBe("failed");
    expect(out.error).toMatch(/no sandbox/);
  });

  it("runs code.run through an injected sandbox", async () => {
    const fake = new FakeSupabase();
    seedPolicy(fake, { effect: "allow", action: "code.run", priority: 1 });
    const sandbox: SandboxRunner = {
      configured: true,
      async run() {
        return { exitCode: 0, stdout: "ok", stderr: "" };
      },
    };
    const out = await runAction(
      fake as unknown as DbClient,
      { ...base(fake), request: { type: "code.run", resource: "*", params: { code: "print(1)" } } },
      { sandbox }
    );
    expect(out.status).toBe("succeeded");
    expect(out.result?.stdout).toBe("ok");
  });

  it("fails on an unknown action type even when allowed", async () => {
    const fake = new FakeSupabase();
    seedPolicy(fake, { effect: "allow", action: "*", priority: 1 });
    const out = await runAction(fake as unknown as DbClient, {
      ...base(fake),
      request: { type: "mystery.do", resource: "*", params: {} },
    });
    expect(out.status).toBe("failed");
    expect(out.error).toMatch(/no handler/);
    expect(fake.tables.actions[0].status).toBe("failed");
  });

  it("an unconfirmed completion is the fixed persistence fault: the handler ran once and its outcome is not rewritten", async () => {
    const fake = new FakeSupabase();
    seedPolicy(fake, { effect: "allow", action: "probe.do", priority: 1 });
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    // Another writer moves the row out of `running` while the handler is in flight, so the
    // terminal write matches nothing.
    const execute = vi.fn(async () => {
      fake.tables.actions[0].status = "denied";
      return { ok: true, output: { done: true } };
    });

    const run = runAction(
      fake as unknown as DbClient,
      { ...base(fake), request: { type: "probe.do", resource: "*", params: {} } },
      { handlers: [{ type: "probe.do", execute }] }
    );

    await expect(run).rejects.toBeInstanceOf(LegacyActionPersistenceFault);
    await expect(run).rejects.toThrow("action persistence unavailable");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(fake.tables.actions[0].status).toBe("denied");
    expect(fake.tables.actions[0].result).toBeUndefined();
    expect(fake.tables.audit_log.map((row) => row.action)).toEqual([]);
    expect(logged.mock.calls).toEqual([
      [
        "[legacy_action_persistence_fault]",
        {
          phase: "action_finish",
          teamId: TEAM,
          actionId: fake.tables.actions[0].id,
          dispatch: "attempted",
          outcome: "succeeded",
        },
      ],
    ]);
  });
});

describe("resolveApproval", () => {
  // Queue a note.create action behind a require_approval policy.
  async function queue(fake: FakeSupabase) {
    seedPolicy(fake, { effect: "require_approval", action: "note.*", priority: 5 });
    const out = await runAction(fake as unknown as DbClient, {
      ...base(fake),
      request: {
        type: "note.create",
        resource: "project:acme/notes/n.md",
        params: { project: "acme", path: "notes/n.md", body: "queued body", access: "team" },
      },
    });
    expect(out.status).toBe("pending_approval");
    return out.approvalRequestId!;
  }

  it("approve resumes the action and executes the handler", async () => {
    const fake = new FakeSupabase();
    const approvalRequestId = await queue(fake);
    const res = await resolveApproval(fake as unknown as DbClient, {
      teamId: TEAM,
      approvalRequestId,
      decision: "approved",
      deciderMemberId: "admin-1",
    });
    expect(res.status).toBe("approved");
    expect(res.actionStatus).toBe("succeeded");
    expect(fake.tables.items).toHaveLength(1);
    expect(fake.tables.items[0].body).toBe("queued body");
    expect(fake.tables.approval_requests[0].status).toBe("approved");
    expect(fake.tables.approval_requests[0].decided_by).toBe("admin-1");
    expect(fake.tables.actions[0].status).toBe("succeeded");
  });

  it("deny marks the action denied and runs nothing", async () => {
    const fake = new FakeSupabase();
    const approvalRequestId = await queue(fake);
    const res = await resolveApproval(fake as unknown as DbClient, {
      teamId: TEAM,
      approvalRequestId,
      decision: "denied",
      deciderMemberId: "admin-1",
      note: "not now",
    });
    expect(res.status).toBe("denied");
    expect(fake.tables.items ?? []).toHaveLength(0);
    expect(fake.tables.approval_requests[0].status).toBe("denied");
    expect(fake.tables.actions[0].status).toBe("denied");
  });

  it("guards against deciding twice", async () => {
    const fake = new FakeSupabase();
    const approvalRequestId = await queue(fake);
    await resolveApproval(fake as unknown as DbClient, { teamId: TEAM, approvalRequestId, decision: "approved", deciderMemberId: "a" });
    const again = await resolveApproval(fake as unknown as DbClient, { teamId: TEAM, approvalRequestId, decision: "denied", deciderMemberId: "a" });
    expect(again.status).toBe("already_decided");
    expect(fake.tables.approval_requests[0].status).toBe("approved");
    expect(fake.tables.actions[0].status).toBe("succeeded");
    expect(fake.tables.items).toHaveLength(1);
  });

  it.each([randomUUID(), "nope"])("returns not_found for an unknown approval id (%s)", async (approvalRequestId) => {
    const fake = new FakeSupabase();
    const res = await resolveApproval(fake as unknown as DbClient, {
      teamId: TEAM,
      approvalRequestId,
      decision: "approved",
      deciderMemberId: "a",
    });
    expect(res.status).toBe("not_found");
  });

  it.each(DECISIONS)("another team's approval id is not_found, exactly like an absent one, and nothing changes (%s)", async (decision) => {
    const fake = new FakeSupabase();
    const approvalRequestId = await queue(fake);
    const before = durable(fake);

    const res = await resolveApproval(fake as unknown as DbClient, {
      teamId: OTHER_TEAM,
      approvalRequestId,
      decision,
      deciderMemberId: "admin-of-other-team",
    });

    expect({ res, ...durable(fake) }).toEqual({ res: { approvalRequestId, status: "not_found" }, ...before });
  });

  it("a producer that has not linked yet is not_ready for both decisions; once it links, the decision proceeds", async () => {
    const fake = new FakeSupabase();
    const { execute, handlers } = probe();
    const actionId = seedAction(fake, { status: "requested" });
    const approvalRequestId = seedApproval(fake, { context: { params: {}, action_id: actionId } });
    const before = durable(fake);

    for (const decision of DECISIONS) {
      const res = await resolveApproval(
        fake as unknown as DbClient,
        { teamId: TEAM, approvalRequestId, decision, deciderMemberId: "admin-1" },
        { handlers }
      );
      expect(res).toEqual({ approvalRequestId, status: "not_ready" });
    }
    expect(durable(fake)).toEqual(before);
    expect(execute).not.toHaveBeenCalled();

    // The producer resumes: the same link runAction writes.
    Object.assign(fake.tables.actions[0], { status: "pending_approval", approval_request_id: approvalRequestId });
    const res = await resolveApproval(
      fake as unknown as DbClient,
      { teamId: TEAM, approvalRequestId, decision: "approved", deciderMemberId: "admin-1" },
      { handlers }
    );
    expect(res).toMatchObject({ status: "approved", actionId, actionStatus: "succeeded" });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(fake.tables.actions[0].status).toBe("succeeded");
  });

  it.each(["running", "succeeded", "failed", "denied"])(
    "a linked action already %s is not_ready: no claim, no replay",
    async (status) => {
      const fake = new FakeSupabase();
      const { execute, handlers } = probe();
      const approvalRequestId = randomUUID();
      const actionId = seedAction(fake, { status, approval_request_id: approvalRequestId });
      seedApproval(fake, { id: approvalRequestId, context: { action_id: actionId } });
      const before = durable(fake);

      const res = await resolveApproval(
        fake as unknown as DbClient,
        { teamId: TEAM, approvalRequestId, decision: "approved", deciderMemberId: "admin-1" },
        { handlers }
      );

      expect({ res, ...durable(fake) }).toEqual({ res: { approvalRequestId, status: "not_ready" }, ...before });
      expect(execute).not.toHaveBeenCalled();
    }
  );

  it("two actions linked to one approval are ambiguous_links: neither is claimed or dispatched", async () => {
    const fake = new FakeSupabase();
    const { execute, handlers } = probe();
    const approvalRequestId = randomUUID();
    const actionId = seedAction(fake, { approval_request_id: approvalRequestId });
    seedAction(fake, { approval_request_id: approvalRequestId });
    seedApproval(fake, { id: approvalRequestId, context: { action_id: actionId } });
    const before = durable(fake);

    const res = await resolveApproval(
      fake as unknown as DbClient,
      { teamId: TEAM, approvalRequestId, decision: "approved", deciderMemberId: "admin-1" },
      { handlers }
    );

    expect({ res, ...durable(fake) }).toEqual({ res: { approvalRequestId, status: "ambiguous_links" }, ...before });
    expect(execute).not.toHaveBeenCalled();
  });

  /** Seeds whatever actions the case needs and returns the approval's context. */
  type LinkSeed = (fake: FakeSupabase, approvalRequestId: string) => Record<string, unknown>;
  const MALFORMED: Array<{ name: string; seed: LinkSeed }> = [
    {
      name: "the forward marker names a different action than the reverse link",
      seed: (fake, approvalRequestId) => {
        seedAction(fake, { approval_request_id: approvalRequestId });
        return { action_id: seedAction(fake) };
      },
    },
    {
      name: "the reverse-linked action belongs to another team",
      seed: (fake, approvalRequestId) => ({
        action_id: seedAction(fake, { team_id: OTHER_TEAM, approval_request_id: approvalRequestId }),
      }),
    },
    {
      name: "the forward marker is not an action id",
      seed: () => ({ action_id: "not-an-id" }),
    },
    {
      name: "the forward marker names an action linked to another approval",
      seed: (fake) => ({ action_id: seedAction(fake, { approval_request_id: randomUUID() }) }),
    },
    {
      name: "a governed marker has no governed owner row (never a standalone approval)",
      seed: () => ({ governed_action_id: randomUUID() }),
    },
  ];

  it.each(MALFORMED)("malformed_links when $name: nothing is claimed or dispatched", async ({ seed }) => {
    const fake = new FakeSupabase();
    const { execute, handlers } = probe();
    const approvalRequestId = randomUUID();
    seedApproval(fake, { id: approvalRequestId, context: seed(fake, approvalRequestId) });
    const before = durable(fake);

    for (const decision of DECISIONS) {
      const res = await resolveApproval(
        fake as unknown as DbClient,
        { teamId: TEAM, approvalRequestId, decision, deciderMemberId: "admin-1" },
        { handlers }
      );
      expect(res).toEqual({ approvalRequestId, status: "malformed_links" });
    }
    expect(durable(fake)).toEqual(before);
    expect(execute).not.toHaveBeenCalled();
  });

  it("precedence: a decided legacy approval is already_decided before its links are read; a dangling governed marker stays malformed_links", async () => {
    const fake = new FakeSupabase();
    const legacy = seedApproval(fake, { status: "approved", context: { action_id: "not-an-id" } });
    const governed = seedApproval(fake, { status: "approved", context: { governed_action_id: randomUUID() } });
    const input = { teamId: TEAM, decision: "approved" as const, deciderMemberId: "admin-1" };

    expect(await resolveApproval(fake as unknown as DbClient, { ...input, approvalRequestId: legacy })).toEqual({
      approvalRequestId: legacy,
      status: "already_decided",
    });
    expect(await resolveApproval(fake as unknown as DbClient, { ...input, approvalRequestId: governed })).toEqual({
      approvalRequestId: governed,
      status: "malformed_links",
    });
  });

  it.each(DECISIONS)("a genuine standalone approval records the %s decision and dispatches nothing", async (decision) => {
    const fake = new FakeSupabase();
    const { execute, handlers } = probe();
    const approvalRequestId = seedApproval(fake, { context: { params: {} } });

    const res = await resolveApproval(
      fake as unknown as DbClient,
      { teamId: TEAM, approvalRequestId, decision, deciderMemberId: "admin-1", note: "standalone" },
      { handlers }
    );

    expect(res).toMatchObject({ approvalRequestId, status: decision, actionId: null });
    expect(fake.tables.approval_requests[0]).toMatchObject({
      status: decision,
      decided_by: "admin-1",
      decision_note: "standalone",
    });
    expect(fake.tables.actions ?? []).toEqual([]);
    expect(execute).not.toHaveBeenCalled();
  });
});

// The double's own contract for the two operations the checked transitions rely on. If either
// regressed to "always empty" / "always everything", the resolver cases above would stop
// discriminating a matched row from a missed one.
describe("FakeSupabase matched-row RETURNING and limit", () => {
  const things = () => {
    const fake = new FakeSupabase();
    fake.tables.things = [
      { id: "a", state: "open" },
      { id: "b", state: "open" },
      { id: "c", state: "done" },
    ];
    return fake;
  };

  it("update().select() returns exactly the rows it matched; a miss returns none and writes nothing", async () => {
    const fake = things();

    const hit = await fake.from("things").update({ state: "closed" }).eq("state", "open").select("id");
    expect(hit.data).toEqual([
      { id: "a", state: "closed" },
      { id: "b", state: "closed" },
    ]);

    const miss = await fake.from("things").update({ state: "reopened" }).eq("state", "open").select("id");
    expect(miss.data).toEqual([]);
    expect(fake.tables.things.map((row) => row.state)).toEqual(["closed", "closed", "done"]);
  });

  it("update() without select() still writes and returns no rows", async () => {
    const fake = things();
    const blind = await fake.from("things").update({ state: "closed" }).eq("id", "a");
    expect(blind.data).toEqual([]);
    expect(fake.tables.things[0].state).toBe("closed");
  });

  it("delete().select() returns the removed rows in table order and leaves the rest", async () => {
    const fake = things();
    const removed = await fake.from("things").delete().eq("state", "open").select("id");
    expect(removed.data).toEqual([
      { id: "a", state: "open" },
      { id: "b", state: "open" },
    ]);
    expect(fake.tables.things).toEqual([{ id: "c", state: "done" }]);
  });

  it("limit() bounds a select; an unbounded select is unchanged", async () => {
    const fake = things();
    expect((await fake.from("things").select("id").eq("state", "open").limit(1)).data).toEqual([{ id: "a", state: "open" }]);
    expect((await fake.from("things").select("id").limit(2)).data).toHaveLength(2);
    expect((await fake.from("things").select("id")).data).toHaveLength(3);
  });
});
