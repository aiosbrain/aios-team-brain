import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import { getPool } from "@/lib/db/pg/pool";
import { advanceAuthorizationEpoch, revocationEpoch } from "@/lib/access/authorization-epoch";
import { ensureAccessBootstrap } from "@/lib/access/bootstrap";
import { issueApiKey } from "@/lib/admin/keys";
import { getSessionUser } from "@/lib/auth/session";
import { serverClient } from "@/lib/db/server";
import { appendMessage, getConversation, recentTurns, searchConversations } from "@/lib/chat/store";
import { backfillTeamContext } from "@/lib/projects/context/backfill";
import { ContextAuthorization } from "@/lib/query/context-authorization";
import { classifyOutputProvenance } from "@/lib/query/output-provenance";
import { retrieve } from "@/lib/query/retrieve";
import { CONTEXT_AUTHORIZATION_CLIENT_MESSAGE } from "@/lib/query/stream-retry";
import { activeRun, createRun, failRun, finishRun, flushPartial, latestRun, touchRun } from "@/lib/query/turn-runs";
import { convergeIdentityAttribution, db, driveFixture, ingest, seedTeam, type Seed } from "./helpers";
import { twoClaimFixture } from "./query-revocation-fixture";

// AIO-1167 R76 — durable query-output provenance, from the readers' side (real Postgres).
//
// Every reader decides from the STORED provenance and the team's current revocation epoch, read at a
// revocation-linearized point — never from whether a worker is alive, heartbeating, or cleaned up:
// NULL = historical (completed readable, a streaming partial never replayed), 0 = non-Google
// (readable), positive = the original capture (readable only while current and verifiable).

const probe = vi.hoisted(() => ({ epochReadFails: false }));
vi.mock("@/lib/access/authorization-epoch", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/access/authorization-epoch")>();
  return {
    ...real,
    lockedRevocationEpoch: async (...args: Parameters<typeof real.lockedRevocationEpoch>) => {
      if (probe.epochReadFails) throw new Error("authorization epoch read failed");
      return real.lockedRevocationEpoch(...args);
    },
  };
});
vi.mock("@/lib/query/answering", () => ({
  resolveAnsweringKeys: async () => ({ openrouterKey: "test-key", openrouterModel: "test-model" }),
}));
vi.mock("@/lib/auth/session", () => ({ getSessionUser: vi.fn() }));
vi.mock("@/lib/db/server", () => ({ serverClient: vi.fn() }));

beforeEach(() => {
  probe.epochReadFails = false;
});

type Owner = { teamId: string; memberId: string };
const ownerOf = (seed: Seed): Owner => ({ teamId: seed.teamId, memberId: seed.memberId });

async function conversation(seed: Seed): Promise<string> {
  const { data, error } = await db().from("conversations")
    .insert({ team_id: seed.teamId, member_id: seed.memberId, title: "thread" }).select("id").single();
  if (error || !data) throw new Error(`conversation seed failed: ${error?.message}`);
  return (data as { id: string }).id;
}

/** A raw historical/legacy row exactly as pre-contract code (or a fixture of it) left it. */
async function rawRun(seed: Seed, conversationId: string, status: string, partial: string, epoch: number | null) {
  const { rows } = await getPool().query<{ id: string }>(
    `insert into chat_turn_runs(conversation_id, team_id, member_id, question, status, partial_text, context_authorization_epoch)
     values ($1,$2,$3,'q',$4,$5,$6) returning id`,
    [conversationId, seed.teamId, seed.memberId, status, partial, epoch],
  );
  return rows[0].id;
}

async function rawMessage(seed: Seed, conversationId: string, role: string, content: string, epoch: number | null) {
  await getPool().query(
    `insert into chat_messages(conversation_id, team_id, member_id, role, content, context_authorization_epoch)
     values ($1,$2,$3,$4,$5,$6)`,
    [conversationId, seed.teamId, seed.memberId, role, content, epoch],
  );
}

