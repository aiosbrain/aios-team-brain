import { describe, expect, it } from "vitest";
import {
  createOpportunity,
  createPlan,
  addVariant,
  listOpportunities,
} from "@/lib/social/store";
import { db, ingest, seedTeam } from "./helpers";

/**
 * Spec (Pass-1 review, Wave 0 follow-on): the social chain's evidence→tier ceiling must survive a
 * RECLASSIFICATION, not just hold at create time.
 *
 * `lib/social/tier`'s invariant is that an opportunity may be at most as public as its most-restrictive
 * evidence item — because its title/summary, and every plan/variant/publication derived from it, are
 * written FROM that item's content. `assertEvidenceTier` enforces it in `createOpportunity` and nowhere
 * else, so when an evidence item is later narrowed external→team the existing `external` opportunity
 * silently violates the invariant and keeps serving that derived text to external principals.
 *
 * Unlike the caches (4h/5min TTL) this chain is PERSISTENT: nothing expires it and nothing recomputes
 * the ceiling, so the exposure is permanent. There is no RLS backstop (CLAUDE.md §5).
 */

/** The whole descendant chain's stored tier, so a test asserts propagation rather than one row. */
async function chainAccess(teamId: string) {
  const pick = async (table: string) => {
    const { data } = await db().from(table).select("access").eq("team_id", teamId);
    return ((data ?? []) as { access: string }[]).map((r) => r.access);
  };
  return {
    opportunities: await pick("social_opportunities"),
    plans: await pick("content_plans"),
    variants: await pick("content_variants"),
    media: await pick("media_assets"),
    publications: await pick("social_publications"),
    analytics: await pick("publication_analytics"),
  };
}

/** The three tables below the variant, each owned by a different module. Seeded directly because their
 *  creation paths need a provider/generation round-trip this spec doesn't care about. */
async function seedBelowVariant(teamId: string, variantId: string, access: "team" | "external") {
  await db()
    .from("media_assets")
    .insert({ team_id: teamId, variant_id: variantId, access, provider: "test", model: "m", data_base64: "x" });
  const { data: pub } = await db()
    .from("social_publications")
    .insert({ team_id: teamId, variant_id: variantId, access })
    .select("id")
    .single();
  await db()
    .from("publication_analytics")
    .insert({ team_id: teamId, publication_id: (pub as { id: string }).id, access });
}

async function seedChain(
  teamId: string,
  access: "team" | "external",
  evidenceItemId: string | undefined,
  dedupKey: string
) {
  const opp = await createOpportunity(db(), teamId, {
    access,
    sourceType: "item",
    title: "What we learned shipping the client portal",
    summary: "derived from the evidence item's content",
    evidence: evidenceItemId ? [{ itemId: evidenceItemId, path: "docs/spec.md" }] : [],
    dedupKey,
  });
  const plan = await createPlan(db(), teamId, opp.id, { objective: "thought leadership" });
  const variant = await addVariant(db(), teamId, plan.id, {
    platform: "x",
    format: "text",
    body: "a post quoting the spec",
  });
  await seedBelowVariant(teamId, variant.id, access);
  return { opp, plan, variant };
}

