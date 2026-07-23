import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveEmbeddingBackend } from "@/lib/query/embedding-key";
import { setIntegrationSecret, upsertIntegration } from "@/lib/integrations/manage";
import { db, seedTeam } from "./helpers";

afterEach(() => vi.unstubAllEnvs());

/**
 * Spec for the per-team embeddings backend on REAL Postgres: `teams.embedding_provider`/`embedding_model`
 * + the provider's encrypted key must round-trip and resolve to the concrete `{ baseUrl, model, apiKey }`
 * the semantic index embeds with — the fix for a dead OpenAI key silently killing dense search when the
 * team already pays for OpenRouter. Env `EMBEDDINGS_URL` is unset in this tier, so a team with no pick
 * resolves to null (dense off). Proven end-to-end (store → decrypt → resolve), which the fake can't.
 */

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

async function firstId(teamId: string, type: string): Promise<string> {
  const { data } = await db().from("integrations").select("id").eq("team_id", teamId).eq("type", type).maybeSingle();
  return (data as { id: string }).id;
}

async function setEmbeddingPick(teamId: string, provider: string | null, model: string | null): Promise<void> {
  await db().from("teams").update({ embedding_provider: provider, embedding_model: model }).eq("id", teamId);
}

describe("embeddings backend resolution (real Postgres)", () => {
  it("resolves the team's OpenRouter pick to openrouter.ai + the decrypted key", async () => {
    const { teamId } = await seedTeam();
    const a = await auth(teamId);
    await upsertIntegration(db(), a, { type: "openrouter", name: "openrouter", config: {}, status: "enabled" });
    await setIntegrationSecret(db(), a, await firstId(teamId, "openrouter"), "sk-or-real");
    await setEmbeddingPick(teamId, "openrouter", "openai/text-embedding-3-small");

    const backend = await resolveEmbeddingBackend(teamId, db());
    expect(backend).toEqual({
      provider: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      model: "openai/text-embedding-3-small",
      apiKey: "sk-or-real",
      dim: 1536,
    });
  });

  it("resolves an OpenAI pick to api.openai.com + the decrypted key", async () => {
    const { teamId } = await seedTeam();
    const a = await auth(teamId);
    await upsertIntegration(db(), a, { type: "openai", name: "openai", config: {}, status: "enabled" });
    await setIntegrationSecret(db(), a, await firstId(teamId, "openai"), "sk-openai-real");
    await setEmbeddingPick(teamId, "openai", "text-embedding-3-small");

    const backend = await resolveEmbeddingBackend(teamId, db());
    expect(backend?.provider).toBe("openai");
    expect(backend?.baseUrl).toBe("https://api.openai.com/v1");
    expect(backend?.apiKey).toBe("sk-openai-real");
  });

  it("is null (dense off) when the team has no pick and no env endpoint", async () => {
    const { teamId } = await seedTeam();
    expect(await resolveEmbeddingBackend(teamId, db())).toBeNull();
  });

  it("is null when a provider is picked but its key isn't stored (no silent wrong-key embed)", async () => {
    const { teamId } = await seedTeam();
    await setEmbeddingPick(teamId, "openrouter", "openai/text-embedding-3-small"); // no key stored
    expect(await resolveEmbeddingBackend(teamId, db())).toBeNull();
  });

  it("env tier key precedence: dedicated EMBEDDINGS_API_KEY wins, else the team's OpenAI key", async () => {
    const { teamId } = await seedTeam();
    const a = await auth(teamId);
    await upsertIntegration(db(), a, { type: "openai", name: "openai", config: {}, status: "enabled" });
    await setIntegrationSecret(db(), a, await firstId(teamId, "openai"), "sk-team-openai");
    vi.stubEnv("EMBEDDINGS_URL", "https://api.openai.com/v1"); // env tier (no team embedding pick)
    vi.stubEnv("EMBEDDINGS_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "");

    let b = await resolveEmbeddingBackend(teamId, db());
    expect(b?.provider).toBe("env");
    expect(b?.apiKey).toBe("sk-team-openai"); // falls back to the team's stored OpenAI key

    vi.stubEnv("EMBEDDINGS_API_KEY", "sk-dedicated");
    b = await resolveEmbeddingBackend(teamId, db());
    expect(b?.apiKey).toBe("sk-dedicated"); // the dedicated decouple key wins
  });
});
