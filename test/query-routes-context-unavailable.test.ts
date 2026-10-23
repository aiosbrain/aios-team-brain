import { beforeEach, describe, expect, it, vi } from "vitest";
import { GraphProvenanceUnavailableError } from "@/lib/graph/provenance-read";
import { AttributionRepairPendingError } from "@/lib/access/authorization-epoch";

/**
 * AIO-1167 — both query routes finish enforced retrieval BEFORE a turn leaves any trace.
 *
 * A graph context whose authorization cannot be proven right now (`GraphProvenanceUnavailableError`,
 * `AttributionRepairPendingError`) is a retryable JSON refusal: no conversation is created or
 * touched, no message of either role is appended, no run is created, no `query_log` row is written,
 * no title or answer is generated and no SSE stream opens. Everything before retrieval (auth,
 * validation, staging refusal, minute throttle, daily count and team budget) keeps its outcome, and
 * a successful turn still reserves its API accounting before the stream.
 *
 * Every collaborator that writes is a spy that appends to one ordered event log, so "nothing was
 * written" and "retrieval came first" are the same assertion over the same record.
 */

const OWNED = "11111111-1111-4111-8111-111111111111";
const FOREIGN = "22222222-2222-4222-8222-222222222222";
const UNAVAILABLE_BODY = {
  code: "temporarily_unavailable",
  message: "query context is temporarily unavailable; retry shortly",
};

const h = vi.hoisted(() => {
  const events: string[] = [];
  const state = {
    sessionUser: { id: "auth-user-1" } as { id: string } | null,
    teamFound: true,
    spendAllowed: true,
    rateAllowed: true,
    todayCount: 0,
    spendRows: [] as Array<{ cost_usd: number }>,
    logInsertFails: false,
    apiKey: true,
    agent: true,
  };
  return { events, state };
});

/** The admin client: reads answer from `h.state`; every write is an event. */
function fakeDb() {
  return {
    from(table: string) {
      const ops: string[] = [];
      const record = (op: string) => {
        ops.push(op);
        h.events.push(`${table}.${op}`);
      };
      const result = () => {
        if (table === "query_log") {
          if (ops.includes("insert")) {
            return h.state.logInsertFails
              ? { data: null, error: { message: "accounting store unavailable" } }
              : { data: { id: "log-1" }, error: null };
          }
          if (ops.includes("update")) return { data: null, error: null };
          return { data: h.state.spendRows, count: h.state.todayCount, error: null };
        }
        if (table === "members") {
          return { data: { display_name: "Represented", email: "rep@test.local", actor_handle: "rep" }, error: null };
        }
        return { data: null, error: null };
      };
      const chain: Record<string, unknown> = {};
      for (const m of ["select", "eq", "gte", "is", "in", "order", "limit"]) chain[m] = () => chain;
      for (const m of ["insert", "update", "upsert", "delete"]) chain[m] = () => (record(m), chain);
      chain.single = async () => result();
      chain.maybeSingle = async () => result();
      chain.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
        Promise.resolve(result()).then(resolve, reject);
      return chain;
    },
  };
}

const spies = vi.hoisted(() => ({
  retrieve: vi.fn(),
  rateLimit: vi.fn(),
  resolveContentView: vi.fn(),
  streamAnswer: vi.fn(),
  runAnswerTurn: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ getSessionUser: async () => h.state.sessionUser }));
