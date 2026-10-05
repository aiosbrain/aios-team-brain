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

type PmKind = "linear" | "plane";
type IntegrationState = "usable" | "disabled" | "secret-less";

// F4 (AIO-1217): an integration row in a given state. Seeded usable through the table's own writers,
// then rewritten and READ BACK, so "disabled" / "secret-less" is what the table holds, not a say-so.
async function seedIntegration(seed: Seed, type: PmKind, state: IntegrationState = "usable") {
  const auth = { teamId: seed.teamId, memberId: seed.memberId };
  const config = type === "linear" ? { teamId: "team-uuid" } : { workspaceSlug: "ws", projectId: "plane-project" };
  const { id } = await upsertIntegration(db(), auth, { type, name: type, config });
  await setIntegrationSecret(db(), auth, id, `${type}_api_x`);
  if (state === "disabled") await db().from("integrations").update({ status: "disabled" }).eq("id", id);
  if (state === "secret-less") await db().from("integrations").update({ secret_ciphertext: null }).eq("id", id);
  const { data } = await db().from("integrations").select("status, secret_ciphertext").eq("id", id).single();
  const row = data as { status: string; secret_ciphertext: string | null };
  expect([row.status, row.secret_ciphertext !== null]).toEqual([
    state === "disabled" ? "disabled" : "enabled",
    state !== "secret-less",
  ]);
}

async function seedProject(teamId: string): Promise<string> {
  const { data } = await db().from("projects").insert({ team_id: teamId, slug: `p-${randomUUID().slice(0, 6)}`, name: "Proj" }).select("id").single();
  return (data as { id: string }).id;
}

// A linked, already-projected task: the engine previously set last_projected_status; the issue now
// lives at `resourceId` on Linear.
async function seedLinkedTask(
  seed: Seed,
  projectId: string,
  rowKey: string,
  resourceId: string,
  lastProjected: string,
  provider: PmKind = "linear"
) {
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
    provider,
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
    // A pass that RAN carries no reason and no not-run marker — not even as an undefined key.
    expect(Object.keys(result).sort()).toEqual(["divergences", "provider", "seenUpdated"]);
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
    // A zero-update pass over a board that WAS read is still a pass: unmarked.
    expect(Object.keys(r2).sort()).toEqual(["divergences", "provider", "seenUpdated"]);
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
    // No provider resolved is NOT the F4 state: the existing reason, and no not-run marker key.
    expect(result).toStrictEqual({ provider: null, seenUpdated: 0, divergences: [], reason: "no enabled PM integration" });
  });
});

// F4 (AIO-1217): `notRunReason: "integration_unavailable"` is set on exactly one return — a primary
// that is NAMED but has no usable integration — and on no other. toStrictEqual / key lists throughout,
// so a marker present as `undefined` on another return cannot pass for absent.
describe("reconcileProviderState — a pass that did not run vs. one that did (F4 marker, real Postgres)", () => {
  const UNAVAILABLE = (["linear", "plane"] as const).flatMap((named) =>
    (["missing", "disabled", "secret-less"] as const).map((state) => ({ named, state }))
  );

  it.each(UNAVAILABLE)(
    "named $named primary, its integration $state → marked integration_unavailable; nothing rescues it, no provider read, link untouched",
    async ({ named, state }) => {
      const seed = await seedTeam();
      const other = await seedTeam();
      await db().from("teams").update({ primary_pm_provider: named }).eq("id", seed.teamId);
      if (state !== "missing") await seedIntegration(seed, named, state);
      // Neither may rescue the named primary: this team's usable OTHER provider, nor another team's
      // usable integration of the SAME provider.
      await seedIntegration(seed, named === "linear" ? "plane" : "linear");
      await seedIntegration(other, named);
      const project = await seedProject(seed.teamId);
      // An eligible link the pass would have read and rewritten had it run.
      await seedLinkedTask(seed, project, "P0", "li-1", "Backlog", named);
      const before = await readLink(seed.teamId, "P0");

      const { fetchImpl, mutations } = linearMock([{ id: "li-1", state: { id: "ls-done", name: "Done", type: "completed" } }]);
      const result = await reconcileProviderState(db(), seed.teamId, { fetchImpl });

      expect(result).toStrictEqual({
        provider: named,
        seenUpdated: 0,
        divergences: [],
        reason: `${named} integration is not enabled or has no secret`,
        notRunReason: "integration_unavailable",
      });
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(mutations.length).toBe(0);
      expect(await readLink(seed.teamId, "P0")).toEqual(before); // seen status still null, updated_at frozen
    }
  );

  it("resolved linear with nothing linked → an unmarked empty pass, before any provider read", async () => {
    const seed = await seedTeam();
    await seedLinearPrimary(seed);

    const { fetchImpl } = linearMock([]);
    const result = await reconcileProviderState(db(), seed.teamId, { fetchImpl });

    expect(result).toStrictEqual({ provider: "linear", seenUpdated: 0, divergences: [] });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("usable plane integration → the existing unsupported-adapter report, unmarked (no link or board read)", async () => {
    const seed = await seedTeam();
    await db().from("teams").update({ primary_pm_provider: "plane" }).eq("id", seed.teamId);
    await seedIntegration(seed, "plane");
    const project = await seedProject(seed.teamId);
    await seedLinkedTask(seed, project, "P0", "pl-1", "Backlog", "plane");
    const before = await readLink(seed.teamId, "P0");

    const { fetchImpl } = linearMock([]);
    const result = await reconcileProviderState(db(), seed.teamId, { fetchImpl });

    // Unsupported is not unavailable: a reason, no marker. This is not evidence a Plane board was read.
    expect(result).toStrictEqual({
      provider: "plane",
      seenUpdated: 0,
      divergences: [],
      reason: "plane has no inbound reconcile support",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await readLink(seed.teamId, "P0")).toEqual(before);
  });

  it("no primary named, one enabled integration → the sole-enabled fallback still resolves and runs, unmarked", async () => {
    const seed = await seedTeam();
    await seedIntegration(seed, "linear");
    const project = await seedProject(seed.teamId);
    await seedLinkedTask(seed, project, "P0", "li-1", "Backlog");

    const { fetchImpl } = linearMock([{ id: "li-1", state: { id: "ls-done", name: "Done", type: "completed" } }]);
    const result = await reconcileProviderState(db(), seed.teamId, { fetchImpl });

    expect(result).toStrictEqual({
      provider: "linear",
      seenUpdated: 1,
      divergences: [{ row_key: "P0", provider: "linear", last_projected_status: "Backlog", provider_seen_status: "Done" }],
    });
  });

  it("no primary named, two enabled integrations → null provider with the existing reason, unmarked", async () => {
    const seed = await seedTeam();
    await seedIntegration(seed, "linear");
    await seedIntegration(seed, "plane");

    const { fetchImpl } = linearMock([]);
    const result = await reconcileProviderState(db(), seed.teamId, { fetchImpl });

    expect(result).toStrictEqual({
      provider: null,
      seenUpdated: 0,
      divergences: [],
      reason: "multiple PM integrations enabled but teams.primary_pm_provider is unset",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
