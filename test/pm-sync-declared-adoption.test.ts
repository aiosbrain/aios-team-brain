import { describe, expect, it, vi } from "vitest";
import { linearAdapter } from "@/lib/pm-sync/linear";
import { projectionFingerprint, type ProjectableTask, type TaskPmLink } from "@/lib/pm-sync/provider";
import { summarizeProjectionReports } from "@/lib/pm-sync/runs";
import type { IntegrationWithSecret } from "@/lib/integrations/manage";

/**
 * ADOPTDECL-1 — a row that NAMES its issue must not get a second one.
 *
 * In prod, four task rows that named existing Linear issues got four duplicates created
 * (`AIO-878`–`AIO-881`), because `linear.ts`'s adopt-or-create chain resolves by `provider_resource_id`
 * and by the `aios-ext:` footer, and by nothing else.
 *
 * THE COLUMN IS THE POINT. Two earlier designs tried to infer "a human declared this" from
 * `provider_external_id` and both were wrong in opposite directions — `ensureLink` defaults that column
 * to `row_key`, so one rule missed real declarations and the other would have adopted a stranger's
 * issue for any row whose key looks like an identifier. `declared_external_id` is written only by
 * `lib/ingest/tasks.ts` and never defaulted, so non-null means exactly one thing.
 */

const integration = {
  id: "int-2",
  type: "linear",
  name: "linear",
  secret: "lin_api_x",
  config: { teamId: "team-uuid" },
} as IntegrationWithSecret;

const baseLink: TaskPmLink = {
  id: "link-1",
  team_id: "team-1",
  project_id: "project-1",
  task_id: "task-1",
  row_key: "TT39",
  provider: "linear",
  provider_resource_id: null,
  provider_external_source: "aios-backlog",
  provider_external_id: "TT39",
  provider_url: "",
};

const projectable = (over: Partial<ProjectableTask> = {}): ProjectableTask => ({
  row_key: "TT39",
  title: "Ship the thing",
  body: "",
  status: "ready",
  priority: "none",
  labels: [],
  sprint: "",
  assignee: "",
  parentResourceId: null,
  ...over,
});

/** An issue as Linear returns it. `description` defaults to human prose with NO aios-ext footer. */
const issue = (over: Record<string, unknown> = {}) => ({
  id: "issue-877",
  identifier: "AIO-877",
  url: "https://linear.app/AIO-877",
  title: "A human wrote this",
  description: "Paragraph one of a real write-up.\n\nParagraph two, with detail nobody wants deleted.",
  priority: 0,
  parent: null,
  state: { id: "ls-todo", name: "Todo", type: "unstarted" },
  labels: { nodes: [] },
  team: { id: "team-uuid" },
  ...over,
});

function linearMock(opts: { issues?: unknown[]; teamKey?: string | null } = {}) {
  const mutations: { name: string; variables: Record<string, unknown> }[] = [];
  const queries: string[] = [];
  const states = [
    { id: "ls-todo", name: "Todo", type: "unstarted" },
    { id: "ls-started", name: "In Progress", type: "started" },
    { id: "ls-done", name: "Done", type: "completed" },
  ];
  const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
    const { query, variables } = JSON.parse(String(init?.body));
    const name = query.match(/(?:mutation|query) (\w+)/)?.[1] ?? "op";
    queries.push(name);
    if (query.includes("ProjectionBootstrap"))
      return Response.json({
        data: { team: { key: opts.teamKey === undefined ? "AIO" : opts.teamKey, states: { nodes: states }, labels: { nodes: [] } } },
      });
    if (query.includes("ProjectionMembers"))
      return Response.json({ data: { team: { members: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } });
    if (query.includes("ProjectionIssues"))
      return Response.json({ data: { team: { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: opts.issues ?? [] } } } });
    if (query.includes("mutation")) mutations.push({ name, variables });
    if (query.includes("issueCreate"))
      return Response.json({ data: { issueCreate: { success: true, issue: { id: "new-issue", identifier: "AIO-999", url: "https://linear.app/AIO-999" } } } });
    if (query.includes("issueUpdate"))
      return Response.json({ data: { issueUpdate: { success: true, issue: { id: variables.id, identifier: "AIO-877", url: "https://linear.app/AIO-877" } } } });
    if (query.includes("issueLabelCreate"))
      return Response.json({ data: { issueLabelCreate: { success: true, issueLabel: { id: "new-label" } } } });
    return Response.json({ data: {} });
  }) as unknown as typeof fetch;
  return { fetchImpl, mutations, queries };
}

