import { describe, expect, it, vi } from "vitest";
import { linearAdapter } from "@/lib/pm-sync/linear";
import { planeAdapter } from "@/lib/pm-sync/plane";
import { projectionFingerprint, plainTextToHtml, type ProjectableTask, type TaskPmLink } from "@/lib/pm-sync/provider";
import type { IntegrationWithSecret } from "@/lib/integrations/manage";

const link: TaskPmLink = {
  id: "link-1",
  team_id: "team-1",
  project_id: "project-1",
  task_id: "task-1",
  row_key: "P0",
  provider: "plane",
  provider_resource_id: null,
  provider_external_source: "aios-backlog",
  provider_external_id: "P0",
  provider_url: "",
};

const planeIntegration = {
  id: "int-1",
  type: "plane",
  name: "plane",
  secret: "plane-key",
  config: { workspaceSlug: "aios", projectId: "plane-project" },
} as IntegrationWithSecret;

const PLANE_STATES = [
  { id: "st-backlog", name: "Backlog", group: "backlog" },
  { id: "st-todo", name: "Todo", group: "unstarted" },
  { id: "st-started", name: "In Progress", group: "started" },
  { id: "st-done", name: "Done", group: "completed" },
];

// A routing Plane fetch mock. `items` seeds GET /work-items/. Records mutation calls.
function planeMock(opts: { items?: unknown[]; labels?: { id: string; name: string }[]; modules?: { id: string; name: string }[]; moduleIssues?: Record<string, unknown[]> } = {}) {
  const mutations: { method: string; path: string; body: { [k: string]: unknown } | undefined }[] = [];
  let newId = 0;
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const path = url.replace(/^https?:\/\/[^/]+/, "").split("?")[0];
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (method === "GET") {
      if (path.endsWith("/states/")) return Response.json(PLANE_STATES);
      if (path.endsWith("/work-items/")) return Response.json({ results: opts.items ?? [] });
      if (path.endsWith("/labels/")) return Response.json(opts.labels ?? []);
      if (path.endsWith("/modules/")) return Response.json(opts.modules ?? []);
      if (path.includes("/module-issues/")) {
        const mid = path.split("/modules/")[1].split("/")[0];
        return Response.json((opts.moduleIssues ?? {})[mid] ?? []);
      }
    }
    mutations.push({ method, path, body });
    if (method === "POST" && path.endsWith("/work-items/")) return Response.json({ id: `new-${++newId}`, ...body });
    if (method === "POST" && path.endsWith("/labels/")) return Response.json({ id: `label-${++newId}`, name: body?.name });
    if (method === "POST" && path.endsWith("/modules/")) return Response.json({ id: `module-${++newId}`, name: body?.name });
    return Response.json({ id: `ok-${++newId}`, ...(body ?? {}) });
  }) as unknown as typeof fetch;
  return { fetchImpl, mutations };
}

function projectable(over: Partial<ProjectableTask> = {}): ProjectableTask {
  return { row_key: "P0", title: "Epic title", body: "Do the thing", status: "ready", priority: "none", labels: [], sprint: "", assignee: "", parentResourceId: null, ...over };
}

