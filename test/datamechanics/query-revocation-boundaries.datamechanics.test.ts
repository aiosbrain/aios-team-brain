import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getPool } from "@/lib/db/pg/pool";
import { CONTEXT_AUTHORIZATION_CLIENT_MESSAGE } from "@/lib/query/stream-retry";
import { recordGdriveItemClaim } from "@/lib/projects/context/gdrive-claims";
import { db, driveFixture } from "./helpers";
import {
  ITEM_TEXT, ask, expectNothingRevokedLeft, ownedConversation, stored, twoClaimFixture,
} from "./query-revocation-fixture";

// AIO-1167 R67 — the query's authorization runs from BEFORE the view that selects its content to
// every later consumer of what it produced. Real routes, real admission, real `retrieve` (with a
// configured reranker), the real `streamAnswer`, `runAnswerTurn` and title helper, and the real claim
// owner retiring connection A in Postgres while connection B keeps the document. Controlled: the
// provider/reranker transport (`fetch`), the answering keys, a pause inserted AFTER the real
// visibility resolvers return, and the dashboard session.

const probe = vi.hoisted(() => {
  // The reranker is a module-level setting of `retrieve`: configured before any import resolves it.
  process.env.RERANK_URL = "http://rerank.test/rerank";
  return {
    afterView: null as null | (() => Promise<void>),
    epochUnreadable: false,
    requests: [] as Array<{ kind: "rerank" | "answer" | "title"; body: string }>,
    answer: null as null | ((attempt: number) => Promise<Response>),
    title: null as null | (() => Promise<void>),
    beforeTitleHelper: null as null | (() => Promise<void>),
    // R69: awaits INSIDE the terminal persistence, where a revocation can commit between two steps.
    afterAssistant: null as null | (() => Promise<void>),
    duringAccounting: null as null | (() => Promise<void>),
    duringFinish: null as null | (() => Promise<void>),
    beforePublicationLock: null as null | (() => Promise<void>),
  };
});

vi.mock("@/lib/access/authorization-epoch", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/access/authorization-epoch")>();
  return {
    ...real,
    revocationEpoch: async (...args: Parameters<typeof real.revocationEpoch>) => {
      if (probe.epochUnreadable) throw new Error("authorization epoch read failed");
      return real.revocationEpoch(...args);
    },
    // R76: the publication/read lock — a seam to land a revocation just before it is taken.
    lockedRevocationEpoch: async (...args: Parameters<typeof real.lockedRevocationEpoch>) => {
      if (probe.beforePublicationLock) await probe.beforePublicationLock();
      return real.lockedRevocationEpoch(...args);
    },
  };
});
// A pause AFTER each real visibility resolver returned: the view is the reader's, accepted, and only
// then does a revocation commit.
vi.mock("@/lib/access/admission", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/access/admission")>();
  return {
    ...real,
    resolveContentView: async (...args: Parameters<typeof real.resolveContentView>) => {
      const view = await real.resolveContentView(...args);
      if (probe.afterView) await probe.afterView();
      return view;
    },
  };
});
vi.mock("@/lib/access/enforce", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/access/enforce")>();
  return {
    ...real,
    delegatedVisibleItemIds: async (...args: Parameters<typeof real.delegatedVisibleItemIds>) => {
      const view = await real.delegatedVisibleItemIds(...args);
      if (probe.afterView) await probe.afterView();
      return view;
    },
  };
});
vi.mock("@/lib/query/answering", () => ({
  resolveAnsweringKeys: async () => ({ openrouterKey: "test-key", openrouterModel: "test-model" }),
}));
// The REAL title helper, entered through a seam that lets a revocation land just before it.
vi.mock("@/lib/chat/title", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/chat/title")>();
  return {
    ...real,
    generateAndSetTitle: async (...args: Parameters<typeof real.generateAndSetTitle>) => {
      if (probe.beforeTitleHelper) await probe.beforeTitleHelper();
      return real.generateAndSetTitle(...args);
    },
  };
});
// The REAL owners, each entered through a seam that lets a revocation commit inside its await.
vi.mock("@/lib/chat/store", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/chat/store")>();
  return {
    ...real,
    appendMessage: async (...args: Parameters<typeof real.appendMessage>) => {
      const id = await real.appendMessage(...args);
      if (args[3] === "assistant" && probe.afterAssistant) await probe.afterAssistant();
      return id;
    },
  };
});
vi.mock("@/lib/costs/llm-usage", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/costs/llm-usage")>();
  return {
    ...real,
    recordLlmUsage: async (...args: Parameters<typeof real.recordLlmUsage>) => {
      if (args[1].source === "query" && probe.duringAccounting) await probe.duringAccounting();
      return real.recordLlmUsage(...args);
    },
  };
});
vi.mock("@/lib/query/turn-runs", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/query/turn-runs")>();
  return {
    ...real,
    finishRun: async (...args: Parameters<typeof real.finishRun>) => {
      if (probe.duringFinish) await probe.duringFinish();
      return real.finishRun(...args);
    },
  };
});
vi.mock("@/lib/auth/session", () => ({ getSessionUser: vi.fn() }));
vi.mock("@/lib/db/server", () => ({ serverClient: vi.fn() }));

