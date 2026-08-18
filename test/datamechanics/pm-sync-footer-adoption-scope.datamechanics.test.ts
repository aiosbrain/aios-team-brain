import { describe, expect, it, vi } from "vitest";
import { projectTaskByIdAfterWrite } from "@/lib/pm-sync";
import { upsertIntegration, setIntegrationSecret } from "@/lib/integrations/manage";
import { db, ingest, seedTeam, type Seed } from "./helpers";

/**
 * ADOPTFOOT-1 — the STORED-STATE half.
 *
 * The unit tier proves the adapter refuses an owned footer match when it is HANDED an owner set. What it
 * cannot prove is that the orchestrator builds that set correctly from real rows — and the live defect
 * was exactly there: the self-exclusion was keyed on `row_key` alone, so with three links all keyed
 * `TT1` the true owner was dropped from the set as "itself" and the refusal could never fire.
 *
 * That is a two-project stored-state property. An adapter-level assertion greens straight past it.
 */

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

function linearMock(opts: { issues?: unknown[] } = {}) {
  const mutations: string[] = [];
  const updated: string[] = [];
  const states = [
    { id: "ls-todo", name: "Todo", type: "unstarted" },
    { id: "ls-started", name: "In Progress", type: "started" },
    { id: "ls-done", name: "Done", type: "completed" },
  ];
  const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
    const { query, variables } = JSON.parse(String(init?.body));
    if (query.includes("ProjectionBootstrap"))
      return Response.json({ data: { team: { key: "AIO", states: { nodes: states }, labels: { nodes: [] } } } });
    if (query.includes("ProjectionMembers"))
      return Response.json({ data: { team: { members: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } });
    if (query.includes("ProjectionIssues"))
      return Response.json({ data: { team: { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: opts.issues ?? [] } } } });
    if (query.includes("IssueForPmSync"))
      return Response.json({ data: { issue: (opts.issues ?? [])[0] ?? null } });
    if (query.includes("issueCreate")) {
      mutations.push("issueCreate");
      return Response.json({ data: { issueCreate: { success: true, issue: { id: "brand-new", identifier: "AIO-900", url: "u" } } } });
    }
    if (query.includes("issueUpdate")) {
      mutations.push("issueUpdate");
      updated.push(String(variables.id));
      return Response.json({ data: { issueUpdate: { success: true, issue: { id: variables.id, identifier: "AIO-444", url: "u" } } } });
    }
    return Response.json({ data: {} });
  }) as unknown as typeof fetch;
  return { fetchImpl, mutations, updated };
}

async function seedLinearPrimary(seed: Seed) {
  await db().from("teams").update({ primary_pm_provider: "linear" }).eq("id", seed.teamId);
  const auth = { teamId: seed.teamId, memberId: seed.memberId };
  const { id } = await upsertIntegration(db(), auth, { type: "linear", name: "linear", config: { teamId: "team-uuid" } });
  await setIntegrationSecret(db(), auth, id, "lin_api_x");
}

const pushTasks = (seed: Seed, salt: string, rows: Record<string, unknown>[]) =>
  ingest(seed, {
    kind: "task",
    path: "3-log/tasks.md",
    body: `${salt}\n` + rows.map((r) => `| ${r.row_key} | ${r.title} | | |`).join("\n"),
    access: "team",
    rows,
  } as never);

const taskIdOf = async (teamId: string, rowKey: string): Promise<string> => {
  const { data } = await db().from("tasks").select("id").eq("team_id", teamId).eq("row_key", rowKey).single();
  return (data as { id: string }).id;
};

const linkOf = async (teamId: string, rowKey: string, projectId?: string) => {
  let q = db().from("task_pm_links").select("id, project_id, provider_resource_id").eq("team_id", teamId).eq("row_key", rowKey);
  if (projectId) q = q.eq("project_id", projectId);
  const { data } = await q.maybeSingle();
  return data as { id: string; project_id: string; provider_resource_id: string | null } | null;
};

/**
 * A DISTRACTOR link: an unrelated row that owns an unrelated issue, so the owner set is never empty.
 * Without one, a mutant that refuses whenever the set is merely non-empty stays green here.
 */
async function seedDistractor(seed: Seed) {
  await pushTasks(seed, "d0", [{ row_key: "ZZ9", title: "Unrelated", status: "in_progress" }]);
  const mock = linearMock({ issues: [] });
  await projectTaskByIdAfterWrite(db(), await taskIdOf(seed.teamId, "ZZ9"), { fetchImpl: mock.fetchImpl });
  const link = await linkOf(seed.teamId, "ZZ9");
  expect(link?.provider_resource_id, "the distractor must actually own something").toBeTruthy();
}

