import { describe, expect, it } from "vitest";
import { upsertIntegration, deleteIntegration } from "@/lib/integrations/manage";
import { db, seedTeam } from "./helpers";

/**
 * Spec (integration-deletion hygiene, provider keys): `teams.answering_provider` / `reasoning_provider`
 * are POINTERS at a provider-key integration (anthropic/openai/openrouter). Deleting that key must not
 * leave the pointer dangling — otherwise the answer path silently falls back to Anthropic/env while the
 * Admin picker keeps claiming the deleted provider is active (a stale lie, not a crash).
 *
 * Rule: deleting a provider-key integration clears any team pointer that referenced its provider —
 * BUT only when no ENABLED key of that provider remains, and only for the pointer(s) that actually
 * matched. Connector deletes never touch these pointers. Already-stored keys/rows are untouched.
 */

function auth(teamId: string, memberId: string) {
  return { teamId, memberId };
}

async function setPointers(
  teamId: string,
  patch: { answering_provider?: string | null; reasoning_provider?: string | null; reasoning_model?: string | null }
): Promise<void> {
  await db().from("teams").update(patch).eq("id", teamId);
}

async function pointers(
  teamId: string
): Promise<{ answering: string | null; reasoning: string | null; reasoningModel: string | null }> {
  const { data } = await db()
    .from("teams")
    .select("answering_provider, reasoning_provider, reasoning_model")
    .eq("id", teamId)
    .maybeSingle();
  const row = data as {
    answering_provider: string | null;
    reasoning_provider: string | null;
    reasoning_model: string | null;
  } | null;
  return {
    answering: row?.answering_provider ?? null,
    reasoning: row?.reasoning_provider ?? null,
    reasoningModel: row?.reasoning_model ?? null,
  };
}

describe("integration delete — provider pointer cascade (data-mechanics)", () => {
  it("clears answering_provider when its OpenRouter key is deleted (no key of that type remains)", async () => {
    const seed = await seedTeam();
    const a = auth(seed.teamId, seed.memberId);
    const { id } = await upsertIntegration(db(), a, { type: "openrouter", name: "or", config: {} });
    await setPointers(seed.teamId, { answering_provider: "openrouter" });

    await deleteIntegration(db(), a, id);

    expect((await pointers(seed.teamId)).answering).toBeNull();
  });

  it("clears reasoning_provider AND its orphaned reasoning_model when the (openai) key is deleted", async () => {
    const seed = await seedTeam();
    const a = auth(seed.teamId, seed.memberId);
    const { id } = await upsertIntegration(db(), a, { type: "openai", name: "oa", config: {} });
    // provider+model are a coupled pair — a nulled provider must not leave the model to run on the
    // (wrong) answering backend, so both must clear together.
    await setPointers(seed.teamId, { reasoning_provider: "openai", reasoning_model: "gpt-4o" });

    await deleteIntegration(db(), a, id);

    const p = await pointers(seed.teamId);
    expect(p.reasoning).toBeNull();
    expect(p.reasoningModel).toBeNull();
  });

  it("does NOT clear the pointer if another ENABLED key of the same provider remains", async () => {
    const seed = await seedTeam();
    const a = auth(seed.teamId, seed.memberId);
    // Two distinct openrouter rows (unique on team_id,type,name) — a redundant/backup key.
    const { id: id1 } = await upsertIntegration(db(), a, { type: "openrouter", name: "primary", config: {} });
    await upsertIntegration(db(), a, { type: "openrouter", name: "backup", config: {} });
    await setPointers(seed.teamId, { answering_provider: "openrouter" });

    await deleteIntegration(db(), a, id1);

    expect((await pointers(seed.teamId)).answering).toBe("openrouter"); // still resolvable → keep
  });

  it("does NOT clear answering_provider when a DIFFERENT provider's key is deleted", async () => {
    const seed = await seedTeam();
    const a = auth(seed.teamId, seed.memberId);
    const { id: openaiId } = await upsertIntegration(db(), a, { type: "openai", name: "oa", config: {} });
    await upsertIntegration(db(), a, { type: "openrouter", name: "or", config: {} });
    await setPointers(seed.teamId, { answering_provider: "openrouter" });

    await deleteIntegration(db(), a, openaiId); // deleting the unrelated OpenAI key

    expect((await pointers(seed.teamId)).answering).toBe("openrouter");
  });

  it("does NOT touch provider pointers when a CONNECTOR (plane) integration is deleted", async () => {
    const seed = await seedTeam();
    const a = auth(seed.teamId, seed.memberId);
    const { id } = await upsertIntegration(db(), a, {
      type: "plane",
      name: "aios-plane",
      config: { workspaceSlug: "aios", projectId: "p1" },
    });
    await setPointers(seed.teamId, { answering_provider: "openrouter" });

    await deleteIntegration(db(), a, id);

    expect((await pointers(seed.teamId)).answering).toBe("openrouter");
  });

  it("clears BOTH pointers when they both referenced the deleted provider", async () => {
    const seed = await seedTeam();
    const a = auth(seed.teamId, seed.memberId);
    const { id } = await upsertIntegration(db(), a, { type: "anthropic", name: "an", config: {} });
    await setPointers(seed.teamId, { answering_provider: "anthropic", reasoning_provider: "anthropic" });

    await deleteIntegration(db(), a, id);

    const p = await pointers(seed.teamId);
    expect(p.answering).toBeNull();
    expect(p.reasoning).toBeNull();
  });
});