const encoder = new TextEncoder();
const frame = (data: unknown) => encoder.encode(`data: ${JSON.stringify(data)}\n\n`);
const delta = (text: string) => frame({ choices: [{ delta: { content: text } }] });
const USAGE = frame({ choices: [], usage: { prompt_tokens: 7, completion_tokens: 5, cost: 0.002 } });

/** A provider stream whose chunks are produced one PULL at a time, so a step can run between them. */
function scripted(steps: Array<Uint8Array | (() => Promise<void>)>): Response {
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      while (index < steps.length) {
        const step = steps[index++];
        if (step instanceof Uint8Array) {
          controller.enqueue(step);
          return;
        }
        await step();
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return { ok: true, status: 200, body, text: async () => "" } as unknown as Response;
}

beforeEach(() => {
  Object.assign(probe, {
    afterView: null, epochUnreadable: false, requests: [], answer: null, title: null, beforeTitleHelper: null,
    afterAssistant: null, duringAccounting: null, duringFinish: null, beforePublicationLock: null,
  });
  let answers = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: unknown, init?: { body?: unknown }) => {
    const body = String(init?.body ?? "");
    if (String(url).includes("rerank.test")) {
      probe.requests.push({ kind: "rerank", body });
      const documents = (JSON.parse(body) as { documents: string[] }).documents;
      return new Response(JSON.stringify({
        results: documents.map((_doc, index) => ({ index, relevance_score: 1 - index / 10 })),
      }));
    }
    if (body.includes('"max_tokens":24')) {
      probe.requests.push({ kind: "title", body });
      if (probe.title) await probe.title();
      return new Response(JSON.stringify({ choices: [{ message: { content: "Ledger owner" } }], usage: {} }));
    }
    probe.requests.push({ kind: "answer", body });
    answers += 1;
    if (probe.answer) return probe.answer(answers);
    return scripted([delta("The owner is the payments desk "), delta("[S1]."), USAGE]);
  }));
});
afterEach(() => {
  vi.unstubAllGlobals();
});

async function fixture() {
  const context = await twoClaimFixture();
  // A second matching document the reader keeps through A after the ledger's claim is retired, so
  // the reranker always has two to order — and a stale view would hand it the revoked text too.
  const providerId = `ledger-memo-${randomUUID()}`;
  const memo = await driveFixture(context.seed, {
    project: "drive-ledger", path: `gdrive/${providerId}.md`, body: "zephyrquartz ledger memo",
    frontmatter: { source: "gdrive", source_id: providerId, title: "Zephyrquartz memo" },
  }, { unclaimed: true });
  await recordGdriveItemClaim(db(), {
    teamId: context.seed.teamId, integrationId: context.connectionA, providerId, itemId: memo.id,
    generation: 1, audienceProjectIds: [context.projectA],
  });
  return context;
}

const requested = (kind: "rerank" | "answer" | "title") => probe.requests.filter((request) => request.kind === kind);

async function conversationTitles(teamId: string): Promise<string[]> {
  const { rows } = await getPool().query<{ title: string }>(`select title from conversations where team_id=$1`, [teamId]);
  return rows.map((row) => row.title);
}

