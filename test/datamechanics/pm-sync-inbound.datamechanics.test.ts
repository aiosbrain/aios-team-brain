import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { runInboundForTeam } from "@/lib/pm-sync/inbound";
import { projectAllTasks, toProjectable, type ProjectionTaskRow } from "@/lib/pm-sync/project";
import { projectionFingerprint } from "@/lib/pm-sync/provider";
import { upsertIntegration, setIntegrationSecret } from "@/lib/integrations/manage";
import { runSql } from "@/lib/db/pg/pool";
import { db, seedTeam, type Seed } from "./helpers";

// Spec (brain-api v1.4 — Linear⇄brain inbound apply, AIO-145): the write half of Phase 5.
//   • APPLY: a Linear status change lands on `tasks.status` ONLY when the brain is unchanged since
//     its last projection — and "unchanged" is BOTH the exact brain-status baseline
//     (`last_projected_brain_status === tasks.status`; the group-granular fingerprint cannot tell
//     in_progress from blocked) AND fingerprint equality (a pending title/body edit blocks apply).
//   • NO ECHO: an apply refreshes the outbound fingerprint atomically, so the next projection
//     makes ZERO provider mutations.
//   • CONFLICT: both-changed is surfaced, never auto-merged, and never writes `tasks.status`.
//   • ADOPT: a Linear-native issue's ingest-created mirror task gets the two-way link backfilled
//     (team tier, origin flipped to 'ui', footer appended) — never a duplicate.
// Verified to the observable outcome on real Postgres with a mutation-counting Linear stub.

// ── Linear stub: projection bootstrap + import queries + counted mutations ──────────────────────
const STATES = [
  { id: "ls-backlog", name: "Backlog", type: "backlog" },
  { id: "ls-todo", name: "Todo", type: "unstarted" },
  { id: "ls-started", name: "In Progress", type: "started" },
  { id: "ls-blocked", name: "Blocked", type: "started" },
  { id: "ls-done", name: "Done", type: "completed" },
  { id: "ls-canceled", name: "Canceled", type: "canceled" },
];

interface MockIssue {
  id: string;
  identifier?: string;
  title?: string;
  description?: string | null;
  url?: string;
  priority?: number;
  parent?: { id?: string; identifier?: string } | null;
  state?: { id?: string; name?: string; type?: string } | null;
  labels?: { nodes: { id?: string; name: string }[] } | null;
  assignee?: null;
  team?: { id: string } | null;
}

function linearMock(issues: MockIssue[]) {
  const mutations: { name: string; variables: Record<string, unknown> }[] = [];
  const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const { query, variables } = JSON.parse(String(init?.body));
    if (query.includes("ProjectionBootstrap")) {
      return Response.json({ data: { team: { states: { nodes: STATES }, labels: { nodes: [] } } } });
    }
    if (query.includes("ProjectionMembers")) {
      return Response.json({
        data: { team: { members: { pageInfo: { hasNextPage: false, endCursor: "" }, nodes: [] } } },
      });
    }
    if (query.includes("ProjectionIssues")) {
      return Response.json({
        data: { team: { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: issues } } },
      });
    }
    if (query.includes("ImportIssues")) {
      return Response.json({
        data: {
          team: {
            key: "ENG",
            members: { nodes: [] },
            issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: issues },
          },
        },
      });
    }
    if (/^\s*mutation/.test(query)) {
      const name = query.match(/mutation (\w+)/)?.[1] ?? "op";
      mutations.push({ name, variables });
      if (name === "CreateIssue") {
        return Response.json({
          data: { issueCreate: { issue: { id: `li-created-${mutations.length}`, identifier: "T-NEW", url: "" } } },
        });
      }
      if (name === "CreateLabel") {
        return Response.json({ data: { issueLabelCreate: { issueLabel: { id: `lb-${mutations.length}` } } } });
      }
      return Response.json({ data: { issueUpdate: { success: true, issue: { id: "x" } } } });
    }
    return Response.json({ data: {} });
  }) as unknown as typeof fetch;
  return { fetchImpl, mutations };
}

// ── Seeds ────────────────────────────────────────────────────────────────────────────────────────

async function seedLinearPrimary(seed: Seed, config: Record<string, unknown> = { teamId: "team-uuid", inboundApply: true }) {
  await db().from("teams").update({ primary_pm_provider: "linear" }).eq("id", seed.teamId);
  const auth = { teamId: seed.teamId, memberId: seed.memberId };
  const { id } = await upsertIntegration(db(), auth, { type: "linear", name: "linear", config });
  await setIntegrationSecret(db(), auth, id, "lin_api_x");
  return id;
}

