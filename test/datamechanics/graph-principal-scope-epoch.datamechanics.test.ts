import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

/**
 * AIO-1167 R94 — a graph read never re-certifies a principal's REVOKED scope under a newer epoch
 * (real Postgres membership/context state, Google Drive evidence, controlled Neo4j transport).
 *
 * Members A and B share restricted project P through group G; P holds a Google Drive item whose
 * episode, event title, participants and fact live in P's partition. The real `removeMemberFromGroup`
 * removes ONLY A (and advances the epoch); B stays authorized, so P's item placement and partition stay
 * valid — the only revoked authority is A's membership edge. Every attempt must capture the epoch
 * BEFORE resolving A's scope and rebuild that scope on retry:
 *   · events + graph-query: a revocation after A's scope resolves, or during the first graph await,
 *     restarts the whole attempt — P is excluded, independently authorized General evidence remains;
 *   · facts: one attempt — a revocation after scope resolution or during graph I/O is empty + degraded;
 *   · repeated epoch changes exhaust into the existing 503;
 *   · the helper bound to epoch E never returns facts stamped E+1 for fixed groups.
 */

type Edge = { id: string; fact: string; at: string; groupId: string; episodeUuids: string[] };
type Episode = { uuid: string; groupId: string; name: string; title: string; participants: string[]; at: string };

const graph = vi.hoisted(() => ({
  edges: [] as Edge[],
  episodes: [] as Episode[],
  /** Runs ONCE, inside the first graph read (any kind), before it answers. */
  duringFirstRead: null as null | (() => Promise<void>),
  /** Runs on EVERY graph read — for repeated epoch changes. */
  duringEveryRead: null as null | (() => Promise<void>),
}));
const scopeHook = vi.hoisted(() => ({ afterFirstResolve: null as null | (() => Promise<void>) }));

vi.mock("@/lib/graph/neo4j", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/graph/neo4j")>()),
  neo4jConfigured: () => true,
  runRead: async (cypher: string, params: Record<string, unknown> = {}) => {
    const first = graph.duringFirstRead;
    if (first) {
      graph.duringFirstRead = null;
      await first();
    }
    if (graph.duringEveryRead) await graph.duringEveryRead();
    const groups = (params.groups as string[] | undefined) ?? [];
    if (cypher.includes("MENTIONS")) {
      return graph.episodes.filter((episode) => groups.includes(episode.groupId)).map((episode) => ({
        id: episode.uuid, name: episode.name, source: "gdrive", title: episode.title, at: episode.at,
        participants: episode.participants,
        factEvidence: graph.edges.filter((edge) => groups.includes(edge.groupId) && edge.episodeUuids.includes(episode.uuid))
          .map((edge) => ({ id: edge.id, fact: edge.fact, episodeUuids: edge.episodeUuids, groupId: edge.groupId })),
      }));
    }
    if (cypher.includes("RELATES_TO")) {
      const rows = graph.edges.filter((edge) => groups.includes(edge.groupId))
        .sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id));
      const offset = Number(params.offset ?? 0);
      const limit = Number(params.limit ?? rows.length);
      return rows.slice(offset, offset + limit).map((edge) => ({
        id: edge.id, fact: edge.fact, at: edge.at, subjectType: "Person", subject: "Alex",
        object: "payments", episodeUuids: edge.episodeUuids, groupId: edge.groupId,
      }));
    }
    if (cypher.includes("Episodic")) {
      const uuids = (params.uuids as string[] | undefined) ?? [];
      return graph.episodes.filter((episode) => groups.includes(episode.groupId) && uuids.includes(episode.uuid))
        .map((episode) => ({ uuid: episode.uuid, name: episode.name, source: "gdrive" }));
    }
    throw new Error(`unexpected graph read in this suite: ${cypher.slice(0, 80)}`);
  },
}));
// The REAL partition selection; a hook runs right after it returns (A's scope resolved, before graph use).
vi.mock("@/lib/graph/partition-read", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/graph/partition-read")>();
  return {
    ...actual,
    selectEnforcedGraphPartitions: async (...args: Parameters<typeof actual.selectEnforcedGraphPartitions>) => {
      const scope = await actual.selectEnforcedGraphPartitions(...args);
      const after = scopeHook.afterFirstResolve;
      if (after) {
        scopeHook.afterFirstResolve = null;
        await after();
      }
      return scope;
    },
  };
});
vi.mock("@/lib/auth/session", () => ({ getSessionUser: vi.fn() }));
vi.mock("@/lib/db/server", () => ({ serverClient: vi.fn() }));

