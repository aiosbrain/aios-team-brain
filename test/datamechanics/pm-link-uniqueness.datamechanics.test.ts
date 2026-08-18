import { describe, expect, it, vi } from "vitest";
import { projectTaskByIdAfterWrite } from "@/lib/pm-sync";
import { upsertIntegration, setIntegrationSecret } from "@/lib/integrations/manage";
import { db, ingest, seedTeam, type Seed } from "./helpers";

/**
 * ADOPTINV-1 — the OUTCOME the adoption fixes exist to produce, asserted on the table.
 *
 * `ADOPTDECL-1` (#581) and `ADOPTFOOT-1` (#588) shipped nine tests between them and every one pins a
 * RUNG'S DECISION: the footer rung's scope, the declared rung's error, the ownership refusal, the
 * single-writer guard. None asserts the state those rungs exist to produce — that no two links in one
 * team, for one provider, point at the same `provider_resource_id`.
 *
 * The closest existing assertions stop just short, both deliberately-looking and both blind to the
 * incident's actual shape:
 *   • `pm-sync-inbound.datamechanics.test.ts:554` asserts one link for one ROW KEY — two links with
 *     DIFFERENT row keys sharing one issue (exactly what happened in prod) pass it.
 *   • `pm-sync-footer-adoption-scope.datamechanics.test.ts:146` asserts the MOCK's recorded calls, not
 *     the row's stored id — a persist bug writing the owner's id into the scaffold's link while the
 *     adapter dutifully created a new issue would stay green.
 *
 * And the DB does not cover it: `postgres/schema.sql:1280` has only
 * `unique (team_id, project_id, row_key, provider)`. `ADOPTUNIQ-1` would add the index this file's
 * query mirrors, but it cannot ship while production holds a violating group and `pg:schema` is
 * Railway's preDeployCommand — a failing index build takes the release down. So until that outward-facing
 * repair happens, THIS is the only thing enforcing the invariant.
 *
 * WHY THE QUERY CARRIES `provider`: it must match `ADOPTUNIQ-1`'s
 * `unique (team_id, provider, provider_resource_id)` exactly, or it does not pre-verify it. Without the
 * provider term a Plane link and a Linear link sharing an id string would be a false positive against a
 * constraint that permits them.
 */

const OWNED_ISSUE_ID = "issue-444";

/** The owner's issue carries NO `aios-ext` footer, and that is load-bearing, not incidental.
 *  `linear.ts:381-386` throws when a DECLARED issue's footer names another row — BEFORE the
 *  `ownedResourceIds` check at `:388-395` is reached. A footered fixture would therefore prove the
 *  footer path and leave the ownership refusal unpinned. The prod shape is footerless too
 *  (`linear.ts:377-379`). */
const OWNED_ISSUE = {
  id: OWNED_ISSUE_ID,
  identifier: "AIO-444",
  url: "https://linear.app/AIO-444",
  title: "Finish verified operator loop",
  description: "A real write-up with no footer.",
  priority: 0,
  parent: null,
  state: { id: "ls-todo", name: "Todo", type: "unstarted" },
  labels: { nodes: [] },
  team: { id: "team-uuid" },
};

/** The footer-bearing variant, for the rung that resolves by `aios-ext:` alone. */
const FOOTERED_ISSUE = {
  ...OWNED_ISSUE,
  description: "A real write-up.\n\naios-ext: TT1 · source: aios-backlog",
};

/**
 * UNIQUE create ids, and this is the difference between a real result and a fixture artifact. The two
 * adoption dm tests' mock returns a constant `id: "brand-new"` for every `issueCreate`. In the
 * three-TT1 scenario below, two rows are refused adoption and each mints its OWN issue — with a
 * constant id both links persist the same `provider_resource_id` and the invariant query reports a
 * duplicate that the product never created. Same pattern as
 * `pm-sync-refusal.datamechanics.test.ts:48`.
 */
/** MODULE-scoped, deliberately. A per-mock counter is not enough: each scenario builds a FRESH mock
 *  per projection, so two independently-created issues would both be `li-1` and the invariant query
 *  would report a duplicate the product never made — the same fixture artifact as the constant id,
 *  one level down. A real provider never reuses an id, and neither does this. */
let issueSeq = 0;