async function seedProject(teamId: string, slug = `p-${randomUUID().slice(0, 6)}`): Promise<string> {
  const { data } = await db().from("projects").insert({ team_id: teamId, slug, name: "Proj" }).select("id").single();
  return (data as { id: string }).id;
}

// The exact fingerprint the outbound engine would have stored for this task shape.
function fp(over: Partial<ProjectionTaskRow> & { row_key: string; status: string }, parentResourceId: string | null = null): string {
  const row: ProjectionTaskRow = {
    id: "",
    team_id: "",
    project_id: "",
    title: over.row_key,
    sprint: "",
    priority: "none",
    labels: [],
    body: "",
    parent_row_key: null,
    assignee: "",
    ...over,
    status: over.status as ProjectionTaskRow["status"],
  };
  return projectionFingerprint(toProjectable(row, parentResourceId), parentResourceId);
}

// A linked, previously-projected task with full v1.4 bookkeeping (baseline + fingerprint).
async function seedLinkedTask(
  seed: Seed,
  projectId: string,
  args: {
    rowKey: string;
    resourceId: string;
    status: string; // current brain tasks.status
    lastProjected: string; // Linear state NAME at last projection
    baselineStatus?: string | null; // last_projected_brain_status (defaults to current status)
    fingerprint?: string | null; // defaults to fingerprint of the CURRENT task shape
    parentRowKey?: string | null;
    parentResourceId?: string | null;
    body?: string;
    origin?: string;
  }
) {
  const baseline = args.baselineStatus === undefined ? args.status : args.baselineStatus;
  const { data: task } = await db()
    .from("tasks")
    .insert({
      team_id: seed.teamId,
      project_id: projectId,
      row_key: args.rowKey,
      title: args.rowKey,
      status: args.status,
      origin: args.origin ?? "ui",
      body: args.body ?? "",
      parent_row_key: args.parentRowKey ?? null,
    })
    .select("id")
    .single();
  const taskId = (task as { id: string }).id;
  const fingerprint =
    args.fingerprint === undefined
      ? fp(
          { row_key: args.rowKey, status: args.status, parent_row_key: args.parentRowKey ?? null, body: args.body ?? "" },
          args.parentResourceId ?? null
        )
      : args.fingerprint;
  await db().from("task_pm_links").insert({
    team_id: seed.teamId,
    project_id: projectId,
    task_id: taskId,
    row_key: args.rowKey,
    provider: "linear",
    provider_external_id: args.rowKey,
    provider_external_source: "aios-backlog",
    provider_resource_id: args.resourceId,
    provider_url: `https://linear.app/${args.resourceId}`,
    last_projected_status: args.lastProjected,
    last_projected_brain_status: baseline,
    projection_fingerprint: fingerprint,
    provider_seen_status: null,
  });
  return taskId;
}

async function readLink(teamId: string, rowKey: string) {
  const { data } = await db()
    .from("task_pm_links")
    .select(
      "id, provider_resource_id, provider_seen_status, last_projected_status, last_projected_brain_status, projection_fingerprint, last_error, updated_at"
    )
    .eq("team_id", teamId)
    .eq("row_key", rowKey)
    .single();
  return data as {
    id: string;
    provider_resource_id: string | null;
    provider_seen_status: string | null;
    last_projected_status: string | null;
    last_projected_brain_status: string | null;
    projection_fingerprint: string | null;
    last_error: string | null;
    updated_at: string;
  };
}

async function readTask(taskId: string) {
  const { data } = await db().from("tasks").select("status, body, origin, updated_at").eq("id", taskId).single();
  return data as { status: string; body: string; origin: string; updated_at: string };
}

const issue = (id: string, stateId: string, over: Partial<MockIssue> = {}): MockIssue => ({
  id,
  state: STATES.filter((s) => s.id === stateId).map((s) => ({ id: s.id, name: s.name, type: s.type }))[0],
  ...over,
});

