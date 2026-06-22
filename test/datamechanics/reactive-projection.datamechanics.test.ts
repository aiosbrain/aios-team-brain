import { describe, expect, it, vi } from "vitest";
import { projectTaskByIdAfterWrite, projectChangedTasksAfterWrite } from "@/lib/pm-sync";
import { upsertIntegration, setIntegrationSecret } from "@/lib/integrations/manage";
import { db, ingest, seedTeam, type Seed } from "./helpers";

// Spec (brain-api v1.2 Phase 2): reactive projection of task writes into the primary PM tool.
// Verified to the observable outcome on real Postgres, with a mutation-counting stub `fetchImpl`
// (the linearMock pattern from test/pm-sync-adapters.test.ts) — NO live Linear calls in CI.

// ── Linear stub: routes GraphQL by operation, records mutations, mints distinct issue ids ──────────
function linearMock(opts: { issues?: unknown[]; labels?: unknown[] } = {}) {
  const mutations: { name: string; variables: { [k: string]: unknown } }[] = [];
  let n = 0;
  const states = [
    { id: "ls-backlog", name: "Backlog", type: "backlog" },
    { id: "ls-todo", name: "Todo", type: "unstarted" },
    { id: "ls-started", name: "In Progress", type: "started" },
    { id: "ls-done", name: "Done", type: "completed" },
  ];
  const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
    const { query, variables } = JSON.parse(String(init?.body));
    if (query.includes("ProjectionBootstrap")) {
      return Response.json({ data: { team: { states: { nodes: states }, labels: { nodes: opts.labels ?? [] } } } });
    }
    if (query.includes("ProjectionIssues")) {
      return Response.json({ data: { team: { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: opts.issues ?? [] } } } });
    }
    const name = query.match(/mutation (\w+)/)?.[1] ?? query.match(/query (\w+)/)?.[1] ?? "op";
    if (query.includes("mutation")) mutations.push({ name, variables });
    if (query.includes("issueCreate")) {
      const id = `li-${++n}`;
      return Response.json({ data: { issueCreate: { success: true, issue: { id, identifier: `AIO-${n}`, url: `https://linear.app/${id}` } } } });
    }
    if (query.includes("issueUpdate")) {
      return Response.json({ data: { issueUpdate: { success: true, issue: { id: variables.id, identifier: "AIO-1", url: "https://linear.app/AIO-1" } } } });
    }
    if (query.includes("issueLabelCreate")) {
      return Response.json({ data: { issueLabelCreate: { issueLabel: { id: `label-${++n}` } } } });
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

// Push a tasks.md item. `salt` keeps content_sha256 unique so each push re-materializes (mirrors a
// real edited tasks.md); the row fields drive the projected columns.
const pushTasks = (seed: Seed, salt: string, rows: Record<string, unknown>[]) =>
  ingest(seed, {
    kind: "task",
    path: "3-log/tasks.md",
    body: `${salt}\n` + rows.map((r) => `| ${r.row_key} | ${r.title} | ${r.parent ?? ""} | ${r.due ?? ""} |`).join("\n"),
    access: "team",
    rows,
  } as never);

async function projectIdOf(teamId: string): Promise<string> {
  const { data } = await db().from("projects").select("id").eq("team_id", teamId).eq("slug", "acme").single();
  return (data as { id: string }).id;
}
async function taskIdOf(teamId: string, rowKey: string): Promise<string> {
  const { data } = await db().from("tasks").select("id").eq("team_id", teamId).eq("row_key", rowKey).single();
  return (data as { id: string }).id;
}
async function linkOf(teamId: string, rowKey: string) {
  const { data } = await db()
    .from("task_pm_links")
    .select("provider, provider_external_id, provider_resource_id, projection_fingerprint, last_error")
    .eq("team_id", teamId)
    .eq("row_key", rowKey)
    .maybeSingle();
  return data as {
    provider: string;
    provider_external_id: string;
    provider_resource_id: string | null;
    projection_fingerprint: string | null;
    last_error: string | null;
  } | null;
}

describe("reactive projection — single task write (real Postgres)", () => {
  it("a task with no PM column auto-creates a link + projects (create path)", async () => {
    const seed = await seedTeam();
    await seedLinearPrimary(seed);
    await pushTasks(seed, "v1", [{ row_key: "P0", title: "Solo task" }]);
    const taskId = await taskIdOf(seed.teamId, "P0");

    const { fetchImpl, mutations } = linearMock();
    const report = await projectTaskByIdAfterWrite(db(), taskId, { fetchImpl });

    expect(report?.status).toBe("synced");
    const link = await linkOf(seed.teamId, "P0");
    expect(link).toMatchObject({ provider: "linear", provider_external_id: "P0", provider_resource_id: "li-1" });
    expect(link?.projection_fingerprint).toBeTruthy();
    expect(mutations.some((m) => m.name === "CreateIssue")).toBe(true);
  });

  it("a projection failure does NOT throw and only records last_error", async () => {
    const seed = await seedTeam();
    await seedLinearPrimary(seed);
    await pushTasks(seed, "v1", [{ row_key: "P0", title: "x" }]);
    const taskId = await taskIdOf(seed.teamId, "P0");

    const failing = vi.fn(async () => {
      throw new Error("linear down");
    }) as unknown as typeof fetch;

    // The helper must RESOLVE (never reject) so the originating user action stays successful.
    const report = await projectTaskByIdAfterWrite(db(), taskId, { fetchImpl: failing });
    expect(report?.status).toBe("failed");

    const link = await linkOf(seed.teamId, "P0");
    expect(link?.last_error).toBeTruthy();
    expect(link?.provider_resource_id).toBeNull(); // nothing was created
  });

  it("a second projection of an unchanged task makes ZERO provider writes (fingerprint skip)", async () => {
    const seed = await seedTeam();
    await seedLinearPrimary(seed);
    await pushTasks(seed, "v1", [{ row_key: "P0", title: "x" }]);
    const taskId = await taskIdOf(seed.teamId, "P0");

    const first = linearMock();
    await projectTaskByIdAfterWrite(db(), taskId, { fetchImpl: first.fetchImpl });

    const second = linearMock();
    const report = await projectTaskByIdAfterWrite(db(), taskId, { fetchImpl: second.fetchImpl });

    expect(report?.status).toBe("skipped");
    expect(second.mutations.length).toBe(0);
    expect(second.fetchImpl).not.toHaveBeenCalled(); // short-circuited before any round-trip
  });
});

describe("reactive projection — changed-rows batch (real Postgres)", () => {
  it("projects parent before child so the child carries the epic's resource id", async () => {
    const seed = await seedTeam();
    await seedLinearPrimary(seed);
    await pushTasks(seed, "v1", [
      { row_key: "E", title: "Epic" },
      { row_key: "C", title: "Child", parent: "E" },
    ]);
    const projectId = await projectIdOf(seed.teamId);

    const { fetchImpl, mutations } = linearMock();
    // Pass the row_keys child-first to prove topo-order projects the epic first regardless.
    const reports = await projectChangedTasksAfterWrite(db(), seed.teamId, projectId, ["C", "E"], { fetchImpl });

    expect(reports.length).toBe(2);
    expect(reports.every((r) => r.status === "synced")).toBe(true);

    const creates = mutations.filter((m) => m.name === "CreateIssue");
    const titleOf = (m: { variables: { [k: string]: unknown } }) => (m.variables.input as { title: string }).title;
    const parentOf = (m: { variables: { [k: string]: unknown } }) => (m.variables.input as { parentId: string | null }).parentId;
    const epicCreate = creates.find((c) => titleOf(c) === "Epic");
    const childCreate = creates.find((c) => titleOf(c) === "Child");

    expect(epicCreate).toBeTruthy();
    expect(childCreate).toBeTruthy();
    const epicLink = await linkOf(seed.teamId, "E");
    expect(epicLink?.provider_resource_id).toBe("li-1"); // epic created first
    expect(parentOf(childCreate!)).toBe(epicLink?.provider_resource_id); // child nested under it
  });
});

describe("materialize changed-rows detection (real Postgres)", () => {
  it("ingestItem returns only the row_keys whose projected fields changed", async () => {
    const seed = await seedTeam();
    // Push 1: two brand-new rows → both changed.
    let res = await pushTasks(seed, "v1", [
      { row_key: "E", title: "Epic" },
      { row_key: "C", title: "Child", parent: "E" },
    ]);
    expect(new Set(res.changedTaskRowKeys)).toEqual(new Set(["E", "C"]));

    // Push 2: identical projected values, different body (content_sha differs) → nothing projected.
    res = await pushTasks(seed, "v2-body-only", [
      { row_key: "E", title: "Epic" },
      { row_key: "C", title: "Child", parent: "E" },
    ]);
    expect(res.changedTaskRowKeys).toEqual([]);

    // Push 3: rename only C → exactly [C].
    res = await pushTasks(seed, "v3", [
      { row_key: "E", title: "Epic" },
      { row_key: "C", title: "Child RENAMED", parent: "E" },
    ]);
    expect(res.changedTaskRowKeys).toEqual(["C"]);

    // Push 4: change only E's due_date (not a projected field) → nothing projected.
    res = await pushTasks(seed, "v4", [
      { row_key: "E", title: "Epic", due: "2030-01-01" },
      { row_key: "C", title: "Child RENAMED", parent: "E" },
    ]);
    expect(res.changedTaskRowKeys).toEqual([]);
  });
});
