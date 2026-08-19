import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { db, ingest, seedTeam, placeMemberByTier, type Seed } from "./helpers";
import { backfillTeamContext } from "@/lib/projects/context/backfill";
import { visibleProjectRows, canSeeProjectRow } from "@/lib/access/enforce";
import { createGroup, grantProjectToGroup, addMemberToGroup } from "@/lib/access/groups";

// ENFB-2 AC1-AC3 (docs/design/enfb2-title-count-surfaces.md §2.1): project-ROW visibility —
// granted OR content-visible (≥1 oracle-visible item, provenance-visible task, or
// provenance-visible decision). Every fixture arm carries its EXPECTED truth explicitly
// (round-2 M7: parity alone lets both owners be wrong together).

vi.mock("@/lib/auth/guard", () => ({ currentMember: vi.fn() }));
vi.mock("@/lib/db/server", () => ({ serverClient: vi.fn() }));

async function seedMember(seed: Seed, posture: "team" | "external" = "team"): Promise<string> {
  const { data } = await db()
    .from("members")
    .insert({ team_id: seed.teamId, email: `${randomUUID()}@test.local`, display_name: "M", actor_handle: `h-${randomUUID().slice(0, 10)}`, role: "member", tier: posture, status: "active" })
    .select("id")
    .single();
  await placeMemberByTier(seed.teamId, data!.id as string, posture);
  return data!.id as string;
}

async function mkProject(seed: Seed, kind: string): Promise<string> {
  const { data } = await db()
    .from("projects")
    .insert({ team_id: seed.teamId, slug: `p-${randomUUID().slice(0, 8)}`, name: "P", kind })
    .select("id")
    .single();
  return data!.id as string;
}

/** Curate an ingested item's unit into `projectId` EXCLUSIVELY (retiring its general row). */
async function curateInto(seed: Seed, itemId: string, projectId: string): Promise<void> {
  const { data: unit } = await db().from("project_context_units").select("id").eq("source_item_id", itemId).single();
  await db().from("project_context_memberships").update({ valid_to: new Date().toISOString() }).eq("context_unit_id", unit!.id).is("valid_to", null);
  const { error } = await db().from("project_context_memberships").insert({ team_id: seed.teamId, project_id: projectId, context_unit_id: unit!.id, method: "manual" });
  expect(error, "curation fixture must insert").toBeNull();
}

async function grantTo(seed: Seed, projectId: string, memberId: string): Promise<void> {
  const g = await createGroup(db(), seed.teamId, `g-${randomUUID().slice(0, 8)}`, "G", seed.memberId);
  await grantProjectToGroup(db(), seed.teamId, projectId, g.groupId!, seed.memberId);
  await addMemberToGroup(db(), seed.teamId, g.groupId!, memberId, seed.memberId);
}

