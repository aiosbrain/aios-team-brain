import "server-only";
import { adminClient } from "@/lib/db/admin";
import { getProviderKey } from "@/lib/integrations/manage";
import type { DbClient } from "@/lib/db/types";
import {
  selectEmbeddingBackend,
  normalizeEmbeddingProvider,
  type EmbeddingBackend,
} from "./embeddings-backend";
import type { EmbeddingProvider } from "@/lib/api/schemas";

/**
 * Resolve a team's embeddings backend (baseUrl + model + key) for the semantic index. The DB-reading
 * wrapper around the pure `selectEmbeddingBackend`. Precedence:
 *   1. the team's Admin pick (`teams.embedding_provider` + `embedding_model`) when that provider's key
 *      is set (openai/openrouter) — routes embeddings the same way the Query box routes answers;
 *   2. env `EMBEDDINGS_URL` (self-host / today's default), keyed by the same dedicated → team-OpenAI →
 *      `OPENAI_API_KEY` → "local" chain the old `resolveEmbeddingKey` used (Ollama keyless still works);
 *   3. null → dense retrieval OFF.
 * Best-effort: never throws (a decrypt/DB hiccup → env tier or null, not a failed index/query).
 */

/** Env-tier key precedence (unchanged from the old resolveEmbeddingKey + embeddingAuthKey chain). */
async function resolveEnvKey(db: DbClient, teamId: string): Promise<string> {
  if (process.env.EMBEDDINGS_API_KEY) return process.env.EMBEDDINGS_API_KEY;
  try {
    const teamKey = await getProviderKey(db, teamId, "openai");
    if (teamKey) return teamKey;
  } catch {
    /* fall through to the env key */
  }
  return process.env.OPENAI_API_KEY ?? "local";
}

export async function resolveEmbeddingBackend(
  teamId: string,
  db: DbClient = adminClient()
): Promise<EmbeddingBackend | null> {
  let activeProvider: EmbeddingProvider | null = null;
  let model: string | null = null;
  let openaiKey: string | null = null;
  let openrouterKey: string | null = null;
  try {
    const { data } = await db
      .from("teams")
      .select("embedding_provider, embedding_model")
      .eq("id", teamId)
      .maybeSingle();
    const row = data as { embedding_provider: string | null; embedding_model: string | null } | null;
    activeProvider = normalizeEmbeddingProvider(row?.embedding_provider);
    model = row?.embedding_model ?? null;
    if (activeProvider === "openai") openaiKey = await getProviderKey(db, teamId, "openai");
    else if (activeProvider === "openrouter") openrouterKey = await getProviderKey(db, teamId, "openrouter");
  } catch {
    /* fall through to the env tier */
  }
  // Read env at CALL time (not module load) so scripts/tests that set it after import — and
  // vi.stubEnv — are honored, and so retrieval-health's `configured` reflects the live endpoint.
  const envUrl = process.env.EMBEDDINGS_URL ?? null;
  // Only resolve the env key when there's an env endpoint to use it with (avoids a needless read).
  const envKey = envUrl ? await resolveEnvKey(db, teamId) : null;
  return selectEmbeddingBackend({
    openaiKey,
    openrouterKey,
    activeProvider,
    model,
    envUrl,
    envModel: process.env.EMBEDDINGS_MODEL ?? null,
    envKey,
    envDim: process.env.EMBEDDINGS_DIM ? Number(process.env.EMBEDDINGS_DIM) : null,
  });
}