import { ensureAccessBootstrap, GENERAL_SLUG } from "@/lib/access/bootstrap";
import { addMemberToGroup, createGroup, grantProjectToGroup, removeMemberFromGroup } from "@/lib/access/groups";
import { revocationEpoch } from "@/lib/access/authorization-epoch";
import { issueApiKey } from "@/lib/admin/keys";
import { getSessionUser } from "@/lib/auth/session";
import { getPool, runSql } from "@/lib/db/pg/pool";
import { serverClient } from "@/lib/db/server";
import { episodeName } from "@/lib/graph/episode-name";
import { projectGroupId } from "@/lib/graph/group";
import { GraphScopeEpochChangedError, readAuthorizedGraphFactsResult } from "@/lib/graph/provenance-read";
import { backfillTeamContext } from "@/lib/projects/context/backfill";
import { convergeIdentityAttribution, db, driveFixture, ingest, placeMemberByTier, seedTeam, type Seed } from "./helpers";

const SECRET_TITLE = "vellichor restricted roadmap";
const SECRET_PARTICIPANT = "Quillon Restricted";
const SECRET_FACT = "Alex owns the vellichor restricted roadmap";
const OPEN_FACT = "Alex owns the general payments ledger";

beforeEach(() => {
  graph.edges = [];
  graph.episodes = [];
  graph.duringFirstRead = null;
  graph.duringEveryRead = null;
  scopeHook.afterFirstResolve = null;
});
afterEach(() => {
  vi.mocked(getSessionUser).mockReset();
  vi.mocked(serverClient).mockReset();
});

async function member(seed: Seed): Promise<{ id: string; authUserId: string }> {
  const authUserId = randomUUID();
  const { data } = await db().from("members").insert({
    team_id: seed.teamId, email: `${randomUUID()}@test.local`, display_name: "M",
    actor_handle: `m-${randomUUID().slice(0, 10)}`, role: "member", tier: "team", status: "active",
  }).select("id").single();
  const id = (data as { id: string }).id;
  await placeMemberByTier(seed.teamId, id, "team");
  await getPool().query(`insert into auth_users(id,email) values($1,$2)`, [authUserId, `${randomUUID()}@test.local`]);
  await getPool().query(`update members set auth_user_id=$1 where id=$2`, [authUserId, id]);
  return { id, authUserId };
}

async function moveInto(seed: Seed, itemId: string, projectId: string): Promise<void> {
  const { data: unit } = await db().from("project_context_units").select("id").eq("source_item_id", itemId).single();
  await db().from("project_context_memberships").update({ valid_to: new Date().toISOString() })
    .eq("context_unit_id", (unit as { id: string }).id).is("valid_to", null);
  await db().from("project_context_memberships").insert({
    team_id: seed.teamId, project_id: projectId, context_unit_id: (unit as { id: string }).id, method: "manual",
  });
}

