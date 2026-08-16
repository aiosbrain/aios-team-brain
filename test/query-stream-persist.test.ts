import { describe, it, expect, vi, beforeEach } from "vitest";
import type { RetrievedContext } from "@/lib/query/retrieve";

// Spec: docs/design/query-background-stream.md — acceptance criteria 2 and 5.
// The turn must complete and persist EXACTLY ONCE even when the client vanishes mid-answer (which
// previously threw inside `send` and skipped every write, losing the message AND the query_log row for
// an answer the provider had already billed), and the persisted error must be the SANITIZED text.

const streamAnswerMock = vi.fn();
const appendMessageMock = vi.fn();
const generateAndSetTitleMock = vi.fn();
const recordLlmUsageMock = vi.fn();
const flushPartialMock = vi.fn();
const finishRunMock = vi.fn();
const failRunMock = vi.fn();

vi.mock("@/lib/query/claude", () => ({ streamAnswer: (...a: unknown[]) => streamAnswerMock(...a) }));
vi.mock("@/lib/chat/store", () => ({ appendMessage: (...a: unknown[]) => appendMessageMock(...a) }));
vi.mock("@/lib/chat/title", () => ({ generateAndSetTitle: (...a: unknown[]) => generateAndSetTitleMock(...a) }));
vi.mock("@/lib/costs/llm-usage", () => ({ recordLlmUsage: (...a: unknown[]) => recordLlmUsageMock(...a) }));
vi.mock("@/lib/query/turn-runs", () => ({
  flushPartial: (...a: unknown[]) => flushPartialMock(...a),
  finishRun: (...a: unknown[]) => finishRunMock(...a),
  failRun: (...a: unknown[]) => failRunMock(...a),
}));

const { runAnswerTurn } = await import("@/lib/query/stream-persist");

const USAGE = {
  input_tokens: 10,
  output_tokens: 20,
  cache_read_tokens: 0,
  cost_usd: 0.001,
  provider: "openrouter",
  model: "test-model",
  estimated: false,
};

/** Records every table insert so "exactly once" is checked against real call counts. */
function fakeDb() {
  const inserts: { table: string; row: Record<string, unknown> }[] = [];
  return {
    inserts,
    from(table: string) {
      return {
        insert: async (row: Record<string, unknown>) => {
          inserts.push({ table, row });
          return { error: null };
        },
      };
    },
  };
}

const ctx = { sources: [], structured: "", grounded: true } as unknown as RetrievedContext;

function baseArgs(db: ReturnType<typeof fakeDb>, send: (e: string, d: unknown) => void) {
  return {
    db: db as never,
    owner: { teamId: "team-1", memberId: "member-1" },
    conversationId: "convo-1",
    runId: "run-1",
    question: "what shipped?",
    ctx,
    keys: {},
    historyTurns: [],
    caller: {},
    timeZone: "UTC",
    createdNew: false,
    startedAt: 0,
    send,
    now: () => 1_000_000,
  };
}

beforeEach(() => {
  for (const m of [
    streamAnswerMock, appendMessageMock, generateAndSetTitleMock,
    recordLlmUsageMock, flushPartialMock, finishRunMock, failRunMock,
  ]) m.mockReset();
  appendMessageMock.mockResolvedValue("msg-1");
  recordLlmUsageMock.mockResolvedValue(undefined);
  finishRunMock.mockResolvedValue(undefined);
  failRunMock.mockResolvedValue(undefined);
  flushPartialMock.mockResolvedValue(undefined);
});

function okStream() {
  return (async function* () {
    yield { type: "delta", text: "the answer" };
    yield { type: "done", usage: USAGE };
  })();
}