const storedRun = async (runId: string) => (await getPool().query<{ partial_text: string; e: string | null }>(
  `select partial_text, context_authorization_epoch::text as e from chat_turn_runs where id=$1`, [runId])).rows[0];

describe("AIO-1167 R76 durable query-output readers (real Postgres)", () => {
  it("a stalled protected partial: heartbeat, worker death and failed cleanup cannot keep it readable after a revocation", async () => {
    const seed = await seedTeam();
    const owner = ownerOf(seed);
    const convo = await conversation(seed);
    const protectedOutput = { epoch: await revocationEpoch(db(), seed.teamId) };
    const run = (await createRun(db(), owner, convo, "q", protectedOutput))!.id;
    expect(await flushPartial(db(), run, "secret partial", { teamId: seed.teamId, provenance: protectedOutput })).toBe(true);
    await touchRun(db(), run);
    expect(await latestRun(db(), owner, convo)).toMatchObject({ status: "streaming", partial_text: "secret partial" });
    expect((await activeRun(db(), owner))?.id).toBe(run);

    await advanceAuthorizationEpoch(seed.teamId); // a revocation commits; the stalled worker never reacts
    await touchRun(db(), run); // its heartbeat keeps going
    const projected = await latestRun(db(), owner, convo);
    expect(projected).toMatchObject({
      status: "error", partial_text: "", final_message_id: null, error_message: CONTEXT_AUTHORIZATION_CLIENT_MESSAGE,
    });
    expect(await activeRun(db(), owner)).toBeNull();
    // A late flush from the old worker is refused; its stored text was never cleaned up, and still
    // no reader serves it.
    await expect(flushPartial(db(), run, "later text", { teamId: seed.teamId, provenance: protectedOutput }))
      .rejects.toMatchObject({ name: "QueryContextAuthorizationChangedError" });
    expect((await storedRun(run)).partial_text).toBe("secret partial");
    expect((await latestRun(db(), owner, convo))?.partial_text).toBe("");
  });

  it("NULL / 0 / positive provenance across runs, threads, search and history reuse", async () => {
    const seed = await seedTeam();
    const owner = ownerOf(seed);
    const epoch = await revocationEpoch(db(), seed.teamId);
    const thread = await conversation(seed);
    await rawMessage(seed, thread, "user", "first question", 0);
    await rawMessage(seed, thread, "assistant", "quasarvellum protected answer", epoch);
    await rawMessage(seed, thread, "user", "second question", 0);
    await rawMessage(seed, thread, "assistant", "nebulith public answer", 0);
    const legacy = await conversation(seed);
    await rawMessage(seed, legacy, "user", "old question", null);
    await rawMessage(seed, legacy, "assistant", "hexaprism legacy answer", null);
    const nullStreaming = await conversation(seed);
    await rawRun(seed, nullStreaming, "streaming", "legacy partial", null);
    const nullDone = await conversation(seed);
    await rawRun(seed, nullDone, "done", "", null);
    const zeroStreaming = await conversation(seed);
    await rawRun(seed, zeroStreaming, "streaming", "public partial", 0);

    const roles = async (id: string) => (await getConversation(db(), owner, id))?.messages.map((m) => m.content);
    const found = async (q: string) => (await searchConversations(db(), owner, q)).map((c) => c.id);
    expect(await roles(thread)).toEqual(["first question", "quasarvellum protected answer", "second question", "nebulith public answer"]);
    expect(await found("quasarvellum")).toEqual([thread]);
    expect(await recentTurns(db(), owner, thread)).toEqual([
      { question: "first question", answer: "quasarvellum protected answer" },
      { question: "second question", answer: "nebulith public answer" },
    ]);
    expect(await recentTurns(db(), owner, legacy), "historical answers are readable but never reused as model input").toEqual([]);
    expect(await latestRun(db(), owner, nullStreaming)).toMatchObject({ status: "error", partial_text: "" });
    expect(await latestRun(db(), owner, nullDone)).toMatchObject({ status: "done" });
    expect(await latestRun(db(), owner, zeroStreaming)).toMatchObject({ status: "streaming", partial_text: "public partial" });

    await advanceAuthorizationEpoch(seed.teamId);

    expect(await roles(thread)).toEqual(["first question", "second question", "nebulith public answer"]);
    expect(await roles(legacy)).toEqual(["old question", "hexaprism legacy answer"]);
    expect(await found("quasarvellum")).toEqual([]);
    expect(await found("nebulith")).toEqual([thread]);
    expect(await found("hexaprism")).toEqual([legacy]);
    expect(await recentTurns(db(), owner, thread)).toEqual([{ question: "second question", answer: "nebulith public answer" }]);
    expect(await latestRun(db(), owner, zeroStreaming)).toMatchObject({ status: "streaming", partial_text: "public partial" });
  });

  it("an unreadable revocation epoch hides protected output only — 0 and completed historical stay readable", async () => {
    const seed = await seedTeam();
    const owner = ownerOf(seed);
    const epoch = await revocationEpoch(db(), seed.teamId);
    const thread = await conversation(seed);
    await rawMessage(seed, thread, "user", "question", 0);
    await rawMessage(seed, thread, "assistant", "quasarvellum protected", epoch);
    await rawMessage(seed, thread, "assistant", "nebulith public", 0);
    await rawMessage(seed, thread, "assistant", "hexaprism legacy", null);
    const protectedRun = await conversation(seed);
    await rawRun(seed, protectedRun, "streaming", "protected partial", epoch);
    const publicRun = await conversation(seed);
    await rawRun(seed, publicRun, "streaming", "public partial", 0);

    probe.epochReadFails = true;

    expect((await getConversation(db(), owner, thread))?.messages.map((m) => m.content))
      .toEqual(["question", "nebulith public", "hexaprism legacy"]);
    expect(await searchConversations(db(), owner, "quasarvellum")).toEqual([]);
    expect((await searchConversations(db(), owner, "nebulith")).map((c) => c.id)).toEqual([thread]);
    expect(await latestRun(db(), owner, protectedRun)).toMatchObject({ status: "error", partial_text: "" });
    expect(await latestRun(db(), owner, publicRun)).toMatchObject({ status: "streaming", partial_text: "public partial" });
  });

  it("provenance is frozen at run creation: heartbeat, finalization and cleanup never change it; a mismatched flush writes nothing", async () => {
    const seed = await seedTeam();
    const owner = ownerOf(seed);
    const convo = await conversation(seed);
    const epoch = await revocationEpoch(db(), seed.teamId);
    const run = (await createRun(db(), owner, convo, "q", { epoch }))!.id;
    await touchRun(db(), run);
    expect(await flushPartial(db(), run, "first", { teamId: seed.teamId, provenance: { epoch: 0 } })).toBe(false);
    await expect(flushPartial(db(), run, "first", { teamId: seed.teamId, provenance: { epoch: epoch + 7 } }))
      .rejects.toMatchObject({ name: "QueryContextAuthorizationChangedError" });
    expect(await storedRun(run)).toEqual({ partial_text: "", e: String(epoch) });
    await failRun(db(), run, "boom", { clearPartial: true });
    await finishRun(db(), run, null);
    expect((await storedRun(run)).e).toBe(String(epoch));
    // A message's provenance is the one it was written with; a user message is 0.
    await appendMessage(db(), owner, convo, "user", "hello", {}, { epoch: 0 });
    const { rows } = await getPool().query<{ e: string }>(
      `select context_authorization_epoch::text as e from chat_messages where conversation_id=$1`, [convo]);
    expect(rows.map((row) => row.e)).toEqual(["0"]);
  });
});