async function world() {
  const seed = await seedTeam();
  const openItem = await ingest(seed, { path: "open.md", body: "general payments", access: "team", project: "src" });
  const driveItem = await driveFixture(seed, {
    project: "drive-src", path: `gdrive/roadmap-${randomUUID()}.md`, body: `${SECRET_TITLE} body`,
    frontmatter: { source: "gdrive", source_id: `roadmap-${randomUUID().slice(0, 8)}`, title: SECRET_TITLE },
  });
  expect((await ensureAccessBootstrap(db(), seed.teamId)).ok).toBe(true);
  await backfillTeamContext(db(), seed.teamId);
  const a = await member(seed);
  const b = await member(seed);

  // Restricted project P (its own partition), granted to group G = {A, B}, holding the Drive item.
  const { data: project } = await db().from("projects").insert({
    team_id: seed.teamId, slug: `p-${randomUUID().slice(0, 6)}`, name: "P", kind: "initiative",
  }).select("id").single();
  const projectId = (project as { id: string }).id;
  const partition = projectGroupId(seed.teamId, projectId);
  await runSql("update projects set graph_group_id = $1 where id = $2", [partition, projectId]);
  const group = await createGroup(db(), seed.teamId, `g-${randomUUID().slice(0, 6)}`, "G", seed.memberId);
  for (const m of [a, b]) expect((await addMemberToGroup(db(), seed.teamId, group.groupId!, m.id, seed.memberId)).ok).toBe(true);
  expect((await grantProjectToGroup(db(), seed.teamId, projectId, group.groupId!, seed.memberId)).ok).toBe(true);
  await moveInto(seed, driveItem.id, projectId);
  const { armProjectsForPrincipal } = await import("@/lib/graph/arming");
  await armProjectsForPrincipal(db(), { teamId: seed.teamId, projectIds: [projectId] });
  await runSql(
    "update graph_episodes set content_sha256 = 'x', episode_uuid = 'ep-ready' where team_id = $1 and group_id = $2",
    [seed.teamId, partition],
  );
  const { data: general } = await db().from("projects").select("graph_group_id")
    .eq("team_id", seed.teamId).eq("slug", GENERAL_SLUG).single();
  const generalGroup = (general as { graph_group_id: string }).graph_group_id;

  const at = new Date(Date.now() - 60_000).toISOString();
  graph.episodes.push(
    { uuid: "ep-open", groupId: generalGroup, name: episodeName(openItem.id, 0, 1), title: "general payments ledger", participants: ["Alex"], at },
    { uuid: "ep-secret", groupId: partition, name: episodeName(driveItem.id, 0, 1), title: SECRET_TITLE, participants: [SECRET_PARTICIPANT], at },
  );
  graph.edges.push(
    { id: "f-open", fact: OPEN_FACT, at, groupId: generalGroup, episodeUuids: ["ep-open"] },
    { id: "f-secret", fact: SECRET_FACT, at, groupId: partition, episodeUuids: ["ep-secret"] },
  );
  await convergeIdentityAttribution(seed);
  const revokeA = async () => {
    expect((await removeMemberFromGroup(db(), seed.teamId, group.groupId!, a.id, seed.memberId)).ok).toBe(true);
  };
  return { seed, a, b, partition, revokeA };
}
type W = Awaited<ReturnType<typeof world>>;

function asSession(m: { authUserId: string }) {
  vi.mocked(getSessionUser).mockResolvedValue({ id: m.authUserId } as Awaited<ReturnType<typeof getSessionUser>>);
  vi.mocked(serverClient).mockResolvedValue(db() as unknown as Awaited<ReturnType<typeof serverClient>>);
}
async function events(w: W, m: { authUserId: string }) {
  asSession(m);
  const { GET } = await import("@/app/api/brain/events/route");
  const res = await GET(new Request(`http://test/api/brain/events?team=${w.seed.teamSlug}`) as unknown as NextRequest);
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}
async function facts(w: W, m: { authUserId: string }) {
  asSession(m);
  const { GET } = await import("@/app/api/brain/facts/route");
  const res = await GET(new Request(`http://test/api/brain/facts?team=${w.seed.teamSlug}`) as unknown as NextRequest);
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}
async function graphQuery(w: W, m: { id: string }) {
  const { POST } = await import("@/app/api/v1/graph-query/route");
  const { key } = await issueApiKey(db(), w.seed.teamId, m.id, `gq-${randomUUID().slice(0, 6)}`);
  const res = await POST(new Request("http://test/api/v1/graph-query", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ query: "who owns what?", maxFacts: 50 }),
  }) as unknown as NextRequest);
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}
const leaks = (body: unknown) => {
  const text = JSON.stringify(body);
  return [SECRET_TITLE, SECRET_PARTICIPANT, SECRET_FACT].some((secret) => text.includes(secret));
};

