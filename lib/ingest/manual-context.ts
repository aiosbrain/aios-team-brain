import "server-only";
import { adminClient } from "@/lib/db/admin";
import type { DbClient } from "@/lib/db/types";
import { backfillTeamContext } from "@/lib/projects/context/backfill";
import { recordIngestRun } from "@/lib/ingest/runs";

/**
 * AUDITFIX-14 — the ONE bounded project-context pass the manual entry points share.
 *
 * `docs/design/auditfix14-manual-context-reconcile.md`. The scheduler reconciles after its connector
 * legs; chat `/sync` and the four admin "Run now" actions did not, so with `INGEST_POLL_ENABLED=false`
 * a manually-imported item could stay readable by NOBODY indefinitely — memberships are the sole
 * enforcement substrate (CLAUDE.md §5), and nothing else was going to write them.
 *
 * WHAT THIS IS, PRECISELY. One call to the existing `backfillTeamContext` over ONE page of
 * CANDIDATES, after the imports settle. It is not a drain and does not pretend to be one:
 *
 *   • `batchSize: 25` — a manual response WAITS for this work. 25 is a quarter of the scheduler's
 *     page and a twentieth of the helper's 500 default: an engineering work bound, not a measured
 *     optimum and not a wall-clock promise (bootstrap, the candidate SQL and a single reconcile can
 *     each take arbitrarily long). No timeout race, no env knob, no loop.
 *   • `afterId: null` every time, and NO stored manual cursor. A repaired row stops being a
 *     candidate, so repeated manual runs make progress on their own — and the SCHEDULER's durable
 *     cursor (`ingest_runs.meta.cursor` on its own `trigger='scheduler'` rows) is neither read nor
 *     written here.
 *   • NO `createdBefore`. The scheduler's cutoff bounds a multi-batch drain to a fixed corpus; this
 *     is a single query and needs no such fence. It would actively hurt: `ingestItem` stamps
 *     `items.created_at` from the APPLICATION clock, so a Postgres-clock cutoff could exclude the
 *     very item the caller just imported under clock skew.
 *
 * WHAT A RESULT MEANS — the honesty rules the messages exist to keep:
 *   complete → this ELIGIBLE CANDIDATE pass finished. NEVER "all items are visible": excluded,
 *              retracted and standing-decision content is deliberately outside it, and a candidate
 *              committed after the selection statement's snapshot waits for the next pass.
 *   pending  → the 25-candidate limit was reached. More may remain; run it again. (A full final page
 *              still needs one further zero-work pass to establish completion.)
 *   failed   → reconciliation stopped at an item. The import is untouched; a THROW has UNKNOWN
 *              progress — null, never a fabricated zero.
 */

/** One page of candidates per manual invocation. See the header for why this number and not 500. */
export const MANUAL_CONTEXT_BATCH = 25;

/** Which manual surface asked for the pass. `manual_sync` covers both the chat box and the CLI. */
export type ManualContextEntrypoint = "manual_sync" | "slack" | "plane" | "linear" | "github";

export type ManualContextStatus = "complete" | "pending" | "failed";

export interface ManualContextOutcome {
  status: ManualContextStatus;
  /** null = UNKNOWN (the pass threw), never "zero". */
  scanned: number | null;
  unitsCreated: number | null;
  membershipsCreated: number | null;
  /** Informational resume point; `null` means this pass reached the end of its candidate query. */
  cursor: string | null;
  error: string | null;
  /** The shared human-readable line every caller reports. */
  message: string;
}

/** A diagnostic that is always usable — a non-Error throw must not surface as "[object Object]". */
function describeThrow(e: unknown): string {
  if (e instanceof Error && e.message) return e.message;
  if (typeof e === "string" && e.trim()) return e.trim();
  return "the project-context pass threw";
}

function completeMessage(scanned: number, membershipsCreated: number): string {
  return (
    `Project context: reconciled ${scanned} eligible candidate(s), ` +
    `${membershipsCreated} membership(s) created. Content under a standing exclusion, and anything ` +
    `imported after this pass started, is outside it.`
  );
}

function pendingMessage(scanned: number): string {
  return (
    `Project context: reconciled ${scanned} candidate(s), but more project-context work may remain, ` +
    `so some imported content may not be readable yet. Run sync again to continue; the scheduler ` +
    `can also continue this work when enabled.`
  );
}

function failedMessage(error: string, scanned: number | null): string {
  const progress = scanned === null ? "progress is unknown" : `${scanned} candidate(s) were reconciled first`;
  return (
    `Project context: reconciliation failed (${error}) — ${progress}. Imported data was kept, but ` +
    `some imported content may not be readable yet. Run sync again to retry the item it stopped on.`
  );
}

