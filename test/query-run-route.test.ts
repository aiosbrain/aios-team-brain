import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// Spec: docs/design/query-background-stream.md — acceptance criterion 6. The reattach endpoint is
// owner-scoped with NO RLS backstop, so this pins WHO gets what: a non-member is refused, a malformed
// id is rejected before it reaches Postgres, and a same-team non-owner gets the same shape as
// "no run" — deliberately not an existence oracle.

const h = vi.hoisted(() => ({
  owner: null as { teamId: string; memberId: string } | null,
  latestRun: vi.fn(),
}));

vi.mock("@/lib/chat/session", () => ({ resolveChatOwner: async () => h.owner }));
vi.mock("@/lib/db/admin", () => ({ adminClient: () => ({}) }));
vi.mock("@/lib/query/turn-runs", async () => {
  const actual = await vi.importActual<typeof import("@/lib/query/turn-runs")>("@/lib/query/turn-runs");
  return { ...actual, latestRun: h.latestRun };
});

const { GET } = await import("@/app/api/dashboard/conversations/[id]/run/route");

const CONVO = "11111111-2222-4333-8444-555555555555";
const call = (id = CONVO, team = "acme") =>
  GET(new NextRequest(`http://localhost/api/dashboard/conversations/${id}/run?team=${team}`), {
    params: Promise.resolve({ id }),
  });

const liveRun = (over: Record<string, unknown> = {}) => ({
  id: "run-1",
  conversation_id: CONVO,
  question: "what shipped?",
  status: "streaming",
  partial_text: "half an answer",
  error_message: null,
  final_message_id: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  ...over,
});

beforeEach(() => {
  h.owner = { teamId: "team-1", memberId: "member-1" };
  h.latestRun.mockReset();
});

describe("GET /api/dashboard/conversations/:id/run", () => {
  it("returns the live run to its owner, with the partial", async () => {
    h.latestRun.mockResolvedValue(liveRun());
    const res = await call();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.run.status).toBe("streaming");
    expect(body.run.partial).toBe("half an answer");
  });

  it("REFUSES a non-member with 403 (never reaches the run read)", async () => {
    h.owner = null;
    const res = await call();
    expect(res.status).toBe(403);
    expect(h.latestRun).not.toHaveBeenCalled();
  });

  it("rejects a malformed id with 422 before it reaches Postgres", async () => {
    const res = await call("not-a-uuid");
    expect(res.status).toBe(422);
    expect(h.latestRun).not.toHaveBeenCalled();
  });

  it("gives a same-team NON-owner the same shape as 'no run' — no existence oracle", async () => {
    // latestRun is owner-filtered, so someone else's conversation resolves to null for this member;
    // the response must be indistinguishable from a thread that simply has no run.
    h.latestRun.mockResolvedValue(null);
    const res = await call();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ run: null });
  });

  it("hides the partial once the turn has settled (the durable answer lives in chat_messages)", async () => {
    h.latestRun.mockResolvedValue(liveRun({ status: "done", partial_text: "leftover", final_message_id: "m1" }));
    const body = await (await call()).json();
    expect(body.run.status).toBe("done");
    expect(body.run.partial).toBe("");
    expect(body.run.final_message_id).toBe("m1");
  });

  it("reports a run orphaned by a deploy as error, with an explanation instead of a spinner", async () => {
    const dead = new Date(Date.now() - 10 * 60_000).toISOString();
    h.latestRun.mockResolvedValue(liveRun({ updated_at: dead }));
    const body = await (await call()).json();
    expect(body.run.status).toBe("error"); // still `streaming` in the table; the READ ages it out
    expect(body.run.error).toMatch(/interrupted|restart/i);
  });

  it("passes a recorded failure's SANITIZED message through unchanged", async () => {
    h.latestRun.mockResolvedValue(
      liveRun({ status: "error", error_message: "The model was busy. Please try again in a moment." })
    );
    const body = await (await call()).json();
    expect(body.run.error).toMatch(/busy/i);
    expect(body.run.error).not.toMatch(/http|openrouter|anthropic|api key/i);
  });
});
