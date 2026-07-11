import "server-only";
import { adminClient } from "@/lib/db/admin";
import { getProviderKey } from "@/lib/integrations/manage";

/**
 * Resolve a team's embeddings key. Precedence:
 *   1. `EMBEDDINGS_API_KEY` env — a DEDICATED key that decouples semantic search from the answer
 *      LLM's quota. Point it at a SEPARATE account so exhausting one provider (the OpenAI-quota
 *      incident) can't silently zero out the other. Explicit opt-in → wins over the shared store key.
 *   2. The team's OpenAI key from **AI model settings** (encrypted integrations store, via
 *      `getProviderKey`) — today's default: embeddings reuse whatever the LLM uses.
 *   3. null → `embed()` falls back to the process env (`OPENAI_API_KEY`), preserving env-only setups.
 * Best-effort: never throws (a decrypt/DB hiccup → null → env fallback, not a failed index/query).
 */
export async function resolveEmbeddingKey(teamId: string): Promise<string | null> {
  if (process.env.EMBEDDINGS_API_KEY) return process.env.EMBEDDINGS_API_KEY;
  try {
    return await getProviderKey(adminClient(), teamId, "openai");
  } catch {
    return null;
  }
}
