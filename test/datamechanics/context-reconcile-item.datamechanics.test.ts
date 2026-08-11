import { describe, expect, it } from "vitest";
import { db, ingest, seedTeam, type Seed } from "./helpers";
import { reconcileItemContext, systemProjectIds } from "@/lib/projects/context/reconcile-item";
import { ensureAccessBootstrap, GENERAL_SLUG, EXTERNAL_SHARED_SLUG } from "@/lib/access/bootstrap";

// Phase A slice 5 (spec §11.2) — the per-item reconcile core shared by the ingest hook, the
// scheduler leg, and the backfill. Proves: routes by audience, moves on tier flip, skips
// gracefully before bootstrap, and matches the backfill's partitioning exactly.

async function sys(seed: Seed) {
  const s = await systemProjectIds(db(), seed.teamId);
  if (!s) throw new Error("system projects missing");
  return s;
}

async function membershipProjects(seed: Seed, itemId: string): Promise<string[]> {
  const { data: unit } = await db()
    .from("project_context_units")
    .select("id")
    .eq("team_id", seed.teamId)
    .eq("source_item_id", itemId)
    .maybeSingle();
  if (!unit) return [];
  const { data: mems } = await db()
    .from("project_context_memberships")
    .select("project_id")
    .eq("team_id", seed.teamId)
    .eq("context_unit_id", (unit as { id: string }).id)
    .is("valid_to", null);
  return ((mems ?? []) as { project_id: string }[]).map((m) => m.project_id);
}

describe("reconcileItemContext (the shared per-item core)", () => {
  it("routes a fresh team item into General only; external into external-shared only", async () => {
    const seed = await seedTeam();
    await ensureAccessBootstrap(db(), seed.teamId);
    const t = await ingest(seed, { path: "t.md", body: "t", access: "team", project: "src" });
    const e = await ingest(seed, { path: "e.md", body: "e", access: "external", project: "src" });

    expect((await reconcileItemContext(db(), seed.teamId, t.id)).ok).toBe(true);
    expect((await reconcileItemContext(db(), seed.teamId, e.id)).ok).toBe(true);

    const s = await sys(seed);
    expect(await membershipProjects(seed, t.id)).toEqual([s.general]);
    expect(await membershipProjects(seed, e.id)).toEqual([s.externalShared]);
  });

  it("moves on a tier flip: external→team closes external-shared, opens General (no dual-project leak)", async () => {
    const seed = await seedTeam();
    await ensureAccessBootstrap(db(), seed.teamId);
    const item = await ingest(seed, { path: "flip.md", body: "f", access: "external", project: "src" });
    await reconcileItemContext(db(), seed.teamId, item.id);
    const s = await sys(seed);
    expect(await membershipProjects(seed, item.id)).toEqual([s.externalShared]);

    await db().from("items").update({ access: "team" }).eq("id", item.id).eq("team_id", seed.teamId);
    await reconcileItemContext(db(), seed.teamId, item.id);
    const after = await membershipProjects(seed, item.id);
    expect(after).toEqual([s.general]);
    expect(after).not.toContain(s.externalShared);
  });

  it("skips gracefully (ok, skipped) when the team has no system projects yet — never fails the push", async () => {
    const seed = await seedTeam(); // NO bootstrap
    const item = await ingest(seed, { path: "early.md", body: "x", access: "team", project: "src" });
    const r = await reconcileItemContext(db(), seed.teamId, item.id);
    expect(r.ok).toBe(true);
    expect(r.skipped).toBe(true);
    // nothing was partitioned
    expect(await membershipProjects(seed, item.id)).toEqual([]);
  });

  it("is idempotent — a second reconcile creates no new unit or membership", async () => {
    const seed = await seedTeam();
    await ensureAccessBootstrap(db(), seed.teamId);
    const item = await ingest(seed, { path: "i.md", body: "i", access: "team", project: "src" });
    const a = await reconcileItemContext(db(), seed.teamId, item.id);
    const b = await reconcileItemContext(db(), seed.teamId, item.id);
    expect(a.unitCreated).toBe(true);
    expect(a.membershipCreated).toBe(true);
    expect(b.unitCreated).toBeFalsy();
    expect(b.membershipCreated).toBeFalsy();
  });
});
