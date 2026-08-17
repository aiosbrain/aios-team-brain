import { describe, expect, it, vi } from "vitest";
import { projectTaskByIdAfterWrite } from "@/lib/pm-sync";
import { upsertIntegration, setIntegrationSecret } from "@/lib/integrations/manage";
import { db, ingest, seedTeam, type Seed } from "./helpers";

/**
 * ADOPTDECL-1 — the STORED-STATE half, which the unit tier structurally cannot prove.
 *
 * The unit tests show the adapter sends `issueUpdate` instead of `issueCreate`. What they cannot show
 * is that ingest's declaration survives a real round-trip into `task_pm_links`, that the adopted
 * resource id is what lands, and that a SECOND run then short-circuits rather than re-writing the
 * issue. Those are two-run stored-state properties: an adapter-level assertion greens while the real
 * chain resolves from a column that was never written.
 */

const issue = (over: Record<string, unknown> = {}) => ({
  id: "issue-877",
  identifier: "AIO-877",
  url: "https://linear.app/AIO-877",
  title: "A human wrote this",
  description: "A real write-up nobody wants deleted.",
  priority: 0,
  parent: null,
  state: { id: "ls-todo", name: "Todo", type: "unstarted" },
  labels: { nodes: [] },
  team: { id: "team-uuid" },
  ...over,
});

function linearMock(opts: { issues?: unknown[] } = {}) {
  const mutations: string[] = [];
  const descriptions: string[] = [];
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
      return Response.json({ data: { issueCreate: { success: true, issue: { id: "brand-new", identifier: "AIO-999", url: "u" } } } });
    }
    if (query.includes("issueUpdate")) {
      mutations.push("issueUpdate");
      const desc = (variables?.input as { description?: string } | undefined)?.description;
      if (typeof desc === "string") descriptions.push(desc);
      return Response.json({ data: { issueUpdate: { success: true, issue: { id: variables.id, identifier: "AIO-877", url: "https://linear.app/AIO-877" } } } });
    }
    return Response.json({ data: {} });
  }) as unknown as typeof fetch;
  return { fetchImpl, mutations, descriptions };
}

async function seedLinearPrimary(seed: Seed) {
  await db().from("teams").update({ primary_pm_provider: "linear" }).eq("id", seed.teamId);
  const auth = { teamId: seed.teamId, memberId: seed.memberId };
  const { id } = await upsertIntegration(db(), auth, { type: "linear", name: "linear", config: { teamId: "team-uuid" } });
  await setIntegrationSecret(db(), auth, id, "lin_api_x");
}

/** Push task rows, optionally carrying a human declaration (`pm_external_id`). */
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

const linkOf = async (teamId: string, rowKey: string) => {
  const { data } = await db()
    .from("task_pm_links")
    .select("provider_resource_id, declared_external_id, projection_fingerprint, last_error")
    .eq("team_id", teamId)
    .eq("row_key", rowKey)
    .maybeSingle();
  return data as {
    provider_resource_id: string | null;
    declared_external_id: string | null;
    projection_fingerprint: string | null;
    last_error: string | null;
  } | null;
};

