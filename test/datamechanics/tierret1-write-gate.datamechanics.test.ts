import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { db, ingest, seedTeam, type Seed } from "./helpers";

/**
 * TIERRET-1 / AIO-1045 — code review 1 HIGH-1 (Astra adjudication, code-review1.decisions.md).
 *
 * Spec: "new read visibility … must never be used to authorize a write"; the exclusions forbid new
 * write permissions. The member READ rule widened, so the board now hands an external collaborator
 * the database ids of team-audience and hand-entered rows it could never reach before — and the
 * board's drag/edit controls call `moveTaskAction`/`updateTaskAction`, which used to check only team
 * membership and then schedule a PM projection via `after()`. The decisions page does the same for an
 * external lead's validity toggle.
 *
 * Contract (derived from the adjudication, not the implementation): an edit is allowed exactly when
 * the PRE-TIERRET row predicate admitted the row — posture label ceiling, sourced row → its source
 * item membership-visible, hand-entered row → `created_by` at team posture. A refused call answers
 * exactly like an absent row, writes nothing (fields and `updated_at` unchanged) and schedules NO
 * projection. Previously editable rows (an external member's external-audience sourced row in an
 * ungranted container; a team-posture member's hand-entered row) still succeed. Hidden, foreign and
 * substrate-error cases deny.
 *
 * The actions run unchanged against the real test Postgres; only their request-context modules are
 * stood in for: the session (`currentMember` → the members row + production posture resolver),
 * `serverClient` (→ the service-role test DB) and `after()` (captured, NEVER run — no PM call).
 */

const h = vi.hoisted(() => ({
  memberId: "",
  afterCbs: [] as Array<() => Promise<void> | void>,
  /** When set, every read of this table through adminClient() fails (a substrate error). */
  failTable: "",
}));

vi.mock("@/lib/db/admin", async (orig) => {
  const actual = (await orig()) as { adminClient: () => { from: (t: string) => unknown } & object };
  const failure = { data: null, error: { message: "injected substrate failure" } };
  const failingChain = (): unknown => {
    const chain: Record<string, unknown> = {};
    for (const m of ["select", "eq", "neq", "in", "is", "not", "order", "limit"]) chain[m] = () => chain;
    chain.maybeSingle = () => Promise.resolve(failure);
    chain.single = () => Promise.resolve(failure);
    chain.then = (resolve: (v: unknown) => void) => resolve(failure);
    return chain;
  };
  return {
    ...actual,
    adminClient: () => {
      const real = actual.adminClient();
      if (!h.failTable) return real;
      // Only `.from(<failTable>)` is faulted; every other member of the real client is untouched.
      return new Proxy(real, {
        get: (target, prop) => {
          if (prop === "from") return (t: string) => (t === h.failTable ? failingChain() : target.from(t));
          const v = Reflect.get(target, prop);
          return typeof v === "function" ? v.bind(target) : v;
        },
      });
    },
  };
});
vi.mock("@/lib/db/server", () => ({
  serverClient: async () => (await import("@/lib/db/admin")).adminClient(),
}));
// The session guard, minus the cookie: the SAME active same-team members-row lookup and the SAME
// posture resolver the production `currentMember` uses.
vi.mock("@/lib/auth/guard", () => ({
  currentMember: async (teamId: string) => {
    if (!h.memberId) return null;
    const { adminClient } = await import("@/lib/db/admin");
    const { data } = await adminClient()
      .from("members")
      .select("id, role")
      .eq("team_id", teamId)
      .eq("id", h.memberId)
      .eq("status", "active")
      .maybeSingle();
    if (!data) return null;
    const { resolveViewerPosture } = await import("@/lib/access/posture");
    const tier = await resolveViewerPosture(adminClient(), teamId, h.memberId);
    return { id: h.memberId, role: (data as { role: string }).role, tier, userId: "u" };
  },
}));
vi.mock("next/server", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, after: (cb: () => Promise<void> | void) => h.afterCbs.push(cb) };
});

