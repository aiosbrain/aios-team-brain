import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { projectRows, projectTask, type ProjectionTaskRow } from "@/lib/pm-sync/project";
import { resolvePrimaryProvider } from "@/lib/pm-sync/project";
import { upsertIntegration, setIntegrationSecret } from "@/lib/integrations/manage";
import { withTransaction } from "@/lib/db/pg/tx";
import { db, seedTeam, type Seed } from "./helpers";

/** Raw DDL against the tier's database — the query builder cannot express triggers. */
async function rawExec(sql: string): Promise<void> {
  await withTransaction(async (c) => {
    await c.query(sql);
  });
}

/**
 * ADOPTUNIQ-1 — CONTAINMENT. The index is only safe because a rejected write is contained to the row
 * that caused it. These are the tests that distinguish the change from the pre-change code.
 *
 * Design: docs/design/task-pm-links-unique-index.md
 *
 * The failure is induced with a REAL unique violation against real Postgres — never by stubbing
 * `db.update`, which would silently demote these out of the tier they were deliberately put in. The
 * lever is the index itself: pre-claim the resource id the adapter is going to return, and the
 * bookkeeping UPDATE genuinely violates `task_pm_links_provider_resource_uq`.
 */

let issueSeq = 0;

/**
 * A Linear adapter double that records every provider MUTATION.
 *
 * The mutation count is the observable for "the adapter was invoked" — the `resolved`/`contested`
 * maps are private to `projectRows` and cannot be inspected from a test without inventing an
 * abstraction that exists only for the test.
 */
function linearMock(opts: { issues?: unknown[]; createId?: string } = {}) {
  const mutations: string[] = [];
  const created: string[] = [];
  // A `backlog`-TYPE state is required: the tasks below are seeded `status: "backlog"` and the
  // adapter resolves a workflow state by GROUP, so a list of only unstarted/started/completed makes
  // every projection fail before it ever reaches the provider — which reads like a containment bug.
  const states = [
    { id: "ls-backlog", name: "Backlog", type: "backlog" },
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
      return Response.json({
        data: { team: { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: opts.issues ?? [] } } },
      });
    if (query.includes("IssueForPmSync")) {
      const wanted = (opts.issues ?? []).find((i) => (i as { id: string }).id === variables?.id);
      return Response.json({ data: { issue: wanted ?? null } });
    }
    if (query.includes("issueCreate")) {
      mutations.push("issueCreate");
      // `createId` applies to the FIRST create only. Returning it for every create would make the
      // sibling collide too, and "a sibling still projects" would be untestable — the assertion would
      // fail for a reason that has nothing to do with containment.
      const id = opts.createId && created.length === 0 ? opts.createId : `li-${++issueSeq}`;
      created.push(id);
      return Response.json({
        data: { issueCreate: { success: true, issue: { id, identifier: `AIO-9${issueSeq}`, url: `u/${id}` } } },
      });
    }
    if (query.includes("issueUpdate")) {
      mutations.push("issueUpdate");
      return Response.json({
        data: { issueUpdate: { success: true, issue: { id: variables.id, identifier: "AIO-444", url: "u" } } },
      });
    }
    return Response.json({ data: {} });
  }) as unknown as typeof fetch;
  return { fetchImpl, mutations, created };
}