describe("inbound apply — pm-wins-if-brain-unchanged (real Postgres)", () => {
  it("applies a Linear move when the brain is unchanged, atomically refreshing baseline + fingerprint", async () => {
    const seed = await seedTeam();
    await seedLinearPrimary(seed);
    const project = await seedProject(seed.teamId);
    // Brain last projected "Todo" (ready); someone moved the issue to Done. Brain untouched since.
    const taskId = await seedLinkedTask(seed, project, {
      rowKey: "P1",
      resourceId: "li-1",
      status: "ready",
      lastProjected: "Todo",
    });

    const { fetchImpl, mutations } = linearMock([issue("li-1", "ls-done", { identifier: "P1" })]);
    const result = await runInboundForTeam(db(), seed.teamId, { fetchImpl });

    expect(result.enabled).toBe(true);
    expect(result.conflicts).toEqual([]);
    expect(result.applied).toHaveLength(1);
    expect(result.applied[0].payload).toMatchObject({ row_key: "P1", from: "ready", brain_state: "done" });

    const task = await readTask(taskId);
    expect(task.status).toBe("done");
    expect(task.body).toBe(""); // body is NEVER written by the apply loop

    const link = await readLink(seed.teamId, "P1");
    expect(link.last_projected_status).toBe("Done");
    expect(link.last_projected_brain_status).toBe("done");
    expect(link.provider_seen_status).toBe("Done");
    // Fingerprint recomputed for the post-apply shape — what the next projection will compute.
    expect(link.projection_fingerprint).toBe(fp({ row_key: "P1", status: "done" }));
    // Apply is inbound-only: zero provider mutations.
    expect(mutations).toEqual([]);
  });

  it("no-echo: the projection pass after an apply makes ZERO provider mutations", async () => {
    const seed = await seedTeam();
    await seedLinearPrimary(seed);
    const project = await seedProject(seed.teamId);
    await seedLinkedTask(seed, project, { rowKey: "P1", resourceId: "li-1", status: "ready", lastProjected: "Todo" });

    const inbound = linearMock([issue("li-1", "ls-done", { identifier: "P1" })]);
    await runInboundForTeam(db(), seed.teamId, { fetchImpl: inbound.fetchImpl });

    const outbound = linearMock([issue("li-1", "ls-done", { identifier: "P1" })]);
    const { reports } = await projectAllTasks(db(), seed.teamId, project, { fetchImpl: outbound.fetchImpl, throttleMs: 0 });
    expect(reports.map((r) => r.status)).toEqual(["skipped"]);
    expect(outbound.mutations).toEqual([]);
  });

  it("same-group Linear-only change (In Progress → Blocked) applies, then projects with zero mutations", async () => {
    // Round-3 review verification #2: the exact baseline lets a same-GROUP provider change apply.
    const seed = await seedTeam();
    await seedLinearPrimary(seed);
    const project = await seedProject(seed.teamId);
    const taskId = await seedLinkedTask(seed, project, {
      rowKey: "P2",
      resourceId: "li-2",
      status: "in_progress",
      lastProjected: "In Progress",
    });

    const inbound = linearMock([issue("li-2", "ls-blocked", { identifier: "P2" })]);
    const result = await runInboundForTeam(db(), seed.teamId, { fetchImpl: inbound.fetchImpl });
    expect(result.conflicts).toEqual([]);
    expect(result.applied).toHaveLength(1);
    expect((await readTask(taskId)).status).toBe("blocked");
    const link = await readLink(seed.teamId, "P2");
    expect(link.last_projected_brain_status).toBe("blocked");
    expect(link.last_projected_status).toBe("Blocked");

    const outbound = linearMock([issue("li-2", "ls-blocked", { identifier: "P2" })]);
    const { reports } = await projectAllTasks(db(), seed.teamId, project, { fetchImpl: outbound.fetchImpl, throttleMs: 0 });
    expect(reports.map((r) => r.status)).toEqual(["skipped"]);
    expect(outbound.mutations).toEqual([]);
  });

  it("concurrent same-group brain edit (in_progress → blocked) + Linear move = CONFLICT, no status write", async () => {
    // Round-3 review verification #1: the fingerprint hashes the state GROUP, so in_progress and
    // blocked hash identically — only the exact baseline catches this. Must NOT silently apply.
    const seed = await seedTeam();
    await seedLinearPrimary(seed);
    const project = await seedProject(seed.teamId);
    const taskId = await seedLinkedTask(seed, project, {
      rowKey: "P3",
      resourceId: "li-3",
      status: "blocked", // brain moved in_progress → blocked after the last projection…
      baselineStatus: "in_progress", // …which projected in_progress
      fingerprint: fp({ row_key: "P3", status: "in_progress" }), // group-equal to blocked!
      lastProjected: "In Progress",
    });

    const { fetchImpl } = linearMock([issue("li-3", "ls-done", { identifier: "P3" })]);
    const result = await runInboundForTeam(db(), seed.teamId, { fetchImpl });

    expect(result.applied).toEqual([]);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].payload).toMatchObject({ row_key: "P3", linear_state: "Done", brain_state: "blocked" });
    // No write: brain status intact, bookkeeping untouched (stays diverged/surfaced).
    expect((await readTask(taskId)).status).toBe("blocked");
    const link = await readLink(seed.teamId, "P3");
    expect(link.last_projected_brain_status).toBe("in_progress");
    expect(link.last_projected_status).toBe("In Progress");
    expect(link.projection_fingerprint).toBe(fp({ row_key: "P3", status: "in_progress" }));
  });

  it("pending non-status brain edit (fingerprint mismatch) + Linear move = CONFLICT", async () => {
    const seed = await seedTeam();
    await seedLinearPrimary(seed);
    const project = await seedProject(seed.teamId);
    // Title changed in the brain since last projection (fingerprint differs), status baseline equal.
    const taskId = await seedLinkedTask(seed, project, {
      rowKey: "P4",
      resourceId: "li-4",
      status: "ready",
      fingerprint: fp({ row_key: "P4-old-title", status: "ready", title: "P4-old-title" }),
      lastProjected: "Todo",
    });

    const { fetchImpl } = linearMock([issue("li-4", "ls-done", { identifier: "P4" })]);
    const result = await runInboundForTeam(db(), seed.teamId, { fetchImpl });
    expect(result.applied).toEqual([]);
    expect(result.conflicts).toHaveLength(1);
    expect((await readTask(taskId)).status).toBe("ready");
  });

  it("is idempotent — a second inbound pass is a pure no-op (updated_at frozen)", async () => {
    const seed = await seedTeam();
    await seedLinearPrimary(seed);
    const project = await seedProject(seed.teamId);
    await seedLinkedTask(seed, project, { rowKey: "P5", resourceId: "li-5", status: "ready", lastProjected: "Todo" });

    const first = linearMock([issue("li-5", "ls-done", { identifier: "P5" })]);
    const r1 = await runInboundForTeam(db(), seed.teamId, { fetchImpl: first.fetchImpl });
    expect(r1.applied).toHaveLength(1);
    const afterFirst = await readLink(seed.teamId, "P5");

    const second = linearMock([issue("li-5", "ls-done", { identifier: "P5" })]);
    const r2 = await runInboundForTeam(db(), seed.teamId, { fetchImpl: second.fetchImpl });
    expect(r2.applied).toEqual([]);
    expect(r2.conflicts).toEqual([]);
    expect(r2.noops).toBeGreaterThan(0);
    expect(second.mutations).toEqual([]);
    expect(new Date((await readLink(seed.teamId, "P5")).updated_at).getTime()).toBe(
      new Date(afterFirst.updated_at).getTime()
    );
  });

  it("child task: apply fingerprints with the REAL parent resource id; next projection = zero mutations", async () => {
    const seed = await seedTeam();
    await seedLinearPrimary(seed);
    const project = await seedProject(seed.teamId);
    await seedLinkedTask(seed, project, { rowKey: "E1", resourceId: "li-epic", status: "in_progress", lastProjected: "In Progress" });
    const childId = await seedLinkedTask(seed, project, {
      rowKey: "C1",
      resourceId: "li-child",
      status: "ready",
      lastProjected: "Todo",
      parentRowKey: "E1",
      parentResourceId: "li-epic",
    });

    const inbound = linearMock([
      issue("li-epic", "ls-started", { identifier: "E1" }),
      issue("li-child", "ls-done", { identifier: "C1", parent: { id: "li-epic" } }),
    ]);
    const result = await runInboundForTeam(db(), seed.teamId, { fetchImpl: inbound.fetchImpl });
    expect(result.conflicts).toEqual([]);
    expect(result.applied).toHaveLength(1);
    expect((await readTask(childId)).status).toBe("done");
    expect((await readLink(seed.teamId, "C1")).projection_fingerprint).toBe(
      fp({ row_key: "C1", status: "done", parent_row_key: "E1" }, "li-epic")
    );

    const outbound = linearMock([
      issue("li-epic", "ls-started", { identifier: "E1" }),
      issue("li-child", "ls-done", { identifier: "C1", parent: { id: "li-epic" } }),
    ]);
    const { reports } = await projectAllTasks(db(), seed.teamId, project, { fetchImpl: outbound.fetchImpl, throttleMs: 0 });
    expect(reports.map((r) => r.status)).toEqual(["skipped", "skipped"]);
    expect(outbound.mutations).toEqual([]);
  });

  it("maps a Canceled (1-L 'canceled' type) state to done — the 2-L StateGroup fork can't mis-map", async () => {
    const seed = await seedTeam();
    await seedLinearPrimary(seed);
    const project = await seedProject(seed.teamId);
    const taskId = await seedLinkedTask(seed, project, { rowKey: "P6", resourceId: "li-6", status: "ready", lastProjected: "Todo" });

    const { fetchImpl } = linearMock([issue("li-6", "ls-canceled", { identifier: "P6" })]);
    const result = await runInboundForTeam(db(), seed.teamId, { fetchImpl });
    expect(result.conflicts).toEqual([]);
    expect(result.applied).toHaveLength(1);
    expect((await readTask(taskId)).status).toBe("done");
  });

  it("an unresolvable Linear state (renamed/unknown group) is a CONFLICT, never a silent default", async () => {
    const seed = await seedTeam();
    await seedLinearPrimary(seed);
    const project = await seedProject(seed.teamId);
    const taskId = await seedLinkedTask(seed, project, { rowKey: "P7", resourceId: "li-7", status: "ready", lastProjected: "Todo" });

    const { fetchImpl } = linearMock([
      { id: "li-7", identifier: "P7", state: { id: "ls-x", name: "Weird", type: "mystery" } },
    ]);
    const result = await runInboundForTeam(db(), seed.teamId, { fetchImpl });
    expect(result.applied).toEqual([]);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].payload.reason).toMatch(/unresolvable/i);
    expect((await readTask(taskId)).status).toBe("ready");
    expect((await readLink(seed.teamId, "P7")).last_error).toMatch(/unresolvable/i);
  });

  it("outbound projection populates the exact brain-status baseline the inbound check depends on", async () => {
    // Round-3 review verification #3 (outbound half; the adopt half is asserted below).
    const seed = await seedTeam();
    await seedLinearPrimary(seed);
    const project = await seedProject(seed.teamId);
    await db()
      .from("tasks")
      .insert({ team_id: seed.teamId, project_id: project, row_key: "N1", title: "N1", status: "in_progress", origin: "ui" });

    const { fetchImpl } = linearMock([]);
    const { reports } = await projectAllTasks(db(), seed.teamId, project, { fetchImpl, throttleMs: 0 });
    expect(reports.map((r) => r.status)).toEqual(["synced"]);
    expect((await readLink(seed.teamId, "N1")).last_projected_brain_status).toBe("in_progress");
  });

  it("does nothing without the per-team opt-in (config.inboundApply)", async () => {
    const seed = await seedTeam();
    await seedLinearPrimary(seed, { teamId: "team-uuid" }); // no inboundApply
    const project = await seedProject(seed.teamId);
    const taskId = await seedLinkedTask(seed, project, { rowKey: "P8", resourceId: "li-8", status: "ready", lastProjected: "Todo" });

    const { fetchImpl } = linearMock([issue("li-8", "ls-done", { identifier: "P8" })]);
    const result = await runInboundForTeam(db(), seed.teamId, { fetchImpl });
    expect(result.enabled).toBe(false);
    expect(result.reason).toMatch(/not enabled/i);
    expect(result.applied).toEqual([]);
    expect((await readTask(taskId)).status).toBe("ready");
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0); // never touches the provider
  });
});