vi.mock("@/lib/db/server", () => ({
  serverClient: async () => ({
    from: (table: string) => {
      const chain: Record<string, unknown> = {};
      for (const m of ["select", "eq"]) chain[m] = () => chain;
      chain.maybeSingle = async () => {
        if (table === "teams") return { data: h.state.teamFound ? { id: "team-1" } : null };
        if (table === "members") {
          return { data: { id: "member-1", display_name: "Member", email: "m@test.local", actor_handle: "member" } };
        }
        return { data: null };
      };
      return chain;
    },
  }),
}));
vi.mock("@/lib/db/admin", () => ({ adminClient: () => fakeDb() }));
vi.mock("@/lib/access/posture", () => ({ resolveViewerPosture: async () => "team" }));
vi.mock("@/lib/api/rate-limit", () => ({ rateLimit: spies.rateLimit }));
vi.mock("@/lib/staging/runtime-policy", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  copiedStagingSpendAllowed: () => h.state.spendAllowed,
}));
vi.mock("@/lib/staging/ingest-policy", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  manualIngestionVerdict: async () => ({ allowed: true, code: null, message: null }),
}));
vi.mock("@/lib/ingest/manual-sync", () => ({
  isSyncCommand: (question: string) => question.trim() === "/sync",
  runManualSync: async () => ({ summary: "", created: 0, updated: 0, errors: 0 }),
}));
vi.mock("@/lib/api/audit", () => ({ audit: async () => undefined }));
vi.mock("@/lib/api/auth", () => ({
  isAgentBearer: (req: Request) => /^Bearer\s+aiosd_/.test(req.headers.get("authorization") || ""),
  authenticateApiKey: async () => (h.state.apiKey ? {
    teamId: "team-1", memberId: "member-1", memberTier: "team", memberRole: "member", apiKeyId: "key-1",
    actorHandle: "member", displayName: "Member", email: "m@test.local", isConnector: false,
  } : null),
  authenticateAgentToken: async () => (h.state.agent ? {
    kind: "agent", teamId: "team-1", memberId: "launcher-1", onBehalfOf: "represented-1",
    projectScope: null, memberTier: "team", agentTokenId: "token-1",
  } : null),
}));
vi.mock("@/lib/access/admission", () => ({
  resolveContentView: spies.resolveContentView,
  retrieveEnforceFor: () => ({ visibleItemIds: new Set<string>(), principal: "member" }),
}));
vi.mock("@/lib/access/enforce", () => ({
  delegatedVisibleItemIds: async () => ({ ids: new Set<string>(), projectIds: [] }),
}));
vi.mock("@/lib/query/retrieve", () => ({ retrieve: spies.retrieve }));
vi.mock("@/lib/query/answering", () => ({
  resolveAnsweringKeys: async () => (h.events.push("keys"), {}),
}));
vi.mock("@/lib/chat/store", () => ({
  ownsConversation: async (_db: unknown, _owner: unknown, id: string) => (h.events.push("ownsConversation"), id === OWNED),
  createConversation: async () => (h.events.push("conversation.create"), { id: "conversation-new" }),
  appendMessage: async (_db: unknown, _owner: unknown, _id: string, role: string) => (h.events.push(`message.${role}`), "message-1"),
}));
vi.mock("@/lib/chat/title", () => ({ generateAndSetTitle: async () => void h.events.push("title") }));
vi.mock("@/lib/costs/llm-usage", () => ({ recordLlmUsage: async () => void h.events.push("llm_usage") }));
vi.mock("@/lib/query/turn-runs", () => ({ createRun: async () => (h.events.push("run.create"), { id: "run-1" }) }));
vi.mock("@/lib/query/stream-persist", () => ({ runAnswerTurn: spies.runAnswerTurn }));
vi.mock("@/lib/query/claude", () => ({ streamAnswer: spies.streamAnswer }));

const dashboard = await import("@/app/api/dashboard/query/route");
const v1 = await import("@/app/api/v1/query/route");

type Body = Record<string, unknown>;
const dashboardRequest = (body: Body | string) => new Request("http://test.local/api/dashboard/query", {
  method: "POST", body: typeof body === "string" ? body : JSON.stringify({ team: "acme", ...body }),
}) as Parameters<typeof dashboard.POST>[0];
const v1Request = (body: Body | string, bearer = "aios_key1_secret") => new Request("http://test.local/api/v1/query", {
  method: "POST", headers: { authorization: `Bearer ${bearer}` },
  body: typeof body === "string" ? body : JSON.stringify(body),
}) as Parameters<typeof v1.POST>[0];

