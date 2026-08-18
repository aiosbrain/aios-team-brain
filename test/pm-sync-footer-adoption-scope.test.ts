import { describe, expect, it, vi } from "vitest";
import { linearAdapter } from "@/lib/pm-sync/linear";
import { projectionFingerprint, type ProjectableTask, type TaskPmLink } from "@/lib/pm-sync/provider";
import type { IntegrationWithSecret } from "@/lib/integrations/manage";

/**
 * ADOPTFOOT-1 — a scaffold row must not adopt someone else's issue.
 *
 * The `aios-ext:` footer carries only a row key (`parseExt` discards the source, and the source is the
 * same default for ~945 of 949 links here anyway), so `issuesByExt` is keyed on the row key alone. The
 * AIOS workspace scaffold seeds a row keyed `TT1`, so every new workspace's `TT1` resolved to whatever
 * issue already carried `aios-ext: TT1` — in prod, a real person's `AIO-444`, twice. Its URL slug is
 * already `…/AIO-444/example-team-task`.
 *
 * THE DISTRACTOR MATTERS. Fixtures here seed an unrelated OWNED link wherever the assertion is "this one
 * still adopts", so the owner set is non-empty but does not contain the candidate. Without it, a mutant
 * that refuses whenever the set is merely non-empty stays green while recovery is broken on every real
 * board — which is the one direction §4 calls more dangerous.
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
  project_id: "project-scaffold",
  task_id: "task-1",
  row_key: "TT1",
  provider: "linear",
  provider_resource_id: null,
  provider_external_source: "aios-backlog",
  provider_external_id: "TT1",
  provider_url: "",
};

const projectable = (over: Partial<ProjectableTask> = {}): ProjectableTask => ({
  row_key: "TT1",
  title: "Example team task",
  body: "",
  status: "ready",
  priority: "none",
  labels: [],
  sprint: "",
  assignee: "",
  parentResourceId: null,
  ...over,
});

/** John's real issue, carrying the `aios-ext: TT1` footer that every scaffold `TT1` matches. */
const OWNED_ISSUE = {
  id: "issue-444",
  identifier: "AIO-444",
  url: "https://linear.app/AIO-444",
  title: "Finish verified operator loop",
  description: "A real write-up.\n\naios-ext: TT1 · source: aios-backlog",
  priority: 0,
  parent: null,
  state: { id: "ls-todo", name: "Todo", type: "unstarted" },
  labels: { nodes: [] },
  team: { id: "team-uuid" },
};

/** An unrelated issue owned by an unrelated link — the distractor that keeps the owner set non-empty. */
const UNRELATED_OWNED_ID = "issue-unrelated";

function linearMock(opts: { issues?: unknown[] } = {}) {
  const mutations: { name: string; variables: Record<string, unknown> }[] = [];
  const states = [
    { id: "ls-todo", name: "Todo", type: "unstarted" },
    { id: "ls-started", name: "In Progress", type: "started" },
    { id: "ls-done", name: "Done", type: "completed" },
  ];
  const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
    const { query, variables } = JSON.parse(String(init?.body));
    const name = query.match(/(?:mutation|query) (\w+)/)?.[1] ?? "op";
    if (query.includes("ProjectionBootstrap"))
      return Response.json({ data: { team: { key: "AIO", states: { nodes: states }, labels: { nodes: [] } } } });
    if (query.includes("ProjectionMembers"))
      return Response.json({ data: { team: { members: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } });
    if (query.includes("ProjectionIssues"))
      return Response.json({ data: { team: { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: opts.issues ?? [] } } } });
    if (query.includes("mutation")) mutations.push({ name, variables });
    if (query.includes("issueCreate"))
      return Response.json({ data: { issueCreate: { success: true, issue: { id: "brand-new", identifier: "AIO-900", url: "u" } } } });
    if (query.includes("issueUpdate"))
      return Response.json({ data: { issueUpdate: { success: true, issue: { id: variables.id, identifier: "AIO-444", url: "u" } } } });
    return Response.json({ data: {} });
  }) as unknown as typeof fetch;
  return { fetchImpl, mutations };
}

const run = (
  link: Partial<TaskPmLink>,
  fetchImpl: typeof fetch,
  ownedResourceIds: ReadonlySet<string> | undefined,
  task: ProjectableTask = projectable()
) =>
  linearAdapter.upsertWorkItem({
    task,
    link: { ...baseLink, ...link },
    integration,
    desiredFingerprint: projectionFingerprint(task, null),
    fetchImpl,
    ownedResourceIds,
  });