async function usageRows(teamId: string) {
  const { rows } = await getPool().query<{ source: string; output_tokens: number }>(
    `select source, output_tokens from llm_usage where team_id=$1 order by created_at`, [teamId]);
  return rows;
}

/** The stored output provenance per table (R76), oldest first. */
async function storedEpochs(teamId: string) {
  const pick = async (sql: string) =>
    (await getPool().query<{ e: string | null }>(sql, [teamId])).rows.map((row) => (row.e === null ? null : Number(row.e)));
  return {
    assistant: await pick(`select context_authorization_epoch::text as e from chat_messages where team_id=$1 and role='assistant' order by created_at`),
    user: await pick(`select context_authorization_epoch::text as e from chat_messages where team_id=$1 and role='user' order by created_at`),
    runs: await pick(`select context_authorization_epoch::text as e from chat_turn_runs where team_id=$1 order by created_at`),
    queryLog: await pick(`select context_authorization_epoch::text as e from query_log where team_id=$1 order by created_at`),
  };
}

async function currentEpoch(teamId: string): Promise<number> {
  const { rows } = await getPool().query<{ epoch: string }>(`select epoch::text from team_authorization_epochs where team_id=$1`, [teamId]);
  return Number(rows[0]?.epoch ?? 1);
}

/** A handshake: the code under test `arrive()`s and waits; the TEST (outside its transaction) acts, then `open()`s. */
function handshake() {
  let arrive!: () => void;
  let open!: () => void;
  const reached = new Promise<void>((resolve) => { arrive = resolve; });
  const opened = new Promise<void>((resolve) => { open = resolve; });
  return { reached, arrive, opened, open };
}

async function queryLogRows(teamId: string) {
  const { rows } = await getPool().query<{ answer_preview: string | null; cited: number; output_tokens: number }>(
    `select answer_preview, coalesce(cardinality(cited_item_ids), 0)::int as cited, output_tokens
       from query_log where team_id=$1`, [teamId]);
  return rows;
}

/** The run's final message pointer and the stored assistant message, read once the run settled. */
async function runCompletion(teamId: string) {
  const { rows } = await getPool().query<{ final_message_id: string | null; assistant_id: string | null }>(
    `select r.final_message_id,
            (select m.id from chat_messages m where m.team_id=$1 and m.role='assistant'
              order by m.created_at desc limit 1) as assistant_id
       from chat_turn_runs r where r.team_id=$1`, [teamId]);
  return rows[0];
}

