import { describe, expect, it } from "vitest";
import { db, seedTeam, ingest } from "./helpers";
import { createOpportunity, listVariantsByOpportunity } from "@/lib/social/store";
import { generateForOpportunity } from "@/lib/social/generate";
import type { VariantRow } from "@/lib/social/types";

// Spec (post generation, real Postgres, stubbed model): generation plans an opportunity, drafts each
// variant body in place, advances filled variants to `awaiting_approval`, is idempotent, and the
// dashboard reader groups drafts by opportunity — all tier-scoped (no external leak of team drafts).

const stubDraft = async (v: VariantRow) => `Draft for ${v.platform}`;

async function seedOpp(access: "team" | "external") {
  const seed = await seedTeam();
  const item = await ingest(seed, { path: "src/1.md", body: "a real, substantial deliverable body", access });
  const opp = await createOpportunity(db(), seed.teamId, {
    access,
    sourceType: "arc",
    title: "Shipped a thing",
    summary: "We shipped a thing worth talking about.",
    evidence: [{ itemId: item.id }],
    dedupKey: `arc:test-${access}`,
  });
  return { seed, opp };
}

describe("generateForOpportunity (data-mechanics)", () => {
  it("plans, drafts both variant bodies, and moves them to awaiting_approval", async () => {
    const { seed, opp } = await seedOpp("external");

    const s = await generateForOpportunity(db(), seed.teamId, opp.id, {}, { draft: stubDraft });
    expect(s.planned).toBe(true);
    expect(s.generated).toBe(2); // x + linkedin
    expect(s.variants.map((v) => v.platform).sort()).toEqual(["linkedin", "x"]);
    for (const v of s.variants) {
      expect(v.body).toBe(`Draft for ${v.platform}`);
      expect(v.status).toBe("awaiting_approval");
    }

    // Persisted + grouped by opportunity for the dashboard.
    const byOpp = await listVariantsByOpportunity(db(), seed.teamId, [opp.id], "team");
    const rows = byOpp.get(opp.id) ?? [];
    expect(rows.length).toBe(2);
    expect(rows.every((v) => v.body.trim() && v.status === "awaiting_approval")).toBe(true);
  });

  it("is idempotent — a second run skips already-drafted variants", async () => {
    const { seed, opp } = await seedOpp("external");
    await generateForOpportunity(db(), seed.teamId, opp.id, {}, { draft: stubDraft });

    const again = await generateForOpportunity(db(), seed.teamId, opp.id, {}, { draft: stubDraft });
    expect(again.planned).toBe(false); // plan already existed
    expect(again.generated).toBe(0);
    expect(again.skipped).toBe(2);
  });

  it("re-drafts when force is set", async () => {
    const { seed, opp } = await seedOpp("external");
    await generateForOpportunity(db(), seed.teamId, opp.id, {}, { draft: stubDraft });

    const forced = await generateForOpportunity(db(), seed.teamId, opp.id, {}, {
      draft: async (v) => `NEW ${v.platform}`,
      force: true,
    });
    expect(forced.generated).toBe(2);
    const rows = (await listVariantsByOpportunity(db(), seed.teamId, [opp.id], "team")).get(opp.id) ?? [];
    expect(rows.map((v) => v.body).sort()).toEqual(["NEW linkedin", "NEW x"]);
  });

  it("skips a variant when the drafter returns nothing", async () => {
    const { seed, opp } = await seedOpp("external");
    const s = await generateForOpportunity(db(), seed.teamId, opp.id, {}, {
      draft: async (v) => (v.platform === "x" ? "only x" : null),
    });
    expect(s.generated).toBe(1);
    expect(s.skipped).toBe(1);
  });

  it("team-tier drafts never surface to an external viewer", async () => {
    const { seed, opp } = await seedOpp("team");
    await generateForOpportunity(db(), seed.teamId, opp.id, {}, { draft: stubDraft });

    const externalView = await listVariantsByOpportunity(db(), seed.teamId, [opp.id], "external");
    expect(externalView.get(opp.id) ?? []).toEqual([]); // no cross-tier leak
    const teamView = await listVariantsByOpportunity(db(), seed.teamId, [opp.id], "team");
    expect((teamView.get(opp.id) ?? []).length).toBe(2);
  });
});