const { moveTaskAction, updateTaskAction } = await import("@/app/actions/tasks");
const { setDecisionValidityAction } = await import("@/app/actions/decisions");
const { createMember } = await import("@/lib/admin/members");
const { createGroup, addMemberToGroup, grantProjectToGroup } = await import("@/lib/access/groups");
const { ensureAccessBootstrap } = await import("@/lib/access/bootstrap");
const { backfillTeamContext } = await import("@/lib/projects/context/backfill");
const { visibleItemIds } = await import("@/lib/access/enforce");
const { resolveContentView, provenanceCtxFor, contentLabelTier } = await import("@/lib/access/admission");
const { boardTaskWindow } = await import("@/lib/access/structured-windows");

const now = () => new Date().toISOString();

interface Fx {
  seed: Seed; // seed.memberId: team-posture (builtin Everyone) ADMIN — the "normal Everyone" writer
  srcId: string; // the ingest container — granted to NO custom group
  X: string; // initiative granted to the clients group
  external: string; // external-posture human (builtin External only), in clients → X; role member
  externalLead: string; // same shape, role lead
  task: Record<string, string>; // row_key → id
  decision: Record<string, string>;
}

async function mkInitiative(seed: Seed, slug: string): Promise<string> {
  const { data, error } = await db()
    .from("projects")
    .insert({ team_id: seed.teamId, slug: `${slug}-${randomUUID().slice(0, 6)}`, name: slug, kind: "initiative" })
    .select("id")
    .single();
  expect(error).toBeNull();
  return (data as { id: string }).id;
}

/** Fixture-only custom placement (spec AC-01: custom placements use fixture membership writes). */
async function moveMembership(seed: Seed, itemId: string, projectId: string): Promise<void> {
  const { data: unit } = await db().from("project_context_units").select("id").eq("source_item_id", itemId).single();
  await db().from("project_context_memberships").update({ valid_to: now() }).eq("context_unit_id", (unit as { id: string }).id).is("valid_to", null);
  const { error } = await db().from("project_context_memberships").insert({
    team_id: seed.teamId,
    project_id: projectId,
    context_unit_id: (unit as { id: string }).id,
    method: "manual",
  });
  expect(error).toBeNull();
}

async function externalHuman(seed: Seed, role: "member" | "lead", group: string): Promise<string> {
  const m = await createMember(db(), seed.teamId, {
    email: `${randomUUID()}@test.local`,
    displayName: `Collaborator ${role}`,
    actorHandle: `c-${randomUUID().slice(0, 8)}`,
    role,
    tier: "external",
  });
  await db().from("members").update({ status: "active" }).eq("id", m.id).eq("team_id", seed.teamId);
  expect((await addMemberToGroup(db(), seed.teamId, group, m.id, seed.memberId)).ok).toBe(true);
  return m.id;
}