describe("ADOPTFOOT-1 — the footer rung refuses an issue another row owns", () => {
  it("a scaffold row does NOT adopt an owned footer match — it creates its own issue", async () => {
    const { fetchImpl, mutations } = linearMock({ issues: [OWNED_ISSUE] });
    await run({}, fetchImpl, new Set(["issue-444"]));

    expect(mutations.map((m) => m.name), "it must create rather than take AIO-444").toContain("CreateIssue");
    expect(
      mutations.find((m) => m.name === "UpdateIssue"),
      "any issueUpdate here is a write into someone else's issue"
    ).toBeUndefined();
  });

  it("SAME ROW KEY, DIFFERENT PROJECT: the owner is not excluded as 'itself'", async () => {
    // The live shape. All three colliding links are `row_key = TT1`; they differ only by project, so a
    // self-exclusion keyed on row_key alone dropped the true owner and the refusal could never fire.
    const { fetchImpl, mutations } = linearMock({ issues: [OWNED_ISSUE] });
    await run({ project_id: "project-scaffold", row_key: "TT1" }, fetchImpl, new Set(["issue-444"]));
    expect(mutations.map((m) => m.name)).toContain("CreateIssue");
  });

  it("THE DELETED-ISSUE PATH: a non-null resource id that resolves to nothing still consults ownership", async () => {
    // Rung 1 misses when `issuesById.get(id)` returns undefined, so the footer rung fires even though the
    // link "looks linked". The first version of this slice gated the owner load on a NULL resource id,
    // so on exactly this path the set was never loaded and the hijack re-formed.
    const { fetchImpl, mutations } = linearMock({ issues: [OWNED_ISSUE] });
    await run({ provider_resource_id: "issue-deleted" }, fetchImpl, new Set(["issue-444"]));

    expect(mutations.find((m) => m.name === "UpdateIssue")).toBeUndefined();
    expect(mutations.map((m) => m.name)).toContain("CreateIssue");
  });

  it("FAIL CLOSED on a missing set — for a FRESH link, which is the scaffold shape", async () => {
    // Universal on purpose. A version conditioned on "the link claimed a resource id" would pass every
    // other criterion here while a fresh link still adopted an owned match.
    const { fetchImpl, mutations } = linearMock({ issues: [OWNED_ISSUE] });
    await run({ provider_resource_id: null }, fetchImpl, undefined);

    expect(mutations.find((m) => m.name === "UpdateIssue"), "unknown ownership must not adopt").toBeUndefined();
    expect(mutations.map((m) => m.name)).toContain("CreateIssue");
  });

  it("FAIL CLOSED reaches the DECLARED rung too — it was optional-chained and silently passed", async () => {
    await expect(
      run({ declared_external_id: "AIO-444" }, linearMock({ issues: [OWNED_ISSUE] }).fetchImpl, undefined)
    ).rejects.toThrow(/ownership is unknown/i);
  });

  it("a refused footer match on a DECLARED row goes to the declared rung, not to create", async () => {
    // The invariant ADOPTDECL-1 set: "a declared key we cannot honour is an ERROR, not a licence to
    // invent a second issue." Sending every refused footer straight to create would have discarded the
    // declaration and minted exactly that duplicate.
    const { fetchImpl, mutations } = linearMock({ issues: [OWNED_ISSUE] });
    await expect(
      run({ declared_external_id: "AIO-444" }, fetchImpl, new Set(["issue-444"]))
    ).rejects.toThrow(/already linked to another task row/i);
    expect(mutations.map((m) => m.name), "erroring must not also create").not.toContain("CreateIssue");
  });

  it("an UNOWNED footer match still adopts — with a distractor keeping the owner set non-empty", async () => {
    // The recovery path the footer rung exists for. The distractor is what makes this non-vacuous: a
    // mutant refusing on a merely non-empty set stays green without it.
    const { fetchImpl, mutations } = linearMock({ issues: [OWNED_ISSUE] });
    await run({}, fetchImpl, new Set([UNRELATED_OWNED_ID]));

    const update = mutations.find((m) => m.name === "UpdateIssue");
    expect(update, "an unowned match must still be adopted").toBeDefined();
    expect(update?.variables.id).toBe("issue-444");
    expect(mutations.map((m) => m.name)).not.toContain("CreateIssue");
  });

  it("a row whose RUNG 1 RESOLVES is untouched — phrased on resolution, not on 'has a resource id'", async () => {
    // Those differ exactly where the bug lived: a non-null id that resolves to nothing falls through to
    // the footer rung (see the deleted-issue test above).
    const { fetchImpl, mutations } = linearMock({ issues: [OWNED_ISSUE] });
    await run(
      { provider_resource_id: "issue-444", row_key: "TT1", project_id: "project-owner" },
      fetchImpl,
      new Set([UNRELATED_OWNED_ID]),
      projectable({ title: "Finish verified operator loop" })
    );
    expect(mutations.map((m) => m.name)).not.toContain("CreateIssue");
  });
});