/** Everything that is not a pure read: what a refused turn must never have produced. */
const READS = new Set(["retrieve", "keys", "ownsConversation"]);
const traces = () => h.events.filter((event) => !READS.has(event));

const CONTEXT = { sources: [], structured: "", text: "" };
const USAGE = {
  input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cost_usd: 0,
  provider: "test", model: "test", estimated: false,
};

beforeEach(() => {
  h.events.length = 0;
  Object.assign(h.state, {
    sessionUser: { id: "auth-user-1" }, teamFound: true, spendAllowed: true, rateAllowed: true,
    todayCount: 0, spendRows: [], logInsertFails: false, apiKey: true, agent: true,
  });
  spies.retrieve.mockReset().mockImplementation(async () => (h.events.push("retrieve"), CONTEXT));
  spies.rateLimit.mockReset().mockImplementation(async () => h.state.rateAllowed);
  spies.resolveContentView.mockReset().mockResolvedValue({});
  spies.streamAnswer.mockReset().mockImplementation(async function* () {
    h.events.push("answer");
    yield { type: "delta", text: "ok" };
    yield { type: "done", usage: USAGE };
  });
  spies.runAnswerTurn.mockReset().mockImplementation(async (args: { send: (e: string, d: unknown) => void }) => {
    h.events.push("answer");
    args.send("done", USAGE);
  });
});

const failRetrieval = (error: Error) => spies.retrieve.mockImplementation(async () => {
  h.events.push("retrieve");
  throw error;
});

async function expectUnavailable(res: Response): Promise<void> {
  expect(res.status).toBe(503);
  expect(res.headers.get("content-type")).toContain("application/json");
  expect(res.headers.get("content-type")).not.toContain("text/event-stream");
  const body = await res.json();
  expect(body).toEqual({ error: { ...UNAVAILABLE_BODY, request_id: expect.stringMatching(/^[0-9a-f-]{36}$/) } });
  expect(Object.keys(body.error).sort()).toEqual(["code", "message", "request_id"]);
}

const UNAVAILABLE = [
  ["GraphProvenanceUnavailableError", () => new GraphProvenanceUnavailableError("raw provider detail must not leak")],
  ["AttributionRepairPendingError", () => new AttributionRepairPendingError()],
] as const;
const CONVERSATIONS = [["new", undefined], ["owned", OWNED], ["foreign", FOREIGN]] as const;
const CASES = UNAVAILABLE.flatMap(([error, make]) =>
  CONVERSATIONS.map(([conversation, id]) => ({ error, make, conversation, id })));