const run = (task: ProjectableTask, link: TaskPmLink, fetchImpl: typeof fetch) =>
  linearAdapter.upsertWorkItem({
    task,
    link,
    integration,
    desiredFingerprint: projectionFingerprint(task, null),
    fetchImpl,
  });

describe("ADOPTDECL-1 — a declared issue is adopted, not duplicated", () => {
  it("adopts the declared issue: issueUpdate on it, and NO issueCreate", async () => {
    const { fetchImpl, mutations } = linearMock({ issues: [issue()] });
    const result = await run(projectable(), { ...baseLink, declared_external_id: "AIO-877" }, fetchImpl);

    expect(mutations.map((m) => m.name)).not.toContain("CreateIssue");
    const update = mutations.find((m) => m.name === "UpdateIssue");
    expect(update, "the declared issue must be updated in place").toBeDefined();
    expect(update?.variables.id).toBe("issue-877");
    expect(result.providerResourceId).toBe("issue-877");
  });

  it("THE FIXTURE ISOLATES THE NEW RUNG: both prior rungs miss, so only it can produce the adopt", () => {
    // One condition per fixture. The link has no `provider_resource_id` (rung 1 cannot fire) and the
    // issue carries no `aios-ext:` footer (rung 2 cannot fire). If either were present this test would
    // pass on a build with no declared rung at all.
    const link = { ...baseLink, declared_external_id: "AIO-877" };
    expect(link.provider_resource_id).toBeNull();
    expect(issue().description).not.toMatch(/aios-ext:/);
  });

  it("a row with NO declaration never adopts — even when its row_key IS a real identifier", async () => {
    // The wrong-issue adoption an earlier draft would have shipped. `ensureLink` defaults
    // `provider_external_id` to `row_key`, so a rule keyed on that column would resolve "AIO-877"
    // here and hand a stranger's issue to this row.
    const { fetchImpl, mutations } = linearMock({ issues: [issue()] });
    const link = { ...baseLink, row_key: "AIO-877", provider_external_id: "AIO-877", declared_external_id: null };
    await run(projectable({ row_key: "AIO-877" }), link, fetchImpl);

    expect(mutations.map((m) => m.name), "it must CREATE, not take AIO-877").toContain("CreateIssue");
    expect(mutations.find((m) => m.name === "UpdateIssue")).toBeUndefined();
  });

  it("SEEDS from the issue when the brain has no body — the erasure this slice must not cause", async () => {
    // A sync-pushed task has no body (`materializeTasks` never writes one). Sending the brain's body
    // on adoption would replace a human's whole write-up with a bare footer, every time.
    const { fetchImpl, mutations } = linearMock({ issues: [issue()] });
    await run(projectable({ body: "" }), { ...baseLink, declared_external_id: "AIO-877" }, fetchImpl);

    const description = String(
      (mutations.find((m) => m.name === "UpdateIssue")?.variables.input as { description?: string })?.description ?? ""
    );
    expect(description).toContain("Paragraph one of a real write-up.");
    expect(description).toContain("Paragraph two, with detail nobody wants deleted.");
    expect(description, "the footer still marks it as brain-projected").toMatch(/aios-ext: TT39/);
  });

  it("…but the BRAIN's body wins once it has one — seeding is not permanent protection", async () => {
    const { fetchImpl, mutations } = linearMock({ issues: [issue()] });
    await run(projectable({ body: "The brain has an opinion now." }), { ...baseLink, declared_external_id: "AIO-877" }, fetchImpl);

    const description = String(
      (mutations.find((m) => m.name === "UpdateIssue")?.variables.input as { description?: string })?.description ?? ""
    );
    expect(description).toContain("The brain has an opinion now.");
    expect(description).not.toContain("Paragraph one of a real write-up.");
  });

  it("refuses an issue that already belongs to another row — one issue, one writer", async () => {
    // Ownership by ANY means, not just by another declaration. The loop that actually happens is
    // "row A created it, a human then declares it on row B" — three TT1 links across three projects
    // share one Linear issue in prod today.
    const owned = issue({ description: "Owned already\n\naios-ext: TT99 · source: aios-backlog" });
    const { fetchImpl } = linearMock({ issues: [owned] });
    await expect(run(projectable(), { ...baseLink, declared_external_id: "AIO-877" }, fetchImpl)).rejects.toThrow(
      /already belongs to TT99/
    );
  });

  it("a declared key that resolves to nothing ERRORS — it does not invent a second issue", async () => {
    const { fetchImpl, mutations } = linearMock({ issues: [] });
    await expect(run(projectable(), { ...baseLink, declared_external_id: "AIO-404" }, fetchImpl)).rejects.toThrow(
      /AIO-404/
    );
    expect(mutations.map((m) => m.name), "creating one would be the silent duplicate again").not.toContain("CreateIssue");
  });

  it("names a FOREIGN key as foreign, so nobody hunts for a typo that isn't there", async () => {
    const { fetchImpl } = linearMock({ issues: [], teamKey: "AIO" });
    await expect(run(projectable(), { ...baseLink, declared_external_id: "ENG-123" }, fetchImpl)).rejects.toThrow(
      /probably another team/
    );
  });

  it("…and does NOT say that for a same-prefix miss, which really could be a typo", async () => {
    const { fetchImpl } = linearMock({ issues: [], teamKey: "AIO" });
    await expect(run(projectable(), { ...baseLink, declared_external_id: "AIO-404" }, fetchImpl)).rejects.toThrow(
      /was not found in this team/
    );
  });

  it("reports `adopted`, not `synced` — the moment an issue changes hands is visible", async () => {
    const { fetchImpl } = linearMock({ issues: [issue()] });
    const result = await run(projectable(), { ...baseLink, declared_external_id: "AIO-877" }, fetchImpl);
    expect(result.status).toBe("adopted");
  });

  it("a NO-OP adopt still reports `adopted` — the row changed hands even with nothing to write", async () => {
    // The issue already matches, so `linearIssueMatches` is true and no mutation is sent. Reporting
    // `skipped` here would hide the handover entirely.
    const matching = issue({ title: "Ship the thing", description: "" });
    const { fetchImpl } = linearMock({ issues: [matching] });
    const result = await run(projectable({ body: "" }), { ...baseLink, declared_external_id: "AIO-877" }, fetchImpl);
    expect(result.status).toBe("adopted");
  });

  it("the run summary counts an adoption as a provider WRITE, not as unchanged", () => {
    const summary = summarizeProjectionReports([
      { row_key: "TT39", provider: "linear", status: "adopted" },
      { row_key: "TT40", provider: "linear", status: "skipped" },
    ]);
    expect(summary.synced, "an adoption wrote to the provider").toBe(1);
    expect(summary.unchanged).toBe(1);
    expect(summary.meta).toMatchObject({ adopted: 1 });
  });

  it("adds no extra GraphQL round-trip: the identifier index and team key ride existing queries", async () => {
    const { fetchImpl, queries } = linearMock({ issues: [issue()] });
    await run(projectable(), { ...baseLink, declared_external_id: "AIO-877" }, fetchImpl);
    // Three reads — bootstrap, members, issues — exactly as before this slice.
    expect(queries.filter((q) => q.startsWith("Projection"))).toEqual([
      "ProjectionBootstrap",
      "ProjectionMembers",
      "ProjectionIssues",
    ]);
  });
});