describe("Plane projection — upsertWorkItem", () => {
  it("adopts a seeded aios-backlog item that already matches and writes nothing", async () => {
    const task = projectable();
    const { fetchImpl, mutations } = planeMock({
      items: [
        {
          id: "wi-existing",
          name: "Epic title",
          description_html: plainTextToHtml("Do the thing"),
          state: "st-todo",
          priority: "none",
          labels: [],
          parent: null,
          external_id: "P0",
          external_source: "aios-backlog",
        },
      ],
    });

    const result = await planeAdapter.upsertWorkItem({
      task,
      link,
      integration: planeIntegration,
      desiredFingerprint: projectionFingerprint(task, null),
      fetchImpl,
    });

    expect(result.status).toBe("skipped");
    expect(result.providerResourceId).toBe("wi-existing");
    expect(mutations).toHaveLength(0); // zero provider writes
  });

  it("creates a new item with external_id + external_source and ensures labels", async () => {
    const task = projectable({ row_key: "P1", title: "Chunk", labels: ["wave-1"] });
    const { fetchImpl, mutations } = planeMock({ items: [] });

    const result = await planeAdapter.upsertWorkItem({
      task,
      link: { ...link, row_key: "P1", provider_external_id: "P1" },
      integration: planeIntegration,
      desiredFingerprint: projectionFingerprint(task, null),
      fetchImpl,
    });

    expect(result.status).toBe("synced");
    expect(result.externalSource).toBe("aios-backlog");
    const created = mutations.find((m) => m.method === "POST" && m.path.endsWith("/work-items/"));
    expect(created?.body).toMatchObject({ external_id: "P1", external_source: "aios-backlog", state: "st-todo" });
    expect(mutations.some((m) => m.path.endsWith("/labels/") && m.method === "POST")).toBe(true);
  });

  it("adds the item to its Wave module", async () => {
    const task = projectable({ row_key: "P2", sprint: "Wave 1 — MVP" });
    const { fetchImpl, mutations } = planeMock({ items: [] });

    await planeAdapter.upsertWorkItem({
      task,
      link: { ...link, row_key: "P2", provider_external_id: "P2" },
      integration: planeIntegration,
      desiredFingerprint: projectionFingerprint(task, null),
      fetchImpl,
    });

    expect(mutations.some((m) => m.method === "POST" && m.path.endsWith("/modules/"))).toBe(true);
    expect(mutations.some((m) => m.path.includes("/module-issues/") && m.method === "POST")).toBe(true);
  });

  it("moveToDone (back-compat) patches only the state", async () => {
    const { fetchImpl, mutations } = planeMock({
      items: [{ id: "wi-1", external_id: "P0", external_source: "aios-backlog", state: "st-todo" }],
    });
    const result = await planeAdapter.moveToDone({ link, integration: planeIntegration, fetchImpl });
    expect(result).toMatchObject({ provider: "plane", status: "synced", providerResourceId: "wi-1" });
    const patch = mutations.find((m) => m.method === "PATCH");
    expect(patch?.body).toEqual({ state: "st-done" });
    expect(mutations.filter((m) => m.method !== "GET")).toHaveLength(1); // state only
  });
});

// ── Linear ─────────────────────────────────────────────────────────────────────

const linearIntegration = {
  id: "int-2",
  type: "linear",
  name: "linear",
  secret: "lin_api_x",
  config: { teamId: "team-uuid" },
} as IntegrationWithSecret;

function linearMock(opts: { issues?: unknown[]; states?: unknown[]; labels?: unknown[]; members?: unknown[] } = {}) {
  const mutations: { name: string; variables: { [k: string]: unknown } }[] = [];
  const states = opts.states ?? [
    { id: "ls-todo", name: "Todo", type: "unstarted" },
    { id: "ls-started", name: "In Progress", type: "started" },
    { id: "ls-done", name: "Done", type: "completed" },
  ];
  const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
    const { query, variables } = JSON.parse(String(init?.body));
    if (query.includes("ProjectionBootstrap")) {
      return Response.json({ data: { team: { states: { nodes: states }, labels: { nodes: opts.labels ?? [] }, members: { nodes: opts.members ?? [] } } } });
    }
    if (query.includes("ProjectionIssues")) {
      return Response.json({ data: { team: { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: opts.issues ?? [] } } } });
    }
    const name = query.match(/mutation (\w+)/)?.[1] ?? query.match(/query (\w+)/)?.[1] ?? "op";
    if (query.includes("mutation")) mutations.push({ name, variables });
    if (query.includes("issueCreate")) return Response.json({ data: { issueCreate: { success: true, issue: { id: "new-issue", identifier: "AIO-9", url: "https://linear.app/AIO-9" } } } });
    if (query.includes("issueUpdate")) return Response.json({ data: { issueUpdate: { success: true, issue: { id: variables.id, identifier: "AIO-1", url: "https://linear.app/AIO-1" } } } });
    if (query.includes("issueLabelCreate")) return Response.json({ data: { issueLabelCreate: { issueLabel: { id: "new-label" } } } });
    return Response.json({ data: {} });
  }) as unknown as typeof fetch;
  return { fetchImpl, mutations };
}

