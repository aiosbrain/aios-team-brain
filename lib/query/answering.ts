import "server-only";
import type { DbClient } from "@/lib/db/types";
import { getProviderSettings } from "@/lib/integrations/manage";
import type { AnsweringProvider, ExtractionProvider, LlmBackendKeys } from "@/lib/query/llm-backend";

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

/** The providers the EXTRACTION role may use — Anthropic is excluded on purpose (ExtractionProvider). */
const VALID_EXTRACTION_PROVIDERS: readonly ExtractionProvider[] = ["openai", "openrouter", "local"];

/**
 * Normalize a stored `teams.extraction_provider`. Anything outside the extraction set — including
 * `anthropic`, which the CHECK constraint already forbids — becomes null, i.e. "the answering backend".
 *
 * That stops a hand-edited row from *selecting* a backend the graph can't serve; it does NOT guarantee
 * the graph resolves a usable one, because null means "whatever answers" and the answering provider can
 * itself be Anthropic. That case is pre-existing (answering on Anthropic has always left the graph dead),
 * is refused by `graphChatTarget` with an actionable 501, and is warned about at save time by
 * `graphModelWarning`. Not silent, but not prevented here either.
 */
export function normalizeExtractionProvider(raw: unknown): ExtractionProvider | null {
  return typeof raw === "string" && (VALID_EXTRACTION_PROVIDERS as readonly string[]).includes(raw)
    ? (raw as ExtractionProvider)
    : null;
}

export async function resolveAnsweringKeys(db: DbClient, teamId: string): Promise<LlmBackendKeys> {
  const [anthropic, openai, openrouter, teamRes] = await Promise.all([
    getProviderSettings(db, teamId, "anthropic"),
    getProviderSettings(db, teamId, "openai"),
    getProviderSettings(db, teamId, "openrouter"),
    db
      .from("teams")
      .select(
        "answering_provider, reasoning_model, reasoning_provider, extraction_model, extraction_provider, extraction_small_model"
      )
      .eq("id", teamId)
      .maybeSingle(),
  ]);
  const teamRow = teamRes.data as {
    answering_provider: string | null;
    reasoning_model: string | null;
    reasoning_provider: string | null;
    extraction_model: string | null;
    extraction_small_model: string | null;
    extraction_provider: string | null;
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
    extractionModel: teamRow?.extraction_model ?? null,
    extractionSmallModel: teamRow?.extraction_small_model ?? null,
    extractionProvider: normalizeExtractionProvider(teamRow?.extraction_provider),
  };
}
