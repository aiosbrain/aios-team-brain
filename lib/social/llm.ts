import "server-only";
import type { DbClient } from "@/lib/db/types";
import type { ProviderKeys } from "@/lib/query/claude";
import { resolveAnsweringKeys } from "@/lib/query/answering";

/**
 * Social content generation reuses the shared, settings-aware completion primitive (`lib/llm/complete`),
 * so a team's chosen answering model (incl. OpenRouter) applies to generated posts too. This module
 * only adds the team-scoped key resolution; the transport lives in one place now.
 */

export { completeText } from "@/lib/llm/complete";
export type { CompleteArgs, CompleteOptions } from "@/lib/llm/complete";

/** Resolve a team's provider keys the same way the query routes do (single source of truth). */
export function resolveProviderKeys(db: DbClient, teamId: string): Promise<ProviderKeys> {
  return resolveAnsweringKeys(db, teamId);
}