describe("ADOPTDECL-1 — a declaration survives ingest and adopts (real Postgres)", () => {
  it("ingest persists the declaration, the projection adopts it, and the SECOND run short-circuits", async () => {
    const seed = await seedTeam();
    await seedLinearPrimary(seed);

    await pushTasks(seed, "a1", [
      { row_key: "D1", title: "Ship the thing", status: "in_progress", pm_provider: "linear", pm_external_id: "AIO-877" },
    ]);

    // The declaration must have LANDED — everything below is meaningless if it did not.
    const declared = await linkOf(seed.teamId, "D1");
    expect(declared?.declared_external_id, "ingest did not persist the declaration").toBe("AIO-877");
    expect(declared?.provider_resource_id, "nothing has been projected yet").toBeNull();

    const first = linearMock({ issues: [issue()] });
    await projectTaskByIdAfterWrite(db(), await taskIdOf(seed.teamId, "D1"), { fetchImpl: first.fetchImpl });

    expect(first.mutations, "it must ADOPT, not create a duplicate").toContain("issueUpdate");
    expect(first.mutations).not.toContain("issueCreate");

    const adopted = await linkOf(seed.teamId, "D1");
    expect(adopted?.provider_resource_id, "the ADOPTED issue's id must land").toBe("issue-877");
    expect(adopted?.last_error).toBeNull();

    // …and the run after it does nothing at all: the fingerprint short-circuit owns this row now.
    const second = linearMock({ issues: [issue({ title: "Ship the thing", description: "" })] });
    await projectTaskByIdAfterWrite(db(), await taskIdOf(seed.teamId, "D1"), { fetchImpl: second.fetchImpl });
    expect(second.mutations, "a settled row must not be re-written every run").toEqual([]);
  });

  it("THE ERASURE BOTH REVIEWERS TRACED: a post-adoption status push must not wipe the write-up", async () => {
    const seed = await seedTeam();
    await seedLinearPrimary(seed);
    await pushTasks(seed, "e1", [
      { row_key: "E1", title: "Ship it", status: "in_progress", pm_provider: "linear", pm_external_id: "AIO-877" },
    ]);

    // Push 1 — adopt. The issue's own write-up is sent, and MUST be persisted into the brain.
    const first = linearMock({ issues: [issue()] });
    await projectTaskByIdAfterWrite(db(), await taskIdOf(seed.teamId, "E1"), { fetchImpl: first.fetchImpl });

    const { data: seeded } = await db().from("tasks").select("body").eq("team_id", seed.teamId).eq("row_key", "E1").single();
    expect(
      (seeded as { body: string }).body,
      "if the seed is not persisted the brain still holds '' and push 2 erases the issue"
    ).toContain("A real write-up nobody wants deleted.");

    // Push 2 — an ordinary status flip, the repo's own close gate. It resolves by resource id and
    // takes the NON-adoption path, so whatever the brain holds is what Linear gets.
    await pushTasks(seed, "e2", [
      { row_key: "E1", title: "Ship it", status: "done", pm_provider: "linear", pm_external_id: "AIO-877" },
    ]);
    const second = linearMock({ issues: [issue({ description: "A real write-up nobody wants deleted.\n\naios-ext: E1 · source: aios-backlog" })] });
    await projectTaskByIdAfterWrite(db(), await taskIdOf(seed.teamId, "E1"), { fetchImpl: second.fetchImpl });

    const sent = second.descriptions.at(-1) ?? "";
    expect(sent, "the write-up must survive the status push").toContain("A real write-up nobody wants deleted.");
  });

  it("an unresolvable declared key records the error and claims NO resource id", async () => {
    const seed = await seedTeam();
    await seedLinearPrimary(seed);
    await pushTasks(seed, "b1", [
      { row_key: "D2", title: "Names a ghost", status: "in_progress", pm_provider: "linear", pm_external_id: "AIO-404" },
    ]);

    const mock = linearMock({ issues: [] }); // the declared issue does not exist
    await projectTaskByIdAfterWrite(db(), await taskIdOf(seed.teamId, "D2"), { fetchImpl: mock.fetchImpl });

    expect(mock.mutations, "inventing a second issue is the behaviour being removed").not.toContain("issueCreate");
    const link = await linkOf(seed.teamId, "D2");
    expect(link?.last_error).toMatch(/AIO-404/);
    expect(link?.provider_resource_id).toBeNull();
    expect(link?.projection_fingerprint, "a failed row must stay retryable").toBeNull();
  });

  it("WITHDRAWAL: removing the declaration from the markdown clears it, and the row creates again", async () => {
    const seed = await seedTeam();
    await seedLinearPrimary(seed);
    await pushTasks(seed, "c1", [
      { row_key: "D3", title: "Typo'd", status: "in_progress", pm_provider: "linear", pm_external_id: "AIO-404" },
    ]);
    expect((await linkOf(seed.teamId, "D3"))?.declared_external_id).toBe("AIO-404");

    // The human deletes BOTH fields — the natural withdrawal, and the case a pm_provider-conditioned
    // clear would have missed entirely, leaving the row failing forever with no remedy.
    await pushTasks(seed, "c2", [{ row_key: "D3", title: "Typo'd", status: "in_progress" }]);
    expect((await linkOf(seed.teamId, "D3"))?.declared_external_id, "the withdrawal must clear it").toBeNull();

    const mock = linearMock({ issues: [] });
    await projectTaskByIdAfterWrite(db(), await taskIdOf(seed.teamId, "D3"), { fetchImpl: mock.fetchImpl });
    expect(mock.mutations, "with no declaration it is an ordinary create again").toContain("issueCreate");
  });
});
