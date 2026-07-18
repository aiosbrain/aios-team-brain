import { describe, expect, it } from "vitest";
import { createOpportunity, getVariant, setVariantGeneration, setVariantStatus } from "@/lib/social/store";
import { planOpportunity } from "@/lib/social/plan";
import { generateVariantText, generatePlanDrafts } from "@/lib/social/generate";
import { saveBrandProfile } from "@/lib/brand/manage";
import { db, ingest, seedTeam } from "./helpers";

/**
 * Spec for text generation + the governance gate on real Postgres, with the model STUBBED (the
 * data-mechanics tier stubs the model; CLAUDE.md §4). Derived from intent: a draft is written,
 * gated against the Brand Brain, persisted with its result, and the variant advances — blocked on
 * a prohibited phrase, warned (not blocked) on an unverified claim.
 */
async function plannedVariant(bodyAccess: "team" | "external" = "team") {
  const seed = await seedTeam();
  await saveBrandProfile(
    db(),
    seed.teamId,
    {
      voice: { prohibitedPhrases: ["synergy"] },
      knowledge: { claimsNeedingVerification: ["fastest"] },
    },
    { memberId: seed.memberId }
  );
  const ev = await ingest(seed, { kind: "deliverable", access: bodyAccess, path: "notes/x.md", body: "we shipped a durable job queue with retries" });
  const opp = await createOpportunity(db(), seed.teamId, {
    access: bodyAccess,
    sourceType: "deliverable",
    title: "Shipped the job queue",
    summary: "M0 landed",
    evidence: [{ itemId: ev.id }],
  });
  const { variants } = await planOpportunity(db(), seed.teamId, opp.id, { memberId: seed.memberId });
  return { seed, opp, variant: variants[0] };
}

describe("content generation + gate (real Postgres, stubbed model)", () => {
  it("generates a clean draft, stores the body, and advances to generated", async () => {
    const { seed, variant } = await plannedVariant();
    const r = await generateVariantText(db(), seed.teamId, variant.id, {
      complete: async () => "We shipped a durable job queue with retries and backoff.",
    });
    expect(r.status).toBe("generated");
    const after = await getVariant(db(), seed.teamId, variant.id);
    expect(after!.status).toBe("generated");
    expect(after!.body).toContain("durable job queue");
  });

  it("BLOCKS a draft containing a prohibited phrase (variant → rejected)", async () => {
    const { seed, variant } = await plannedVariant();
    const r = await generateVariantText(db(), seed.teamId, variant.id, {
      complete: async () => "Unlock Synergy with our new release!",
    });
    expect(r.status).toBe("rejected");
    expect(r.violations.some((v) => v.rule === "prohibited_phrase")).toBe(true);
    const after = await getVariant(db(), seed.teamId, variant.id);
    expect(after!.status).toBe("rejected");
    expect((after!.validation as { violations: unknown[] }).violations.length).toBeGreaterThan(0);
  });

  it("WARNS but does not block on an unverified claim", async () => {
    const { seed, variant } = await plannedVariant();
    const r = await generateVariantText(db(), seed.teamId, variant.id, {
      complete: async () => "This is the fastest way to ship.",
    });
    expect(r.status).toBe("generated");
    expect(r.warnings.some((w) => w.rule === "unverified_claim")).toBe(true);
  });

  it("generatePlanDrafts drafts every variant and counts outcomes", async () => {
    const { seed, opp } = await plannedVariant();
    const s = await generatePlanDrafts(db(), seed.teamId, opp.id, {
      complete: async () => "A clean grounded post about the launch.",
    });
    expect(s.generated).toBe(2); // X + LinkedIn
    expect(s.blocked).toBe(0);
    expect(s.variants.every((v) => v.status === "generated")).toBe(true);
  });

  // audit #7: the evidence→tier ceiling is re-asserted when bodies are re-read at generation, so an
  // item narrowed external→team AFTER the opportunity was created can't leak into an external draft.
  it("#7 re-asserts the evidence tier at generation — a narrowed item can't leak into an external draft", async () => {
    const seed = await seedTeam();
    const ev = await ingest(seed, {
      kind: "deliverable",
      access: "external",
      path: "notes/leak.md",
      body: "SECRETMARKER confidential internal roadmap details",
    });
    const opp = await createOpportunity(db(), seed.teamId, {
      access: "external",
      sourceType: "deliverable",
      title: "Public post",
      evidence: [{ itemId: ev.id }],
    });
    const { variants } = await planOpportunity(db(), seed.teamId, opp.id, { memberId: seed.memberId });
    // The cited item is later narrowed to internal — it must vanish from the external draft's evidence.
    await db().from("items").update({ access: "team" }).eq("team_id", seed.teamId).eq("id", ev.id);

    let seenPrompt = "";
    await generateVariantText(db(), seed.teamId, variants[0].id, {
      complete: async (a) => {
        seenPrompt = a.prompt;
        return "a clean grounded post about the launch";
      },
    });
    expect(seenPrompt).not.toContain("SECRETMARKER");
  });

  // audit #3: generatePlanDrafts must never overwrite an already-approved variant — a regenerated,
  // possibly gate-rejected body could otherwise replace a body that can still fire.
  it("#3 does not regenerate an already-approved variant (its fireable body is preserved)", async () => {
    const { seed, opp, variant } = await plannedVariant("external");
    await setVariantGeneration(db(), seed.teamId, variant.id, { body: "APPROVED BODY", status: "generated", validation: {} });
    await setVariantStatus(db(), seed.teamId, variant.id, "approved");

    await generatePlanDrafts(db(), seed.teamId, opp.id, { complete: async () => "REGENERATED DIFFERENT BODY" });

    const after = await getVariant(db(), seed.teamId, variant.id);
    expect(after!.status).toBe("approved"); // untouched
    expect(after!.body).toBe("APPROVED BODY"); // NOT overwritten
  });
});
