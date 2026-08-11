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

describe("accessChanged threads through the heal-access path (Fable HIGH-1 mechanism)", () => {
  it("a same-body re-push with a different tier returns status:unchanged AND accessChanged:true", async () => {
    const { ingestItem } = await import("@/lib/ingest");
    const { randomUUID, createHash } = await import("node:crypto");
    const seed = await seedTeam();
    const body = "heal me";
    const sha = createHash("sha256").update(body).digest("hex");
    const auth = { teamId: seed.teamId, memberId: seed.memberId, apiKeyId: randomUUID() };
    const payload = { project: "src", kind: "deliverable" as const, actor: "t", frontmatter: {}, path: "heal.md", body, content_sha256: sha };

    const first = await ingestItem(db(), auth, payload, "team");
    expect(first.status).toBe("created");
    // Same body, tier flips team→external: the heal-access path patches access but returns unchanged.
    const healed = await ingestItem(db(), auth, payload, "external");
    expect(healed.status).toBe("unchanged");
    expect(healed.accessChanged, "the hook keys on THIS to re-partition a tier flip that looks unchanged").toBe(true);
  });
});

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

  it("refuses to partition into a slug-squatting INITIATIVE — resolves system by kind, not slug alone (Fable HIGH)", async () => {
    const seed = await seedTeam();
    // BOTH system slugs squatted by dashboard-created initiatives BEFORE bootstrap runs. Planting
    // both is load-bearing: with only one squatter the resolve returns null anyway (the other slug
    // is missing), so the test would pass even WITHOUT the kind='system' filter — the mutation that
    // exposed this. With both present, only the kind filter keeps the resolve from finding them.
    await db().from("projects").insert({ team_id: seed.teamId, slug: GENERAL_SLUG, name: "curated-g", kind: "initiative" });
    await db().from("projects").insert({ team_id: seed.teamId, slug: EXTERNAL_SHARED_SLUG, name: "curated-x", kind: "initiative" });
    const item = await ingest(seed, { path: "s.md", body: "s", access: "team", project: "src" });
    const r = await reconcileItemContext(db(), seed.teamId, item.id);
    // No kind='system' project exists → resolves null → skipped, never partitions into the squatter.
    expect(r.ok).toBe(true);
    expect(r.skipped).toBe(true);
    const { data: mems } = await db()
      .from("project_context_memberships")
      .select("id")
      .eq("team_id", seed.teamId);
    expect((mems ?? []).length, "must not write a membership into the squatting initiative").toBe(0);
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
