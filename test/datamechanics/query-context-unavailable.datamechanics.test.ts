import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import { getPool } from "@/lib/db/pg/pool";
import { issueApiKey } from "@/lib/admin/keys";
import { ensureAccessBootstrap } from "@/lib/access/bootstrap";
import { getSessionUser } from "@/lib/auth/session";
import { serverClient } from "@/lib/db/server";
import { backfillTeamContext } from "@/lib/projects/context/backfill";
import { convergeIdentityAttribution, db, ingest, seedTeam, type Seed } from "./helpers";

// AIO-1167: when graph context cannot be authorized, BOTH query routes must say so as a retryable
// 503 before the turn leaves any trace. A pending identity-attribution repair is NOT such a case:
// retrieval (its graph leg included) publishes no person attribution, so it proceeds under the
// revocation barrier alone — the repair gate belongs to attributed payloads (Timeline, arcs, events).
// This is the real path, not a thrown stub: real authentication, the real admission resolver, real
// `retrieve`, the real graph partition selection and the real authorization epoch against real
// Postgres. Only the Neo4j transport, the model and the title generator are controlled, and the
// session identity for the dashboard route; the refusal is the real provenance reader's response to a
// failing graph read, and the success controls prove the fixture really reaches the graph leg.

const probe = vi.hoisted(() => ({ graphReads: 0, answers: 0, titles: 0, graphDown: false }));

vi.mock("@/lib/graph/neo4j", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/graph/neo4j")>()),
  neo4jConfigured: () => true,
  runRead: async () => {
    probe.graphReads += 1;
    if (probe.graphDown) throw new Error("neo4j unreachable");
    return [];
  },
}));
vi.mock("@/lib/query/claude", () => ({
  async *streamAnswer() {
    probe.answers += 1;
    yield { type: "delta" as const, text: "ok" };
    yield {
      type: "done" as const,
      usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cost_usd: 0, provider: "test", model: "test", estimated: false },
    };
  },
}));
vi.mock("@/lib/chat/title", () => ({
  generateAndSetTitle: async () => {
    probe.titles += 1;
  },
}));
vi.mock("@/lib/auth/session", () => ({ getSessionUser: vi.fn() }));
vi.mock("@/lib/db/server", () => ({ serverClient: vi.fn() }));

beforeEach(() => {
  probe.graphReads = 0;
  probe.answers = 0;
  probe.titles = 0;
  probe.graphDown = false;
  // The graph leg runs only behind a configured Graphiti; its reads go to the controlled transport.
  vi.stubEnv("GRAPHITI_URL", "http://graphiti.test");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

async function rawMember(seed: Seed): Promise<string> {
  const { data, error } = await db().from("members").insert({
    team_id: seed.teamId, email: `${randomUUID()}@test.local`, display_name: "Roster change",
    actor_handle: `r-${randomUUID().slice(0, 10)}`, role: "member", tier: "team", status: "active",
  }).select("id").single();
  if (error || !data) throw new Error(`member seed failed: ${error?.message}`);
  return (data as { id: string }).id;
}

async function conversationOf(seed: Seed, memberId: string): Promise<string> {
  const { data, error } = await db().from("conversations")
    .insert({ team_id: seed.teamId, member_id: memberId, title: "earlier thread" }).select("id").single();
  if (error || !data) throw new Error(`conversation seed failed: ${error?.message}`);
  return (data as { id: string }).id;
}

/** A graph-scoped member (General's partition) with an API key, a session, and two threads. */
async function graphScopedMember() {
  const seed = await seedTeam();
  await ingest(seed, { path: "team.md", body: "team payments", access: "team", project: "src" });
  expect((await ensureAccessBootstrap(db(), seed.teamId)).ok).toBe(true);
  await backfillTeamContext(db(), seed.teamId);
  const other = await rawMember(seed);
  const owned = await conversationOf(seed, seed.memberId);
  const foreign = await conversationOf(seed, other);
  await convergeIdentityAttribution(seed);
  const { key } = await issueApiKey(db(), seed.teamId, seed.memberId, "query-context-unavailable");
  const authUserId = randomUUID();
  await getPool().query(`insert into auth_users(id,email) values($1,$2)`, [authUserId, `${randomUUID()}@test.local`]);
  // auth_user_id is not an attribution dependency: this binding leaves the repair complete.
  await getPool().query(`update members set auth_user_id=$1 where id=$2 and team_id=$3`, [authUserId, seed.memberId, seed.teamId]);
  vi.mocked(getSessionUser).mockResolvedValue({ id: authUserId } as Awaited<ReturnType<typeof getSessionUser>>);
  vi.mocked(serverClient).mockResolvedValue(db() as unknown as Awaited<ReturnType<typeof serverClient>>);
  expect(await repairStatus(seed)).toBe("complete");
  return { seed, key, owned, foreign };
}

async function repairStatus(seed: Seed): Promise<string> {
  const { rows } = await getPool().query<{ repair_status: string }>(
    `select repair_status from team_identity_authority where team_id=$1`, [seed.teamId]);
  return rows[0]?.repair_status ?? "complete";
}

/** A roster change on a team with items: the attribution repair is now pending. */
async function makeRepairPending(seed: Seed): Promise<void> {
  await rawMember(seed);
  expect(await repairStatus(seed)).toBe("pending");
}

/** Every row a turn could create or touch, as content, so an UPDATE shows as well as an INSERT. */
async function turnState(seed: Seed) {
  const { rows } = await getPool().query(
    `select
       (select coalesce(string_agg(id::text||'|'||title||'|'||updated_at::text, ',' order by id), '')
          from conversations where team_id=$1) as conversations,
       (select coalesce(string_agg(id::text||'|'||role, ',' order by id), '')
          from chat_messages where team_id=$1) as messages,
       (select coalesce(string_agg(id::text||'|'||status, ',' order by id), '')
          from chat_turn_runs where team_id=$1) as runs,
       (select coalesce(string_agg(id::text||'|'||answer_preview||'|'||cost_usd::text, ',' order by id), '')
          from query_log where team_id=$1) as query_log,
       (select count(*)::int from query_log where team_id=$1) as query_log_rows`,
    [seed.teamId],
  );
  return rows[0] as { conversations: string; messages: string; runs: string; query_log: string; query_log_rows: number };
}

type Route = "v1" | "dashboard";
async function ask(route: Route, seed: Seed, key: string, conversationId?: string): Promise<Response> {
  const body = { question: "who owns payments?", ...(conversationId ? { conversation_id: conversationId } : {}) };
  if (route === "v1") {
    const { POST } = await import("@/app/api/v1/query/route");
    return POST(new Request("http://test/api/v1/query", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "X-AIOS-Team": seed.teamSlug, "content-type": "application/json" },
      body: JSON.stringify(body),
    }) as unknown as NextRequest);
  }
  const { POST } = await import("@/app/api/dashboard/query/route");
  return POST(new Request("http://test/api/dashboard/query", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ team: seed.teamSlug, ...body }),
  }) as unknown as NextRequest);
}

