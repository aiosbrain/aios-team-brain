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

  it("schema: a cross-team membership edge is unrepresentable (composite FK)", async () => {
    const seedA = await seedTeam();
    const seedB = await seedTeam();
    const itemA = await ingest(seedA, { path: "a.md", body: "a", access: "team", project: "src" });
    const uA = await reconcileItemUnit(db(), seedA.teamId, itemA.id);
    await ensureAccessBootstrap(db(), seedB.teamId);
    const sysB = await systemProjectIds(seedB);
    // team A's unit into team B's project, tagged team A — the composite FK on project must reject.
    const { error } = await db().from("project_context_memberships").insert({
      team_id: seedA.teamId,
      project_id: sysB.general,
      context_unit_id: uA.unitId!,
    });
    expect(error, "composite FK must reject a cross-team membership").not.toBeNull();
  });
});
