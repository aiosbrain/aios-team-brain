import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONTEXT_AUTHORIZATION_CLIENT_MESSAGE } from "@/lib/query/stream-retry";
import { ask, expectNothingRevokedLeft, stored, twoClaimFixture } from "./query-revocation-fixture";

// AIO-1167 R66 — a Drive revocation committed AFTER retrieval never reaches a model, the client,
// citations or stored answers through the context retrieval captured before it.
//
// Real authentication, the real admission resolver, real `retrieve`, the real `streamAnswer` with
// its retry owner, the real `runAnswerTurn`, and the real claim owner retiring connection A's claim
// against real Postgres (advancing the team's revocation epoch) while connection B — whose audience
// is another member — keeps the document. Controlled: the provider transport (`fetch`), the graph
// fact transport (facts are certified under the epoch their read observed, exactly as the real
// provenance reader reports it), the answering keys (to pause INSIDE route preparation), the title
// generator and the dashboard session.

// vi.mock factories are hoisted above imports, so the two texts they and the tests share are
// read from the fixture through the hoisted probe below rather than a top-level import binding.
const { ITEM_TEXT, GRAPH_FACT } = await import("./query-revocation-fixture");

const probe = vi.hoisted(() => ({
  graph: false,
  epochUnreadable: false,
  pause: null as null | (() => Promise<void>),
  dispatches: [] as string[],
  onDispatch: null as null | ((attempt: number) => Promise<Response | null>),
}));

vi.mock("@/lib/access/authorization-epoch", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/access/authorization-epoch")>();
  return {
    ...real,
    revocationEpoch: async (...args: Parameters<typeof real.revocationEpoch>) => {
      if (probe.epochUnreadable) throw new Error("authorization epoch read failed");
      return real.revocationEpoch(...args);
    },
  };
});
vi.mock("@/lib/graph/provenance-read", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/graph/provenance-read")>();
  const epochs = await import("@/lib/access/authorization-epoch");
  const read = async (client: Parameters<typeof real.readAuthorizedGraphFactsResult>[0], args: { teamId: string }) => {
    if (!probe.graph) return { facts: [], incomplete: false, nextOffset: null, checked: 0, epoch: null };
    const epoch = await epochs.revocationEpoch(client, args.teamId);
    return {
      facts: [{
        id: "fact-1", fact: GRAPH_FACT, at: new Date().toISOString(), subjectType: "Team",
        subject: "payments desk", object: "ledger", episodeUuids: ["episode-1"],
      }],
      incomplete: false, nextOffset: null, checked: 1, epoch,
    };
  };
  return {
    ...real,
    // Both public readers: the result form (epoch included) and the facts-only form.
    readAuthorizedGraphFactsResult: read,
    readAuthorizedGraphFacts: async (...args: Parameters<typeof read>) => (await read(...args)).facts,
  };
});
vi.mock("@/lib/query/answering", () => ({
  resolveAnsweringKeys: async () => {
    if (probe.pause) await probe.pause();
    return { openrouterKey: "test-key", openrouterModel: "test-model" };
  },
}));
vi.mock("@/lib/chat/title", () => ({ generateAndSetTitle: async () => undefined }));
vi.mock("@/lib/auth/session", () => ({ getSessionUser: vi.fn() }));
vi.mock("@/lib/db/server", () => ({ serverClient: vi.fn() }));

function providerStream(text: string): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return { ok: true, status: 200, body, text: async () => "" } as unknown as Response;
}

