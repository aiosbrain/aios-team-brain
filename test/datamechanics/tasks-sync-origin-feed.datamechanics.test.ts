import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { GET as tasksGET } from "@/app/api/v1/tasks/route";
import { issueApiKey } from "@/lib/admin/keys";
import { db, seedTeam, type Seed } from "./helpers";

/**
 * Spec for AIO-537 (brain-api 1.13) — the task-writeback RETURN LEG.
 *
 * Before 1.13 the only rows `GET /api/v1/tasks` emitted were dashboard-origin (`origin='ui'`) or
 * rows whose `updated_at` post-dated the pushing item's `synced_at`. A workspace-pushed
 * (`origin='sync'`) row whose status later changed in Linear therefore never reached the
 * workspace markdown, and `3-log/tasks-team.md` decayed (the field audit: 6 rows said `todo`
 * while Linear said Done/In Progress).
 *
 * These assertions are derived from the contract in `../aios-workspace/docs/brain-api.md` §
 * "sync-origin return leg", not from the implementation:
 *   1. sync-origin rows are returned ONLY in the new explicit mode (old clients see no change),
 *   2. the mode is scoped to ONE project (a workspace merges only its own table),
 *   3. tier isolation holds (an external key never sees a team-audience row — no RLS backstop),
 *   4. `raw_status` rides along in this mode only (the client's normalization-echo guard).
 */

const URL = "http://test/api/v1/tasks";

async function issueKeyFor(seed: Seed, tier: "team" | "external"): Promise<string> {
  let memberId = seed.memberId;
  if (tier === "external") {
    const { data, error } = await db()
      .from("members")
      .insert({
        team_id: seed.teamId,
        email: `ext-${randomUUID().slice(0, 8)}@test.local`,
        display_name: "External",
        actor_handle: `ext-${randomUUID().slice(0, 8)}`,
        role: "member",
        tier: "external",
        status: "active",
      })
      .select("id")
      .single();
    if (error || !data) throw new Error(`external member seed failed: ${error?.message}`);
    memberId = (data as { id: string }).id;
  }
  const { key } = await issueApiKey(db(), seed.teamId, memberId, `${tier} key`);
  return key;
}

function get(key: string, teamSlug: string, qs: string) {
  const req = new Request(`${URL}?${qs}`, {
    headers: { Authorization: `Bearer ${key}`, "X-AIOS-Team": teamSlug },
  }) as unknown as NextRequest;
  return tasksGET(req);
}

type FeedRow = {
  row_key: string;
  status: string;
  assignee: string;
  raw_status?: string | null;
};
type Feed = { mode: string; tasks: { project: string; rows: FeedRow[] }[] };

function rowsOf(feed: Feed, project?: string): FeedRow[] {
  return feed.tasks
    .filter((g) => (project ? g.project === project : true))
    .flatMap((g) => g.rows);
}

async function seedProject(teamId: string, slug: string): Promise<string> {
  const { data } = await db()
    .from("projects")
    .insert({ team_id: teamId, slug, name: slug })
    .select("id")
    .single();
  return (data as { id: string }).id;
}

async function seedTask(args: {
  teamId: string;
  projectId: string;
  rowKey: string;
  origin: "sync" | "ui";
  status?: string;
  rawStatus?: string | null;
  assignee?: string;
  audience?: "team" | "external";
}): Promise<void> {
  const { error } = await db()
    .from("tasks")
    .insert({
      team_id: args.teamId,
      project_id: args.projectId,
      row_key: args.rowKey,
      title: `task ${args.rowKey}`,
      status: args.status ?? "done",
      raw_status: args.rawStatus ?? null,
      assignee: args.assignee ?? "",
      origin: args.origin,
      audience: args.audience ?? "team",
      updated_at: "2026-07-01T10:00:00Z",
    });
  if (error) throw new Error(`task seed failed: ${error.message}`);
}

