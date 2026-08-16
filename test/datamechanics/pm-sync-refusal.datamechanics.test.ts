import { describe, expect, it, vi } from "vitest";
import { projectTaskByIdAfterWrite } from "@/lib/pm-sync";
import { runInboundForTeam } from "@/lib/pm-sync/inbound";
import { upsertIntegration, setIntegrationSecret } from "@/lib/integrations/manage";
import { db, ingest, seedTeam, type Seed } from "./helpers";

/**
 * PMSUCCESS-1 — the STORED-STATE half, which the unit tier structurally cannot prove.
 *
 * A refused mutation throwing is only half the fix. The half that matters is what is NOT written:
 * `persistSuccess` used to record the desired `projection_fingerprint` next to a real
 * `provider_resource_id`, and `project.ts`'s short-circuit then skipped that row on EVERY future run —
 * so a refused update was never retried and Linear stayed wrong under `0 errors`.
 *
 * "Retried on the next run" is a two-run property over stored state. A unit-tier assertion on an update
 * payload greens while the real short-circuit still skips, which is exactly why these live here.
 */

function linearMock(opts: { issues?: unknown[]; refuse?: boolean } = {}) {
  const mutations: string[] = [];
  let n = 0;
  const states = [
    { id: "ls-backlog", name: "Backlog", type: "backlog" },
    { id: "ls-todo", name: "Todo", type: "unstarted" },
    { id: "ls-started", name: "In Progress", type: "started" },
    { id: "ls-done", name: "Done", type: "completed" },
  ];
  const refuse = { success: false, issue: null };
  const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
    const { query, variables } = JSON.parse(String(init?.body));
    if (query.includes("ProjectionBootstrap"))
      return Response.json({ data: { team: { states: { nodes: states }, labels: { nodes: [] } } } });
    if (query.includes("ProjectionMembers"))
      return Response.json({ data: { team: { members: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } });
    if (query.includes("ProjectionIssues"))
      return Response.json({ data: { team: { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: opts.issues ?? [] } } } });
    if (query.includes("IssueForPmSync"))
      return Response.json({ data: { issue: (opts.issues ?? [])[0] ?? null } });
    if (query.includes("TeamDoneStates")) return Response.json({ data: { team: { states: { nodes: states } } } });

    if (query.includes("issueLabelCreate")) {
      mutations.push("issueLabelCreate");
      return Response.json({ data: { issueLabelCreate: { success: true, issueLabel: { id: `label-${++n}` } } } });
    }
    if (query.includes("issueCreate")) {
      mutations.push("issueCreate");
      if (opts.refuse) return Response.json({ data: { issueCreate: refuse } });
      const id = `li-${++n}`;
      return Response.json({ data: { issueCreate: { success: true, issue: { id, identifier: `AIO-${n}`, url: `https://linear.app/${id}` } } } });
    }
    mutations.push("issueUpdate");
    if (opts.refuse) return Response.json({ data: { issueUpdate: refuse } });
    return Response.json({
      data: { issueUpdate: { success: true, issue: { id: variables.id, identifier: "AIO-1", url: "https://linear.app/AIO-1" } } },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, mutations };
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

const linkOf = async (teamId: string, rowKey: string) => {
  const { data } = await db()
    .from("task_pm_links")
    .select("provider_resource_id, projection_fingerprint, last_projected_status, last_error, last_synced_at")
    .eq("team_id", teamId)
    .eq("row_key", rowKey)
    .maybeSingle();
  return data as {
    provider_resource_id: string | null;
    projection_fingerprint: string | null;
    last_projected_status: string | null;
    last_error: string | null;
    last_synced_at: string | null;
  } | null;
};

describe("PMSUCCESS-1 — a refused mutation must not latch the row (real Postgres)", () => {
  it("a refused UPDATE writes last_error, leaves the fingerprint stale, and the NEXT run retries", async () => {
    const seed = await seedTeam();
    await seedLinearPrimary(seed);

    // 1. A successful create, so the row has a real resource id and a fingerprint to latch on.
    await pushTasks(seed, "s1", [{ row_key: "R1", title: "First", status: "in_progress" }]);
    const ok = linearMock();
    await projectTaskByIdAfterWrite(db(), await taskIdOf(seed.teamId, "R1"), { fetchImpl: ok.fetchImpl });
    const created = await linkOf(seed.teamId, "R1");
    expect(created?.provider_resource_id, "the create must have landed for this test to mean anything").toBeTruthy();
    const fingerprintAfterCreate = created?.projection_fingerprint;
    expect(fingerprintAfterCreate).toBeTruthy();

    // 2. Edit the task so the next projection is a real UPDATE — and have Linear refuse it.
    await pushTasks(seed, "s2", [{ row_key: "R1", title: "Second", status: "in_progress" }]);
    const refused = linearMock({
      refuse: true,
      issues: [
        {
          id: created!.provider_resource_id,
          identifier: "AIO-1",
          url: "https://linear.app/AIO-1",
          title: "First",
          description: "aios-ext: R1 · source: aios-backlog",
          priority: 0,
          parent: null,
          state: { id: "ls-started", name: "In Progress", type: "started" },
          labels: { nodes: [] },
          team: { id: "team-uuid" },
        },
      ],
    });
    const report = await projectTaskByIdAfterWrite(db(), await taskIdOf(seed.teamId, "R1"), {
      fetchImpl: refused.fetchImpl,
    });
    expect(JSON.stringify(report)).toMatch(/failed/);

    const afterRefusal = await linkOf(seed.teamId, "R1");
    // THE POINT: the error is recorded and the fingerprint is NOT advanced to the desired one.
    expect(afterRefusal?.last_error, "a refused write must record why").toMatch(/success=false/i);
    expect(
      afterRefusal?.projection_fingerprint,
      "the fingerprint must NOT advance on a refusal — advancing it is what latched the row forever"
    ).toBe(fingerprintAfterCreate);

    // 3. The two-run property: a THIRD projection must actually call Linear again, not short-circuit.
    const retry = linearMock({
      issues: [
        {
          id: created!.provider_resource_id,
          identifier: "AIO-1",
          url: "https://linear.app/AIO-1",
          title: "First",
          description: "aios-ext: R1 · source: aios-backlog",
          priority: 0,
          parent: null,
          state: { id: "ls-started", name: "In Progress", type: "started" },
          labels: { nodes: [] },
          team: { id: "team-uuid" },
        },
      ],
    });
    await projectTaskByIdAfterWrite(db(), await taskIdOf(seed.teamId, "R1"), { fetchImpl: retry.fetchImpl });
    expect(
      retry.mutations,
      "the row was skipped on the next run — the refusal latched it, which is the whole defect"
    ).toContain("issueUpdate");
    const healed = await linkOf(seed.teamId, "R1");
    expect(healed?.last_error, "a later success must clear the error").toBeNull();
    expect(healed?.projection_fingerprint).not.toBe(fingerprintAfterCreate);
  });

  it("a refused CREATE leaves no resource id and records the error — not a clean row", async () => {
    // The footprint §0c reasons about: before this fix the row got `last_synced_at = now`,
    // `last_error = null` and a NULL resource id, which reads as a successful sync.
    const seed = await seedTeam();
    await seedLinearPrimary(seed);
    await pushTasks(seed, "c1", [{ row_key: "C1", title: "Created", status: "in_progress" }]);
    const refused = linearMock({ refuse: true });
    await projectTaskByIdAfterWrite(db(), await taskIdOf(seed.teamId, "C1"), { fetchImpl: refused.fetchImpl });

    const link = await linkOf(seed.teamId, "C1");
    expect(link?.provider_resource_id).toBeNull();
    expect(link?.last_error, "a refused create must be an error, not a silent success").toMatch(/success=false/i);
    expect(link?.projection_fingerprint, "nothing may be latched from a refused create").toBeNull();
  });

  /**
   * §0e — THE WORST OUTCOME, and the one a comment in the unit tier claimed was covered here when it
   * was not. Review caught the false attestation; this is the test it was attesting to.
   *
   * A refused `statusOnly` write used to return a result carrying the DESIRED state, so `persistSuccess`
   * recorded `last_projected_status` as a state Linear was never moved to, plus a matching fingerprint.
   * Inbound then saw `brainUnchanged` true with Linear's real state differing, and wrote Linear's OLD
   * state back onto the brain task — silently reverting a done-transition the user made.
   */
  it("a refused STATUS write leaves the projection baseline unwritten, and inbound does NOT revert the brain", async () => {
    const seed = await seedTeam();
    await seedLinearPrimary(seed);

    // 1. Land a real issue for the row.
    await pushTasks(seed, "d1", [{ row_key: "D1", title: "Ship it", status: "in_progress" }]);
    const ok = linearMock();
    await projectTaskByIdAfterWrite(db(), await taskIdOf(seed.teamId, "D1"), { fetchImpl: ok.fetchImpl });
    const created = await linkOf(seed.teamId, "D1");
    expect(created?.provider_resource_id).toBeTruthy();
    const baselineStatus = created?.last_projected_status;

    // 2. Move it to done in the brain — and have Linear REFUSE the status write.
    await pushTasks(seed, "d2", [{ row_key: "D1", title: "Ship it", status: "done" }]);
    const liveIssue = {
      id: created!.provider_resource_id,
      identifier: "AIO-1",
      url: "https://linear.app/AIO-1",
      title: "Ship it",
      description: "aios-ext: D1 · source: aios-backlog",
      priority: 0,
      parent: null,
      state: { id: "ls-started", name: "In Progress", type: "started" }, // Linear is still NOT done
      labels: { nodes: [] },
      team: { id: "team-uuid" },
    };
    const refused = linearMock({ refuse: true, issues: [liveIssue] });
    await projectTaskByIdAfterWrite(db(), await taskIdOf(seed.teamId, "D1"), { fetchImpl: refused.fetchImpl });

    const afterRefusal = await linkOf(seed.teamId, "D1");
    expect(afterRefusal?.last_error, "the refusal must be recorded").toMatch(/success=false/i);
    expect(
      afterRefusal?.last_projected_status,
      "recording the DESIRED state as projected is what made inbound revert the task"
    ).toBe(baselineStatus ?? null);

    // 3. The brain still says done, and an inbound pass must NOT drag it back to Linear's state.
    const brainBefore = await db().from("tasks").select("status").eq("team_id", seed.teamId).eq("row_key", "D1").single();
    expect((brainBefore.data as { status: string }).status).toBe("done");

    const inbound = linearMock({ issues: [liveIssue] });
    await runInboundForTeam(db(), seed.teamId, { fetchImpl: inbound.fetchImpl });

    const brainAfter = await db().from("tasks").select("status").eq("team_id", seed.teamId).eq("row_key", "D1").single();
    expect(
      (brainAfter.data as { status: string }).status,
      "inbound reverted the brain to Linear's stale state — the refused write was silently undone"
    ).toBe("done");
  });
});