describe("Linear projection — upsertWorkItem", () => {
  it("adopts an issue by its aios-ext footer marker and updates on divergence", async () => {
    const task = projectable({ row_key: "P0", title: "New title" });
    const { fetchImpl, mutations } = linearMock({
      issues: [
        {
          id: "issue-existing",
          identifier: "AIO-1",
          url: "https://linear.app/AIO-1",
          title: "Old title",
          description: "Do the thing\n\naios-ext: P0 · source: aios-backlog",
          priority: 0,
          parent: null,
          state: { id: "ls-todo", name: "Todo", type: "unstarted" },
          labels: { nodes: [] },
          team: { id: "team-uuid" },
        },
      ],
    });

    const result = await linearAdapter.upsertWorkItem({
      task,
      link: { ...link, provider: "linear" },
      integration: linearIntegration,
      desiredFingerprint: projectionFingerprint(task, null),
      fetchImpl,
    });

    expect(result.status).toBe("synced");
    expect(result.providerResourceId).toBe("issue-existing");
    const update = mutations.find((m) => m.name === "UpdateIssue");
    expect(update).toBeTruthy();
    expect((update?.variables as { input: { title: string } }).input.title).toBe("New title");
  });

  it("creates a new issue with the footer marker when none is adopted", async () => {
    const task = projectable({ row_key: "P3", title: "Fresh" });
    const { fetchImpl, mutations } = linearMock({ issues: [] });

    const result = await linearAdapter.upsertWorkItem({
      task,
      link: { ...link, provider: "linear", row_key: "P3", provider_external_id: "P3" },
      integration: linearIntegration,
      desiredFingerprint: projectionFingerprint(task, null),
      fetchImpl,
    });

    expect(result.status).toBe("synced");
    const create = mutations.find((m) => m.name === "CreateIssue");
    expect((create?.variables as { input: { description: string } }).input.description).toContain("aios-ext: P3 · source: aios-backlog");
  });

  it("resolves a brain assignee (by name / handle / email) to a Linear user id on create", async () => {
    const members = [{ id: "LU-7", name: "Chetan", displayName: "chetan", email: "chetan@x.io" }];
    for (const who of ["Chetan", "chetan", "CHETAN@X.IO"]) {
      const task = projectable({ row_key: "P3", title: "Owned", assignee: who });
      const { fetchImpl, mutations } = linearMock({ issues: [], members });
      await linearAdapter.upsertWorkItem({
        task,
        link: { ...link, provider: "linear", row_key: "P3", provider_external_id: "P3" },
        integration: linearIntegration,
        desiredFingerprint: projectionFingerprint(task, null),
        fetchImpl,
      });
      const create = mutations.find((m) => m.name === "CreateIssue");
      expect((create?.variables as { input: { assigneeId?: string } }).input.assigneeId).toBe("LU-7");
    }
  });

  it("never sends assigneeId when the brain owner is empty or unresolved (no force-unassign)", async () => {
    const members = [{ id: "LU-7", name: "Chetan" }];
    for (const who of ["", "Nobody Known"]) {
      const task = projectable({ row_key: "P4", title: "Unowned", assignee: who });
      const { fetchImpl, mutations } = linearMock({ issues: [], members });
      await linearAdapter.upsertWorkItem({
        task,
        link: { ...link, provider: "linear", row_key: "P4", provider_external_id: "P4" },
        integration: linearIntegration,
        desiredFingerprint: projectionFingerprint(task, null),
        fetchImpl,
      });
      const create = mutations.find((m) => m.name === "CreateIssue");
      expect((create?.variables as { input: Record<string, unknown> }).input).not.toHaveProperty("assigneeId");
    }
  });

  it("moveToDone (back-compat) moves an issue to the completed state", async () => {
    const queries: string[] = [];
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      queries.push(body.query);
      if (body.query.includes("IssueForPmSync")) {
        return Response.json({ data: { issue: { id: "issue-uuid", identifier: "ENG-123", url: "https://linear.app/ENG-123", team: { id: "team-uuid" }, state: { id: "todo", name: "Todo", type: "unstarted" } } } });
      }
      if (body.query.includes("TeamDoneStates")) {
        return Response.json({ data: { team: { states: { nodes: [{ id: "done", name: "Done", type: "completed" }] } } } });
      }
      return Response.json({ data: { issueUpdate: { success: true, issue: { id: "issue-uuid" } } } });
    }) as unknown as typeof fetch;

    const result = await linearAdapter.moveToDone({
      link: { ...link, provider: "linear", provider_external_source: "linear", provider_external_id: "ENG-123" },
      integration: { id: "int-1", type: "linear", name: "linear", secret: "lin_api_x", config: {} } as IntegrationWithSecret,
      fetchImpl,
    });

    expect(result).toMatchObject({ provider: "linear", status: "synced", providerResourceId: "issue-uuid" });
    expect(queries.some((q) => q.includes("issueUpdate"))).toBe(true);
  });
});

describe("projectionFingerprint", () => {
  it("is stable across label order and changes when a field changes", () => {
    const a = projectionFingerprint(projectable({ labels: ["x", "y"] }), null);
    const b = projectionFingerprint(projectable({ labels: ["y", "x"] }), null);
    expect(a).toBe(b);
    expect(projectionFingerprint(projectable({ title: "different" }), null)).not.toBe(a);
    expect(projectionFingerprint(projectable(), "parent-id")).not.toBe(a);
  });
});