function linearMock(opts: { issues?: unknown[] } = {}) {
  const mutations: string[] = [];
  const updated: string[] = [];
  const created: string[] = [];
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
      return Response.json({
        data: { team: { members: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } },
      });
    if (query.includes("ProjectionIssues"))
      return Response.json({
        data: {
          team: {
            issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: opts.issues ?? [] },
          },
        },
      });
    if (query.includes("IssueForPmSync")) {
      const wanted = (opts.issues ?? []).find((i) => (i as { id: string }).id === variables?.id);
      return Response.json({ data: { issue: wanted ?? null } });
    }
    if (query.includes("issueCreate")) {
      mutations.push("issueCreate");
      const id = `li-${++issueSeq}`;
      created.push(id);
      return Response.json({
        data: { issueCreate: { success: true, issue: { id, identifier: `AIO-9${issueSeq}`, url: `u/${id}` } } },
      });
    }
    if (query.includes("issueUpdate")) {
      mutations.push("issueUpdate");
      updated.push(String(variables?.id));
      return Response.json({
        data: { issueUpdate: { success: true, issue: { id: variables.id, identifier: "AIO-444", url: "u" } } },
      });
    }
    return Response.json({ data: {} });
  }) as unknown as typeof fetch;
  return { fetchImpl, mutations, updated, created };
}

async function seedLinearPrimary(seed: Seed) {
  await db().from("teams").update({ primary_pm_provider: "linear" }).eq("id", seed.teamId);
  const auth = { teamId: seed.teamId, memberId: seed.memberId };
  const { id } = await upsertIntegration(db(), auth, {
    type: "linear",
    name: "linear",
    config: { teamId: "team-uuid" },
  });
  await setIntegrationSecret(db(), auth, id, "lin_api_x");
}

/** Push into a NAMED project. The incident was three workspaces = three projects, each with its own
 *  `TT1` task, so the scenarios seed three real projects rather than moving one link around: a moved
 *  link leaves the original project's link in place holding a resolved id and a matching fingerprint,
 *  which short-circuits at `project.ts:284` and never reaches the rungs. */
const pushTasks = (seed: Seed, salt: string, rows: Record<string, unknown>[], project = "acme") =>
  ingest(seed, {
    project,
    kind: "task",
    path: `3-log/${project}-tasks.md`,
    body: `${salt}\n` + rows.map((r) => `| ${r.row_key} | ${r.title} | | |`).join("\n"),
    access: "team",
    rows,
  } as never);

const taskIdOf = async (teamId: string, rowKey: string, projectSlug = "acme"): Promise<string> => {
  const { data: project } = await db()
    .from("projects")
    .select("id")
    .eq("team_id", teamId)
    .eq("slug", projectSlug)
    .single();
  const { data } = await db()
    .from("tasks")
    .select("id")
    .eq("team_id", teamId)
    .eq("project_id", (project as { id: string }).id)
    .eq("row_key", rowKey)
    .single();
  return (data as { id: string }).id;
};

const linkOf = async (teamId: string, rowKey: string) => {
  const { data } = await db()
    .from("task_pm_links")
    .select("id, project_id, provider_resource_id, projection_fingerprint")
    .eq("team_id", teamId)
    .eq("row_key", rowKey)
    .maybeSingle();
  return data as {
    id: string;
    project_id: string;
    provider_resource_id: string | null;
    projection_fingerprint: string | null;
  } | null;
};

/** A real second project — `task_pm_links.project_id` is an FK, so a made-up uuid silently no-ops
 *  the update and the test passes for the wrong reason. */
async function makeProject(seed: Seed, slug: string): Promise<string> {
  const { data } = await db()
    .from("projects")
    .insert({ team_id: seed.teamId, slug, name: slug })
    .select("id")
    .single();
  return (data as { id: string }).id;
}

/**
 * THE INVARIANT. Mirrors `ADOPTUNIQ-1`'s index exactly:
 *   unique (team_id, provider, provider_resource_id) where provider_resource_id is not null
 */