// ── applicability: classified from EVERY model input, through the real retrieval ───────────────────

describe("AIO-1167 R76 output provenance applicability (real Postgres)", () => {
  async function readerView(seed: Seed) {
    const { resolveContentView, retrieveEnforceFor } = await import("@/lib/access/admission");
    return retrieveEnforceFor(await resolveContentView(db(), seed.teamId, seed.memberId));
  }

  async function classified(seed: Seed, question: string) {
    const authorization = await ContextAuthorization.capture(db(), seed.teamId);
    const ctx = await retrieve(db(), seed.teamId, "team", question, null, await readerView(seed), authorization);
    const provenance = await classifyOutputProvenance(seed.teamId, ctx.modelInputs, authorization);
    return { ctx, provenance, epoch: authorization.epoch };
  }

  it("Google sources, a Google-backed decision line, and a known non-Google answer in a team with Google", async () => {
    const { seed, item } = await twoClaimFixture();
    const publicItem = await ingest(seed, {
      path: "nebulith.md", body: "nebulith public roadmap notes", access: "team", project: "src",
    });
    // Newer public notes fill the recency padding (8), so the Google item is admitted ONLY through a
    // leg that names it — a matching source, or the decision line below.
    for (let i = 0; i < 9; i += 1) {
      await ingest(seed, { path: `filler-${i}.md`, body: `filler note ${i} about weather`, access: "team", project: "src" });
    }
    await backfillTeamContext(db(), seed.teamId);

    const google = await classified(seed, "zephyrquartz ledger");
    expect(google.ctx.sources.map((s) => s.item_id)).toContain(item.id);
    expect(google.provenance.epoch).toBe(google.epoch);

    // A known non-Google answer in a team that also holds Google content: nothing Google admitted → 0.
    const publicAnswer = await classified(seed, "nebulith roadmap");
    expect(publicAnswer.ctx.sources.map((s) => s.item_id)).toContain(publicItem.id);
    expect(publicAnswer.ctx.modelInputs?.itemIds).not.toContain(item.id);
    expect(publicAnswer.ctx.modelInputs?.complete).toBe(true);
    expect(publicAnswer.provenance.epoch).toBe(0);

    // A decision line backed by the Google item enters the always-included decision window: from then
    // on it reaches the model with EVERY answer, so even the same public question is protected.
    const { data: project } = await db().from("projects").select("id").eq("team_id", seed.teamId).eq("slug", "src").single();
    await db().from("decisions").insert({
      team_id: seed.teamId, project_id: (project as { id: string }).id, source_item_id: item.id,
      row_key: `D-${randomUUID().slice(0, 6)}`, title: "orbitalis migration approved", decided_by: "Tester",
    });
    const decisionBacked = await classified(seed, "nebulith roadmap");
    expect(decisionBacked.ctx.structured).toContain("orbitalis migration approved");
    expect(decisionBacked.ctx.modelInputs?.itemIds).toContain(item.id);
    expect(decisionBacked.provenance.epoch).toBe(decisionBacked.epoch);
  });

  it("the classifier: mixed, unresolved and missing inputs protect; complete non-Google and source-free are 0; a changed capture refuses", async () => {
    const seed = await seedTeam();
    const googleItem = await driveFixture(seed, {
      project: "drive", path: "gdrive/classify.md", body: "google body",
      frontmatter: { source: "gdrive", source_id: `classify-${randomUUID()}` },
    });
    const plain = await ingest(seed, { path: "plain.md", body: "plain body", access: "team", project: "src" });
    const authorization = await ContextAuthorization.capture(db(), seed.teamId);
    const epoch = authorization.epoch;
    const classify = (itemIds: string[], complete = true) =>
      classifyOutputProvenance(seed.teamId, { itemIds, complete }, authorization);

    expect((await classify([googleItem.id])).epoch).toBe(epoch);
    expect((await classify([plain.id])).epoch).toBe(0);
    expect((await classify([plain.id, googleItem.id])).epoch).toBe(epoch);
    expect((await classify([])).epoch).toBe(0); // source-free / structural
    expect((await classify([plain.id], false)).epoch).toBe(epoch); // unproven inputs
    expect((await classify([randomUUID()])).epoch).toBe(epoch); // an item that cannot be found
    expect((await classifyOutputProvenance(seed.teamId, undefined, authorization)).epoch).toBe(epoch);

    await advanceAuthorizationEpoch(seed.teamId);
    await expect(classify([plain.id])).rejects.toMatchObject({ name: "QueryContextAuthorizationChangedError" });
  });
});

