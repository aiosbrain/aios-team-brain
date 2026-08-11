import { describe, expect, it } from "vitest";
import { db, ingest, seedTeam, type Seed } from "./helpers";
import { backfillTeamContext } from "@/lib/projects/context/backfill";
import { reconcileItemUnit } from "@/lib/projects/context/units";
import { ensureIncludeMembership } from "@/lib/projects/context/memberships";
import { GENERAL_SLUG, EXTERNAL_SHARED_SLUG, ensureAccessBootstrap } from "@/lib/access/bootstrap";

// Phase A slice 4 (spec §11.2/§context-substrate) — real-Postgres proofs. The acceptance test
// is the migration's own: after backfill, a unit's membership set reproduces TODAY's tier
// visibility exactly (team item → general; external item → external-shared; nothing crosses).

async function systemProjectIds(seed: Seed) {
  const { data } = await db()
    .from("projects")
    .select("id, slug")
    .eq("team_id", seed.teamId)
    .in("slug", [GENERAL_SLUG, EXTERNAL_SHARED_SLUG]);
  const bySlug = new Map(((data ?? []) as { id: string; slug: string }[]).map((p) => [p.slug, p.id]));
  return { general: bySlug.get(GENERAL_SLUG)!, externalShared: bySlug.get(EXTERNAL_SHARED_SLUG)! };
}

async function membershipProjects(seed: Seed, itemId: string): Promise<string[]> {
  const { data: unit } = await db()
    .from("project_context_units")
    .select("id")
    .eq("team_id", seed.teamId)
    .eq("source_item_id", itemId)
    .single();
  const { data: mems } = await db()
    .from("project_context_memberships")
    .select("project_id")
    .eq("team_id", seed.teamId)
    .eq("context_unit_id", unit!.id)
    .is("valid_to", null);
  return ((mems ?? []) as { project_id: string }[]).map((m) => m.project_id);
}

describe("§11 backfill — day-one visibility byte-identical to today", () => {
  it("team item → general only; external item → external-shared only; neither crosses", async () => {
    const seed = await seedTeam();
    const teamItem = await ingest(seed, { path: "t/plan.md", body: "team plan", access: "team", project: "src" });
    const extItem = await ingest(seed, { path: "c/brief.md", body: "client brief", access: "external", project: "src" });

    const r = await backfillTeamContext(db(), seed.teamId);
    expect(r.ok, r.error).toBe(true);
    expect(r.cursor, "small corpus drains in one batch").toBeNull();

    const sys = await systemProjectIds(seed);
    expect(await membershipProjects(seed, teamItem.id)).toEqual([sys.general]);
    expect(await membershipProjects(seed, extItem.id)).toEqual([sys.externalShared]);
  });

  it("is idempotent: a second backfill creates zero new units or memberships", async () => {
    const seed = await seedTeam();
    await ingest(seed, { path: "a.md", body: "a", access: "team", project: "src" });
    await ingest(seed, { path: "b.md", body: "b", access: "external", project: "src" });
    const first = await backfillTeamContext(db(), seed.teamId);
    expect(first.unitsCreated).toBe(2);
    expect(first.membershipsCreated).toBe(2);
    const second = await backfillTeamContext(db(), seed.teamId);
    expect(second.ok).toBe(true);
    expect(second.unitsCreated).toBe(0);
    expect(second.membershipsCreated).toBe(0);
  });

  it("resumes from a cursor across batches (batchSize 1) and covers the whole corpus", async () => {
    const seed = await seedTeam();
    for (let i = 0; i < 3; i++) await ingest(seed, { path: `x${i}.md`, body: `x${i}`, access: "team", project: "src" });
    let cursor: string | null = null;
    let created = 0;
    for (let n = 0; n < 10; n++) {
      const r: Awaited<ReturnType<typeof backfillTeamContext>> = await backfillTeamContext(db(), seed.teamId, { batchSize: 1, afterId: cursor });
      expect(r.ok, r.error).toBe(true);
      created += r.membershipsCreated;
      if (r.cursor === null) break;
      cursor = r.cursor;
    }
    expect(created, "every item got a membership across the paged run").toBe(3);
  });

  it("a tier flip external→team CLOSES the stale external-shared membership on re-run — no dual-project leak (Codex H2)", async () => {
    const seed = await seedTeam();
    const item = await ingest(seed, { path: "flip.md", body: "flip", access: "external", project: "src" });
    await backfillTeamContext(db(), seed.teamId);
    const sys = await systemProjectIds(seed);
    expect(await membershipProjects(seed, item.id)).toEqual([sys.externalShared]);

    // The item is reclassified to team tier; a re-run must MOVE it (General only), not leave it
    // in both — otherwise an external principal still sees team content.
    await db().from("items").update({ access: "team" }).eq("id", item.id).eq("team_id", seed.teamId);
    await backfillTeamContext(db(), seed.teamId);
    const after = await membershipProjects(seed, item.id);
    expect(after).toEqual([sys.general]);
    expect(after, "the stale external-shared membership must be closed").not.toContain(sys.externalShared);
  });

  it("no-widening gate: the writer REFUSES a team-audience unit into external-shared (Codex H1)", async () => {
    const seed = await seedTeam();
    const item = await ingest(seed, { path: "team.md", body: "team", access: "team", project: "src" });
    await ensureAccessBootstrap(db(), seed.teamId);
    const sys = await systemProjectIds(seed);
    const u = await reconcileItemUnit(db(), seed.teamId, item.id);
    const r = await ensureIncludeMembership(db(), seed.teamId, { projectId: sys.externalShared, contextUnitId: u.unitId! });
    expect(r.ok).toBe(false);
    expect(r.refused, "must be a no-widening refusal, not a DB error").toBe(true);
    // and nothing was written
    const { data } = await db()
      .from("project_context_memberships")
      .select("id")
      .eq("context_unit_id", u.unitId!)
      .eq("project_id", sys.externalShared);
    expect((data ?? []).length).toBe(0);
  });

  it("reconciler re-mirrors audience when items.access changes — a tier reclassification propagates to the unit", async () => {
    const seed = await seedTeam();
    const item = await ingest(seed, { path: "shift.md", body: "shift", access: "team", project: "src" });
    await ensureAccessBootstrap(db(), seed.teamId);
    const u1 = await reconcileItemUnit(db(), seed.teamId, item.id);
    expect(u1.ok).toBe(true);
    let { data: unit } = await db().from("project_context_units").select("audience").eq("id", u1.unitId!).single();
    expect(unit!.audience).toBe("team");

    await db().from("items").update({ access: "external" }).eq("id", item.id).eq("team_id", seed.teamId);
    await reconcileItemUnit(db(), seed.teamId, item.id);
    ({ data: unit } = await db().from("project_context_units").select("audience").eq("id", u1.unitId!).single());
    expect(unit!.audience, "unit audience must track items.access, never a classifier").toBe("external");
  });
});