describe("POST /api/dashboard/query — retrieval before any turn state", () => {
  it.each(CASES)("$error with a $conversation conversation is a 503 that leaves no trace", async ({ make, id }) => {
    failRetrieval(make());

    const res = await dashboard.POST(dashboardRequest({ question: "who owns payments?", conversation_id: id }));

    await expectUnavailable(res);
    // Retrieval was reached (behind every gate) and is the ONLY thing that happened after them:
    // no ownership read, no conversation, no message, no run, no answering keys, no answer.
    expect(h.events).toEqual(["retrieve"]);
    expect(spies.runAnswerTurn).not.toHaveBeenCalled();
    // It still cost the minute throttle — and no daily quota, since query_log was only read.
    expect(spies.rateLimit).toHaveBeenCalledWith(expect.anything(), "member-1:query", 10);
  });

  it("an unrelated retrieval failure is not relabelled as retryable, and still leaves no trace", async () => {
    failRetrieval(new Error("unrelated retrieval defect"));
    await expect(dashboard.POST(dashboardRequest({ question: "q" }))).rejects.toThrow("unrelated retrieval defect");
    expect(traces()).toEqual([]);
  });

  it("an enforcement failure keeps its existing 500 and never enters retrieval", async () => {
    spies.resolveContentView.mockRejectedValue(new Error("oracle unavailable"));
    const res = await dashboard.POST(dashboardRequest({ question: "q", conversation_id: OWNED }));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatchObject({ code: "internal", message: "enforcement check failed" });
    expect(h.events).toEqual([]);
  });

  it.each([
    ["unauthenticated", () => { h.state.sessionUser = null; }, { question: "q" }, 401, "unauthorized"],
    ["not a member", () => { h.state.teamFound = false; }, { question: "q" }, 403, "forbidden"],
    ["invalid", () => {}, { question: "" }, 422, "invalid_payload"],
    ["staging-disabled", () => { h.state.spendAllowed = false; }, { question: "q" }, 503, "answering_disabled"],
    ["minute-limited", () => { h.state.rateAllowed = false; }, { question: "q" }, 429, "rate_limited"],
    ["daily-count-limited", () => { h.state.todayCount = 20; }, { question: "q" }, 429, "rate_limited"],
    ["team-budget-limited", () => { h.state.spendRows = [{ cost_usd: 10 }]; }, { question: "q" }, 429, "rate_limited"],
  ] as const)("a %s request keeps its outcome without entering retrieval", async (_label, arrange, body, status, code) => {
    arrange();
    const res = await dashboard.POST(dashboardRequest({ ...body, conversation_id: OWNED }));
    expect(res.status).toBe(status);
    expect((await res.json()).error.code).toBe(code);
    expect(spies.retrieve).not.toHaveBeenCalled();
    expect(traces()).toEqual([]);
  });

  it.each([["new", undefined, ["conversation.create", "message.user"]], ["owned", OWNED, ["message.user"]]] as const)(
    "a successful turn with a %s conversation retrieves first, then writes, then streams",
    async (_label, id, conversationWrites) => {
      const res = await dashboard.POST(dashboardRequest({ question: "q", conversation_id: id }));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");
      const text = await res.text();
      expect(text).toContain("event: done");
      expect(traces()).toEqual([...conversationWrites, "run.create", "answer"]);
      expect(h.events.indexOf("retrieve")).toBe(0);
    },
  );
});