describe("tasks sync-origin return leg (real handler, real Postgres)", () => {
  it("returns workspace-pushed rows ONLY in sync-origin mode — the default feed is unchanged", async () => {
    const seed = await seedTeam();
    const proj = await seedProject(seed.teamId, "acme");
    const key = await issueKeyFor(seed, "team");
    await seedTask({ teamId: seed.teamId, projectId: proj, rowKey: "T-01", origin: "sync", status: "done" });
    await seedTask({ teamId: seed.teamId, projectId: proj, rowKey: "T-UI", origin: "ui", status: "ready" });

    // Old client (no `mode`): sync-origin row stays invisible; the UI row still comes through.
    const legacy = (await (await get(key, seed.teamSlug, "since=1970-01-01T00:00:00Z")).json()) as Feed;
    expect(legacy.mode).toBe("writeback");
    expect(rowsOf(legacy).map((r) => r.row_key)).toEqual(["T-UI"]);

    // New client: gets the sync-origin row, and NOT the dashboard-origin one (no double merge).
    const res = await get(key, seed.teamSlug, "mode=sync-origin&project=acme&since=1970-01-01T00:00:00Z");
    const feed = (await res.json()) as Feed;
    expect(res.status).toBe(200);
    expect(feed.mode).toBe("sync-origin");
    expect(rowsOf(feed, "acme").map((r) => r.row_key)).toEqual(["T-01"]);
    expect(rowsOf(feed, "acme")[0].status).toBe("done");
  });

  it("scopes sync-origin rows to the requested project", async () => {
    const seed = await seedTeam();
    const mine = await seedProject(seed.teamId, "mine");
    const theirs = await seedProject(seed.teamId, "theirs");
    const key = await issueKeyFor(seed, "team");
    await seedTask({ teamId: seed.teamId, projectId: mine, rowKey: "M-1", origin: "sync" });
    await seedTask({ teamId: seed.teamId, projectId: theirs, rowKey: "X-1", origin: "sync" });

    const feed = (await (await get(key, seed.teamSlug, "mode=sync-origin&project=mine")).json()) as Feed;
    expect(rowsOf(feed).map((r) => r.row_key)).toEqual(["M-1"]);
    expect(feed.tasks.map((g) => g.project)).toEqual(["mine"]);

    // An unknown project is an EMPTY feed, not an error (indistinguishable from a pre-1.13 brain).
    const unknown = await get(key, seed.teamSlug, "mode=sync-origin&project=nope");
    expect(unknown.status).toBe(200);
    expect(((await unknown.json()) as Feed).tasks).toEqual([]);
  });

  it("never leaks a team-audience row to an external-tier key in sync-origin mode", async () => {
    const seed = await seedTeam();
    const proj = await seedProject(seed.teamId, "acme");
    await seedTask({ teamId: seed.teamId, projectId: proj, rowKey: "T-INTERNAL", origin: "sync", audience: "team" });
    await seedTask({ teamId: seed.teamId, projectId: proj, rowKey: "T-SHARED", origin: "sync", audience: "external" });

    const ext = await issueKeyFor(seed, "external");
    const extFeed = (await (await get(ext, seed.teamSlug, "mode=sync-origin&project=acme")).json()) as Feed;
    expect(rowsOf(extFeed).map((r) => r.row_key)).toEqual(["T-SHARED"]);

    // Not over-restrictive: the team key sees both.
    const team = await issueKeyFor(seed, "team");
    const teamFeed = (await (await get(team, seed.teamSlug, "mode=sync-origin&project=acme")).json()) as Feed;
    expect(rowsOf(teamFeed).map((r) => r.row_key).sort()).toEqual(["T-INTERNAL", "T-SHARED"]);
  });

  it("carries raw_status + assignee in sync-origin mode only", async () => {
    const seed = await seedTeam();
    const proj = await seedProject(seed.teamId, "acme");
    const key = await issueKeyFor(seed, "team");
    // An unmapped markdown status ("todo") normalizes to backlog with raw_status preserved —
    // the client uses it to skip a normalization echo instead of clobbering the author's word.
    await seedTask({
      teamId: seed.teamId,
      projectId: proj,
      rowKey: "T-01",
      origin: "sync",
      status: "backlog",
      rawStatus: "todo",
      assignee: "riley",
    });
    await seedTask({ teamId: seed.teamId, projectId: proj, rowKey: "T-UI", origin: "ui", status: "ready" });

    const feed = (await (await get(key, seed.teamSlug, "mode=sync-origin&project=acme")).json()) as Feed;
    expect(rowsOf(feed)[0]).toMatchObject({ raw_status: "todo", assignee: "riley", status: "backlog" });

    // The pre-1.13 shapes gain no new key (byte-compatible for old clients).
    const legacy = (await (await get(key, seed.teamSlug, "")).json()) as Feed;
    expect(rowsOf(legacy)[0]).not.toHaveProperty("raw_status");
    const table = (await (await get(key, seed.teamSlug, "all=1")).json()) as Feed;
    expect(table.mode).toBe("table");
    expect(rowsOf(table)[0]).not.toHaveProperty("raw_status");
  });

  it("rejects an unknown mode and a sync-origin call without a project (400, never a silent downgrade)", async () => {
    const seed = await seedTeam();
    const key = await issueKeyFor(seed, "team");

    const bogus = await get(key, seed.teamSlug, "mode=everything");
    expect(bogus.status).toBe(400);
    expect((await bogus.json()).error.code).toBe("invalid_request");

    const noProject = await get(key, seed.teamSlug, "mode=sync-origin");
    expect(noProject.status).toBe(400);
    expect((await noProject.json()).error.code).toBe("invalid_request");
  });
});
