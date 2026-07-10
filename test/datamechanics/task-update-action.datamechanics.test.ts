import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { upsertIntegration, setIntegrationSecret } from "@/lib/integrations/manage";
import { db, seedTeam, type Seed } from "./helpers";

// Spec (brain-api v1.2 Phase 4): the dashboard `updateTaskAction` is the second authoring surface.
// It must persist & round-trip ALL projectable fields, enforce parent integrity (missing/self/cycle),
// and schedule reactive projection via `next/server`'s `after()`. Verified to the observable outcome
// on real Postgres, with the after() callback captured and a mutation-counting Linear stub (no live
// PM calls in CI). updateTaskAction itself depends on request-context modules (serverClient/auth/
// after) — those three are mocked to the service-role test DB; the action's own logic runs unchanged.

const h = vi.hoisted(() => ({
  memberId: "",
  afterCbs: [] as Array<() => Promise<void> | void>,
}));

vi.mock("@/lib/db/server", () => ({
  serverClient: async () => (await import("@/lib/db/admin")).adminClient(),
}));
vi.mock("@/lib/auth/guard", () => ({
  currentMember: async () =>
    h.memberId ? { id: h.memberId, role: "admin", tier: "team", userId: "u" } : null,
}));
vi.mock("next/server", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, after: (cb: () => Promise<void> | void) => h.afterCbs.push(cb) };
});

// Imported AFTER the mocks are registered (vi.mock is hoisted, so this is safe).
const { updateTaskAction } = await import("@/app/actions/tasks");

// ── Linear stub: routes GraphQL by operation, records mutations, mints issue ids ────────────────
function linearMock() {
  const mutations: { name: string }[] = [];
  let n = 0;
  const states = [
    { id: "ls-backlog", name: "Backlog", type: "backlog" },
    { id: "ls-todo", name: "Todo", type: "unstarted" },
    { id: "ls-started", name: "In Progress", type: "started" },
    { id: "ls-done", name: "Done", type: "completed" },
  ];
  const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
    const { query } = JSON.parse(String(init?.body));
    if (query.includes("ProjectionBootstrap")) {
      return Response.json({ data: { team: { states: { nodes: states }, labels: { nodes: [] } } } });
    }
    if (query.includes("ProjectionIssues")) {
      return Response.json({ data: { team: { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } });
    }
    const name = query.match(/mutation (\w+)/)?.[1] ?? "op";
    if (query.includes("mutation")) mutations.push({ name });
    if (query.includes("issueCreate")) {
      const id = `li-${++n}`;
      return Response.json({ data: { issueCreate: { success: true, issue: { id, identifier: `AIO-${n}`, url: `https://linear.app/${id}` } } } });
    }
    if (query.includes("issueUpdate")) {
      return Response.json({ data: { issueUpdate: { success: true, issue: { id: "li-x", identifier: "AIO-1", url: "https://linear.app/AIO-1" } } } });
    }
    return Response.json({ data: {} });
  }) as unknown as typeof fetch;
  return { fetchImpl, mutations };
}

async function seedLinearPrimary(seed: Seed) {
  await db().from("teams").update({ primary_pm_provider: "linear" }).eq("id", seed.teamId);
  const auth = { teamId: seed.teamId, memberId: seed.memberId };
  const { id } = await upsertIntegration(db(), auth, { type: "linear", name: "linear", config: { teamId: "team-uuid" } });
  await setIntegrationSecret(db(), auth, id, "lin_api_x");
}

async function seedProject(teamId: string): Promise<string> {
  const { data } = await db()
    .from("projects")
    .insert({ team_id: teamId, slug: `p-${randomUUID().slice(0, 6)}`, name: "Proj" })
    .select("id")
    .single();
  return (data as { id: string }).id;
}

async function seedTask(teamId: string, projectId: string, rowKey: string, over: Record<string, unknown> = {}): Promise<string> {
  const { data } = await db()
    .from("tasks")
    .insert({ team_id: teamId, project_id: projectId, row_key: rowKey, title: rowKey, status: "backlog", origin: "ui", ...over })
    .select("id")
    .single();
  return (data as { id: string }).id;
}

async function readTask(taskId: string) {
  const { data } = await db()
    .from("tasks")
    .select("title, sprint, due_date, parent_row_key, labels, priority, body")
    .eq("id", taskId)
    .single();
  return data as {
    title: string;
    sprint: string;
    due_date: string | null;
    parent_row_key: string | null;
    labels: string[];
    priority: string;
    body: string;
  };
}