describe("runAnswerTurn — the turn outlives its client", () => {
  it("persists message + query_log + usage exactly once on a normal turn", async () => {
    streamAnswerMock.mockReturnValue(okStream());
    const db = fakeDb();
    const sent: string[] = [];
    await runAnswerTurn(baseArgs(db, (e) => sent.push(e)));

    expect(appendMessageMock).toHaveBeenCalledTimes(1);
    expect(db.inserts.filter((i) => i.table === "query_log")).toHaveLength(1);
    expect(recordLlmUsageMock).toHaveBeenCalledTimes(1);
    expect(finishRunMock).toHaveBeenCalledTimes(1);
    expect(sent).toEqual(["delta", "sources", "done"]);
  });

  it("STILL persists exactly once when the client disconnected (send throws → swallowed by caller's no-op)", async () => {
    streamAnswerMock.mockReturnValue(okStream());
    const db = fakeDb();
    // A `send` that has gone dead. The route makes it a no-op after cancel; here we assert that even a
    // THROWING sink cannot take down persistence — the failure mode that lost the writes before.
    const deadSend = () => {
      throw new Error("client gone: controller is closed");
    };
    await expect(runAnswerTurn(baseArgs(db, deadSend as never))).resolves.toBeUndefined();

    expect(appendMessageMock).toHaveBeenCalledTimes(1);
    expect(db.inserts.filter((i) => i.table === "query_log")).toHaveLength(1);
    expect(recordLlmUsageMock).toHaveBeenCalledTimes(1);
    expect(finishRunMock).toHaveBeenCalledWith(expect.anything(), "run-1", "msg-1");
  });

  it("writes the assistant message BEFORE flipping the run to done (partial→final ordering)", async () => {
    streamAnswerMock.mockReturnValue(okStream());
    const order: string[] = [];
    appendMessageMock.mockImplementation(async () => {
      order.push("appendMessage");
      return "msg-1";
    });
    finishRunMock.mockImplementation(async () => {
      order.push("finishRun");
    });
    await runAnswerTurn(baseArgs(fakeDb(), () => {}));
    expect(order).toEqual(["appendMessage", "finishRun"]);
  });

  it("records the SANITIZED error on the run — never the raw provider text", async () => {
    const raw = new Error("LLM secret-model-x @ https://internal.openrouter.ai/api/v1: 529 overloaded");
    streamAnswerMock.mockReturnValue(
      (async function* () {
        throw raw;
      })()
    );
    const db = fakeDb();
    const sent: { event: string; data: unknown }[] = [];
    await runAnswerTurn(baseArgs(db, (event, data) => sent.push({ event, data })));

    expect(failRunMock).toHaveBeenCalledTimes(1);
    const persisted = String(failRunMock.mock.calls[0][2]);
    expect(persisted).not.toContain("openrouter.ai");
    expect(persisted).not.toContain("secret-model-x");
    expect(persisted).toMatch(/busy|try again/i);
    // …and the same sanitized text goes to the client.
    const err = sent.find((s) => s.event === "error");
    expect((err?.data as { message: string }).message).toBe(persisted);
    // A failed turn writes no assistant message and no spend rows.
    expect(appendMessageMock).not.toHaveBeenCalled();
    expect(db.inserts.filter((i) => i.table === "query_log")).toHaveLength(0);
  });

  it("keeps streaming when a heartbeat flush fails (observability must not break the answer)", async () => {
    streamAnswerMock.mockReturnValue(okStream());
    flushPartialMock.mockRejectedValue(new Error("db blip"));
    const db = fakeDb();
    await runAnswerTurn({ ...baseArgs(db, () => {}), now: (() => { let t = 0; return () => (t += 10_000); })() });
    // The turn still completed and persisted despite the failing flush.
    expect(appendMessageMock).toHaveBeenCalledTimes(1);
    expect(finishRunMock).toHaveBeenCalledTimes(1);
  });

  it("does not touch run bookkeeping when there is no run row", async () => {
    streamAnswerMock.mockReturnValue(okStream());
    await runAnswerTurn({ ...baseArgs(fakeDb(), () => {}), runId: null });
    expect(flushPartialMock).not.toHaveBeenCalled();
    expect(finishRunMock).not.toHaveBeenCalled();
  });
});