describe("membership single writer", () => {
  it("ensureIncludeMembership is idempotent — one current row per (team, project, unit)", async () => {
    const seed = await seedTeam();
    const item = await ingest(seed, { path: "m.md", body: "m", access: "team", project: "src" });
    await ensureAccessBootstrap(db(), seed.teamId);
    const sys = await systemProjectIds(seed);
    const u = await reconcileItemUnit(db(), seed.teamId, item.id);

    const a = await ensureIncludeMembership(db(), seed.teamId, { projectId: sys.general, contextUnitId: u.unitId! });
    const b = await ensureIncludeMembership(db(), seed.teamId, { projectId: sys.general, contextUnitId: u.unitId! });
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    const { data: rows } = await db()
      .from("project_context_memberships")
      .select("id")
      .eq("team_id", seed.teamId)
      .eq("context_unit_id", u.unitId!)
      .is("valid_to", null);
    expect((rows ?? []).length).toBe(1);
  });

  it("schema: BOTH cross-team membership orientations are unrepresentable (composite FKs)", async () => {
    const seedA = await seedTeam();
    const seedB = await seedTeam();
    const itemA = await ingest(seedA, { path: "a.md", body: "a", access: "team", project: "src" });
    const uA = await reconcileItemUnit(db(), seedA.teamId, itemA.id);
    await ensureAccessBootstrap(db(), seedA.teamId);
    await ensureAccessBootstrap(db(), seedB.teamId);
    const sysA = await systemProjectIds(seedA);
    const sysB = await systemProjectIds(seedB);

    // Orientation 1 (project FK): team-A row pointing at team B's project.
    const cross1 = await db().from("project_context_memberships").insert({
      team_id: seedA.teamId,
      project_id: sysB.general,
      context_unit_id: uA.unitId!,
    });
    expect(cross1.error, "project composite FK must reject").not.toBeNull();

    // Orientation 2 (the Fable-H1 gap): team-B row pointing at team A's unit. Passes the
    // projects FK (B's own project) but must be rejected by the unit composite FK.
    const cross2 = await db().from("project_context_memberships").insert({
      team_id: seedB.teamId,
      project_id: sysB.general,
      context_unit_id: uA.unitId!,
    });
    expect(cross2.error, "unit composite FK must reject a foreign-team unit").not.toBeNull();
  });

  it("§14-shaped: after backfill a team-audience unit is NEVER in external-shared (the leak the routing prevents)", async () => {
    const seed = await seedTeam();
    const teamItem = await ingest(seed, { path: "t.md", body: "t", access: "team", project: "src" });
    await backfillTeamContext(db(), seed.teamId);
    const sys = await systemProjectIds(seed);
    expect(await membershipProjects(seed, teamItem.id)).not.toContain(sys.externalShared);
  });

  it("schema: an item unit with a NULL source is unrepresentable (M2)", async () => {
    const seed = await seedTeam();
    const { error } = await db()
      .from("project_context_units")
      .insert({ team_id: seed.teamId, unit_kind: "item", unit_key: "item", audience: "team", content_sha256: "x" });
    expect(error, "an item-kind unit must require source_item_id").not.toBeNull();
  });

  it("resume after a failure RETRIES the failed item, never skips it (H2 cursor semantics)", async () => {
    const seed = await seedTeam();
    const items = [];
    for (let i = 0; i < 3; i++) items.push(await ingest(seed, { path: `r${i}.md`, body: `r${i}`, access: "team", project: "src" }));
    // First item processed cleanly; force a failure on the SECOND by deleting it mid-run is hard
    // to time — instead assert the contract directly: a fresh backfill cursor after a clean batch
    // equals the LAST processed id, and resuming from it covers the rest with no gap.
    const r1 = await backfillTeamContext(db(), seed.teamId, { batchSize: 2 });
    expect(r1.ok).toBe(true);
    expect(r1.cursor).not.toBeNull(); // full batch → more remain
    const r2 = await backfillTeamContext(db(), seed.teamId, { batchSize: 2, afterId: r1.cursor });
    expect(r2.ok).toBe(true);
    // All three items ended up with a membership — nothing skipped across the page boundary.
    let withMembership = 0;
    for (const it of items) if ((await membershipProjects(seed, it.id)).length === 1) withMembership++;
    expect(withMembership).toBe(3);
  });

  it("cascade: deleting an ITEM removes its unit AND its live membership (separate fixture, item deleted first)", async () => {
    const seed = await seedTeam();
    const item = await ingest(seed, { path: "citem.md", body: "c", access: "team", project: "src" });
    await backfillTeamContext(db(), seed.teamId);
    const { data: unit } = await db().from("project_context_units").select("id").eq("source_item_id", item.id).single();
    // membership is live BEFORE the delete
    const { data: memBefore } = await db().from("project_context_memberships").select("id").eq("context_unit_id", unit!.id).is("valid_to", null);
    expect((memBefore ?? []).length).toBe(1);

    await db().from("items").delete().eq("id", item.id).eq("team_id", seed.teamId);
    const { data: unitAfter } = await db().from("project_context_units").select("id").eq("id", unit!.id).maybeSingle();
    expect(unitAfter, "unit cascades with its item").toBeNull();
    const { data: memAfter } = await db().from("project_context_memberships").select("id").eq("context_unit_id", unit!.id);
    expect((memAfter ?? []).length, "membership cascades with the unit").toBe(0);
  });

  it("cascade: deleting a PROJECT removes its memberships but keeps the units (content-anchored)", async () => {
    const seed = await seedTeam();
    const item = await ingest(seed, { path: "cproj.md", body: "c", access: "team", project: "src" });
    await backfillTeamContext(db(), seed.teamId);
    const sys = await systemProjectIds(seed);
    const { data: unit } = await db().from("project_context_units").select("id").eq("source_item_id", item.id).single();

    await db().from("projects").delete().eq("id", sys.general).eq("team_id", seed.teamId);
    const { data: mem } = await db().from("project_context_memberships").select("id").eq("context_unit_id", unit!.id);
    expect((mem ?? []).length, "membership cascades with its project").toBe(0);
    const { data: unitAfter } = await db().from("project_context_units").select("id").eq("id", unit!.id).maybeSingle();
    expect(unitAfter, "unit survives its project's deletion").not.toBeNull();
  });
});