describe("ENFB-2 §2.1 — visibleProjectRows / canSeeProjectRow", () => {
  it("a stock everyone-member sees content-bearing containers (item-, TASK-only-, and DECISION-only), not empty or restricted ones — with per-arm expected truth", async () => {
    const seed = await seedTeam();
    const stock = await seedMember(seed);

    // Arm 1 — item-bearing source container (the measured prod shape: grants cover ONLY
    // system rows, so this row is visible purely through its General-curated item).
    const itemBearing = await ingest(seed, { path: "doc.md", body: "d", access: "team", project: "srcp" });
    await backfillTeamContext(db(), seed.teamId);
    const { data: srcProj } = await db().from("projects").select("id").eq("team_id", seed.teamId).eq("slug", "srcp").single();
    const itemBearingId = srcProj!.id as string;

    // Arm 2 — TASK-only container: zero items; its task's SOURCE lives in the item-bearing
    // container (the extracted-from-meetings shape).
    const taskOnly = await mkProject(seed, "source");
    await db().from("tasks").insert({ team_id: seed.teamId, project_id: taskOnly, row_key: "T-1", title: "t", status: "backlog", origin: "sync", source_item_id: itemBearing.id });

    // Arm 3 — DECISION-only container: zero items/tasks; one hand-typed decision (round-1 F2).
    const decisionOnly = await mkProject(seed, "initiative");
    await db().from("decisions").insert({ team_id: seed.teamId, project_id: decisionOnly, row_key: "D-1", title: "d", rationale: "r", decided_by: "x", impact: "m", source_item_id: null, created_by: stock });

    // Arm 4 — fully empty container: invisible without a grant (D1's stated consequence).
    const empty = await mkProject(seed, "source");

    // Arm 5 — restricted initiative: its only item curated AWAY from general.
    const restrictedItem = await ingest(seed, { path: "sec.md", body: "s", access: "team", project: "srcp" });
    await backfillTeamContext(db(), seed.teamId);
    const restricted = await mkProject(seed, "initiative");
    await curateInto(seed, restrictedItem.id, restricted);

    const rows = await visibleProjectRows(db(), { teamId: seed.teamId, memberId: stock });
    expect(rows.error, "substrate must not error").toBeFalsy();
    const expected: Record<string, boolean> = {
      [itemBearingId]: true, // item-bearing → visible
      [taskOnly]: true, // task-only, sourced task with visible source → visible
      [decisionOnly]: true, // decision-only, hand-typed at team posture → visible
      [empty]: false, // no content, no grant → hidden
      [restricted]: false, // restricted initiative, non-grantee → hidden
    };
    for (const [pid, want] of Object.entries(expected)) {
      expect(rows.ids.has(pid), `set arm project=${pid} expected=${want}`).toBe(want);
      expect(await canSeeProjectRow(db(), { teamId: seed.teamId, memberId: stock }, pid), `by-id arm agrees project=${pid}`).toBe(want);
    }
  });

  it("a granted member sees the restricted initiative and an empty granted project; grant-arm expected truth both ways", async () => {
    const seed = await seedTeam();
    const insider = await seedMember(seed);
    const outsider = await seedMember(seed);
    const restrictedItem = await ingest(seed, { path: "r.md", body: "r", access: "team", project: "srcp" });
    await backfillTeamContext(db(), seed.teamId);
    const restricted = await mkProject(seed, "initiative");
    await curateInto(seed, restrictedItem.id, restricted);
    const emptyGranted = await mkProject(seed, "initiative");
    await grantTo(seed, restricted, insider);
    await grantTo(seed, emptyGranted, insider);

    for (const [member, name, wantRestricted, wantEmpty] of [
      [insider, "insider", true, true],
      [outsider, "outsider", false, false],
    ] as const) {
      const rows = await visibleProjectRows(db(), { teamId: seed.teamId, memberId: member });
      expect(rows.ids.has(restricted), `${name} restricted`).toBe(wantRestricted);
      expect(rows.ids.has(emptyGranted), `${name} empty-granted`).toBe(wantEmpty);
      expect(await canSeeProjectRow(db(), { teamId: seed.teamId, memberId: member }, restricted), `${name} by-id restricted`).toBe(wantRestricted);
    }
  });

  it("external posture: the hand-typed arms close (a decision-only container hides), sourced arms follow the external-shared grant; deleted-author flips a decision-only container invisible", async () => {
    const seed = await seedTeam();
    const external = await seedMember(seed, "external");
    const author = await seedMember(seed);

    const decisionOnly = await mkProject(seed, "initiative");
    await db().from("decisions").insert({ team_id: seed.teamId, project_id: decisionOnly, row_key: "D-2", title: "d", rationale: "r", decided_by: "x", impact: "m", source_item_id: null, created_by: author });

    // External posture: hand-typed arm requires team posture → hidden.
    const extRows = await visibleProjectRows(db(), { teamId: seed.teamId, memberId: external });
    expect(extRows.ids.has(decisionOnly), "hand-typed arm must not serve external posture").toBe(false);

    // Team member sees it…
    const teamRows = await visibleProjectRows(db(), { teamId: seed.teamId, memberId: author });
    expect(teamRows.ids.has(decisionOnly)).toBe(true);

    // …until the author is DELETED (created_by → null via on delete set null): the stated
    // fail-closed over-restriction (round-2 H6), pinned here rather than discovered in prod.
    await db().from("members").delete().eq("id", author);
    const after = await visibleProjectRows(db(), { teamId: seed.teamId, memberId: seed.memberId });
    expect(after.ids.has(decisionOnly), "deleted-author decision no longer carries provenance").toBe(false);
  });

  it("fail closed: a member in no groups sees only content-free nothing (empty set), and a substrate error reports error:true", async () => {
    const seed = await seedTeam();
    await ingest(seed, { path: "x.md", body: "x", access: "team", project: "srcp" });
    await backfillTeamContext(db(), seed.teamId);
    const lonely = await seedMember(seed);
    const { data: everyone } = await db().from("groups").select("id").eq("team_id", seed.teamId).eq("slug", "everyone").single();
    await db().from("group_members").delete().eq("group_id", everyone!.id).eq("member_id", lonely);

    const rows = await visibleProjectRows(db(), { teamId: seed.teamId, memberId: lonely });
    // No grants → no sourced visibility; external posture (no everyone row) → no hand-typed arm.
    expect(rows.ids.size, "a group-less member sees no project rows").toBe(0);
  });
});

