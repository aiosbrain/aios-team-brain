import "server-only";
import { readStagingRuntimeState } from "@/lib/staging/runtime-policy";

/**
 * AC-07: connector ingestion is disabled on a copied staging deployment — **as a whole operation**,
 * including the manual triggers.
 *
 * `instrumentation.ts` already refuses to start the poller there, and the spend policy already
 * refuses every provider key. Neither covers a manual import: `runManualSync` and the four admin
 * "Run now" actions pull production connectors on demand, and the spend policy has nothing to say
 * about a Slack or GitHub token because that is not model spend.
 *
 * Why this needs its own gate rather than the per-leg refusals underneath it: since AUDITFIX-14 a
 * manual entrypoint runs `import → ONE bounded project-context pass → revalidate`, and the context
 * stage is deliberately NOT conditional on the import succeeding — a thrown leg is not evidence that
 * nothing was committed. That is right for production and wrong for a disabled deployment, where a
 * connector leg refusing is exactly what one expects and must not become the trigger for the rest of
 * a supposedly disabled operation. So the whole operation stops here, before the connector legs, the
 * Linear inbound stage, the context pass and the revalidation — not at each of them.
 *
 * The context pass itself is deterministic Postgres membership work (no provider call, no graph
 * mutation), so this is not a spend refusal and does not use that vocabulary. It refuses the
 * INGESTION, and the reconciliation only because it is one stage of it.
 *
 * Fail-closed exactly like {@link assertCopiedStagingGraphMutationAllowed}: `copy-safe-refusal` —
 * a pinned staging deployment whose marker or journal could not be read — denies too, so an
 * unreadable mode is never permission to import.
 */

export const INGEST_DISABLED_CODE = "ingestion_disabled";

export const INGEST_DISABLED_MESSAGE =
  "this deployment is a copied staging environment: connector ingestion is disabled, so nothing was " +
  "imported, reconciled or revalidated; the copied content stays readable";

export interface ManualIngestionVerdict {
  allowed: boolean;
  code: typeof INGEST_DISABLED_CODE | null;
  message: string | null;
}

/** The one question every manual ingestion entrypoint asks, after it has authorized the caller. */
export async function manualIngestionVerdict(
  env: NodeJS.ProcessEnv = process.env
): Promise<ManualIngestionVerdict> {
  const state = await readStagingRuntimeState(env);
  if (state.mode === "copy-ready" || state.mode === "copy-safe-refusal") {
    return { allowed: false, code: INGEST_DISABLED_CODE, message: INGEST_DISABLED_MESSAGE };
  }
  return { allowed: true, code: null, message: null };
}

/** True when a manual connector import may run at all. */
export async function manualIngestionAllowed(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  return (await manualIngestionVerdict(env)).allowed;
}
