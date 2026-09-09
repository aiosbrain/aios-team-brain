import "server-only";
import { copiedStagingSpendAllowed, interactiveQueryOptIn } from "@/lib/staging/runtime-policy";

/**
 * M9: one vocabulary for "this feature needs a model and this deployment has none".
 *
 * `resolveAnsweringKeys` throws `copied-staging-no-spend` when the central policy denies spend. That
 * is correct as a BACKSTOP and wrong as a caller's first encounter with the state: every eager
 * resolution — arcs, arc recompute, meeting summaries and attendee/action extraction, the schedule
 * backfill, social generation, attribution inference — surfaced it as an unhandled throw, i.e. a
 * generic 500 or a red server action that named nothing an operator could act on.
 *
 * The rule this module exists to make uniform:
 *   - the check happens AFTER authentication, membership and posture resolution, so a refusal never
 *     tells a stranger what mode the deployment is in;
 *   - it happens BEFORE the eager key resolution, and before anything that spends a caller's quota;
 *   - it produces a NAMED outcome, and where a non-model reading exists (cached arcs, stored
 *     summaries) the feature degrades to that reading instead of failing;
 *   - it never substitutes a placeholder key or falls through to process-environment credentials.
 */

export const MODEL_DISABLED_CODE = "answering_disabled";

export const MODEL_DISABLED_MESSAGE =
  "this deployment is a copied staging environment: model-backed answering is disabled; graph-backed and full-text reads remain available";

export type ModelPurpose = Parameters<typeof copiedStagingSpendAllowed>[0];

export interface ModelFeatureVerdict {
  enabled: boolean;
  code: typeof MODEL_DISABLED_CODE | null;
  message: string | null;
  /** Distinguishes an operator whose budgeted opt-in did not take effect from a plain default. */
  posture: "enabled" | "disabled" | "unsupported-budgeted-mode";
}

export function modelFeatureVerdict(
  purpose: ModelPurpose = "interactive-query",
  env: NodeJS.ProcessEnv = process.env
): ModelFeatureVerdict {
  if (copiedStagingSpendAllowed(purpose, env)) {
    return { enabled: true, code: null, message: null, posture: "enabled" };
  }
  const optIn = interactiveQueryOptIn(env);
  const posture = purpose === "interactive-query" && optIn.status !== "not-requested"
    ? "unsupported-budgeted-mode"
    : "disabled";
  return {
    enabled: false,
    code: MODEL_DISABLED_CODE,
    message: posture === "unsupported-budgeted-mode" && optIn.reason ? `${MODEL_DISABLED_MESSAGE} (${optIn.reason})` : MODEL_DISABLED_MESSAGE,
    posture,
  };
}

/** True when a model-backed feature may run. The one call sites should read. */
export function modelFeaturesEnabled(
  purpose: ModelPurpose = "interactive-query",
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return modelFeatureVerdict(purpose, env).enabled;
}

/**
 * The server-action shape. Actions have no HTTP status to carry the state, so they return it —
 * `ok: false` with a code the UI can branch on, rather than a thrown error that renders as a
 * generic failure and looks like a bug in the feature.
 */
export function modelDisabledResult(purpose: ModelPurpose = "interactive-query"): {
  ok: false;
  code: typeof MODEL_DISABLED_CODE;
  error: string;
  posture: ModelFeatureVerdict["posture"];
} {
  const verdict = modelFeatureVerdict(purpose);
  return { ok: false, code: MODEL_DISABLED_CODE, error: verdict.message ?? MODEL_DISABLED_MESSAGE, posture: verdict.posture };
}