describe("social chain follows a narrowed evidence item (real Postgres)", () => {
  it("narrows the opportunity AND its whole derived chain when its evidence item goes external→team", async () => {
    const seed = await seedTeam();
    const item = await ingest(seed, {
      kind: "deliverable",
      path: "docs/spec.md",
      body: "the client-visible spec",
      access: "external",
    });
    await seedChain(seed.teamId, "external", item.id, "opp-evidence");

    // Before: legitimately external — the evidence was external, so the ceiling allowed it.
    expect(await chainAccess(seed.teamId)).toEqual({
      opportunities: ["external"],
      plans: ["external"],
      variants: ["external"],
      media: ["external"],
      publications: ["external"],
      analytics: ["external"],
    });

    // The evidence item is reclassified upstream WITHOUT touching its prose (the unchanged fast path).
    await ingest(seed, {
      kind: "deliverable",
      path: "docs/spec.md",
      body: "the client-visible spec",
      access: "team",
    });

    // After: the ceiling dropped, so the opportunity and everything derived from it must drop with it.
    expect(await chainAccess(seed.teamId)).toEqual({
      opportunities: ["team"],
      plans: ["team"],
      variants: ["team"],
      media: ["team"],
      publications: ["team"],
      analytics: ["team"],
    });
  });

  it("stops serving it on the external read path — the observable leak", async () => {
    const seed = await seedTeam();
    const item = await ingest(seed, {
      kind: "deliverable",
      path: "docs/spec.md",
      body: "the client-visible spec",
      access: "external",
    });
    await seedChain(seed.teamId, "external", item.id, "opp-read");
    expect(await listOpportunities(db(), seed.teamId, "external")).toHaveLength(1);

    await ingest(seed, {
      kind: "deliverable",
      path: "docs/spec.md",
      body: "the client-visible spec",
      access: "team",
    });

    // The thing that actually matters: an external principal can no longer read the derived text.
    expect(await listOpportunities(db(), seed.teamId, "external")).toHaveLength(0);
    expect(await listOpportunities(db(), seed.teamId, "team")).toHaveLength(1); // still there internally
  });

  it("leaves an opportunity citing a DIFFERENT item alone", async () => {
    // The cascade must be evidence-scoped, not team-wide — narrowing one doc must not retract unrelated
    // client-facing content.
    const seed = await seedTeam();
    const narrowed = await ingest(seed, { kind: "deliverable", path: "docs/a.md", body: "doc a", access: "external" });
    const untouched = await ingest(seed, { kind: "deliverable", path: "docs/b.md", body: "doc b", access: "external" });
    await seedChain(seed.teamId, "external", narrowed.id, "opp-a");
    await seedChain(seed.teamId, "external", untouched.id, "opp-b");

    await ingest(seed, { kind: "deliverable", path: "docs/a.md", body: "doc a", access: "team" });

    const { data } = await db()
      .from("social_opportunities")
      .select("dedup_key, access")
      .eq("team_id", seed.teamId);
    const byKey = Object.fromEntries(
      ((data ?? []) as { dedup_key: string; access: string }[]).map((r) => [r.dedup_key, r.access])
    );
    expect(byKey["opp-a"]).toBe("team");
    expect(byKey["opp-b"]).toBe("external"); // unrelated evidence → untouched
  });

  it("does NOT widen an opportunity when its evidence item is widened team→external", async () => {
    // The invariant is a CEILING, not equality. A team-tier item becoming external raises what WOULD be
    // permitted, but publishing internal-derived content externally is a human decision — auto-widening
    // would silently make internal narrative public.
    const seed = await seedTeam();
    const item = await ingest(seed, { kind: "deliverable", path: "docs/spec.md", body: "internal spec", access: "team" });
    await seedChain(seed.teamId, "team", item.id, "opp-widen");

    await ingest(seed, { kind: "deliverable", path: "docs/spec.md", body: "internal spec", access: "external" });

    expect(await chainAccess(seed.teamId)).toEqual({
      opportunities: ["team"],
      plans: ["team"],
      variants: ["team"],
      media: ["team"],
      publications: ["team"],
      analytics: ["team"],
    });
  });

  it("is a no-op for an opportunity already at the narrower tier", async () => {
    const seed = await seedTeam();
    const item = await ingest(seed, { kind: "deliverable", path: "docs/spec.md", body: "the spec", access: "external" });
    await seedChain(seed.teamId, "team", item.id, "opp-noop");

    await ingest(seed, { kind: "deliverable", path: "docs/spec.md", body: "the spec", access: "team" });

    expect(await chainAccess(seed.teamId)).toEqual({
      opportunities: ["team"],
      plans: ["team"],
      variants: ["team"],
      media: ["team"],
      publications: ["team"],
      analytics: ["team"],
    });
  });
});