async function buildFixture(): Promise<Fx> {
  const seed = await seedTeam();
  await db().from("members").update({ role: "admin" }).eq("id", seed.memberId);
  await backfillTeamContext(db(), seed.teamId);
  const x = await ingest(seed, { path: "x.md", body: "x doc", access: "team", project: "src" });
  const y = await ingest(seed, { path: "y.md", body: "y doc", access: "team", project: "src" });
  await backfillTeamContext(db(), seed.teamId);
  const boot = await ensureAccessBootstrap(db(), seed.teamId);
  expect(boot.ok, boot.error).toBe(true);
  const X = await mkInitiative(seed, "x");
  const Y = await mkInitiative(seed, "y");
  await moveMembership(seed, x.id, X);
  await moveMembership(seed, y.id, Y);
  const srcId = x.projectId!;

  const g = await createGroup(db(), seed.teamId, `clients-${randomUUID().slice(0, 6)}`, "Clients X", seed.memberId);
  expect(g.ok, g.error).toBe(true);
  expect((await grantProjectToGroup(db(), seed.teamId, X, g.groupId!, seed.memberId)).ok).toBe(true);
  const external = await externalHuman(seed, "member", g.groupId!);
  const externalLead = await externalHuman(seed, "lead", g.groupId!);

  const task: Record<string, string> = {};
  const taskRows = [
    // NEWLY readable for the external members (TIERRET-1), never editable before → must refuse.
    { row_key: "LX-T", project_id: srcId, audience: "team", source_item_id: x.id, created_by: null, origin: "sync" },
    { row_key: "HTX-T", project_id: X, audience: "team", source_item_id: null, created_by: seed.memberId, origin: "ui" },
    { row_key: "HTXE-T", project_id: X, audience: "external", source_item_id: null, created_by: seed.memberId, origin: "ui" },
    // PREVIOUSLY readable+editable by the external members: external audience, source visible
    // through X, container srcId NOT granted to them → must still succeed (no extra container rule).
    { row_key: "LXE-T", project_id: srcId, audience: "external", source_item_id: x.id, created_by: null, origin: "sync" },
    // HIDDEN: external audience but the source item sits in ungranted Y.
    { row_key: "LYE-T", project_id: srcId, audience: "external", source_item_id: y.id, created_by: null, origin: "sync" },
    // The normal Everyone hand-entered row (team posture writer succeeds).
    { row_key: "HTS-T", project_id: srcId, audience: "team", source_item_id: null, created_by: seed.memberId, origin: "ui" },
  ];
  for (const t of taskRows) {
    const { data, error } = await db()
      .from("tasks")
      .insert({ team_id: seed.teamId, title: `${t.row_key} title`, body: `${t.row_key} body`, assignee: "Tester", status: "backlog", ...t })
      .select("id")
      .single();
    expect(error).toBeNull();
    task[t.row_key] = (data as { id: string }).id;
  }

  const decision: Record<string, string> = {};
  const decisionRows = [
    { row_key: "DX-T", project_id: srcId, audience: "team", source_item_id: x.id, created_by: null },
    { row_key: "HDX-T", project_id: X, audience: "team", source_item_id: null, created_by: seed.memberId },
    { row_key: "DXE-T", project_id: srcId, audience: "external", source_item_id: x.id, created_by: null },
    { row_key: "HDS-T", project_id: srcId, audience: "team", source_item_id: null, created_by: seed.memberId },
  ];
  for (const d of decisionRows) {
    const { data, error } = await db()
      .from("decisions")
      .insert({ team_id: seed.teamId, title: `${d.row_key} title`, decided_by: "tester", decided_at: now().slice(0, 10), still_valid: true, ...d })
      .select("id")
      .single();
    expect(error).toBeNull();
    decision[d.row_key] = (data as { id: string }).id;
  }
  return { seed, srcId, X, external, externalLead, task, decision };
}

async function taskRow(id: string): Promise<Record<string, unknown>> {
  const { data } = await db()
    .from("tasks")
    .select("status, raw_status, title, sprint, due_date, parent_row_key, labels, priority, body, updated_at")
    .eq("id", id)
    .single();
  return JSON.parse(JSON.stringify(data));
}

async function decisionRow(id: string): Promise<Record<string, unknown>> {
  const { data } = await db().from("decisions").select("still_valid, updated_at").eq("id", id).single();
  return JSON.parse(JSON.stringify(data));
}

beforeEach(() => {
  h.memberId = "";
  h.afterCbs = [];
  h.failTable = "";
});

