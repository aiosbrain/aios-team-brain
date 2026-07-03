import "server-only";
import { adminClient } from "@/lib/db/admin";
import { getProviderKey } from "@/lib/integrations/manage";

/**
 * Resolve a team's OpenAI embeddings key from **AI model settings** (the encrypted integrations
 * store) — the same source the answering LLM uses (`getProviderKey`). Returns null when unset, in
 * which case `embed()` falls back to the process env (`OPENAI_API_KEY`), preserving env-only setups.
 * Best-effort: never throws (a decrypt/DB hiccup → null → env fallback, not a failed index/query).
 */
export async function resolveEmbeddingKey(teamId: string): Promise<string | null> {
  try {
    return await getProviderKey(adminClient(), teamId, "openai");
  } catch {
    return null;
  }
}