// ── titles: protected answers keep the question title; non-Google answers get an automatic one ─────

describe("AIO-1167 R76 non-Google answers keep automatic titles (real Postgres)", () => {
  async function publicTeam() {
    const seed = await seedTeam();
    await ingest(seed, { path: "team.md", body: "nebulith payments roadmap", access: "team", project: "src" });
    expect((await ensureAccessBootstrap(db(), seed.teamId)).ok).toBe(true);
    await backfillTeamContext(db(), seed.teamId);
    await convergeIdentityAttribution(seed);
    const { key } = await issueApiKey(db(), seed.teamId, seed.memberId, "query-output-provenance");
    const authUserId = randomUUID();
    await getPool().query(`insert into auth_users(id,email) values($1,$2)`, [authUserId, `${randomUUID()}@test.local`]);
    await getPool().query(`update members set auth_user_id=$1 where id=$2 and team_id=$3`, [authUserId, seed.memberId, seed.teamId]);
    vi.mocked(getSessionUser).mockResolvedValue({ id: authUserId } as Awaited<ReturnType<typeof getSessionUser>>);
    vi.mocked(serverClient).mockResolvedValue(db() as unknown as Awaited<ReturnType<typeof serverClient>>);
    return { seed, key };
  }

  it.each(["v1", "dashboard"] as const)("%s: a non-Google answer is stored with provenance 0 and titled automatically", async (route) => {
    const { seed, key } = await publicTeam();
    const titles: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
      const body = String(init?.body ?? "");
      if (body.includes('"max_tokens":24')) {
        titles.push(body);
        return new Response(JSON.stringify({ choices: [{ message: { content: "Nebulith roadmap" } }], usage: {} }));
      }
      const encoder = new TextEncoder();
      return {
        ok: true, status: 200, text: async () => "",
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "The roadmap is nebulith." } }] })}\n\n`));
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          },
        }),
      } as unknown as Response;
    }));
    try {
      const request = route === "v1"
        ? new Request("http://test/api/v1/query", {
          method: "POST",
          headers: { authorization: `Bearer ${key}`, "X-AIOS-Team": seed.teamSlug, "content-type": "application/json" },
          body: JSON.stringify({ question: "nebulith roadmap?" }),
        })
        : new Request("http://test/api/dashboard/query", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ team: seed.teamSlug, question: "nebulith roadmap?" }),
        });
      const { POST } = route === "v1"
        ? await import("@/app/api/v1/query/route")
        : await import("@/app/api/dashboard/query/route");
      await (await POST(request as unknown as NextRequest)).text();
      for (let i = 0; i < 100; i += 1) {
        const { rows } = await getPool().query<{ title: string }>(`select title from conversations where team_id=$1`, [seed.teamId]);
        if (rows[0]?.title === "Nebulith roadmap") break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const { rows } = await getPool().query<{ title: string }>(`select title from conversations where team_id=$1`, [seed.teamId]);
      expect(titles).toHaveLength(1);
      expect(rows.map((row) => row.title)).toEqual(["Nebulith roadmap"]);
      const epochs = await getPool().query<{ e: string }>(
        `select context_authorization_epoch::text as e from chat_messages where team_id=$1 and role='assistant'`, [seed.teamId]);
      expect(epochs.rows.map((row) => row.e)).toEqual(["0"]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