describe("TIERRET-1 HIGH-1 — newly READABLE task rows are not newly WRITABLE (real Postgres)", () => {
  it("non-vacuity: the production board path now serves the external member the trigger rows (with ids)", async () => {
    const fx = await buildFixture();
    const vis = await resolveContentView(db(), fx.seed.teamId, fx.external);
    const rows = await boardTaskWindow<{ id: string; row_key: string }>(
      fx.seed.teamId,
      provenanceCtxFor(vis),
      contentLabelTier(vis.admission) === "external"
    );
    const keys = rows.map((r) => r.row_key);
    expect(keys).toEqual(expect.arrayContaining(["LX-T", "HTX-T", "HTXE-T", "LXE-T"]));
    expect(keys).not.toContain("LYE-T");
    expect(rows.every((r) => typeof r.id === "string" && r.id.length > 0), "the board ships row ids to the client").toBe(true);
  });

  it("move: an external member's drag of a newly readable row (sourced team / hand-entered either audience) refuses like an absent task — no write, no projection", async () => {
    const fx = await buildFixture();
    h.memberId = fx.external;
    const absent = await moveTaskAction(randomUUID(), "done");
    expect(absent).toEqual({ ok: false, error: "task not found" });
    for (const key of ["LX-T", "HTX-T", "HTXE-T"]) {
      const before = await taskRow(fx.task[key]);
      const res = await moveTaskAction(fx.task[key], "done");
      expect(res, `${key} must refuse exactly like an absent task`).toEqual(absent);
      expect(await taskRow(fx.task[key]), `${key} must be unchanged (fields + updated_at)`).toEqual(before);
    }
    expect(h.afterCbs.length, "a refused move schedules NO PM projection").toBe(0);
  });

  it("update: the edit dialog's save (incl. a parent probe) refuses a newly readable row identically to an absent one — no write, no projection", async () => {
    const fx = await buildFixture();
    h.memberId = fx.external;
    const absent = await updateTaskAction({ taskId: randomUUID(), title: "hijacked", body: "overwritten", parentRowKey: "GHOST" });
    expect(absent).toEqual({ ok: false, error: "task not found" });
    for (const key of ["LX-T", "HTX-T", "HTXE-T"]) {
      const before = await taskRow(fx.task[key]);
      const res = await updateTaskAction({ taskId: fx.task[key], title: "hijacked", body: "overwritten", parentRowKey: "GHOST" });
      expect(res, `${key} must refuse before parent validation, exactly like an absent task`).toEqual(absent);
      expect(await taskRow(fx.task[key])).toEqual(before);
    }
    expect(h.afterCbs.length).toBe(0);
  });

  it("previously editable rows still succeed: external member on an external-audience sourced row in an UNGRANTED container; team-posture member on a hand-entered row", async () => {
    const fx = await buildFixture();
    // The container-not-granted half: srcId is not in the external member's oracle set — the row's
    // source item is visible only through X. The gate must add no container requirement.
    const granted = await visibleItemIds(db(), { teamId: fx.seed.teamId, memberId: fx.external });
    expect(granted.projectIds).toContain(fx.X);
    expect(granted.projectIds).not.toContain(fx.srcId);

    h.memberId = fx.external;
    expect(await moveTaskAction(fx.task["LXE-T"], "done")).toEqual({ ok: true });
    expect((await taskRow(fx.task["LXE-T"])).status).toBe("done");
    expect(await updateTaskAction({ taskId: fx.task["LXE-T"], title: "renamed by collaborator" })).toEqual({ ok: true });
    expect((await taskRow(fx.task["LXE-T"])).title).toBe("renamed by collaborator");
    expect(h.afterCbs.length, "each authorized write schedules its projection").toBe(2);

    h.afterCbs = [];
    h.memberId = fx.seed.memberId;
    expect(await moveTaskAction(fx.task["HTS-T"], "in_progress")).toEqual({ ok: true });
    expect(await updateTaskAction({ taskId: fx.task["HTS-T"], body: "edited by Everyone member" })).toEqual({ ok: true });
    const t = await taskRow(fx.task["HTS-T"]);
    expect([t.status, t.body]).toEqual(["in_progress", "edited by Everyone member"]);
    expect(h.afterCbs.length).toBe(2);
    // …and the same team-posture member still edits the team-audience hand-entered row in X it could
    // always see (hand-entered + team posture = the old all arm).
    expect(await moveTaskAction(fx.task["HTX-T"], "done")).toEqual({ ok: true });
  });

  it("hidden, foreign and substrate-error cases deny; removing the fault restores the allowed write (negative control)", async () => {
    const fx = await buildFixture();
    h.memberId = fx.external;
    // Hidden: external audience, but the source item is in ungranted Y.
    const hiddenBefore = await taskRow(fx.task["LYE-T"]);
    expect(await moveTaskAction(fx.task["LYE-T"], "done")).toEqual({ ok: false, error: "task not found" });
    expect(await taskRow(fx.task["LYE-T"])).toEqual(hiddenBefore);

    // Foreign: a task in another team — the pre-existing team-membership refusal, nothing written.
    const other = await seedTeam();
    const { data: op } = await db().from("projects").insert({ team_id: other.teamId, slug: `o-${randomUUID().slice(0, 6)}`, name: "o" }).select("id").single();
    const { data: ot } = await db()
      .from("tasks")
      .insert({ team_id: other.teamId, project_id: (op as { id: string }).id, row_key: "F-1", title: "foreign", status: "backlog", origin: "ui", created_by: other.memberId })
      .select("id")
      .single();
    const foreignId = (ot as { id: string }).id;
    const foreignBefore = await taskRow(foreignId);
    const foreign = await moveTaskAction(foreignId, "done");
    expect(foreign.ok).toBe(false);
    expect(await taskRow(foreignId)).toEqual(foreignBefore);

    // Substrate error: the oracle's grant read fails → the source item cannot be proven visible.
    const allowedBefore = await taskRow(fx.task["LXE-T"]);
    h.failTable = "project_groups";
    expect(await moveTaskAction(fx.task["LXE-T"], "done")).toEqual({ ok: false, error: "task not found" });
    expect(await updateTaskAction({ taskId: fx.task["LXE-T"], title: "during outage" })).toEqual({ ok: false, error: "task not found" });
    h.failTable = "";
    expect(await taskRow(fx.task["LXE-T"])).toEqual(allowedBefore);
    expect(h.afterCbs.length).toBe(0);

    expect(await moveTaskAction(fx.task["LXE-T"], "done"), "the same call succeeds once the substrate reads").toEqual({ ok: true });
    expect(h.afterCbs.length).toBe(1);
  });
});