beforeEach(() => {
  Object.assign(probe, { graph: false, epochUnreadable: false, pause: null, dispatches: [], onDispatch: null });
  vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
    probe.dispatches.push(String(init?.body ?? ""));
    const scripted = probe.onDispatch ? await probe.onDispatch(probe.dispatches.length) : null;
    return scripted ?? providerStream("The owner is the payments desk [S1].");
  }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const ROUTES = ["v1", "dashboard"] as const;

describe("AIO-1167 R66 query dispatch rechecks the captured revocation epoch (real Postgres)", () => {
  it.each(ROUTES.flatMap((route) => (["graph-present", "item-only"] as const).map((graph) => ({ route, graph }))))(
    "$route, $graph: revoking A during route preparation refuses before any dispatch",
    async ({ route, graph }) => {
      const { seed, key, revokeA } = await twoClaimFixture();
      if (graph === "graph-present") {
        vi.stubEnv("GRAPHITI_URL", "http://graphiti.test");
        probe.graph = true;
      }
      probe.pause = async () => {
        probe.pause = null;
        await revokeA(); // committed between retrieval and dispatch
      };

      const res = await ask(route, seed, key);

      expect(res.status).toBe(503);
      const payload = await res.json() as { error: { code: string; message: string } };
      expect(payload.error).toEqual(expect.objectContaining({
        code: "temporarily_unavailable", message: CONTEXT_AUTHORIZATION_CLIENT_MESSAGE,
      }));
      expect(probe.dispatches, "no captured context reached the provider").toEqual([]);
      expectNothingRevokedLeft(JSON.stringify(payload));
      const after = await stored(seed);
      expect(after.messages).not.toContain("assistant:");
      expect(after.runs).toBe("");
      expectNothingRevokedLeft(JSON.stringify(after));
    },
  );

  it.each(ROUTES)("%s, unchanged epoch: the same fixture answers with the item and the graph fact", async (route) => {
    const { seed, key } = await twoClaimFixture();
    vi.stubEnv("GRAPHITI_URL", "http://graphiti.test");
    probe.graph = true;

    const res = await ask(route, seed, key);

    expect(res.status).toBe(200);
    const sse = await res.text();
    expect(sse).toContain("event: delta");
    expect(sse).toContain("event: sources");
    expect(probe.dispatches).toHaveLength(1);
    expect(probe.dispatches[0]).toContain(ITEM_TEXT); // retrieval really carried the item…
    expect(probe.dispatches[0]).toContain(GRAPH_FACT); // …and the graph fact, so the refusals above discriminate
    expect((await stored(seed)).messages).toContain("assistant:");
  });

  it.each(ROUTES)("%s, unreadable epoch at dispatch: refused, nothing dispatched or stored", async (route) => {
    const { seed, key } = await twoClaimFixture();
    probe.pause = async () => {
      probe.pause = null;
      probe.epochUnreadable = true;
    };

    const res = await ask(route, seed, key);

    expect(res.status).toBe(503);
    expect((await res.json() as { error: { message: string } }).error.message).toBe(CONTEXT_AUTHORIZATION_CLIENT_MESSAGE);
    expect(probe.dispatches).toEqual([]);
    const after = await stored(seed);
    expect(after.messages).not.toContain("assistant:");
    expectNothingRevokedLeft(JSON.stringify(after));
  });

  it.each(ROUTES)("%s, revoked during answer retry backoff: the retry is never dispatched", async (route) => {
    const { seed, key, revokeA } = await twoClaimFixture();
    vi.stubEnv("GRAPHITI_URL", "http://graphiti.test");
    probe.graph = true;
    probe.onDispatch = async (attempt) => {
      if (attempt !== 1) return null;
      await revokeA(); // committed while the first, still-authorized attempt fails transiently
      return { ok: false, status: 503, text: async () => "service unavailable", body: null } as unknown as Response;
    };

    const res = await ask(route, seed, key);

    expect(res.status).toBe(200);
    const sse = await res.text();
    expect(probe.dispatches, "only the attempt made BEFORE the revocation").toHaveLength(1);
    expect(sse).toContain("event: error");
    expect(sse).toContain(CONTEXT_AUTHORIZATION_CLIENT_MESSAGE);
    expect(sse).not.toContain("event: delta");
    expect(sse).not.toContain("event: sources");
    expectNothingRevokedLeft(sse);
    const after = await stored(seed);
    expect(after.messages).not.toContain("assistant:");
    if (route === "dashboard") {
      // The run is finalized as failed with the sanitized message, and no partial answer.
      expect(after.runs).toBe(`error::${CONTEXT_AUTHORIZATION_CLIENT_MESSAGE}`);
    }
    expectNothingRevokedLeft(JSON.stringify(after));
  });
});