async function duplicateGroups(teamId: string): Promise<{ provider: string; id: string; n: number }[]> {
  const { data } = await db()
    .from("task_pm_links")
    .select("provider, provider_resource_id")
    .eq("team_id", teamId)
    .not("provider_resource_id", "is", null);
  const counts = new Map<string, number>();
  for (const row of (data ?? []) as { provider: string; provider_resource_id: string }[]) {
    const key = `${row.provider} ${row.provider_resource_id}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, n]) => n > 1)
    .map(([key, n]) => ({ provider: key.split(" ")[0], id: key.split(" ")[1], n }));
}

/** How many links actually hold a resource id — the COUNT ANCHOR. A scenario that silently projected
 *  nothing would otherwise satisfy `duplicateGroups() === []` trivially. */
async function ownedLinkCount(teamId: string): Promise<number> {
  const { data } = await db()
    .from("task_pm_links")
    .select("id")
    .eq("team_id", teamId)
    .not("provider_resource_id", "is", null);
  return (data ?? []).length;
}

describe("ADOPTINV-1 — no two links in a team share one PM issue (real Postgres)", () => {
  it("THE DETECTOR WORKS: two links deliberately sharing one issue are REPORTED", async () => {
    // The inverse control. Draft 1 of the spec proposed "the query returns zero rows on a team with no
    // links", which proves the opposite of what it claimed — that the query passes on nothing, which IS
    // the vacuity. Any query typo that matches nothing would survive that. This is the assertion that
    // makes every `toEqual([])` below mean something.
    const seed = await seedTeam();
    await seedLinearPrimary(seed);
    const projectA = await makeProject(seed, "dup-a");
    const projectB = await makeProject(seed, "dup-b");
    for (const [i, projectId] of [projectA, projectB].entries()) {
      // `provider_external_id` is NOT NULL with no default — omitting it makes the insert fail and the
      // whole control silently pass over an empty table, which is the exact vacuity this case exists to
      // rule out. So the error is checked rather than discarded.
      const { error } = await db()
        .from("task_pm_links")
        .insert({
          team_id: seed.teamId,
          project_id: projectId,
          row_key: `DUP${i}`,
          provider: "linear",
          provider_external_id: `DUP${i}`,
          provider_resource_id: OWNED_ISSUE_ID,
        });
      expect(error, "the seeded duplicate link must actually insert").toBeFalsy();
    }
    expect(await duplicateGroups(seed.teamId)).toEqual([
      { provider: "linear", id: OWNED_ISSUE_ID, n: 2 },
    ]);

    // And it is provider-scoped, matching the index it pre-verifies: the SAME id under a different
    // provider is NOT a violation, because the index would permit it.
    const seed2 = await seedTeam();
    const p1 = await makeProject(seed2, "mixed-a");
    const p2 = await makeProject(seed2, "mixed-b");
    for (const [i, [projectId, provider]] of [
      [p1, "linear"],
      [p2, "plane"],
    ].entries()) {
      const { error } = await db()
        .from("task_pm_links")
        .insert({
          team_id: seed2.teamId,
          project_id: projectId,
          row_key: `MIX${i}`,
          provider,
          provider_external_id: `MIX${i}`,
          provider_resource_id: "same-string",
        });
      expect(error, "the mixed-provider link must actually insert").toBeFalsy();
    }
    expect(await duplicateGroups(seed2.teamId)).toEqual([]);
  });

  it("THE INCIDENT'S SHAPE: three same-keyed rows in three projects, projected back to back", async () => {
    // `projectAllTasks` is (team, project)-scoped, so three projects cannot share one run — these are
    // three successive projections, each seeing the state the previous one left.
    const seed = await seedTeam();
    await seedLinearPrimary(seed);

    // Workspace 1 legitimately owns AIO-444 via its footer.
    await pushTasks(seed, "o1", [
      { row_key: "TT1", title: "Finish verified operator loop", status: "in_progress" },
    ]);
    const first = linearMock({ issues: [FOOTERED_ISSUE] });
    await projectTaskByIdAfterWrite(db(), await taskIdOf(seed.teamId, "TT1"), { fetchImpl: first.fetchImpl });
    const ownerLink = await linkOf(seed.teamId, "TT1");
    expect(ownerLink?.provider_resource_id, "the owner must hold the issue or this proves nothing").toBe(
      OWNED_ISSUE_ID
    );

    // Workspaces 2 and 3: their OWN projects, each with its own scaffold `TT1` — the live shape, where
    // the owner keeps its link and the newcomers have none.
    // The anchors are RECORDED here and asserted AFTER the invariant, deliberately. Asserted inline they
    // abort the scenario first — under the canonical mutant (self-exclusion re-keyed to `row_key`
    // alone) the scaffold row adopts the owner's issue, `issueCreate` never happens, and the anchor
    // fires before the invariant assertion is ever evaluated. The invariant would then be caught by a
    // sibling layer instead of proving itself, which is how a guard ends up decorative.
    const anchors: { slug: string; mutations: string[]; updated: string[] }[] = [];
    for (const slug of ["ws-two", "ws-three"]) {
      await pushTasks(seed, slug, [{ row_key: "TT1", title: "Example team task", status: "ready" }], slug);
      const scaffold = linearMock({ issues: [FOOTERED_ISSUE] });
      await projectTaskByIdAfterWrite(db(), await taskIdOf(seed.teamId, "TT1", slug), {
        fetchImpl: scaffold.fetchImpl,
      });
      anchors.push({ slug, mutations: scaffold.mutations, updated: scaffold.updated });
    }

    // THE INVARIANT, first.
    expect(await duplicateGroups(seed.teamId)).toEqual([]);
    expect(await ownedLinkCount(seed.teamId), "three rows must have produced three distinct links").toBe(3);

    // Then the anti-vacuity anchors: each row actually reached the adapter. "The fetch mock was called"
    // would not do — `projectRows` calls `prepare` before any row projects (project.ts:401), so
    // bootstrap alone satisfies it even when every row short-circuits at :284.
    for (const a of anchors) {
      expect(a.mutations, `scaffold ${a.slug} never reached the adapter`).toContain("issueCreate");
      expect(a.updated, "it must not write into the owner's issue").not.toContain(OWNED_ISSUE_ID);
    }
  });

  it("RUNG 1 MISSING because the issue was DELETED at the provider, twice in succession", async () => {
    const seed = await seedTeam();
    await seedLinearPrimary(seed);

    await pushTasks(seed, "d1", [{ row_key: "TT1", title: "Finish verified operator loop", status: "in_progress" }]);
    const owner = linearMock({ issues: [FOOTERED_ISSUE] });
    await projectTaskByIdAfterWrite(db(), await taskIdOf(seed.teamId, "TT1"), { fetchImpl: owner.fetchImpl });
    const ownerLink = await linkOf(seed.teamId, "TT1");
    expect(ownerLink?.provider_resource_id).toBe(OWNED_ISSUE_ID);

    // A second workspace's row whose link points at an id the provider no longer returns — the deleted
    // issue that made rung 1 MISS, which is the path ADOPTFOOT-1 found its load gate blind to.
    await pushTasks(seed, "d2", [{ row_key: "TT1", title: "Example team task", status: "ready" }], "ws-deleted");
    const seeded = linearMock({ issues: [] });
    await projectTaskByIdAfterWrite(db(), await taskIdOf(seed.teamId, "TT1", "ws-deleted"), {
      fetchImpl: seeded.fetchImpl,
    });
    const secondProject = await db()
      .from("projects")
      .select("id")
      .eq("team_id", seed.teamId)
      .eq("slug", "ws-deleted")
      .single();
    const secondProjectId = (secondProject.data as { id: string }).id;
    const setDeleted = async () => {
      await db()
        .from("task_pm_links")
        .update({ provider_resource_id: "issue-deleted", projection_fingerprint: null })
        .eq("team_id", seed.teamId)
        .eq("project_id", secondProjectId);
    };

    // TWICE, because the re-fire sequence needs a second bite: pass 1 resolves and stamps a fingerprint,
    // so a naive second pass would legitimately SKIP at project.ts:284 and prove nothing. Re-seeding the
    // deleted id and clearing the fingerprint is the "a later edit breaks the short-circuit" step that
    // reopened the hijack in the real incident.
    for (const pass of [1, 2]) {
      await setDeleted();
      const run = linearMock({ issues: [FOOTERED_ISSUE] });
      await projectTaskByIdAfterWrite(db(), await taskIdOf(seed.teamId, "TT1", "ws-deleted"), {
        fetchImpl: run.fetchImpl,
      });
      // Invariant first, anchors second — see the note in the scenario above.
      expect(await duplicateGroups(seed.teamId), `pass ${pass} produced a duplicate group`).toEqual([]);
      expect(run.mutations.length, `pass ${pass} never reached the adapter`).toBeGreaterThan(0);
      expect(run.updated, `pass ${pass} wrote into the owner's issue`).not.toContain(OWNED_ISSUE_ID);
    }
  });

  it("A DECLARED id already owned by another row is refused, and the row records an error", async () => {
    const seed = await seedTeam();
    await seedLinearPrimary(seed);

    await pushTasks(seed, "c1", [
      {
        row_key: "TT1",
        title: "Finish verified operator loop",
        status: "in_progress",
        pm_provider: "linear",
        pm_external_id: "AIO-444",
      },
    ]);
    const owner = linearMock({ issues: [OWNED_ISSUE] });
    await projectTaskByIdAfterWrite(db(), await taskIdOf(seed.teamId, "TT1"), { fetchImpl: owner.fetchImpl });
    const ownerLink = await linkOf(seed.teamId, "TT1");
    expect(ownerLink?.provider_resource_id, "the owner must hold the issue").toBe(OWNED_ISSUE_ID);

    // A DIFFERENT row, in its own project, declaring the SAME issue. The fixture issue is footerless on
    // purpose, so this exercises the ownedResourceIds refusal rather than the ownerExt throw that
    // precedes it at linear.ts:381-386.
    await pushTasks(
      seed,
      "c2",
      [{ row_key: "TT9", title: "Another row", status: "ready", pm_provider: "linear", pm_external_id: "AIO-444" }],
      "ws-claimant"
    );
    const claimant = linearMock({ issues: [OWNED_ISSUE] });
    await projectTaskByIdAfterWrite(db(), await taskIdOf(seed.teamId, "TT9", "ws-claimant"), {
      fetchImpl: claimant.fetchImpl,
    });

    expect(await duplicateGroups(seed.teamId)).toEqual([]);
    const claimantLink = await linkOf(seed.teamId, "TT9");
    expect(claimantLink?.provider_resource_id, "the claimant must not end up holding the owner's issue").not.toBe(
      OWNED_ISSUE_ID
    );
    expect(claimant.updated, "and must not have written into it").not.toContain(OWNED_ISSUE_ID);
  });
});