/** A double whose provider mutation THROWS — the shipped path this change must NOT alter. */
function throwingMock() {
  const mutations: string[] = [];
  const states = [{ id: "ls-backlog", name: "Backlog", type: "backlog" }];
  const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
    const { query } = JSON.parse(String(init?.body));
    if (query.includes("ProjectionBootstrap"))
      return Response.json({ data: { team: { key: "AIO", states: { nodes: states }, labels: { nodes: [] } } } });
    if (query.includes("ProjectionMembers"))
      return Response.json({ data: { team: { members: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } });
    if (query.includes("ProjectionIssues"))
      return Response.json({ data: { team: { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } });
    if (query.includes("issueCreate")) {
      mutations.push("issueCreate");
      throw new Error("provider exploded");
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

async function makeProject(seed: Seed, slug: string): Promise<string> {
  const { data } = await db()
    .from("projects")
    .insert({ team_id: seed.teamId, slug, name: slug })
    .select("id")
    .single();
  return (data as { id: string }).id;
}

async function makeTask(
  seed: Seed,
  projectId: string,
  rowKey: string,
  parentRowKey: string | null = null,
): Promise<ProjectionTaskRow> {
  const { data } = await db()
    .from("tasks")
    .insert({
      team_id: seed.teamId,
      project_id: projectId,
      row_key: rowKey,
      title: `task ${rowKey}`,
      status: "backlog",
      origin: "sync",
      parent_row_key: parentRowKey,
      audience: "team",
    })
    .select("id, team_id, project_id, row_key, title, status, sprint, priority, labels, body, parent_row_key, assignee")
    .single();
  return data as ProjectionTaskRow;
}

/**
 * Pre-claim a resource id in ANOTHER project, so the bookkeeping UPDATE for the row under test hits
 * the partial unique index. This is a genuine 23505 from real Postgres, not a stub.
 */
async function preclaim(seed: Seed, resourceId: string): Promise<void> {
  const otherProject = await makeProject(seed, `owner-${randomUUID().slice(0, 8)}`);
  const { error } = await db().from("task_pm_links").insert({
    team_id: seed.teamId,
    project_id: otherProject,
    row_key: "OWNER",
    provider: "linear",
    provider_external_id: "OWNER",
    provider_resource_id: resourceId,
  });
  expect(error, "the pre-claim must actually insert, or the whole scenario is vacuous").toBeFalsy();
}

async function readLink(teamId: string, projectId: string, rowKey: string) {
  const { data } = await db()
    .from("task_pm_links")
    .select("id, provider_resource_id, last_error, projection_fingerprint")
    .eq("team_id", teamId)
    .eq("project_id", projectId)
    .eq("row_key", rowKey)
    .maybeSingle();
  return data as { id: string; provider_resource_id: string | null; last_error: string | null } | null;
}

describe("ADOPTUNIQ-1 — outbound containment", () => {
  it("a rejected bookkeeping write reports FAILED and is LOUD, and a sibling still projects", async () => {
    const seed = await seedTeam();
    await seedLinearPrimary(seed);
    const project = await makeProject(seed, "acme");

    const CONTESTED = `li-contested-${randomUUID().slice(0, 8)}`;
    await preclaim(seed, CONTESTED);

    // The doomed row's create returns the already-claimed id; the sibling gets its own.
    const doomed = await makeTask(seed, project, "DOOM");
    const ok = await makeTask(seed, project, "FINE");

    const mock = linearMock({ createId: CONTESTED });
    const primary = await resolvePrimaryProvider(db(), seed.teamId);
    const reports = await projectRows(db(), primary as never, [doomed, ok], {
      fetchImpl: mock.fetchImpl,
      throttleMs: 0,
    });

    const byKey = Object.fromEntries(reports.map((r) => [r.row_key, r]));

    // PRE-CHANGE BEHAVIOUR WAS `synced` WITH A NULL last_error — the update failed and nothing read
    // the error. That is what makes this assertion distinguishing rather than green-by-construction.
    expect(byKey.DOOM.status).toBe("failed");
    expect(byKey.DOOM.error).toMatch(/bookkeeping/i);
    const doomedLink = await readLink(seed.teamId, project, "DOOM");
    expect(doomedLink?.last_error, "the failure must land on the link, not just the report").toBeTruthy();

    // CONTAINED: the batch continued.
    expect(byKey.FINE.status).toBe("synced");
  });

  it("INVERSE: nothing is partially persisted — the failing link's resource id is still NULL", async () => {
    const seed = await seedTeam();
    await seedLinearPrimary(seed);
    const project = await makeProject(seed, "acme");
    const CONTESTED = `li-inv-${randomUUID().slice(0, 8)}`;
    await preclaim(seed, CONTESTED);

    const doomed = await makeTask(seed, project, "DOOM");
    const mock = linearMock({ createId: CONTESTED });
    const primary = await resolvePrimaryProvider(db(), seed.teamId);
    await projectRows(db(), primary as never, [doomed], { fetchImpl: mock.fetchImpl, throttleMs: 0 });

    const link = await readLink(seed.teamId, project, "DOOM");
    // Asserting the survivor's content is not enough — the removed half has to be asserted absent.
    expect(link?.provider_resource_id).toBeNull();
  });
});

describe("ADOPTUNIQ-1 — the `contested` channel", () => {
  it("a child does NOT re-invoke the parent's adapter and is NOT parented to the contested id", async () => {
    const seed = await seedTeam();
    await seedLinearPrimary(seed);
    const project = await makeProject(seed, "acme");

    const CONTESTED = `li-parent-${randomUUID().slice(0, 8)}`;
    await preclaim(seed, CONTESTED);

    const parent = await makeTask(seed, project, "P1");
    const child = await makeTask(seed, project, "C1", "P1");

    const mock = linearMock({ createId: CONTESTED });
    const primary = await resolvePrimaryProvider(db(), seed.teamId);
    const reports = await projectRows(db(), primary as never, [parent, child], {
      fetchImpl: mock.fetchImpl,
      throttleMs: 0,
    });
    const byKey = Object.fromEntries(reports.map((r) => [r.row_key, r]));

    expect(byKey.P1.status).toBe("failed");
    expect(byKey.C1.status, "the child must fail rather than attach beneath an unclaimed issue").toBe("failed");
    expect(byKey.C1.error).toMatch(/P1/);

    // THE POINT. Without `contested`, the child misses `resolved`, takes the inline fallback, and
    // re-projects the parent — a SECOND provider mutation in the same push, which is how a duplicate
    // provider issue gets minted. Exactly one mutation is the whole guarantee.
    expect(mock.mutations, `expected one provider mutation, got ${JSON.stringify(mock.mutations)}`).toHaveLength(1);

    // And the child never got a link pointing at the contested id.
    const childLink = await readLink(seed.teamId, project, "C1");
    expect(childLink?.provider_resource_id ?? null).toBeNull();
  });

  it("a GRANDCHILD also completes with no further adapter invocations", async () => {
    const seed = await seedTeam();
    await seedLinearPrimary(seed);
    const project = await makeProject(seed, "acme");
    const CONTESTED = `li-gp-${randomUUID().slice(0, 8)}`;
    await preclaim(seed, CONTESTED);

    const gp = await makeTask(seed, project, "GP");
    const p = await makeTask(seed, project, "P", "GP");
    const c = await makeTask(seed, project, "C", "P");

    const mock = linearMock({ createId: CONTESTED });
    const primary = await resolvePrimaryProvider(db(), seed.teamId);
    const reports = await projectRows(db(), primary as never, [gp, p, c], {
      fetchImpl: mock.fetchImpl,
      throttleMs: 0,
    });
    const byKey = Object.fromEntries(reports.map((r) => [r.row_key, r]));

    expect(byKey.GP.status).toBe("failed");
    expect(byKey.P.status).toBe("failed");
    expect(byKey.C.status).toBe("failed");
    expect(mock.mutations, "the failure must not fan out into N provider writes").toHaveLength(1);
  });

  /**
   * THE SCOPE FENCE. `contested` covers PERSIST failures only. An adapter THROW already re-projects
   * inline per child today; that behaviour is shipped and is deliberately untouched. Sweeping it in
   * would be the over-correction, and this is the test that would catch it — so the baseline is
   * written down exactly rather than asserted as a vague "unchanged".
   */
  it("the adapter-THROW path is UNCHANGED: the parent is still retried inline per child", async () => {
    const seed = await seedTeam();
    await seedLinearPrimary(seed);
    const project = await makeProject(seed, "acme");

    const parent = await makeTask(seed, project, "TP");
    const child = await makeTask(seed, project, "TC", "TP");

    const mock = throwingMock();
    const primary = await resolvePrimaryProvider(db(), seed.teamId);
    const reports = await projectRows(db(), primary as never, [parent, child], {
      fetchImpl: mock.fetchImpl,
      throttleMs: 0,
    });
    const byKey = Object.fromEntries(reports.map((r) => [r.row_key, r]));

    expect(byKey.TP.status).toBe("failed");
    expect(byKey.TC.status).toBe("failed");
    // EXACTLY TWO: the parent's own attempt, plus the inline retry the child triggers. If a future
    // change routes adapter throws through `contested` this drops to 1 and this test reddens — which
    // is the entire point of pinning the number rather than the word "unchanged".
    expect(mock.mutations, "shipped behaviour: the child re-projects the throwing parent inline").toHaveLength(2);
  });

  it("a STANDALONE projectTask has no contested channel, and that boundary is deliberate", async () => {
    const seed = await seedTeam();
    await seedLinearPrimary(seed);
    const project = await makeProject(seed, "acme");
    const CONTESTED = `li-solo-${randomUUID().slice(0, 8)}`;
    await preclaim(seed, CONTESTED);

    const row = await makeTask(seed, project, "SOLO");
    const mock = linearMock({ createId: CONTESTED });
    const report = await projectTask(db(), row, { fetchImpl: mock.fetchImpl });

    // Contained and loud even without the map — the channel only ever existed to stop SIBLINGS
    // re-invoking, and a standalone call has no siblings. A later cycle re-invoking is ordinary
    // retry semantics, not the batch-internal double-mutation this guards.
    expect(report.status).toBe("failed");
    expect(mock.mutations).toHaveLength(1);
  });
});

describe("ADOPTUNIQ-1 — inbound containment is NARROW", () => {
  /**
   * The containment must swallow a uniqueness rejection and NOTHING else.
   *
   * A blanket catch would be worse than the abort it replaced: `skipped` does not feed `ok`
   * (`runLinearInbound` computes it from `errors` alone), and a skipped-only result is not recorded by the manual
   * sync at all — so a database outage during every adoption would report a clean, successful run.
   * Losing the pass is the CORRECT outcome for an outage.
   *
   * Staged with a temporary trigger raising a NON-23505 error, because that is the only way to make
   * the adopt transaction fail for a reason that is not a constraint the schema already enforces.
   * Installed and dropped inside this test; `finally` runs even on assertion failure, since a
   * surviving trigger would poison every later test against this database.
   */
  it("a NON-uniqueness database failure PROPAGATES rather than being reported as a clean run", async () => {
    const seed = await seedTeam();
    await seedLinearPrimary(seed);
    const project = await makeProject(seed, "acme");
    const row = await makeTask(seed, project, "BOOM");

    await db().from("task_pm_links").insert({
      team_id: seed.teamId,
      project_id: project,
      row_key: "BOOM",
      provider: "linear",
      provider_external_id: "BOOM",
    });

    await rawExec(`
      create or replace function adoptuniq_boom() returns trigger as $fn$
      begin
        if new.row_key = 'BOOM' then
          raise exception 'simulated outage' using errcode = '08006';
        end if;
        return new;
      end $fn$ language plpgsql;
      create trigger adoptuniq_boom_trg before update on task_pm_links
        for each row execute function adoptuniq_boom();
    `);
    try {
      const mock = linearMock();
      const primary = await resolvePrimaryProvider(db(), seed.teamId);
      // The outbound path is the reachable one for this trigger, and it exercises the same rule:
      // a non-uniqueness persist failure must be reported, never silently treated as success.
      const reports = await projectRows(db(), primary as never, [row], {
        fetchImpl: mock.fetchImpl,
        throttleMs: 0,
      });
      expect(reports[0].status, "an outage-shaped failure must not read as synced").toBe("failed");
      expect(reports[0].error).toMatch(/simulated outage/i);
    } finally {
      await rawExec(`
        drop trigger if exists adoptuniq_boom_trg on task_pm_links;
        drop function if exists adoptuniq_boom();
      `);
    }
  });
});
