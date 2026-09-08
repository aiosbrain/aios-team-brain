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

/**
 * Whether this build can honour the spec's OPTIONAL "separately budgeted interactive queries" mode.
 *
 * It cannot, and saying so in one place is the point. `STAGING_QUERY_LLM_BUDGET_USD` is read by
 * exactly one expression in this repository — the gate below — and by nothing that meters, reserves
 * or refuses spend against it. The provider paths carry token, rate and retry budgets and report
 * usage after the fact; none of them is a dollar ceiling. So a configured positive amount was never
 * an enforced cap, it was a permission bit wearing a number's clothes, and the previous
 * `Number(...) > 0` test additionally accepted `Infinity`.
 *
 * Building a metering/reservation layer to back it is a separate piece of work with its own review;
 * inventing one here would be worse than the gap. Until such a contract exists and is demonstrably
 * enforced, the optional mode is UNSUPPORTED and copied staging serves direct graph/FTS retrieval
 * with no model calls at all — which is the specified DEFAULT behaviour, not a degradation of it.
 */
export const BUDGETED_INTERACTIVE_QUERY_SUPPORTED: boolean = false;

/** The one name every surface uses for this refusal, so preflight, health and docs cannot drift. */
export const UNSUPPORTED_BUDGETED_MODE = "staging-budgeted-interactive-query-unsupported";

/** A configured ceiling above this is not a ceiling; it is an unbounded authorisation. */
const MAX_INTERACTIVE_BUDGET_USD = 10_000;

export interface InteractiveQueryOptIn {
  /** The operator asked for the optional mode. */
  optedIn: boolean;
  status: "not-requested" | "invalid-budget" | "unsupported";
  budgetUsd: number | null;
  reason: string | null;
}

/**
 * Classify the optional interactive-query configuration WITHOUT authorising anything.
 *
 * Note there is no `"valid"` outcome: a well-formed opt-in is still `"unsupported"` while
 * {@link BUDGETED_INTERACTIVE_QUERY_SUPPORTED} is false. The amount is still parsed and bounds-checked
 * so the refusal can say which of the two problems it is — a malformed budget or an unimplemented
 * mode — and so a future implementation inherits the validation rather than the `> 0` test.
 */
export function interactiveQueryOptIn(env: NodeJS.ProcessEnv = process.env): InteractiveQueryOptIn {
  if (env.STAGING_QUERY_LLM_ENABLED !== "true") {
    return { optedIn: false, status: "not-requested", budgetUsd: null, reason: null };
  }
  const raw = (env.STAGING_QUERY_LLM_BUDGET_USD ?? "").trim();
  const amount = raw === "" ? Number.NaN : Number(raw);
  if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_INTERACTIVE_BUDGET_USD) {
    return {
      optedIn: true,
      status: "invalid-budget",
      budgetUsd: null,
      reason: `STAGING_QUERY_LLM_BUDGET_USD must be a finite amount in (0, ${MAX_INTERACTIVE_BUDGET_USD}]; Infinity, NaN, blank, zero and negative values are refused`,
    };
  }
  return {
    optedIn: true,
    status: "unsupported",
    budgetUsd: amount,
    reason: `${UNSUPPORTED_BUDGETED_MODE}: no component of this build enforces a dollar ceiling, so a configured budget of ${amount} USD authorises nothing; copied staging answers from direct graph/FTS retrieval with no model calls`,
  };
}

/**
 * Synchronous spend backstop for raw transports which may otherwise fall back to process env keys.
 *
 * In copy scope this returns false for EVERY purpose, including `interactive-query`: see
 * {@link BUDGETED_INTERACTIVE_QUERY_SUPPORTED}. Forced provider keys, a `true` flag and any budget
 * value — finite, `Infinity` or otherwise — all land here.
 */
export function copiedStagingSpendAllowed(
  purpose: "interactive-query" | "background" | "graph-extraction" | "embedding" | "image",
  env: NodeJS.ProcessEnv = process.env
): boolean {
  // `stagingModeFromEnvironment`, not a raw `===`: the central parser TRIMS, and these two
  // synchronous sites compared the untrimmed text, so `STAGING_DATA_MODE=" copy-ready"` classified
  // as not-copy here while every other reader classified it as copy-ready. Parser consistency, not
  // a demonstrated leak — a pinned deployed environment already refuses regardless of whitespace.
  const copyScoped = isPinnedStagingEnvironment(env) || stagingModeFromEnvironment(env) === "copy-ready";
  if (!copyScoped) return true;
  if (purpose !== "interactive-query") return false;
  if (!BUDGETED_INTERACTIVE_QUERY_SUPPORTED) return false;
  // Reached only once an enforced budget contract exists; a well-formed opt-in is necessary then,
  // and still not sufficient on its own — the contract itself has to authorise the call.
  const optIn = interactiveQueryOptIn(env);
  return optIn.optedIn && optIn.status !== "invalid-budget";
}

export function isCopiedStagingRuntime(env: NodeJS.ProcessEnv = process.env): boolean {
  // The second untrimmed site; see `copiedStagingSpendAllowed`.
  return isPinnedStagingEnvironment(env) || stagingModeFromEnvironment(env) === "copy-ready";
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