async function settledRun(teamId: string) {
  for (let i = 0; i < 100; i += 1) {
    const { rows } = await getPool().query<{ status: string; partial_text: string; error_message: string | null }>(
      `select status, partial_text, error_message from chat_turn_runs where team_id=$1`, [teamId]);
    if (rows[0] && rows[0].status !== "streaming") return rows[0];
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("run never settled");
}

// ── P1-1: the authorization is captured BEFORE the view that selects content ─────────────────────

describe("AIO-1167 R67 pre-retrieval visibility race (real Postgres)", () => {
  it.each(["v1", "delegated", "dashboard"] as const)(
    "%s: A retired after the view resolved — refused, no reranker or answer dispatch, nothing stored",
    async (route) => {
      const { seed, key, agentToken, revokeA } = await fixture();
      probe.afterView = async () => {
        probe.afterView = null;
        await revokeA();
      };

      const res = await ask(route, seed, route === "delegated" ? agentToken : key);

      expect(res.status).toBe(503);
      const payload = await res.json() as { error: { code: string; message: string } };
      expect(payload.error).toEqual(expect.objectContaining({
        code: "temporarily_unavailable", message: CONTEXT_AUTHORIZATION_CLIENT_MESSAGE,
      }));
      expect(requested("rerank"), "no source text reached the reranker").toEqual([]);
      expect(requested("answer")).toEqual([]);
      const after = await stored(seed);
      expect(after.messages).not.toContain("assistant:");
      expectNothingRevokedLeft(JSON.stringify(payload) + JSON.stringify(after));
    },
  );

  it.each(["v1", "delegated", "dashboard"] as const)("%s, unchanged: the same view answers, reranked", async (route) => {
    const { seed, key, agentToken } = await fixture();
    const res = await ask(route, seed, route === "delegated" ? agentToken : key);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("event: done");
    const sourceCount = (requested("answer")[0]?.body.match(/<source id=/g) ?? []).length;
    expect({ sourceCount, rerankUrl: process.env.RERANK_URL }).toEqual({ sourceCount: 2, rerankUrl: "http://rerank.test/rerank" });
    expect(requested("rerank")).toHaveLength(1);
    expect(requested("rerank")[0].body).toContain(ITEM_TEXT);
    expect(requested("answer")[0].body).toContain(ITEM_TEXT);
  });

  it.each(["v1", "dashboard"] as const)("%s, epoch unreadable after the view: refused, nothing dispatched", async (route) => {
    const { seed, key } = await fixture();
    probe.afterView = async () => {
      probe.afterView = null;
      probe.epochUnreadable = true;
    };
    const res = await ask(route, seed, key);
    expect(res.status).toBe(503);
    expect(probe.requests).toEqual([]);
    expect((await stored(seed)).messages).not.toContain("assistant:");
  });
});

// ── P1-3: every later publication, persistence and downstream dispatch ─────────────────────────────

describe("AIO-1167 R67 a revocation after dispatch stops all later output (real Postgres)", () => {
  it.each(["v1", "dashboard"] as const)("%s: revoked before the first delta — no answer text at all", async (route) => {
    const { seed, key, revokeA } = await fixture();
    probe.answer = async () => scripted([revokeA, delta("The owner is the payments desk "), USAGE]);

    const sse = await (await ask(route, seed, key)).text();

    expect(sse).not.toContain("event: delta");
    expect(sse).not.toContain("event: sources");
    expect(sse).toContain(CONTEXT_AUTHORIZATION_CLIENT_MESSAGE);
    const after = await stored(seed);
    expect(after.messages).not.toContain("assistant:");
    if (route === "dashboard") expect(await settledRun(seed.teamId)).toMatchObject({ status: "error", partial_text: "" });
    expect(requested("title")).toEqual([]);
  });

  it.each(["v1", "dashboard"] as const)("%s: revoked after an authorized delta — nothing further, partial cleared", async (route) => {
    const { seed, key, revokeA } = await fixture();
    probe.answer = async () => scripted([delta("first part "), revokeA, delta("second part"), USAGE]);

    const sse = await (await ask(route, seed, key)).text();

    expect(sse).toContain("first part "); // already delivered before the revocation: not recalled
    expect(sse).not.toContain("second part");
    expect(sse).not.toContain("event: sources");
    expect(sse).toContain(CONTEXT_AUTHORIZATION_CLIENT_MESSAGE);
    const after = await stored(seed);
    expect(after.messages).not.toContain("assistant:");
    expect(after.query_log).not.toContain("first part");
    if (route === "dashboard") {
      expect(await settledRun(seed.teamId)).toEqual({
        status: "error", partial_text: "", error_message: CONTEXT_AUTHORIZATION_CLIENT_MESSAGE,
      });
    }
    expect(requested("title")).toEqual([]);
  });

  it.each(["v1", "dashboard"] as const)("%s: revoked before terminal publication — no citations or stored answer, spend still metered", async (route) => {
    const { seed, key, revokeA } = await fixture();
    probe.answer = async () => scripted([delta("The owner is the payments desk [S1]."), USAGE, revokeA]);

    const sse = await (await ask(route, seed, key)).text();

    expect(sse).toContain("payments desk");
    expect(sse).not.toContain("event: sources");
    expect(sse).not.toContain("event: done");
    const after = await stored(seed);
    expect(after.messages).not.toContain("assistant:");
    expect(after.query_log).not.toContain("payments desk"); // no answer preview…
    expect((await usageRows(seed.teamId)).filter((row) => row.source === "query")).toEqual([
      { source: "query", output_tokens: 5 }, // …but the provider's charge is still accounted
    ]);
    if (route === "dashboard") expect(await settledRun(seed.teamId)).toMatchObject({ status: "error", partial_text: "" });
    expect(requested("title")).toEqual([]);
  });

  it.each(["v1", "dashboard"] as const)("%s: a protected (Google-derived) answer never requests a title — the question title stays", async (route) => {
    const { seed, key } = await fixture();

    const sse = await (await ask(route, seed, key)).text();
    await settledRunOrNone(route, seed.teamId);

    expect(sse).toContain("event: done");
    expect(requested("title"), "R76: no answer-derived title for a protected answer").toEqual([]);
    expect(await conversationTitles(seed.teamId)).toEqual(["zephyrquartz ledger owner?"]);
    expect((await storedEpochs(seed.teamId)).assistant).toEqual([await currentEpoch(seed.teamId)]);
  });

  it.each(["v1", "dashboard"] as const)("%s, unchanged: answer, citations, message and spend — a transport retry included", async (route) => {
    const { seed, key } = await fixture();
    probe.answer = async (attempt) => attempt === 1
      ? ({ ok: false, status: 503, text: async () => "service unavailable", body: null } as unknown as Response)
      : scripted([delta("The owner is the payments desk [S1]."), USAGE]);

    const sse = await (await ask(route, seed, key)).text();
    await settledRunOrNone(route, seed.teamId);

    expect(requested("answer")).toHaveLength(2);
    expect(sse).toContain("event: sources");
    expect(sse).toContain("event: done");
    expect((await stored(seed)).messages).toContain("assistant:The owner is the payments desk [S1].");
    expect((await usageRows(seed.teamId)).map((row) => row.source)).toEqual(["query"]);
    if (route === "dashboard") expect(await settledRun(seed.teamId)).toMatchObject({ status: "done", partial_text: "" });
  });

  it("dashboard, client disconnected: the revoked turn still ends with no answer and no readable partial", async () => {
    const { seed, key, revokeA } = await fixture();
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    probe.answer = async () => scripted([delta("first part "), async () => { await released; await revokeA(); }, delta("second part"), USAGE]);

    const res = await ask("dashboard", seed, key);
    const reader = res.body!.getReader();
    let seen = "";
    while (!seen.includes("first part")) seen += new TextDecoder().decode((await reader.read()).value);
    await reader.cancel(); // the browser goes away
    release();

    expect(await settledRun(seed.teamId)).toMatchObject({ status: "error", partial_text: "" });
    expect((await stored(seed)).messages).not.toContain("assistant:");
    expect(requested("title")).toEqual([]);
  });
});

/** The dashboard turn finishes after its SSE; v1 persists inside the stream it already returned. */
async function settledRunOrNone(route: "v1" | "dashboard", teamId: string): Promise<void> {
  if (route === "dashboard") await settledRun(teamId);
  else await new Promise((resolve) => setTimeout(resolve, 50));
}

// ── R69: a terminal success authorizes nothing past the next await ───────────────────────────────

// ── R76: durable output provenance — publication linearized against revocation ───────────────────

describe("AIO-1167 R76 output publication is linearized against revocation (real Postgres)", () => {
  async function owner(seed: { teamId: string; memberId: string }) {
    return { teamId: seed.teamId, memberId: seed.memberId };
  }

  it("v1: a revocation committed before the publication lock — no stored answer, no preview, accounting once", async () => {
    const { seed, key, revokeA } = await fixture();
    const conversation = await ownedConversation(seed);
    const lock = handshake();
    probe.beforePublicationLock = async () => {
      probe.beforePublicationLock = null;
      lock.arrive();
      await lock.opened;
    };

    const pending = ask("v1", seed, key, conversation).then((res) => res.text());
    await lock.reached; // past every preliminary check, the publication transaction not yet locked…
    await revokeA(); // …a revocation commits from ANOTHER connection…
    lock.open(); // …and the publication's own epoch check refuses.
    const sse = await pending;
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(sse).toContain("event: done"); // delivered before the revocation; not recalled
    expect((await stored(seed)).messages).not.toContain("assistant:");
    const epoch = (await storedEpochs(seed.teamId)).queryLog[0];
    expect(epoch).toBeGreaterThan(0); // the reservation keeps the answer's provenance…
    expect(await queryLogRows(seed.teamId)).toEqual([{ answer_preview: "", cited: 0, output_tokens: 5 }]); // …and only accounting
    expect((await usageRows(seed.teamId)).filter((row) => row.source === "query")).toHaveLength(1);
  });

  it("dashboard: a revocation committed before a protected partial FLUSH locks — no partial stored, refused, no spend yet", async () => {
    const { seed, key, revokeA } = await fixture();
    const conversation = await ownedConversation(seed);
    const lock = handshake();
    probe.beforePublicationLock = async () => { // the first locked write of the turn is its partial flush
      probe.beforePublicationLock = null;
      lock.arrive();
      await lock.opened;
    };

    const pending = ask("dashboard", seed, key, conversation).then((res) => res.text());
    await lock.reached;
    await revokeA();
    lock.open();
    const sse = await pending;
    const run = await settledRun(seed.teamId);

    expect(sse).not.toContain("event: sources");
    expect(sse).toContain(CONTEXT_AUTHORIZATION_CLIENT_MESSAGE);
    expect(run).toEqual({ status: "error", partial_text: "", error_message: CONTEXT_AUTHORIZATION_CLIENT_MESSAGE });
    expect((await stored(seed)).messages).not.toContain("assistant:");
    // Refused before the terminal usage was known: no spend is recorded (nothing to record yet).
    expect(await queryLogRows(seed.teamId)).toEqual([]);
    expect((await usageRows(seed.teamId)).filter((row) => row.source === "query")).toEqual([]);
  });

  it("dashboard: a revocation committed before the publication lock — nothing published, refusal, partial cleared, accounting once", async () => {
    const { seed, key, revokeA } = await fixture();
    const conversation = await ownedConversation(seed);
    const lock = handshake();
    let lockCalls = 0;
    probe.beforePublicationLock = async () => {
      lockCalls += 1;
      if (lockCalls < 2) return; // the first is the partial flush; the second, the completed answer
      probe.beforePublicationLock = null;
      lock.arrive();
      await lock.opened;
    };

    const pending = ask("dashboard", seed, key, conversation).then((res) => res.text());
    await lock.reached;
    await revokeA();
    lock.open();
    const sse = await pending;
    const run = await settledRun(seed.teamId);

    expect(sse).not.toContain("event: sources");
    expect(sse).not.toContain("event: done");
    expect(sse).toContain(CONTEXT_AUTHORIZATION_CLIENT_MESSAGE);
    expect(run).toEqual({ status: "error", partial_text: "", error_message: CONTEXT_AUTHORIZATION_CLIENT_MESSAGE });
    expect((await stored(seed)).messages).not.toContain("assistant:");
    expect(await queryLogRows(seed.teamId)).toEqual([{ answer_preview: "", cited: 0, output_tokens: 5 }]);
    expect((await storedEpochs(seed.teamId)).queryLog).toEqual([0]); // source-free accounting is 0
    expect((await usageRows(seed.teamId)).filter((row) => row.source === "query")).toHaveLength(1);
    expect((await runCompletion(seed.teamId)).final_message_id).toBeNull();
  });

  it.each([
    ["v1", "afterAssistant"], ["dashboard", "afterAssistant"], ["dashboard", "duringFinish"],
  ] as const)("%s: the publication holds the lock first (%s) — the revocation waits, then readers suppress", async (route, seam) => {
    const { seed, key, revokeA } = await fixture();
    const conversation = await ownedConversation(seed);
    const inside = handshake();
    probe[seam] = async () => {
      probe[seam] = null;
      inside.arrive();
      await inside.opened;
    };

    const pending = ask(route, seed, key, conversation).then((res) => res.text());
    await inside.reached; // inside the publication transaction, holding the epoch share lock
    let revoked = false;
    const revocation = revokeA().then(() => { revoked = true; });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(revoked, "the revocation waits for the publication that locked first").toBe(false);
    inside.open();
    await pending;
    await revocation;
    await settledRunOrNone(route, seed.teamId);

    // The publication committed while authorized (retained); every durable reader now suppresses it.
    const raw = await getPool().query<{ n: string }>(
      `select count(*)::text as n from chat_messages where team_id=$1 and role='assistant'`, [seed.teamId]);
    expect(Number(raw.rows[0].n)).toBe(1);
    const { getConversation, searchConversations } = await import("@/lib/chat/store");
    const readerOwner = await owner(seed);
    const thread = await getConversation(db(), readerOwner, conversation);
    expect(thread?.messages.map((m) => m.role)).toEqual(["user"]);
    expect(await searchConversations(db(), readerOwner, "payments desk")).toEqual([]);
    if (route === "dashboard") {
      const { latestRun, activeRun } = await import("@/lib/query/turn-runs");
      expect(await latestRun(db(), readerOwner, conversation)).toMatchObject({
        status: "error", partial_text: "", final_message_id: null, error_message: CONTEXT_AUTHORIZATION_CLIENT_MESSAGE,
      });
      expect(await activeRun(db(), readerOwner)).toBeNull();
    }
  });

  it("dashboard: revoked while the spend is accounted (after the publication committed) — no sources/done; readers suppress", async () => {
    const { seed, key, revokeA } = await fixture();
    const conversation = await ownedConversation(seed);
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    probe.duringAccounting = async () => {
      probe.duringAccounting = null;
      await released; // the accounting write is held — the publication transaction already committed
    };

    const pending = ask("dashboard", seed, key, conversation).then((res) => res.text());
    // Settles either way, so the held request is always drained — even when an assertion below fails.
    const settled = pending.then((text) => ({ text }), (error: unknown) => ({ error }));
    try {
      for (let i = 0; i < 200 && probe.duringAccounting !== null; i += 1) await new Promise((r) => setTimeout(r, 10));
      expect(probe.duringAccounting, "the accounting write was reached and is being held").toBeNull();
      await revokeA();
    } finally {
      probe.duringAccounting = null;
      release();
      await settled;
    }
    const outcome = await settled;
    if ("error" in outcome) throw outcome.error;
    const sse = outcome.text;
    const run = await settledRun(seed.teamId);

    expect(sse).not.toContain("event: sources");
    expect(sse).not.toContain("event: done");
    expect(sse).toContain(CONTEXT_AUTHORIZATION_CLIENT_MESSAGE);
    expect(run).toEqual({ status: "error", partial_text: "", error_message: CONTEXT_AUTHORIZATION_CLIENT_MESSAGE });
    expect((await usageRows(seed.teamId)).filter((row) => row.source === "query")).toHaveLength(1);
    expect(await queryLogRows(seed.teamId)).toHaveLength(1);
    // The completion committed while authorized (its pointer is retained in storage)…
    expect((await runCompletion(seed.teamId)).final_message_id).not.toBeNull();
    // …but no reader serves it: the run projects as a refusal with no pointer, the thread omits the answer.
    const { latestRun } = await import("@/lib/query/turn-runs");
    const { getConversation } = await import("@/lib/chat/store");
    const readerOwner = await owner(seed);
    expect(await latestRun(db(), readerOwner, conversation)).toMatchObject({ status: "error", final_message_id: null });
    expect((await getConversation(db(), readerOwner, conversation))?.messages.map((m) => m.role)).toEqual(["user"]);
  });

  it.each(["v1", "dashboard"] as const)("%s, existing conversation, unchanged: stored answer, preview, citations, completion, spend, provenance", async (route) => {
    const { seed, key } = await fixture();
    const conversation = await ownedConversation(seed);

    const sse = await (await ask(route, seed, key, conversation)).text();
    await settledRunOrNone(route, seed.teamId);

    expect(sse).toContain("event: sources");
    expect(sse).toContain("event: done");
    expect((await stored(seed)).messages).toContain("assistant:The owner is the payments desk [S1].");
    expect(await queryLogRows(seed.teamId)).toEqual([
      { answer_preview: "The owner is the payments desk [S1].", cited: 1, output_tokens: 5 },
    ]);
    expect((await usageRows(seed.teamId)).filter((row) => row.source === "query")).toHaveLength(1);
    const epoch = await currentEpoch(seed.teamId);
    const epochs = await storedEpochs(seed.teamId);
    expect(epochs.assistant).toEqual([epoch]);
    expect(epochs.user).toEqual([0]);
    expect(epochs.queryLog).toEqual([epoch]);
    if (route === "dashboard") {
      expect(epochs.runs).toEqual([epoch]);
      expect(await settledRun(seed.teamId)).toMatchObject({ status: "done", partial_text: "" });
    }
  });
});
