import { describe, expect, it } from "vitest";
import { addBrandAsset, listBrandAssets, removeBrandAsset } from "@/lib/brand/assets";
import { db, seedTeam } from "./helpers";

/**
 * Spec for the brand assets library on real Postgres. Derived from intent: a team maintains a
 * reference library the Brand Brain uses; assets persist, list newest-first, are team-scoped, and
 * removable — every mutation audited.
 */
describe("brand_assets (real Postgres)", () => {
  it("adds, lists (newest first), and removes assets", async () => {
    const { teamId, memberId } = await seedTeam();
    const a = await addBrandAsset(db(), teamId, { kind: "url", label: "Site", url: "https://aios.dev" }, { memberId });
    await addBrandAsset(db(), teamId, { kind: "reference", label: "Tone example", notes: "emulate" }, { memberId });

    let assets = await listBrandAssets(db(), teamId);
    expect(assets.length).toBe(2);
    expect(assets[0].label).toBe("Tone example"); // newest first
    expect(assets.find((x) => x.id === a.id)!.url).toBe("https://aios.dev");

    await removeBrandAsset(db(), teamId, a.id, { memberId });
    assets = await listBrandAssets(db(), teamId);
    expect(assets.length).toBe(1);
    expect(assets[0].kind).toBe("reference");
  });

  it("scopes assets to the team", async () => {
    const a = await seedTeam();
    const b = await seedTeam();
    await addBrandAsset(db(), a.teamId, { kind: "url", label: "A site", url: "https://a.com" }, { memberId: a.memberId });
    expect(await listBrandAssets(db(), b.teamId)).toEqual([]);
  });

  it("audits an add with kind + label", async () => {
    const { teamId, memberId } = await seedTeam();
    await addBrandAsset(db(), teamId, { kind: "url", label: "Blog", url: "https://blog.aios.dev" }, { memberId });
    const { data } = await db()
      .from("audit_log")
      .select("action, meta")
      .eq("team_id", teamId)
      .eq("action", "brand.asset_added")
      .maybeSingle();
    expect(data).toBeTruthy();
    expect(data.meta.kind).toBe("url");
    expect(data.meta.label).toBe("Blog");
  });
});
