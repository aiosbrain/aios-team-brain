import { describe, expect, it } from "vitest";
import type { DbClient } from "@/lib/db/types";
import { runAction, resolveApproval } from "@/lib/actions";
import type { SandboxRunner } from "@/lib/actions";
import { FakeSupabase } from "@/lib/ingest/fake-supabase";
import type { Principal } from "@/lib/policy/evaluate";

const PRINCIPAL: Principal = { role: "member", tier: "team", actor: "agent-x" };

function seedPolicy(fake: FakeSupabase, over: Record<string, unknown>) {
  fake.tables.policies ??= [];
  fake.tables.policies.push({
    id: `p-${fake.tables.policies.length}`,
    team_id: "team-1",
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
  teamId: "team-1",
  principal: PRINCIPAL,
  memberId: "mem-1",
  apiKeyId: "key-1",
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
    await resolveApproval(fake as unknown as DbClient, { approvalRequestId, decision: "approved", deciderMemberId: "a" });
    const again = await resolveApproval(fake as unknown as DbClient, { approvalRequestId, decision: "denied", deciderMemberId: "a" });
    expect(again.status).toBe("already_decided");
  });

  it("returns not_found for an unknown approval id", async () => {
    const fake = new FakeSupabase();
    const res = await resolveApproval(fake as unknown as DbClient, {
      approvalRequestId: "nope",
      decision: "approved",
      deciderMemberId: "a",
    });
    expect(res.status).toBe("not_found");
  });
});
