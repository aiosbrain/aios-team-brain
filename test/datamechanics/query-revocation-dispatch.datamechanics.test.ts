import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import { getPool } from "@/lib/db/pg/pool";
import { issueApiKey } from "@/lib/admin/keys";
import { ensureAccessBootstrap } from "@/lib/access/bootstrap";
import { revocationEpoch } from "@/lib/access/authorization-epoch";
import { getSessionUser } from "@/lib/auth/session";
import { serverClient } from "@/lib/db/server";
import { ensureProjectGraphPointer } from "@/lib/graph/project-pointer";
import { reconcileGdriveItems } from "@/lib/ingest/source-reconcile";
import { upsertIntegration } from "@/lib/integrations/manage";
import { backfillTeamContext } from "@/lib/projects/context/backfill";
import { recordGdriveItemClaim } from "@/lib/projects/context/gdrive-claims";
import { CONTEXT_AUTHORIZATION_CLIENT_MESSAGE } from "@/lib/query/stream-retry";
import { convergeIdentityAttribution, db, driveFixture, seedTeam, type Seed } from "./helpers";

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

const ITEM_TEXT = "zephyrquartz ledger reconciliation";
const GRAPH_FACT = "zephyrquartz graph fact: the ledger owner is the payments desk";

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

async function member(seed: Seed): Promise<string> {
  const { data, error } = await db().from("members").insert({
    team_id: seed.teamId, email: `${randomUUID()}@test.local`, display_name: "Other reader",
    actor_handle: `o-${randomUUID().slice(0, 10)}`, role: "member", tier: "team", status: "active",
  }).select("id").single();
  if (error || !data) throw new Error(`member seed failed: ${error?.message}`);
  return (data as { id: string }).id;
}

async function audience(seed: Seed, memberId: string, slug: string): Promise<string> {
  const { data: group } = await db().from("groups").insert({
    team_id: seed.teamId, slug: `person-${randomUUID()}`, name: slug, person_member_id: memberId,
  }).select("id").single();
  await db().from("group_members").insert({ team_id: seed.teamId, group_id: (group as { id: string }).id, member_id: memberId });
  const { data: project } = await db().from("projects").insert({
    team_id: seed.teamId, slug, name: slug, kind: "initiative",
  }).select("id").single();
  const projectId = (project as { id: string }).id;
  await db().from("project_groups").insert({ team_id: seed.teamId, project_id: projectId, group_id: (group as { id: string }).id });
  const pointer = await ensureProjectGraphPointer(db(), { teamId: seed.teamId, projectId });
  if (!pointer.ok) throw new Error(pointer.error);
  return projectId;
}

async function connection(seed: Seed, name: string, projectId: string): Promise<string> {
  return (await upsertIntegration(db(), { teamId: seed.teamId, memberId: seed.memberId }, {
    type: "gdrive", name, status: "enabled",
    config: {
      fileIds: ["ledger-doc"], folderIds: [], sharedDriveIds: [], recursive: false,
      selectionState: "selected", authMode: "service_account", audienceProjectIds: [projectId],
    },
  })).id;
}

/** A reader who sees the ledger document ONLY through connection A; connection B serves another member. */
async function twoClaimFixture() {
  const seed = await seedTeam();
  const other = await member(seed);
  const projectA = await audience(seed, seed.memberId, `ledger-a-${randomUUID().slice(0, 8)}`);
  const projectB = await audience(seed, other, `ledger-b-${randomUUID().slice(0, 8)}`);
  const connectionA = await connection(seed, `ledger-a-${randomUUID().slice(0, 8)}`, projectA);
  const connectionB = await connection(seed, `ledger-b-${randomUUID().slice(0, 8)}`, projectB);
  const providerId = `ledger-doc-${randomUUID()}`;
  const item = await driveFixture(seed, {
    project: "drive-ledger", path: `gdrive/${providerId}.md`, body: `${ITEM_TEXT} — quarterly figures`,
    frontmatter: { source: "gdrive", source_id: providerId, title: "Zephyrquartz ledger" },
  }, { unclaimed: true });
  for (const [integrationId, projectId] of [[connectionA, projectA], [connectionB, projectB]] as const) {
    await recordGdriveItemClaim(db(), {
      teamId: seed.teamId, integrationId, providerId, itemId: item.id, generation: 1, audienceProjectIds: [projectId],
    });
  }
  expect((await ensureAccessBootstrap(db(), seed.teamId)).ok).toBe(true);
  await backfillTeamContext(db(), seed.teamId);
  await convergeIdentityAttribution(seed);
  const { key } = await issueApiKey(db(), seed.teamId, seed.memberId, "query-revocation-dispatch");
  const authUserId = randomUUID();
  await getPool().query(`insert into auth_users(id,email) values($1,$2)`, [authUserId, `${randomUUID()}@test.local`]);
  await getPool().query(`update members set auth_user_id=$1 where id=$2 and team_id=$3`, [authUserId, seed.memberId, seed.teamId]);
  vi.mocked(getSessionUser).mockResolvedValue({ id: authUserId } as Awaited<ReturnType<typeof getSessionUser>>);
  vi.mocked(serverClient).mockResolvedValue(db() as unknown as Awaited<ReturnType<typeof serverClient>>);
  const revokeA = async () => {
    const before = await revocationEpoch(db(), seed.teamId);
    await reconcileGdriveItems(db(), seed.teamId, {
      connectionId: connectionA, removedProviderIds: [providerId], reason: "connection A revoked",
    });
    // The real retirement advanced the epoch, while B's claim — another member's audience — keeps
    // the document physically present.
    expect(await revocationEpoch(db(), seed.teamId)).toBeGreaterThan(before);
    const { rows } = await getPool().query<{ integration_id: string; active: boolean }>(
      `select integration_id, active from gdrive_item_claims where team_id=$1 and provider_id=$2`, [seed.teamId, providerId]);
    expect(Object.fromEntries(rows.map((row) => [row.integration_id, row.active])))
      .toEqual({ [connectionA]: false, [connectionB]: true });
    expect((await db().from("items").select("id").eq("id", item.id).maybeSingle()).data).not.toBeNull();
  };
  return { seed, key, item, revokeA };
}

type Route = "v1" | "dashboard";
async function ask(route: Route, seed: Seed, key: string): Promise<Response> {
  const body = { question: "zephyrquartz ledger owner?" };
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
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ team: seed.teamSlug, ...body }),
  }) as unknown as NextRequest);
}

/** Everything a turn could have stored from the captured context. */
async function stored(seed: Seed) {
  const { rows } = await getPool().query(
    `select
       (select coalesce(string_agg(role||':'||content, ' | ' order by created_at), '') from chat_messages where team_id=$1) as messages,
       (select coalesce(string_agg(status||':'||partial_text||':'||coalesce(error_message,''), ' | '), '') from chat_turn_runs where team_id=$1) as runs,
       (select coalesce(string_agg(coalesce(answer_preview,'')||':'||coalesce(cited_item_ids::text,''), ' | '), '') from query_log where team_id=$1) as query_log`,
    [seed.teamId],
  );
  return rows[0] as { messages: string; runs: string; query_log: string };
}

function expectNothingRevokedLeft(text: string): void {
  expect(text).not.toContain(ITEM_TEXT);
  expect(text).not.toContain(GRAPH_FACT);
}

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