describe("inbound adopt — Linear-native issues become owned team-tier tasks (real Postgres)", () => {
  // Mimic what runLinearIngestion creates for a Linear-native issue: a mirror task, no link.
  async function seedMirrorTask(seed: Seed, projectId: string, rowKey: string, status = "in_progress", parentRowKey: string | null = null) {
    const { data } = await db()
      .from("tasks")
      .insert({
        team_id: seed.teamId,
        project_id: projectId,
        row_key: rowKey,
        title: `Native ${rowKey}`,
        status,
        origin: "sync",
        parent_row_key: parentRowKey,
      })
      .select("id")
      .single();
    return (data as { id: string }).id;
  }

  it("adopts: backfills the link + footer, flips origin to 'ui', seeds body, and never duplicates", async () => {
    const seed = await seedTeam();
    await seedLinearPrimary(seed);
    const mirror = await seedProject(seed.teamId, "linear-eng");
    const taskId = await seedMirrorTask(seed, mirror, "ENG-1");

    const native = issue("li-n1", "ls-started", {
      identifier: "ENG-1",
      title: "Native ENG-1",
      description: "A Linear-authored description",
      url: "https://linear.app/li-n1",
    });
    const first = linearMock([native]);
    const r1 = await runInboundForTeam(db(), seed.teamId, { fetchImpl: first.fetchImpl });
    expect(r1.adopted).toEqual(["ENG-1"]);

    const link = await readLink(seed.teamId, "ENG-1");
    expect(link.provider_resource_id).toBe("li-n1");
    expect(link.last_projected_status).toBe("In Progress");
    expect(link.last_projected_brain_status).toBe("in_progress"); // review verification #3 (adopt half)
    expect(link.projection_fingerprint).toBeTruthy();

    const task = await readTask(taskId);
    expect(task.origin).toBe("ui"); // survives the next ingest diff-delete
    expect(task.body).toBe("A Linear-authored description"); // one-time ownership seed

    // Footer appended to the EXISTING description (nothing wiped), exactly once.
    const footers = first.mutations.filter((m) => m.name === "AdoptFooter");
    expect(footers).toHaveLength(1);
    expect(String(footers[0].variables.description)).toContain("A Linear-authored description");
    expect(String(footers[0].variables.description)).toContain("aios-ext: ENG-1");

    // Re-run: the link's resource id excludes the issue — no duplicate, no second footer write.
    const second = linearMock([native]);
    const r2 = await runInboundForTeam(db(), seed.teamId, { fetchImpl: second.fetchImpl });
    expect(r2.adopted).toEqual([]);
    const { data: links } = await db().from("task_pm_links").select("id").eq("team_id", seed.teamId).eq("row_key", "ENG-1");
    expect(links).toHaveLength(1);
    expect(second.mutations).toEqual([]);

    // Adopt-no-duplicate: the first outbound pass fingerprint-short-circuits (zero mutations).
    const outbound = linearMock([{ ...native, description: String(footers[0].variables.description) }]);
    const { reports } = await projectAllTasks(db(), seed.teamId, mirror, { fetchImpl: outbound.fetchImpl, throttleMs: 0 });
    expect(reports.map((r) => r.status)).toEqual(["skipped"]);
    expect(outbound.mutations).toEqual([]);
  });

  it("adopts the CURRENT Linear state even when the mirror row is stale", async () => {
    const seed = await seedTeam();
    await seedLinearPrimary(seed);
    const mirror = await seedProject(seed.teamId, "linear-eng");
    const taskId = await seedMirrorTask(seed, mirror, "ENG-2", "ready"); // ingest saw Todo…

    const { fetchImpl } = linearMock([issue("li-n2", "ls-done", { identifier: "ENG-2", description: "" })]); // …board moved to Done
    await runInboundForTeam(db(), seed.teamId, { fetchImpl });
    expect((await readTask(taskId)).status).toBe("done");
    expect((await readLink(seed.teamId, "ENG-2")).last_projected_brain_status).toBe("done");
  });

  it("no destination: a missing mirror task fails soft (skip + surfaced reason, no insert)", async () => {
    const seed = await seedTeam();
    await seedLinearPrimary(seed);
    await seedProject(seed.teamId, "linear-eng"); // project exists, but ingest hasn't created the task

    const { fetchImpl } = linearMock([issue("li-n3", "ls-started", { identifier: "ENG-3", description: "" })]);
    const result = await runInboundForTeam(db(), seed.teamId, { fetchImpl });
    expect(result.adopted).toEqual([]);
    expect(result.skipped.some((s) => s.includes("ENG-3"))).toBe(true);
    const { data: links } = await db().from("task_pm_links").select("id").eq("team_id", seed.teamId);
    expect(links ?? []).toHaveLength(0);
  });

  it("no destination: an integration without teamId fails soft with a surfaced reason", async () => {
    const seed = await seedTeam();
    await seedLinearPrimary(seed, { inboundApply: true }); // no teamId
    const result = await runInboundForTeam(db(), seed.teamId, { fetchImpl: linearMock([]).fetchImpl });
    expect(result.reason).toMatch(/teamId/);
    expect(result.adopted).toEqual([]);
    expect(result.applied).toEqual([]);
  });

  it("tier safety is structural: access_tier has no admin value; adopt is team-tier by construction", async () => {
    const { rows } = await runSql<{ v: string }>(
      `select unnest(enum_range(null::access_tier))::text as v`,
      []
    );
    expect(rows.map((r) => r.v).sort()).toEqual(["external", "team"]);
  });
});
