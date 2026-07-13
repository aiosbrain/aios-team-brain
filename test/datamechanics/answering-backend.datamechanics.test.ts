import { describe, expect, it } from "vitest";
import { resolveAnsweringKeys } from "@/lib/query/answering";
import { saveProviderModel, setIntegrationSecret, upsertIntegration } from "@/lib/integrations/manage";
import { selectLlmBackend } from "@/lib/query/llm-backend";
import { db, seedTeam } from "./helpers";

/**
 * Spec for the answering-backend resolution on REAL Postgres: the per-provider key+model and the
 * explicit `teams.answering_provider` override must round-trip through the encrypted `integrations`
 * store and the `teams` column, then resolve to the model the admin actually chose. Proven end-to-end
 * (encrypt → store → decrypt → resolve → selectLlmBackend), which the in-memory fake can't.
 */

// The integration writers audit under a member id; reuse the seeded team's member.
async function auth(teamId: string): Promise<{ teamId: string; memberId: string }> {
  const { data } = await db()
    .from("members")
    .select("id")
    .eq("team_id", teamId)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  return { teamId, memberId: (data as { id: string }).id };
}

describe("answering backend resolution (real Postgres)", () => {
  it("round-trips each provider's key + chosen model through the encrypted store", async () => {
    const { teamId } = await seedTeam();
    const a = await auth(teamId);

    // Anthropic: model-only (answers via env key) + a stored key too.
    await upsertIntegration(db(), a, { type: "anthropic", name: "anthropic", config: {}, status: "enabled" });
    await setIntegrationSecret(db(), a, (await firstId(teamId, "anthropic")), "sk-ant-real");
    await saveProviderModel(db(), a, "anthropic", "claude-sonnet-4");

    // OpenAI key + model.
    await upsertIntegration(db(), a, { type: "openai", name: "openai", config: {}, status: "enabled" });
    await setIntegrationSecret(db(), a, (await firstId(teamId, "openai")), "sk-openai-real");
    await saveProviderModel(db(), a, "openai", "gpt-4.1");

    const keys = await resolveAnsweringKeys(db(), teamId);
    expect(keys.anthropicKey).toBe("sk-ant-real");
    expect(keys.anthropicModel).toBe("claude-sonnet-4");
    expect(keys.openaiKey).toBe("sk-openai-real");
    expect(keys.openaiModel).toBe("gpt-4.1");
    expect(keys.activeProvider).toBeNull(); // no override set yet
  });

  it("the explicit override forces the chosen backend + model end-to-end", async () => {
    const { teamId } = await seedTeam();
    const a = await auth(teamId);
    await upsertIntegration(db(), a, { type: "openai", name: "openai", config: {}, status: "enabled" });
    await setIntegrationSecret(db(), a, (await firstId(teamId, "openai")), "sk-openai-real");
    await saveProviderModel(db(), a, "openai", "gpt-4o-mini");

    // Force OpenAI as the answering backend.
    await db().from("teams").update({ answering_provider: "openai" }).eq("id", teamId);

    const keys = await resolveAnsweringKeys(db(), teamId);
    expect(keys.activeProvider).toBe("openai");
    const backend = selectLlmBackend({}, keys);
    expect(backend.provider).toBe("openai");
    expect(backend.model).toBe("gpt-4o-mini");
  });

  it("saveProviderModel preserves the stored key (model-only update)", async () => {
    const { teamId } = await seedTeam();
    const a = await auth(teamId);
    await upsertIntegration(db(), a, { type: "openai", name: "openai", config: {}, status: "enabled" });
    await setIntegrationSecret(db(), a, (await firstId(teamId, "openai")), "sk-keepme");

    await saveProviderModel(db(), a, "openai", "gpt-4o");
    const keys = await resolveAnsweringKeys(db(), teamId);
    expect(keys.openaiKey).toBe("sk-keepme"); // key survived the model write
    expect(keys.openaiModel).toBe("gpt-4o");
  });
});

async function firstId(teamId: string, type: string): Promise<string> {
  const { data } = await db()
    .from("integrations")
    .select("id")
    .eq("team_id", teamId)
    .eq("type", type)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  return (data as { id: string }).id;
}