const CASES = (["v1", "dashboard"] as const).flatMap((route) =>
  (["new", "owned", "foreign"] as const).map((conversation) => ({ route, conversation })));

describe("AIO-1167 query routes refuse before writing when graph authorization is unavailable (real Postgres)", () => {
  it.each(CASES)("$route with a $conversation conversation: 503, and no turn state at all", async ({ route, conversation }) => {
    const { seed, key, owned, foreign } = await graphScopedMember();
    probe.graphDown = true;
    const before = await turnState(seed);

    const res = await ask(route, seed, key, conversation === "owned" ? owned : conversation === "foreign" ? foreign : undefined);

    expect(res.status).toBe(503);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({
      error: {
        code: "temporarily_unavailable",
        message: "query context is temporarily unavailable; retry shortly",
        request_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      },
    });
    // No conversation created or touched, no message, no run, no query_log row (so no daily quota).
    expect(await turnState(seed)).toEqual(before);
    // Refused by the provenance reader after the failed graph read, and nothing was generated.
    expect(probe.graphReads).toBeGreaterThan(0);
    expect(probe.answers).toBe(0);
    expect(probe.titles).toBe(0);
  });

  it.each([
    ["v1", "complete"], ["dashboard", "complete"], ["v1", "pending"], ["dashboard", "pending"],
  ] as const)("%s, attribution repair %s: the same fixture reaches the graph and answers, writing after retrieval", async (route, repair) => {
    const { seed, key } = await graphScopedMember();
    // A roster change marks the team's attribution repair pending. Retrieval carries no person
    // attribution, so it must not be taken down by an unrelated repair.
    if (repair === "pending") await makeRepairPending(seed);
    const before = await turnState(seed);

    const res = await ask(route, seed, key);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    if (route === "v1") {
      // API accounting is reserved before the stream is handed back.
      expect((await turnState(seed)).query_log_rows).toBe(before.query_log_rows + 1);
    }
    await res.text();
    expect(probe.graphReads, "the graph leg ran, so the refusal above is the reader's, not an omitted leg").toBeGreaterThan(0);
    expect(probe.answers).toBe(1);
    const after = await turnState(seed);
    expect(after.query_log_rows).toBe(before.query_log_rows + 1);
    expect(after.conversations.split(",").length).toBe(before.conversations.split(",").length + 1);
    expect(after.messages.split(",").filter(Boolean).map((row) => row.split("|")[1]).sort()).toEqual(["assistant", "user"]);
  });
});