describe("TIERRET-1 HIGH-1 — decision validity toggle keeps its role check AND the old row boundary (real Postgres)", () => {
  it("an external LEAD cannot toggle a newly readable team-sourced or hand-entered decision; refused like an absent decision, unchanged", async () => {
    const fx = await buildFixture();
    h.memberId = fx.externalLead;
    const absent = await setDecisionValidityAction(randomUUID(), false);
    expect(absent).toEqual({ ok: false, error: "decision not found" });
    for (const key of ["DX-T", "HDX-T"]) {
      const before = await decisionRow(fx.decision[key]);
      expect(await setDecisionValidityAction(fx.decision[key], false), key).toEqual(absent);
      expect(await decisionRow(fx.decision[key])).toEqual(before);
    }
    // The previously reachable external-audience sourced decision still toggles.
    expect(await setDecisionValidityAction(fx.decision["DXE-T"], false)).toEqual({ ok: true });
    expect((await decisionRow(fx.decision["DXE-T"])).still_valid).toBe(false);
  });

  it("role is still required (a plain external member is refused by role), and a team-posture admin still toggles", async () => {
    const fx = await buildFixture();
    h.memberId = fx.external;
    const before = await decisionRow(fx.decision["DXE-T"]);
    expect(await setDecisionValidityAction(fx.decision["DXE-T"], false)).toEqual({ ok: false, error: "admins and leads only" });
    expect(await decisionRow(fx.decision["DXE-T"])).toEqual(before);

    h.memberId = fx.seed.memberId;
    expect(await setDecisionValidityAction(fx.decision["HDS-T"], false)).toEqual({ ok: true });
    expect(await setDecisionValidityAction(fx.decision["HDX-T"], false)).toEqual({ ok: true });
    expect((await decisionRow(fx.decision["HDS-T"])).still_valid).toBe(false);
  });

  it("a substrate error denies the toggle (fail closed)", async () => {
    const fx = await buildFixture();
    h.memberId = fx.externalLead;
    const before = await decisionRow(fx.decision["DXE-T"]);
    h.failTable = "project_groups";
    expect(await setDecisionValidityAction(fx.decision["DXE-T"], false)).toEqual({ ok: false, error: "decision not found" });
    h.failTable = "";
    expect(await decisionRow(fx.decision["DXE-T"])).toEqual(before);
  });
});
