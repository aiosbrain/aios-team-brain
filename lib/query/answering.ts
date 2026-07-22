import "server-only";
import type { DbClient } from "@/lib/db/types";
import { getProviderSettings } from "@/lib/integrations/manage";
import type { AnsweringProvider, LlmBackendKeys } from "@/lib/query/llm-backend";

/**
 * The single place the answer path assembles a team's LLM backend keys: every provider's decrypted
 * key + chosen model, plus the explicit answering-backend override (`teams.answering_provider`).
 * Both query routes (`/api/dashboard/query`, `/api/v1/query`) call this so they resolve the SAME
 * backend — previously the v1 route silently ignored OpenRouter. Server-only; keys are decrypted
 * in-process and never cross an HTTP boundary.
 */

const VALID_PROVIDERS: readonly AnsweringProvider[] = ["anthropic", "openai", "openrouter", "local"];

/** Normalize a stored `teams.answering_provider` to a valid override or null (auto precedence). */
export function normalizeAnsweringProvider(raw: unknown): AnsweringProvider | null {
  return typeof raw === "string" && (VALID_PROVIDERS as readonly string[]).includes(raw)
    ? (raw as AnsweringProvider)
    : null;
}

export async function resolveAnsweringKeys(db: DbClient, teamId: string): Promise<LlmBackendKeys> {
  const [anthropic, openai, openrouter, teamRes] = await Promise.all([
    getProviderSettings(db, teamId, "anthropic"),
    getProviderSettings(db, teamId, "openai"),
    getProviderSettings(db, teamId, "openrouter"),
    db.from("teams").select("answering_provider, reasoning_model, reasoning_provider").eq("id", teamId).maybeSingle(),
  ]);
  const teamRow = teamRes.data as {
    answering_provider: string | null;
    reasoning_model: string | null;
    reasoning_provider: string | null;
  } | null;
  return {
    anthropicKey: anthropic.key,
    anthropicModel: anthropic.model,
    openaiKey: openai.key,
    openaiModel: openai.model,
    openrouterKey: openrouter.key,
    openrouterModel: openrouter.model,
    activeProvider: normalizeAnsweringProvider(teamRow?.answering_provider),
    reasoningModel: teamRow?.reasoning_model ?? null,
    reasoningProvider: normalizeAnsweringProvider(teamRow?.reasoning_provider),
  };
}