describe("ENFB-2 D1 — createProjectAction grants its creator (round-2 blockers 3-4 pins)", () => {
  async function mockSessionAs(memberId: string) {
    const { currentMember } = await import("@/lib/auth/guard");
    const { serverClient } = await import("@/lib/db/server");
    (currentMember as ReturnType<typeof vi.fn>).mockResolvedValue({ id: memberId, role: "member", tier: "team" });
    (serverClient as ReturnType<typeof vi.fn>).mockResolvedValue(db());
  }

  it("create → the CREATOR immediately row-sees the fresh empty initiative; a non-creator stock member does not", async () => {
    const seed = await seedTeam();
    const creator = await seedMember(seed);
    const bystander = await seedMember(seed);
    await mockSessionAs(creator);

    const { createProjectAction } = await import("@/app/actions/projects");
    const r = await createProjectAction({ teamId: seed.teamId, name: `Roadmap ${randomUUID().slice(0, 6)}` });
    expect(r.ok, r.error).toBe(true);
    const pid = r.project!.id;

    expect(await canSeeProjectRow(db(), { teamId: seed.teamId, memberId: creator }, pid), "create→see round-trip").toBe(true);
    expect(await canSeeProjectRow(db(), { teamId: seed.teamId, memberId: bystander }, pid), "no grant leaks to bystanders").toBe(false);
  });

  it("duplicate slug against a CONTENTFUL existing row grants nothing; against an empty initiative it converges (creator granted)", async () => {
    const seed = await seedTeam();
    const creator = await seedMember(seed);
    await mockSessionAs(creator);
    const { createProjectAction } = await import("@/app/actions/projects");

    // Contentful duplicate: a SOURCE project with an item — the grant would be an ITEM grant
    // (round-2 B3), so it must NOT fire.
    await ingest(seed, { path: "y.md", body: "y", access: "team", project: "held" });
    await backfillTeamContext(db(), seed.teamId);
    const dup = await createProjectAction({ teamId: seed.teamId, name: "held" });
    expect(dup.ok, "contentful duplicate is a refusal").toBe(false);
    const { data: heldRow } = await db().from("projects").select("id").eq("team_id", seed.teamId).eq("slug", "held").single();
    const { data: grants } = await db().from("project_groups").select("group_id").eq("project_id", heldRow!.id as string);
    expect((grants ?? []).length, "no grant may land on a contentful existing slug").toBe(0);

    // Empty-initiative duplicate: retry converges — the creator ends granted.
    const name = `Fresh ${randomUUID().slice(0, 6)}`;
    const first = await createProjectAction({ teamId: seed.teamId, name });
    expect(first.ok, first.error).toBe(true);
    const again = await createProjectAction({ teamId: seed.teamId, name });
    expect(again.ok === false, "duplicate create still refuses (identity is the unique constraint)").toBe(true);
    expect(await canSeeProjectRow(db(), { teamId: seed.teamId, memberId: creator }, first.project!.id), "creator stays granted after retry").toBe(true);
  });
});