describe("POST /api/v1/query — retrieval before any turn state, accounting before the stream", () => {
  it.each(CASES)("$error with a $conversation conversation is a 503 that leaves no trace", async ({ make, id }) => {
    failRetrieval(make());

    const res = await v1.POST(v1Request({ question: "who owns payments?", conversation_id: id }));

    await expectUnavailable(res);
    expect(h.events).toEqual(["retrieve"]);
    expect(spies.streamAnswer).not.toHaveBeenCalled();
    expect(spies.rateLimit).toHaveBeenCalledWith(expect.anything(), "member-1:query", 10);
  });

  it.each(UNAVAILABLE)("a delegated token's %s is a stateless 503 throttled on its launcher", async (_name, make) => {
    failRetrieval(make());

    const res = await v1.POST(v1Request({ question: "who owns payments?" }, "aiosd_token1_secret"));

    await expectUnavailable(res);
    expect(h.events).toEqual(["retrieve"]);
    expect(spies.rateLimit).toHaveBeenCalledWith(expect.anything(), "launcher-1:query", 10);
  });

  it("a delegated token passing a conversation id is refused before retrieval, as before", async () => {
    const res = await v1.POST(v1Request({ question: "q", conversation_id: OWNED }, "aiosd_token1_secret"));
    expect(res.status).toBe(422);
    expect(spies.retrieve).not.toHaveBeenCalled();
    expect(traces()).toEqual([]);
  });

  it("an unrelated retrieval failure is not relabelled as retryable, and reserves nothing", async () => {
    failRetrieval(new Error("unrelated retrieval defect"));
    await expect(v1.POST(v1Request({ question: "q" }))).rejects.toThrow("unrelated retrieval defect");
    expect(traces()).toEqual([]);
  });

  it("an enforcement failure keeps its existing 500 and never enters retrieval", async () => {
    spies.resolveContentView.mockRejectedValue(new Error("oracle unavailable"));
    const res = await v1.POST(v1Request({ question: "q" }));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatchObject({ code: "internal", message: "enforcement check failed" });
    expect(h.events).toEqual([]);
  });

  it.each([
    ["unauthenticated", () => { h.state.apiKey = false; }, { question: "q" }, 401, "unauthorized"],
    ["staging-disabled", () => { h.state.spendAllowed = false; }, { question: "q" }, 503, "answering_disabled"],
    ["minute-limited", () => { h.state.rateAllowed = false; }, { question: "q" }, 429, "rate_limited"],
    ["daily-count-limited", () => { h.state.todayCount = 20; }, { question: "q" }, 429, "rate_limited"],
    ["team-budget-limited", () => { h.state.spendRows = [{ cost_usd: 10 }]; }, { question: "q" }, 429, "rate_limited"],
    ["invalid", () => {}, { question: "" }, 422, "invalid_payload"],
  ] as const)("a %s request keeps its outcome without entering retrieval", async (_label, arrange, body, status, code) => {
    arrange();
    const res = await v1.POST(v1Request({ ...body, conversation_id: OWNED }));
    expect(res.status).toBe(status);
    expect((await res.json()).error.code).toBe(code);
    expect(spies.retrieve).not.toHaveBeenCalled();
    expect(traces()).toEqual([]);
  });

  it("a successful turn retrieves first, writes the thread, reserves query_log, and only then streams", async () => {
    const res = await v1.POST(v1Request({ question: "q" }));
    expect(res.status).toBe(200);
    await res.text();
    expect(h.events.indexOf("retrieve")).toBe(0);
    expect(traces()).toEqual([
      "conversation.create", "message.user", "query_log.insert",
      "answer", "message.assistant", "title", "query_log.update", "llm_usage",
    ]);
  });

  it("a successful delegated turn writes no thread but still reserves on its launcher before streaming", async () => {
    const res = await v1.POST(v1Request({ question: "q" }, "aiosd_token1_secret"));
    expect(res.status).toBe(200);
    await res.text();
    expect(traces()).toEqual(["query_log.insert", "answer", "query_log.update", "llm_usage"]);
  });

  it("a reservation failure after successful retrieval still prevents generation", async () => {
    h.state.logInsertFails = true;
    const res = await v1.POST(v1Request({ question: "q" }));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatchObject({ code: "internal", message: "query accounting failed" });
    expect(h.events.indexOf("retrieve")).toBe(0);
    expect(h.events).not.toContain("keys");
    expect(spies.streamAnswer).not.toHaveBeenCalled();
  });

  it("a stream that errors keeps its reservation", async () => {
    spies.streamAnswer.mockImplementation(async function* () {
      h.events.push("answer");
      yield { type: "delta", text: "partial" };
      throw new Error("provider dropped the stream");
    });
    const res = await v1.POST(v1Request({ question: "q" }));
    const text = await res.text();
    expect(text).toContain("event: error");
    expect(text).not.toContain("provider dropped the stream");
    expect(traces()).toEqual(["conversation.create", "message.user", "query_log.insert", "answer"]);
  });

  it("a client that disconnects mid-stream keeps its reservation", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    spies.streamAnswer.mockImplementation(async function* () {
      h.events.push("answer");
      yield { type: "delta", text: "partial" };
      await gate;
    });
    const res = await v1.POST(v1Request({ question: "q" }));
    const reader = res.body!.getReader();
    await reader.read();
    await reader.cancel();
    release();
    expect(h.events.indexOf("query_log.insert")).toBeLessThan(h.events.indexOf("answer"));
    expect(h.events).not.toContain("query_log.delete");
  });
});
