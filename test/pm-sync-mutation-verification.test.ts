import { describe, expect, it, vi } from "vitest";
import { linearAdapter } from "@/lib/pm-sync/linear";
import { linearMutation } from "@/lib/pm-sync/linear-client";
import { projectionFingerprint, type ProjectableTask, type TaskPmLink } from "@/lib/pm-sync/provider";
import type { IntegrationWithSecret } from "@/lib/integrations/manage";

/**
 * PMSUCCESS-1 — a mutation is not done until Linear says it is.
 *
 * Five of the six Linear mutations REQUESTED `success: Boolean!` and none of them read it. Linear
 * returns that field INSIDE `data`, so a well-formed 200 carrying `{ success: false, issue: null }`
 * passes every check `linearGraphql` makes, and `aios push` printed `N synced · 0 errors` having
 * changed nothing. Two consequences were worse than the report:
 *
 *   • a refused UPDATE LATCHED — `persistSuccess` wrote the desired fingerprint next to a real resource
 *     id, so `project.ts`'s short-circuit skipped that row on every future run;
 *   • a refused STATUS write was REVERTED — the result carries the DESIRED state, so inbound saw
 *     Linear's real state over an "unchanged" brain row and wrote it back onto the task.
 *
 * These tests drive the ADAPTER ENTRY POINTS with a fake `fetch`, not the choke point, because a
 * choke-point-only test pins the checker and not the call sites — and it was the call sites that were
 * wrong.
 *
 * The stored-state halves live in `test/datamechanics/pm-sync-refusal.datamechanics.test.ts`: the
 * fingerprint non-write plus the two-run retry, and the §0e case where inbound must NOT revert the brain
 * task. THAT SENTENCE WAS A LIE WHEN IT WAS FIRST WRITTEN — the reversion test did not exist and review
 * caught the false attestation. It exists now, and the mutation that removes the `success` check reddens
 * all three of those dm tests. A unit-tier payload assertion cannot stand in for them: it greens while
 * the real short-circuit still skips.
 */

const integration = {
  id: "int-linear",
  type: "linear",
  name: "linear",
  secret: "lin-key",
  config: { teamId: "team-uuid" },
} as IntegrationWithSecret;

const link: TaskPmLink = {
  id: "link-1",
  team_id: "team-1",
  project_id: "project-1",
  task_id: "task-1",
  row_key: "P0",
  provider: "linear",
  provider_resource_id: null,
  provider_external_source: "aios-backlog",
  provider_external_id: "P0",
  provider_url: "",
};

const projectable = (over: Partial<ProjectableTask> = {}): ProjectableTask => ({
  row_key: "P0",
  title: "A task",
  description: "Do the thing",
  status: "in_progress",
  assignee: null,
  labels: [],
  priority: null,
  due_date: null,
  parent_row_key: null,
  ...over,
});

const STATES = [
  { id: "ls-todo", name: "Todo", type: "unstarted" },
  { id: "ls-started", name: "In Progress", type: "started" },
  { id: "ls-done", name: "Done", type: "completed" },
];

const EXISTING_ISSUE = {
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
};

/**
 * A Linear mock whose MUTATION replies are injectable per payload key, so a refusal can be aimed at one
 * site while every other call in the run still succeeds. Reads always succeed — the defect is on writes.
 */
