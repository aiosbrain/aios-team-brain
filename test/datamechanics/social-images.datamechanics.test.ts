import { describe, expect, it } from "vitest";
import { db, seedTeam, ingest } from "./helpers";
import {
  createOpportunity,
  getContentImage,
  listImageIdsByVariant,
  countImagesSince,
} from "@/lib/social/store";
import { generateForOpportunity } from "@/lib/social/generate";
import { generateImagesForOpportunity } from "@/lib/social/images";
import { getImageDailyCap, setImageDailyCap } from "@/lib/social/settings";
import type { OpportunityRow, VariantRow } from "@/lib/social/types";

// Spec (post images, real Postgres, stubbed provider): images are stored per-variant with the tier
// inherited from the variant, generation respects the per-team daily cap, and team-tier images never
// leak to an external viewer.

const stubImg = async () => ({ mime: "image/png", dataBase64: "aGVsbG8=" }); // "hello"

async function seedDraftedOpp(access: "team" | "external"): Promise<{ teamId: string; opp: OpportunityRow; variants: VariantRow[] }> {
  const seed = await seedTeam();
  const item = await ingest(seed, { path: "src/1.md", body: "a substantial deliverable body", access });
  const opp = await createOpportunity(db(), seed.teamId, {
    access,
    sourceType: "arc",
    title: "Shipped a thing",
    summary: "worth talking about",
    evidence: [{ itemId: item.id }],
    dedupKey: `arc:img-${access}`,
  });
  const g = await generateForOpportunity(db(), seed.teamId, opp.id, {}, { draft: async (v) => `body ${v.platform}` });
  return { teamId: seed.teamId, opp, variants: g.variants };
}

describe("social images (data-mechanics)", () => {
  it("generates one image per variant, tier inherited, retrievable + counted", async () => {
    const { teamId, opp, variants } = await seedDraftedOpp("external");

    const s = await generateImagesForOpportunity(db(), teamId, opp, variants, { generate: stubImg });
    expect(s.created).toBe(2);
    expect(s.capped).toBe(0);

    const idByVariant = await listImageIdsByVariant(db(), teamId, variants.map((v) => v.id), "team");
    expect(idByVariant.size).toBe(2);
    const first = await getContentImage(db(), teamId, idByVariant.get(variants[0].id)!, "team");
    expect(first?.access).toBe("external"); // inherited from the external variant
    expect(first?.data_base64).toBe("aGVsbG8=");

    expect(await countImagesSince(db(), teamId, "1970-01-01T00:00:00.000Z")).toBe(2);
  });

  it("stops at the daily cap — remaining variants are `capped`, not created", async () => {
    const { teamId, opp, variants } = await seedDraftedOpp("external");
    await setImageDailyCap(db(), teamId, 1);

    const s = await generateImagesForOpportunity(db(), teamId, opp, variants, { generate: stubImg });
    expect(s.created).toBe(1);
    expect(s.capped).toBe(1);
    expect(await countImagesSince(db(), teamId, "1970-01-01T00:00:00.000Z")).toBe(1);
  });

  it("skips variants that already have an image (idempotent), force re-generates", async () => {
    const { teamId, opp, variants } = await seedDraftedOpp("external");
    await generateImagesForOpportunity(db(), teamId, opp, variants, { generate: stubImg });

    const again = await generateImagesForOpportunity(db(), teamId, opp, variants, { generate: stubImg });
    expect(again.created).toBe(0);
    expect(again.skipped).toBe(2);

    const forced = await generateImagesForOpportunity(db(), teamId, opp, variants, {
      generate: async () => ({ mime: "image/png", dataBase64: "d29ybGQ=" }),
      force: true,
    });
    expect(forced.created).toBe(2);
    // Upsert-by-variant means still one image per variant (2 total), with the new bytes.
    expect(await countImagesSince(db(), teamId, "1970-01-01T00:00:00.000Z")).toBe(2);
  });

  it("does nothing when the provider returns null (no key / failure) — post stays image-less", async () => {
    const { teamId, opp, variants } = await seedDraftedOpp("external");
    const s = await generateImagesForOpportunity(db(), teamId, opp, variants, { generate: async () => null });
    expect(s.created).toBe(0);
    expect(s.skipped).toBe(2);
  });

  it("team-tier images never surface to an external viewer", async () => {
    const { teamId, opp, variants } = await seedDraftedOpp("team");
    await generateImagesForOpportunity(db(), teamId, opp, variants, { generate: stubImg });

    const externalView = await listImageIdsByVariant(db(), teamId, variants.map((v) => v.id), "external");
    expect(externalView.size).toBe(0); // no cross-tier leak
    const teamView = await listImageIdsByVariant(db(), teamId, variants.map((v) => v.id), "team");
    expect(teamView.size).toBe(2);
  });

  it("defaults the cap to 10 and clamps on set", async () => {
    const seed = await seedTeam();
    expect(await getImageDailyCap(db(), seed.teamId)).toBe(10);
    expect(await setImageDailyCap(db(), seed.teamId, 999)).toBe(100); // clamped to max
    expect(await setImageDailyCap(db(), seed.teamId, -5)).toBe(0); // clamped to floor
  });
});