describe("R94: a principal's scope is re-resolved under every epoch it is certified at", () => {
  it("controls: before any revocation A and B both see the restricted evidence; B keeps it after A is revoked", async () => {
    const w = await world();
    for (const read of [events, facts]) expect(leaks((await read(w, w.a)).body)).toBe(true);
    expect(leaks((await graphQuery(w, w.a)).body)).toBe(true);
    await w.revokeA();
    expect(leaks((await events(w, w.b)).body), "B is still authorized").toBe(true);
    expect(leaks((await graphQuery(w, w.b)).body)).toBe(true);
    expect(leaks((await events(w, w.a)).body), "A is not").toBe(false);
  }, 60_000);

  it.each(["after scope resolution", "during the first graph await"] as const)("events: revocation %s — the retry rebuilds A's scope; General evidence remains", async (when) => {
    const w = await world();
    if (when === "after scope resolution") scopeHook.afterFirstResolve = w.revokeA;
    else graph.duringFirstRead = w.revokeA;
    const res = await events(w, w.a);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(leaks(res.body)).toBe(false);
    expect(JSON.stringify(res.body)).toContain("general payments ledger");
  }, 60_000);

  it.each(["after scope resolution", "during the first graph await"] as const)("graph-query: revocation %s — the retry rebuilds A's scope; General facts remain", async (when) => {
    const w = await world();
    if (when === "after scope resolution") scopeHook.afterFirstResolve = w.revokeA;
    else graph.duringFirstRead = w.revokeA;
    const res = await graphQuery(w, w.a);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(leaks(res.body)).toBe(false);
    expect(JSON.stringify(res.body)).toContain(OPEN_FACT);
  }, 60_000);

  it.each(["after scope resolution", "during the first graph await"] as const)("facts: revocation %s — one attempt, empty and degraded", async (when) => {
    const w = await world();
    if (when === "after scope resolution") scopeHook.afterFirstResolve = w.revokeA;
    else graph.duringFirstRead = w.revokeA;
    const res = await facts(w, w.a);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ facts: [], degraded: true });
  }, 60_000);

  it("repeated epoch changes exhaust into the existing unavailable answer (events and graph-query)", async () => {
    const w = await world();
    graph.duringEveryRead = async () => {
      await getPool().query(`update team_authorization_epochs set epoch = epoch + 1, updated_at = now() where team_id=$1`, [w.seed.teamId]);
    };
    const ev = await events(w, w.a);
    expect(ev.status).toBe(503);
    expect(leaks(ev.body)).toBe(false);
    const gq = await graphQuery(w, w.a);
    expect(gq.status).toBe(503);
    expect(leaks(gq.body)).toBe(false);
  }, 60_000);

  it("the helper: fixed groups bound to epoch E never return facts stamped E+1", async () => {
    const w = await world();
    const epoch = await revocationEpoch(db(), w.seed.teamId);
    // Bound to E, but E+1 is already current: refused before any read — never re-certified.
    await w.revokeA();
    await expect(readAuthorizedGraphFactsResult(db(), {
      teamId: w.seed.teamId, groupIds: [w.partition], expectedEpoch: epoch,
    })).rejects.toBeInstanceOf(GraphScopeEpochChangedError);
    // Bound to the current epoch, a change DURING the read is the same refusal — no internal retry.
    const current = await revocationEpoch(db(), w.seed.teamId);
    graph.duringFirstRead = async () => {
      await getPool().query(`update team_authorization_epochs set epoch = epoch + 1, updated_at = now() where team_id=$1`, [w.seed.teamId]);
    };
    await expect(readAuthorizedGraphFactsResult(db(), {
      teamId: w.seed.teamId, groupIds: [w.partition], expectedEpoch: current,
    })).rejects.toBeInstanceOf(GraphScopeEpochChangedError);
    // Control — the established unbound contract (retrieve): its own retry, and the epoch it read under.
    graph.duringFirstRead = async () => {
      await getPool().query(`update team_authorization_epochs set epoch = epoch + 1, updated_at = now() where team_id=$1`, [w.seed.teamId]);
    };
    const unbound = await readAuthorizedGraphFactsResult(db(), { teamId: w.seed.teamId, groupIds: [w.partition] });
    expect(unbound.epoch).toBe(await revocationEpoch(db(), w.seed.teamId));
  }, 60_000);
});