describe("ADOPTFOOT-1 — the owner set is built from real links (real Postgres)", () => {
  it("a SAME-KEYED row in another project does not take the owner's issue", async () => {
    const seed = await seedTeam();
    await seedLinearPrimary(seed);

    // Owner: a TT1 row that legitimately holds AIO-444.
    await pushTasks(seed, "o1", [
      { row_key: "TT1", title: "Finish verified operator loop", status: "in_progress", pm_provider: "linear", pm_external_id: "AIO-444" },
    ]);
    const owner = linearMock({ issues: [OWNED_ISSUE] });
    await projectTaskByIdAfterWrite(db(), await taskIdOf(seed.teamId, "TT1"), { fetchImpl: owner.fetchImpl });
    const ownerLink = await linkOf(seed.teamId, "TT1");
    expect(ownerLink?.provider_resource_id, "the owner must hold the issue for this test to mean anything").toBe(
      "issue-444"
    );

    // Move the OWNER's link into a REAL second project, leaving this project's TT1 unlinked. That is the
    // live shape: two projects, one row key, and the owner holding the issue. A self-exclusion keyed on
    // `row_key` alone drops the owner as "itself" and the refusal never fires.
    //
    // The project has to exist: `task_pm_links.project_id` is an FK, so pointing it at a made-up uuid
    // silently no-ops the update and the test passes for the wrong reason (it did, first run).
    const { data: other } = await db()
      .from("projects")
      .insert({ team_id: seed.teamId, slug: "other-workspace", name: "other" })
      .select("id")
      .single();
    const otherProjectId = (other as { id: string }).id;
    await db().from("task_pm_links").update({ project_id: otherProjectId }).eq("id", ownerLink!.id);
    const moved = await db()
      .from("task_pm_links")
      .select("project_id")
      .eq("id", ownerLink!.id)
      .single();
    expect(
      (moved.data as { project_id: string }).project_id,
      "the owner link did not actually move — the rest of this test would prove nothing"
    ).toBe(otherProjectId);

    // The scaffold push: same row key, no declaration, so only the FOOTER rung can resolve it.
    await pushTasks(seed, "s1", [{ row_key: "TT1", title: "Example team task", status: "ready" }]);
    const scaffold = linearMock({ issues: [OWNED_ISSUE] });
    await projectTaskByIdAfterWrite(db(), await taskIdOf(seed.teamId, "TT1"), { fetchImpl: scaffold.fetchImpl });

    expect(scaffold.updated, "it must not write into the owner's issue").not.toContain("issue-444");
    expect(scaffold.mutations, "it gets its own issue instead").toContain("issueCreate");
  });

  it("RECOVERY: a nulled link whose issue nobody else owns re-adopts it, with a distractor present", async () => {
    const seed = await seedTeam();
    await seedLinearPrimary(seed);
    await seedDistractor(seed);

    await pushTasks(seed, "r1", [
      { row_key: "TT1", title: "Finish verified operator loop", status: "in_progress", pm_provider: "linear", pm_external_id: "AIO-444" },
    ]);
    const first = linearMock({ issues: [OWNED_ISSUE] });
    await projectTaskByIdAfterWrite(db(), await taskIdOf(seed.teamId, "TT1"), { fetchImpl: first.fetchImpl });
    const link = await linkOf(seed.teamId, "TT1");
    expect(link?.provider_resource_id).toBe("issue-444");

    // Lose the link's id — the recovery scenario the footer rung exists for. Nobody else owns the issue,
    // and the owner set is NON-EMPTY thanks to the distractor, so a "refuse when non-empty" mutant dies.
    await db().from("task_pm_links").update({ provider_resource_id: null, projection_fingerprint: null }).eq("id", link!.id);

    const recover = linearMock({ issues: [OWNED_ISSUE] });
    await projectTaskByIdAfterWrite(db(), await taskIdOf(seed.teamId, "TT1"), { fetchImpl: recover.fetchImpl });

    expect(recover.mutations, "recovery must not mint a second issue").not.toContain("issueCreate");
    expect((await linkOf(seed.teamId, "TT1"))?.provider_resource_id, "it re-adopts its own issue").toBe("issue-444");
  });
});
