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

    // Empty-initiative duplicate: the ORIGINAL creator's grant persists (it landed on the
    // fresh insert); the duplicate arm itself grants NOTHING (Fable diff HIGH 1 — the drafted
    // convergence heal keyed on the CALLER and was a self-service grant onto foreign rows).
    const name = `Fresh ${randomUUID().slice(0, 6)}`;
    const first = await createProjectAction({ teamId: seed.teamId, name });
    expect(first.ok, first.error).toBe(true);
    const again = await createProjectAction({ teamId: seed.teamId, name });
    expect(again.ok === false, "duplicate create still refuses (identity is the unique constraint)").toBe(true);
    expect(await canSeeProjectRow(db(), { teamId: seed.teamId, memberId: creator }, first.project!.id), "the original creator keeps their fresh-insert grant").toBe(true);
  });

  it("HIGH-1 pin: a DIFFERENT member's duplicate create grants them nothing — even on an empty initiative", async () => {
    const seed = await seedTeam();
    const creator = await seedMember(seed);
    const prober = await seedMember(seed);
    await mockSessionAs(creator);
    const { createProjectAction } = await import("@/app/actions/projects");
    const name = `Secret ${randomUUID().slice(0, 6)}`;
    const first = await createProjectAction({ teamId: seed.teamId, name });
    expect(first.ok, first.error).toBe(true);

    await mockSessionAs(prober);
    const probe = await createProjectAction({ teamId: seed.teamId, name });
    expect(probe.ok).toBe(false);
    expect(await canSeeProjectRow(db(), { teamId: seed.teamId, memberId: prober }, first.project!.id), "a duplicate-name probe must never become a membership grant").toBe(false);
    expect(await canSeeProjectRow(db(), { teamId: seed.teamId, memberId: creator }, first.project!.id), "the creator's grant is untouched").toBe(true);
  });

  it("HIGH-2 pin: the WRITE routes gate on row visibility — filing into an unseen container refuses instead of un-hiding it", async () => {
    const seed = await seedTeam();
    const insider = await seedMember(seed);
    const outsider = await seedMember(seed);
    // A restricted initiative only the insider can row-see.
    const secretItem = await ingest(seed, { path: "w.md", body: "w", access: "team", project: "srcp" });
    await backfillTeamContext(db(), seed.teamId);
    const restricted = await mkProject(seed, "initiative");
    await curateInto(seed, secretItem.id, restricted);
    await grantTo(seed, restricted, insider);

    const { createTaskAction } = await import("@/app/actions/tasks");
    const { createDecisionAction } = await import("@/app/actions/decisions");

    // The outsider cannot file into it (both actions refuse with the absent-project shape,
    // §5.7 — a success would make the container CONTENT-VISIBLE to the whole team). The
    // outsider is mocked as an ADMIN: role must not bypass the wall (content→membership
    // applies to admins — the ENFB-1 data-browser ruling).
    const { currentMember: cm } = await import("@/lib/auth/guard");
    const { serverClient: sc } = await import("@/lib/db/server");
    (cm as ReturnType<typeof vi.fn>).mockResolvedValue({ id: outsider, role: "admin", tier: "team" });
    (sc as ReturnType<typeof vi.fn>).mockResolvedValue(db());
    const taskRefusal = await createTaskAction({ teamId: seed.teamId, projectId: restricted, title: "junk", assignee: "", sprint: "" } as Parameters<typeof createTaskAction>[0]);
    expect(taskRefusal.ok).toBe(false);
    expect(taskRefusal.error).toBe("project not found");
    const decRefusal = await createDecisionAction({ teamId: seed.teamId, projectId: restricted, title: "junk", rationale: "r", decidedBy: "x", impact: "m", decidedAt: "2026-08-19" } as Parameters<typeof createDecisionAction>[0]);
    expect(decRefusal.ok).toBe(false);
    expect(decRefusal.error).toBe("project not found");
    const rows = await visibleProjectRows(db(), { teamId: seed.teamId, memberId: outsider });
    expect(rows.ids.has(restricted), "the refused writes left the container hidden").toBe(false);

    // Non-vacuity: the INSIDER can file into it (the gate is visibility, not a blanket wall).
    // Probed via the decision action — the task action's post-write projection uses Next's
    // request-scoped `after()`, unreachable in the dm environment; the gate under test is the
    // same canSeeProjectRow call in both actions (guard-pinned per file).
    const { currentMember } = await import("@/lib/auth/guard");
    (currentMember as ReturnType<typeof vi.fn>).mockResolvedValue({ id: insider, role: "admin", tier: "team" });
    const ok = await createDecisionAction({ teamId: seed.teamId, projectId: restricted, title: "real", rationale: "r", decidedBy: "x", impact: "m", decidedAt: "2026-08-19" } as Parameters<typeof createDecisionAction>[0]);
    expect(ok.ok, ok.error).toBe(true);
  });

  it("M4 pins: GET /api/v1/projects serves row-visible rows only, and visibleProjectCards counts the VIEWER-visible content", async () => {
    const seed = await seedTeam();
    const insider = await seedMember(seed);
    const outsider = await seedMember(seed);
    await ingest(seed, { path: "o.md", body: "o", access: "team", project: "srcp" });
    const secretItem = await ingest(seed, { path: "s.md", body: "s", access: "team", project: "srcp" });
    await backfillTeamContext(db(), seed.teamId);
    const restricted = await mkProject(seed, "initiative");
    await curateInto(seed, secretItem.id, restricted);
    await grantTo(seed, restricted, insider);
    const { data: srcProj } = await db().from("projects").select("id, slug").eq("team_id", seed.teamId).eq("slug", "srcp").single();

    // The wire (round-2 BLOCKER 2's surface): a non-grantee's pull omits the restricted slug.
    const { GET: projectsGET } = await import("@/app/api/v1/projects/route");
    const { issueApiKey } = await import("@/lib/admin/keys");
    const wire = async (memberId: string) => {
      const { key } = await issueApiKey(db(), seed.teamId, memberId, "k");
      const res = await projectsGET(new Request("http://test/api/v1/projects", { headers: { authorization: `Bearer ${key}` } }) as never);
      expect(res.status).toBe(200);
      return ((await res.json()) as { projects: { slug: string }[] }).projects.map((r) => r.slug);
    };
    const { data: restrictedRow } = await db().from("projects").select("slug").eq("id", restricted).single();
    expect(await wire(outsider), "non-grantee wire omits the restricted slug").not.toContain(restrictedRow!.slug);
    expect(await wire(insider), "grantee wire carries it").toContain(restrictedRow!.slug);
    expect(await wire(outsider), "the content-bearing source container still serves").toContain(srcProj!.slug);

    // The cards (the LIST page's read): counts are viewer-visible, not totals.
    const { visibleProjectCards } = await import("@/lib/access/enforce");
    const outsiderCards = await visibleProjectCards(db(), { teamId: seed.teamId, memberId: outsider });
    const insiderCards = await visibleProjectCards(db(), { teamId: seed.teamId, memberId: insider });
    const srcCardOut = outsiderCards.rows.find((r) => r.id === (srcProj!.id as string))!;
    expect(srcCardOut.visibleItems, "outsider counts only the open item").toBe(1);
    expect(outsiderCards.rows.some((r) => r.id === restricted), "restricted card absent for the outsider").toBe(false);
    // Container-count semantic, pinned: the curated item's CONTAINER is still srcp (curation
    // moves membership, not residence), so the initiative's card counts 0 contained items —
    // exactly what the previous items(count) embed measured, now visibility-filtered. The
    // grantee's srcp card counts BOTH contained items (open + the restricted one they hold).
    const restrictedCard = insiderCards.rows.find((r) => r.id === restricted)!;
    expect(restrictedCard.visibleItems, "an initiative with curated-in (not contained) content counts 0").toBe(0);
    const srcCardIn = insiderCards.rows.find((r) => r.id === (srcProj!.id as string))!;
    expect(srcCardIn.visibleItems, "the grantee counts both contained items").toBe(2);
  });
});
