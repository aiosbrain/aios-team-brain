import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { reconcileProviderState } from "@/lib/pm-sync/reconcile";
import { upsertIntegration, setIntegrationSecret } from "@/lib/integrations/manage";
import { db, seedTeam, type Seed } from "./helpers";

// Spec (brain-api v1.2 Phase 5): inbound divergence detection. A reconcile pass reads the provider's
// CURRENT workflow state, records it on `task_pm_links.provider_seen_status`, and SURFACES divergence
// when that state ≠ `last_projected_status`. It is SURFACE-ONLY: it must never mutate the provider
// (brain wins) and never change brain `tasks.status` (brain is the source of truth). Verified to the
// observable outcome on real Postgres with a mutation-counting Linear stub — no live calls in CI.

// ── Linear stub: ProjectionBootstrap (states/labels) + ProjectionIssues (current issue states) ──────
function linearMock(issues: unknown[]) {
  const mutations: { name: string }[] = [];
  const states = [
    { id: "ls-backlog", name: "Backlog", type: "backlog" },
    { id: "ls-todo", name: "Todo", type: "unstarted" },
    { id: "ls-started", name: "In Progress", type: "started" },
    { id: "ls-done", name: "Done", type: "completed" },
  ];
  const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
    const { query } = JSON.parse(String(init?.body));
    if (query.includes("ProjectionBootstrap")) {
      return Response.json({ data: { team: { states: { nodes: states }, labels: { nodes: [] } } } });
    }
    if (query.includes("ProjectionIssues")) {
      return Response.json({ data: { team: { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: issues } } } });
    }
    if (query.includes("mutation")) mutations.push({ name: query.match(/mutation (\w+)/)?.[1] ?? "op" });
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

async function seedProject(teamId: string): Promise<string> {
  const { data } = await db().from("projects").insert({ team_id: teamId, slug: `p-${randomUUID().slice(0, 6)}`, name: "Proj" }).select("id").single();
  return (data as { id: string }).id;
}

// A linked, already-projected task: the engine previously set last_projected_status; the issue now
// lives at `resourceId` on Linear.
async function seedLinkedTask(seed: Seed, projectId: string, rowKey: string, resourceId: string, lastProjected: string) {
  const { data: task } = await db()
    .from("tasks")
    .insert({ team_id: seed.teamId, project_id: projectId, row_key: rowKey, title: rowKey, status: "backlog", origin: "ui" })
    .select("id")
    .single();
  const taskId = (task as { id: string }).id;
  await db().from("task_pm_links").insert({
    team_id: seed.teamId,
    project_id: projectId,
    task_id: taskId,
    row_key: rowKey,
    provider: "linear",
    provider_external_id: rowKey,
    provider_external_source: "aios-backlog",
    provider_resource_id: resourceId,
    provider_url: `https://linear.app/${resourceId}`,
    last_projected_status: lastProjected,
    provider_seen_status: null,
  });
  return taskId;
}

async function readLink(teamId: string, rowKey: string) {
  const { data } = await db()
    .from("task_pm_links")
    .select("provider_seen_status, last_projected_status, updated_at")
    .eq("team_id", teamId)
    .eq("row_key", rowKey)
    .single();
  return data as { provider_seen_status: string | null; last_projected_status: string | null; updated_at: string };
}

async function readTaskStatus(taskId: string): Promise<string> {
  const { data } = await db().from("tasks").select("status").eq("id", taskId).single();
  return (data as { status: string }).status;
}

describe("reconcileProviderState — inbound divergence (real Postgres)", () => {
  it("surfaces divergence + records provider_seen_status, WITHOUT touching brain status or the board", async () => {
    const seed = await seedTeam();
    await seedLinearPrimary(seed);
    const project = await seedProject(seed.teamId);
    // Brain last projected "Backlog"; someone moved the Linear issue to "Done".
    const taskId = await seedLinkedTask(seed, project, "P0", "li-1", "Backlog");

    const { fetchImpl, mutations } = linearMock([{ id: "li-1", state: { id: "ls-done", name: "Done", type: "completed" } }]);
    const result = await reconcileProviderState(db(), seed.teamId, { fetchImpl });

    expect(result.provider).toBe("linear");
    expect(result.divergences).toEqual([
      expect.objectContaining({ row_key: "P0", provider: "linear", last_projected_status: "Backlog", provider_seen_status: "Done" }),
    ]);
    // provider_seen_status persisted.
    expect((await readLink(seed.teamId, "P0")).provider_seen_status).toBe("Done");
    // SURFACE-ONLY: brain status unchanged + ZERO provider mutations (never writes back to the board).
    expect(await readTaskStatus(taskId)).toBe("backlog");
    expect(mutations.length).toBe(0);
  });

  it("no-op when the provider state equals last_projected_status (not flagged)", async () => {
    const seed = await seedTeam();
    await seedLinearPrimary(seed);
    const project = await seedProject(seed.teamId);
    await seedLinkedTask(seed, project, "P0", "li-1", "Backlog");

    const { fetchImpl, mutations } = linearMock([{ id: "li-1", state: { id: "ls-backlog", name: "Backlog", type: "backlog" } }]);
    const result = await reconcileProviderState(db(), seed.teamId, { fetchImpl });

    expect(result.divergences).toEqual([]); // equal → no divergence
    expect((await readLink(seed.teamId, "P0")).provider_seen_status).toBe("Backlog"); // still recorded as seen
    expect(mutations.length).toBe(0);
  });

  it("is idempotent — a second pass makes ZERO writes (seenUpdated=0, updated_at frozen)", async () => {
    const seed = await seedTeam();
    await seedLinearPrimary(seed);
    const project = await seedProject(seed.teamId);
    await seedLinkedTask(seed, project, "P0", "li-1", "Backlog");

    const first = linearMock([{ id: "li-1", state: { id: "ls-done", name: "Done", type: "completed" } }]);
    const r1 = await reconcileProviderState(db(), seed.teamId, { fetchImpl: first.fetchImpl });
    expect(r1.seenUpdated).toBe(1);
    const afterFirst = await readLink(seed.teamId, "P0");

    const second = linearMock([{ id: "li-1", state: { id: "ls-done", name: "Done", type: "completed" } }]);
    const r2 = await reconcileProviderState(db(), seed.teamId, { fetchImpl: second.fetchImpl });
    expect(r2.seenUpdated).toBe(0); // nothing changed → no DB write
    expect(second.mutations.length).toBe(0);
    // The divergence is still surfaced (read from stored state), but the row was not re-written.
    expect(r2.divergences.length).toBe(1);
    expect(new Date((await readLink(seed.teamId, "P0")).updated_at).getTime()).toBe(
      new Date(afterFirst.updated_at).getTime()
    );
  });

  it("no primary provider → clean no-op report (nothing to reconcile)", async () => {
    const seed = await seedTeam();
    const { fetchImpl } = linearMock([]);
    const result = await reconcileProviderState(db(), seed.teamId, { fetchImpl });
    expect(result.provider).toBeNull();
    expect(result.divergences).toEqual([]);
    expect(result.seenUpdated).toBe(0);
  });
});