/**
 * Reconcile ONE page of this team's context candidates and report honestly.
 *
 * Never throws: a caller has already imported data by the time this runs, and its own result must
 * survive both a reconciliation failure and a ledger failure.
 */
export async function runManualContextPass(
  teamId: string,
  entrypoint: ManualContextEntrypoint
): Promise<ManualContextOutcome> {
  // The context STAGE start, so the recorded duration excludes the provider imports that preceded it.
  const startedAt = Date.now();
  const db = adminClient();
  const outcome = await onePass(db, teamId);

  // Best-effort ledger row. `ok`/`errors` carry the FAILURE question and `meta.status` carries the
  // BACKLOG question: routine bounded pending work is `ok:true` with no errors, because a bounded
  // pass that succeeded is not an outage and must not feed `pipeline-health`'s failure streak.
  // `trigger` is the literal "manual" — `test/guards/ingest-leg-ledger` does not resolve constants
  // for it — and it keeps these rows out of the scheduler's cursor/staleness reads, which filter
  // `trigger='scheduler'`.
  try {
    await recordIngestRun(db, {
      teamId,
      source: "context_backfill",
      trigger: "manual",
      ok: outcome.status !== "failed",
      created: outcome.membershipsCreated ?? 0,
      errors: outcome.error ? [outcome.error] : [],
      meta: {
        entrypoint,
        status: outcome.status,
        scanned: outcome.scanned,
        unitsCreated: outcome.unitsCreated,
        membershipsCreated: outcome.membershipsCreated,
        cursor: outcome.cursor,
      },
      startedAt,
    });
  } catch {
    // The writer already swallows its own errors; this is the belt for a caller that must keep its
    // message either way. Do not build a logging reliability system here.
  }
  return outcome;
}

async function onePass(db: DbClient, teamId: string): Promise<ManualContextOutcome> {
  let r: Awaited<ReturnType<typeof backfillTeamContext>>;
  try {
    r = await backfillTeamContext(db, teamId, { batchSize: MANUAL_CONTEXT_BATCH, afterId: null });
  } catch (e) {
    const error = describeThrow(e);
    // A throw is not evidence that nothing was written — hence null counts rather than zeros.
    return {
      status: "failed",
      scanned: null,
      unitsCreated: null,
      membershipsCreated: null,
      cursor: null,
      error,
      message: failedMessage(error, null),
    };
  }

  const counts = { scanned: r.scanned, unitsCreated: r.unitsCreated, membershipsCreated: r.membershipsCreated };
  if (!r.ok) {
    const error = r.error ?? "the project-context pass failed";
    return { status: "failed", ...counts, cursor: r.cursor, error, message: failedMessage(error, r.scanned) };
  }
  if (r.cursor !== null) {
    return { status: "pending", ...counts, cursor: r.cursor, error: null, message: pendingMessage(r.scanned) };
  }
  return {
    status: "complete",
    ...counts,
    cursor: null,
    error: null,
    message: completeMessage(r.scanned, r.membershipsCreated),
  };
}

export interface AdminSyncInput {
  /** The provider pass was clean AND not skipped. */
  importOk: boolean;
  importError: string | null;
  /** The provider's own count line, on a clean run. */
  importMessage: string | null;
  context: ManualContextOutcome;
}

/**
 * The `{ ok, error?, message? }` the four admin actions return.
 *
 * ⚠️ WHY PENDING IS `ok:false`. Both consumers — `components/admin/integrations-manager.tsx` and
 * `components/admin/github-repos-panel.tsx` — render `error` on a failed result and the GitHub panel
 * reads NO `message` at all. Remaining context work returned as `{ok:true, message}` would therefore
 * be invisible to the admin who caused it. It leads with "Import succeeded" so a healthy import is
 * never mis-reported as a failed one, and a provider error or a SKIP keeps its own diagnostic and
 * never borrows that phrase.
 */
export function adminSyncResult(input: AdminSyncInput): { ok: boolean; error?: string; message?: string } {
  const { importOk, importError, importMessage, context } = input;
  if (importOk && context.status === "complete") {
    return { ok: true, message: [importMessage, context.message].filter(Boolean).join(" ") };
  }
  const primary = importOk
    ? `Import succeeded${importMessage ? ` — ${importMessage}` : "."}`
    : (importError ?? "The import failed.");
  // BOTH halves, always — neither diagnostic may overwrite the other.
  return { ok: false, error: `${primary} ${context.message}` };
}