function linearMock(opts: {
  issues?: unknown[];
  labels?: { id: string; name: string }[];
  lite?: unknown;
  reply?: Record<string, unknown>;
} = {}) {
  const sent: string[] = [];
  const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
    const { query, variables } = JSON.parse(String(init?.body));
    if (query.includes("ProjectionBootstrap"))
      return Response.json({ data: { team: { states: { nodes: STATES }, labels: { nodes: opts.labels ?? [] } } } });
    if (query.includes("ProjectionMembers"))
      return Response.json({ data: { team: { members: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } });
    if (query.includes("ProjectionIssues"))
      return Response.json({ data: { team: { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: opts.issues ?? [] } } } });
    // The statusOnly / moveToDone paths resolve the issue and the states standalone, without the
    // bootstrap — so both need their own replies or the run dies before reaching the mutation.
    if (query.includes("IssueForPmSync")) return Response.json({ data: { issue: opts.lite ?? EXISTING_ISSUE } });
    if (query.includes("TeamDoneStates")) return Response.json({ data: { team: { states: { nodes: STATES } } } });

    const payloadKey = query.includes("issueLabelCreate")
      ? "issueLabelCreate"
      : query.includes("issueCreate")
        ? "issueCreate"
        : "issueUpdate";
    sent.push(payloadKey);
    if (opts.reply && payloadKey in opts.reply)
      return Response.json({ data: { [payloadKey]: opts.reply[payloadKey] } });

    if (payloadKey === "issueLabelCreate")
      return Response.json({ data: { issueLabelCreate: { success: true, issueLabel: { id: "new-label" } } } });
    if (payloadKey === "issueCreate")
      return Response.json({
        data: { issueCreate: { success: true, issue: { id: "new-issue", identifier: "AIO-9", url: "https://linear.app/AIO-9" } } },
      });
    return Response.json({
      data: { issueUpdate: { success: true, issue: { id: variables.id ?? "issue-existing", identifier: "AIO-1", url: "https://linear.app/AIO-1" } } },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, sent };
}

const upsert = (fetchImpl: typeof fetch, over: Partial<ProjectableTask> = {}, statusOnly = false) => {
  const task = projectable(over);
  return linearAdapter.upsertWorkItem({
    task,
    // statusOnly resolves the issue by stored id, so the link must carry one for that path.
    link: statusOnly ? { ...link, provider_resource_id: "issue-existing" } : link,
    integration,
    desiredFingerprint: projectionFingerprint(task, null),
    statusOnly,
    fetchImpl,
    // ADOPTFOOT-1 — the footer rung now fails closed on a MISSING owner set, and these fixtures resolve
    // their issue through that rung. Nothing else owns anything here, so: an empty set, not `undefined`.
    ownedResourceIds: new Set<string>(),
  });
};

/** The refusal shape Linear can return on a well-formed 200. */
const REFUSED = { success: false, issue: null };

describe("PMSUCCESS-1: a refused mutation throws instead of reporting synced", () => {
  it("CREATE — a success:false payload throws rather than returning a report", async () => {
    const { fetchImpl } = linearMock({ reply: { issueCreate: REFUSED } });
    await expect(upsert(fetchImpl)).rejects.toThrow(/issueCreate.*success=false/i);
  });

  it("UPDATE — the site whose refusal used to LATCH the row as skipped forever", async () => {
    const { fetchImpl } = linearMock({ issues: [EXISTING_ISSUE], reply: { issueUpdate: REFUSED } });
    await expect(upsert(fetchImpl, { title: "New title" })).rejects.toThrow(/issueUpdate.*success=false/i);
  });

  it("STATUS-ONLY — the site whose refusal used to be REVERTED in the brain on the next inbound pass", async () => {
    const { fetchImpl } = linearMock({
      issues: [{ ...EXISTING_ISSUE, state: { id: "ls-todo", name: "Todo", type: "unstarted" } }],
      reply: { issueUpdate: REFUSED },
    });
    await expect(upsert(fetchImpl, { status: "done" }, true)).rejects.toThrow(/issueUpdate.*success=false/i);
  });

  it("moveToDone — guarded even though it has no production caller today", async () => {
    // Grep finds only back-compat tests. Guarded anyway: an unguarded path is one refactor away from
    // being live, and the spec is explicit that its consequence is not sold as a live one.
    const { fetchImpl } = linearMock({ issues: [EXISTING_ISSUE], reply: { issueUpdate: REFUSED } });
    await expect(
      linearAdapter.moveToDone({ task: projectable({ status: "done" }), link: { ...link, provider_resource_id: "issue-existing" }, integration, fetchImpl })
    ).rejects.toThrow(/issueUpdate.*success=false/i);
  });

  it("LABEL CREATE — the one site that never even ASKED for success now asks and checks", async () => {
    // Not covered by any pre-existing test: the old fixture returned `{ issueLabel: { id } }` with no
    // `success` field at all, and nothing exercised it. That is the site a criteria set could most
    // easily leave unguarded, so it gets its own case.
    const { fetchImpl } = linearMock({ reply: { issueLabelCreate: { success: false, issueLabel: null } } });
    await expect(upsert(fetchImpl, { labels: ["urgent"] })).rejects.toThrow(/issueLabelCreate.*success=false/i);
  });
});

describe("PMSUCCESS-1: success alone is not enough, and absence is not tolerated", () => {
  it("success:true with a NULL entity throws — the flag does not stand in for the thing", async () => {
    const { fetchImpl } = linearMock({ reply: { issueCreate: { success: true, issue: null } } });
    await expect(upsert(fetchImpl)).rejects.toThrow(/no issue/i);
  });

  it("success:true with an entity that has NO id throws — an unusable id is what poisoned the caches", async () => {
    const { fetchImpl } = linearMock({ reply: { issueCreate: { success: true, issue: { identifier: "AIO-9" } } } });
    await expect(upsert(fetchImpl)).rejects.toThrow(/no id/i);
  });

  it("a payload OMITTING success throws — there is no opt-out to forget", async () => {
    // A draft carried a `successNotReturned` hatch. Every site requests the field, so nothing needed
    // it, and an unused hatch is a hole waiting for someone to reach for it to green a test.
    const { fetchImpl } = linearMock({
      reply: { issueCreate: { issue: { id: "new-issue", identifier: "AIO-9", url: "u" } } },
    });
    await expect(upsert(fetchImpl)).rejects.toThrow(/success=undefined/i);
  });

  it("a MISSING payload key throws rather than reading through undefined", async () => {
    await expect(
      linearMutation(
        (async () => Response.json({ data: { somethingElse: {} } })) as unknown as typeof fetch,
        "k",
        `mutation X { issueCreate(input: {}) { success issue { id } } }`,
        {},
        { payload: "issueCreate", entity: "issue" }
      )
    ).rejects.toThrow(/no payload/i);
  });

  it("the happy path still works end to end — the guard must not fail closed on a real write", async () => {
    const { fetchImpl, sent } = linearMock();
    const result = await upsert(fetchImpl, { labels: ["urgent"] });
    expect(result.providerResourceId).toBe("new-issue");
    expect(result.status).toBe("synced");
    expect(sent).toContain("issueLabelCreate");
    expect(sent).toContain("issueCreate");
  });

  it("a create can never report success with an empty providerResourceId", async () => {
    // §1c, and after the entity check it is structural rather than a second branch: the only way to
    // reach the report is through an entity carrying a non-empty string id.
    const { fetchImpl } = linearMock({ reply: { issueCreate: { success: true, issue: { id: "", identifier: "x", url: "u" } } } });
    await expect(upsert(fetchImpl)).rejects.toThrow(/no id/i);
  });
});
