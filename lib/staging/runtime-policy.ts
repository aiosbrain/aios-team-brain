import "server-only";
import { timingSafeEqual } from "node:crypto";
import { runSql } from "@/lib/db/pg/pool";
import { readStagingMarker } from "@/lib/env/staging-marker";

export type StagingDataMode = "production" | "legacy-pg-only" | "copy-ready" | "copy-safe-refusal";

export interface StagingRuntimeState {
  mode: StagingDataMode;
  ready: boolean;
  runId: string | null;
}

export function isPinnedStagingEnvironment(env: NodeJS.ProcessEnv = process.env): boolean {
  const pinned = env.STAGING_OPS_ENVIRONMENT_ID?.trim();
  const actual = env.RAILWAY_ENVIRONMENT_ID?.trim();
  return Boolean(pinned && actual && pinned === actual);
}

export function stagingModeFromEnvironment(env: NodeJS.ProcessEnv = process.env): StagingDataMode | null {
  const raw = env.STAGING_DATA_MODE?.trim();
  if (raw === "copy-ready" || raw === "legacy-pg-only") return raw;
  return null;
}

/** Synchronous spend backstop for raw transports which may otherwise fall back to process env keys. */
export function copiedStagingSpendAllowed(
  purpose: "interactive-query" | "background" | "graph-extraction" | "embedding" | "image",
  env: NodeJS.ProcessEnv = process.env
): boolean {
  const copyScoped = isPinnedStagingEnvironment(env) || env.STAGING_DATA_MODE === "copy-ready";
  if (!copyScoped) return true;
  if (purpose !== "interactive-query") return false;
  return env.STAGING_QUERY_LLM_ENABLED === "true" && Number(env.STAGING_QUERY_LLM_BUDGET_USD ?? 0) > 0;
}

export function isCopiedStagingRuntime(env: NodeJS.ProcessEnv = process.env): boolean {
  return isPinnedStagingEnvironment(env) || env.STAGING_DATA_MODE === "copy-ready";
}

export function assertCopiedStagingSpendAllowed(
  purpose: "interactive-query" | "background" | "graph-extraction" | "embedding" | "image",
  env: NodeJS.ProcessEnv = process.env
): void {
  if (!copiedStagingSpendAllowed(purpose, env)) {
    throw new Error(`copied-staging-no-spend: ${purpose} provider access is disabled`);
  }
}

export function stagingHealthTokenMatches(presented: string | null, env: NodeJS.ProcessEnv = process.env): boolean {
  const expected = env.STAGING_HEALTH_TOKEN?.trim() ?? "";
  const actual = presented?.trim() ?? "";
  if (expected.length < 32 || actual.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}

/**
 * Reads the ops journal without ever treating an absent/failed marker check as permission to write.
 * The ops schema is intentionally outside public dumps and may be absent until copy-mode activation.
 */
export async function readStagingRuntimeState(env: NodeJS.ProcessEnv = process.env): Promise<StagingRuntimeState> {
  let marker = false;
  try {
    marker = await readStagingMarker();
  } catch {
    if (isPinnedStagingEnvironment(env)) return { mode: "copy-safe-refusal", ready: false, runId: null };
  }
  const declared = stagingModeFromEnvironment(env);
  if (!marker && !isPinnedStagingEnvironment(env) && !declared) return { mode: "production", ready: true, runId: null };
  if (!declared) return { mode: "copy-safe-refusal", ready: false, runId: null };
  if (declared === "legacy-pg-only") return { mode: declared, ready: true, runId: null };

  try {
    const result = await runSql<{ run_id: string | null; state: string | null; catchup_commit: string | null; last_ready_mode: string | null; candidate_mode: string | null }>(
      `select run_id, state, catchup_commit, last_ready_mode, candidate_mode from staging_ops.refresh_journal where singleton = true limit 1`,
      []
    );
    const row = result.rows[0];
    const journalMode = row?.state === "booting" ? row.candidate_mode : row?.last_ready_mode;
    const effectiveMode = journalMode === "legacy-pg-only" || journalMode === "copy-ready" ? journalMode : declared;
    return { mode: effectiveMode, ready: row?.state === "ready", runId: row?.run_id ?? null };
  } catch {
    return { mode: "copy-safe-refusal", ready: false, runId: null };
  }
}

export async function assertCopiedStagingGraphMutationAllowed(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const state = await readStagingRuntimeState(env);
  if (state.mode === "copy-ready" || state.mode === "copy-safe-refusal") {
    throw new Error("copied-staging-read-only: graph mutations and extraction are disabled");
  }
}