beforeEach(() => {
  h.memberId = "";
  h.afterCbs = [];
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("updateTaskAction — persistence & round-trip (real Postgres)", () => {
  it("persists every projectable field and reads them back", async () => {
    const seed = await seedTeam();
    h.memberId = seed.memberId;
    const project = await seedProject(seed.teamId);
    await seedTask(seed.teamId, project, "E1");
    const childId = await seedTask(seed.teamId, project, "C1");

    const res = await updateTaskAction({
      taskId: childId,
      title: "Child renamed",
      sprint: "Wave 2",
      dueDate: "2030-03-01",
      parentRowKey: "E1",
      labels: ["integration", "wave-2"],
      priority: "critical", // normalizes → urgent
      body: "dashboard-only description",
    });
    expect(res.ok).toBe(true);

    const t = await readTask(childId);
    expect(t.title).toBe("Child renamed");
    expect(t.sprint).toBe("Wave 2");
    const d = new Date(t.due_date as string); // pg adapter returns `date` cols as a local-midnight Date
    expect([d.getFullYear(), d.getMonth() + 1, d.getDate()]).toEqual([2030, 3, 1]);
    expect(t.parent_row_key).toBe("E1");
    expect(t.labels).toEqual(["integration", "wave-2"]);
    expect(t.priority).toBe("urgent");
    expect(t.body).toBe("dashboard-only description");
  });

  it("is partial — a title-only edit never clobbers existing labels/priority", async () => {
    const seed = await seedTeam();
    h.memberId = seed.memberId;
    const project = await seedProject(seed.teamId);
    const id = await seedTask(seed.teamId, project, "T1", { labels: ["keep"], priority: "high" });

    const res = await updateTaskAction({ taskId: id, title: "only title" });
    expect(res.ok).toBe(true);
    const t = await readTask(id);
    expect(t.title).toBe("only title");
    expect(t.labels).toEqual(["keep"]); // untouched
    expect(t.priority).toBe("high"); // untouched
  });
});

describe("updateTaskAction — parent integrity (real Postgres)", () => {
  it("rejects a parent that does not resolve in the project", async () => {
    const seed = await seedTeam();
    h.memberId = seed.memberId;
    const project = await seedProject(seed.teamId);
    const id = await seedTask(seed.teamId, project, "C1");
    const res = await updateTaskAction({ taskId: id, parentRowKey: "GHOST" });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/not found/);
  });

  it("rejects a self-parent", async () => {
    const seed = await seedTeam();
    h.memberId = seed.memberId;
    const project = await seedProject(seed.teamId);
    const id = await seedTask(seed.teamId, project, "A");
    const res = await updateTaskAction({ taskId: id, parentRowKey: "A" });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/own parent/);
  });

  it("rejects a 2-node cycle (A is parent of B; re-parenting A under B closes the loop)", async () => {
    const seed = await seedTeam();
    h.memberId = seed.memberId;
    const project = await seedProject(seed.teamId);
    const aId = await seedTask(seed.teamId, project, "A");
    // B is A's child (B.parent = A).
    await seedTask(seed.teamId, project, "B", { parent_row_key: "A" });

    // Now point A at B → A→B→A. Must be rejected as a cycle (not silently persisted).
    const res = await updateTaskAction({ taskId: aId, parentRowKey: "B" });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/cycle/i);
    // And the DB must be unchanged — A still has no parent.
    expect((await readTask(aId)).parent_row_key).toBeNull();
  });

  it("rejects a 3-node cycle (A→B→C, re-parenting A under C)", async () => {
    const seed = await seedTeam();
    h.memberId = seed.memberId;
    const project = await seedProject(seed.teamId);
    const aId = await seedTask(seed.teamId, project, "A");
    await seedTask(seed.teamId, project, "B", { parent_row_key: "A" });
    await seedTask(seed.teamId, project, "C", { parent_row_key: "B" });

    const res = await updateTaskAction({ taskId: aId, parentRowKey: "C" });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/cycle/i);
  });

  it("allows a legitimate re-parent that introduces no cycle", async () => {
    const seed = await seedTeam();
    h.memberId = seed.memberId;
    const project = await seedProject(seed.teamId);
    await seedTask(seed.teamId, project, "E1");
    const cId = await seedTask(seed.teamId, project, "C1");
    const res = await updateTaskAction({ taskId: cId, parentRowKey: "E1" });
    expect(res.ok).toBe(true);
    expect((await readTask(cId)).parent_row_key).toBe("E1");
  });
});

describe("updateTaskAction — reactive projection via after() (real Postgres)", () => {
  it("schedules a projection that fires projectTask (create path) when the after() callback runs", async () => {
    const seed = await seedTeam();
    h.memberId = seed.memberId;
    await seedLinearPrimary(seed);
    const project = await seedProject(seed.teamId);
    const id = await seedTask(seed.teamId, project, "P0");

    const { fetchImpl, mutations } = linearMock();
    vi.stubGlobal("fetch", fetchImpl); // scheduleProjection's after() callback uses global fetch

    const res = await updateTaskAction({ taskId: id, title: "edited via dashboard" });
    expect(res.ok).toBe(true);
    expect(h.afterCbs.length).toBe(1); // a projection was scheduled

    // Run the scheduled work (as next/server would after the response is sent).
    for (const cb of h.afterCbs) await cb();

    expect(mutations.some((m) => m.name === "CreateIssue")).toBe(true);
    const { data: link } = await db()
      .from("task_pm_links")
      .select("provider, provider_resource_id, projection_fingerprint")
      .eq("team_id", seed.teamId)
      .eq("row_key", "P0")
      .maybeSingle();
    expect(link).toMatchObject({ provider: "linear", provider_resource_id: "li-1" });
    expect((link as { projection_fingerprint: string | null }).projection_fingerprint).toBeTruthy();
  });
});
