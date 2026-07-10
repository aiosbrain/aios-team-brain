import { describe, expect, it } from "vitest";
import { getBrandProfile, saveBrandProfile } from "@/lib/brand/manage";
import { db, seedTeam } from "./helpers";

/**
 * Spec for the Brand Brain on real Postgres (M1). Derived from the product need — one persistent,
 * team-scoped brand config the Social Brain reads before generating/validating content. Proves:
 * save→read roundtrip, upsert keeps exactly one row per team (team_id PK), team scoping (no
 * cross-team leak), and that every save is audited with section keys (not values).
 */
describe("brand_profiles (real Postgres)", () => {
  it("persists a profile and reads it back", async () => {
    const { teamId, memberId } = await seedTeam();
    await saveBrandProfile(
      db(),
      teamId,
      {
        voice: { formality: "formal", prohibitedPhrases: ["synergy"] },
        knowledge: { products: ["AIOS"], roadmapVisibility: "hint" },
        governance: { confidentialTopics: ["unreleased pricing"] },
      },
      { memberId }
    );

    const p = await getBrandProfile(db(), teamId);
    expect(p).toBeTruthy();
    expect(p!.voice.formality).toBe("formal");
    expect(p!.voice.prohibitedPhrases).toEqual(["synergy"]);
    expect(p!.knowledge.products).toEqual(["AIOS"]);
    expect(p!.governance.confidentialTopics).toEqual(["unreleased pricing"]);
    expect(p!.updated_at).toBeTruthy();
  });

  it("upserts in place — a second save replaces, never duplicates", async () => {
    const { teamId, memberId } = await seedTeam();
    await saveBrandProfile(db(), teamId, { voice: { humor: "dry" } }, { memberId });
    await saveBrandProfile(db(), teamId, { voice: { humor: "bold" }, knowledge: { positioning: "the team brain" } }, { memberId });

    const { data, count } = await db()
      .from("brand_profiles")
      .select("team_id", { count: "exact", head: true })
      .eq("team_id", teamId);
    void data;
    expect(count).toBe(1);

    const p = await getBrandProfile(db(), teamId);
    expect(p!.voice.humor).toBe("bold");
    expect(p!.knowledge.positioning).toBe("the team brain");
  });

  it("scopes to the team — another team's profile is not visible", async () => {
    const a = await seedTeam();
    const b = await seedTeam();
    await saveBrandProfile(db(), a.teamId, { voice: { formality: "casual" } }, { memberId: a.memberId });

    expect(await getBrandProfile(db(), b.teamId)).toBeNull();
    expect((await getBrandProfile(db(), a.teamId))!.voice.formality).toBe("casual");
  });

  it("audits every save with section keys, never values", async () => {
    const { teamId, memberId } = await seedTeam();
    await saveBrandProfile(db(), teamId, { voice: { prohibitedPhrases: ["secret sauce"] } }, { memberId });

    const { data } = await db()
      .from("audit_log")
      .select("action, target_type, meta")
      .eq("team_id", teamId)
      .eq("action", "brand.updated")
      .maybeSingle();
    expect(data).toBeTruthy();
    expect(data.target_type).toBe("brand_profile");
    expect(data.meta.voiceKeys).toContain("prohibitedPhrases");
    // The audit records keys, never the phrase itself.
    expect(JSON.stringify(data.meta)).not.toContain("secret sauce");
  });
});
