import "server-only";

import { lockedRevocationEpoch } from "@/lib/access/authorization-epoch";
import { runSql, withTransaction } from "@/lib/db/pg/pool";
import { ContextAuthorization, QueryContextAuthorizationChangedError } from "./context-authorization";

/**
 * AIO-1167 R76 — the durable authorization provenance of one query's OUTPUT (the answer-run, its
 * partial text, the assistant message and the query-log preview), stored as `context_authorization_epoch`.
 *
 *   0         no Google-derived input reached the answer model (positively classified);
 *   positive  the ORIGINAL `ContextAuthorization.epoch`, captured before the authorization and content
 *             reads: the output is source-bearing and readable only while the team's revocation epoch
 *             still equals it;
 *   NULL      (stored only) a historical, pre-contract row — never written by new code.
 *
 * Provenance is decided ONCE, from everything admitted to the model, and frozen before the run is
 * created or the model dispatched. It is never re-derived at persistence time and never refreshed with a
 * later epoch: old text is not blessed by an epoch obtained after it was generated.
 */
export interface OutputProvenance {
  readonly epoch: number;
}

/** Output with no Google-derived model input (user messages, source-free accounting, structural answers). */
export const NON_GOOGLE_OUTPUT: OutputProvenance = Object.freeze({ epoch: 0 });

export function isProtectedOutput(provenance: OutputProvenance): boolean {
  return provenance.epoch > 0;
}

/** Every input admitted to the answer model, by item — or `complete: false` when that cannot be proven. */
export interface ModelInputProvenance {
  readonly itemIds: readonly string[];
  readonly complete: boolean;
}

function assertEpoch(epoch: number): number {
  if (!Number.isSafeInteger(epoch) || epoch < 0) throw new QueryContextAuthorizationChangedError("inconsistent");
  return epoch;
}

/**
 * Classify a captured context's output provenance from ALL model inputs — retrieved sources, the items
 * behind every task/decision line and every graph fact — never from citations or display paths. Any
 * Google-derived input protects the whole answer; unproven inputs, or an item that cannot be found,
 * protect it too (conservative). Google-derived means the item was written by the Drive source
 * (`frontmatter.source = 'gdrive'`) or holds a Drive claim row. The original capture is re-checked AFTER
 * classification, and the result is frozen.
 */
export async function classifyOutputProvenance(
  teamId: string,
  inputs: ModelInputProvenance | undefined,
  authorization: ContextAuthorization,
): Promise<OutputProvenance> {
  if (authorization.teamId !== teamId) throw new QueryContextAuthorizationChangedError("inconsistent");
  const captured = assertEpoch(authorization.epoch);
  if (captured === 0) throw new QueryContextAuthorizationChangedError("inconsistent");
  let google = true;
  if (inputs?.complete) {
    const ids = [...new Set(inputs.itemIds.filter(Boolean))];
    if (ids.length === 0) {
      google = false;
    } else {
      const { rows } = await runSql<{ id: string; google: boolean }>(
        `select i.id,
                (coalesce(i.frontmatter->>'source', '') = 'gdrive'
                 or exists (select 1 from gdrive_item_claims c where c.team_id = i.team_id and c.item_id = i.id)) as google
           from items i
          where i.team_id = $1 and i.id = any($2::uuid[])`,
        [teamId, ids],
      );
      google = rows.length !== ids.length || rows.some((row) => row.google);
    }
  }
  await authorization.assertCurrent();
  return Object.freeze({ epoch: google ? captured : 0 });
}

/**
 * Run source-bearing durable writes inside ONE short transaction linearized against revocation: the
 * revocation epoch is share-locked FIRST (before any run/message/conversation/log row lock), compared
 * with the output's ORIGINAL positive epoch, and the writes commit only while it is unchanged. A
 * revocation that commits first means no output; a publication that locks first makes the revocation
 * wait, after which readers suppress the now-obsolete output. Never held across a model request or
 * stream. Output with provenance 0 takes no epoch lock.
 */
export async function withOutputPublication<T>(
  teamId: string,
  provenance: OutputProvenance,
  fn: () => Promise<T>,
): Promise<T> {
  const expected = assertEpoch(provenance.epoch);
  return withTransaction(async () => {
    if (expected > 0) {
      const current = await lockedRevocationEpoch(teamId);
      if (current !== expected) throw new QueryContextAuthorizationChangedError("changed");
    }
    return fn();
  });
}

/**
 * A durable read at a revocation-linearized epoch: `fn` runs inside a short transaction holding the
 * epoch share lock and receives the current epoch, so what it projects is validated against the state
 * it reads. When the epoch itself cannot be read, `fn` runs with `null` — protected output must then be
 * suppressed, while 0 and completed historical rows stay readable.
 */
export async function withOutputRead<T>(teamId: string, fn: (current: number | null) => Promise<T>): Promise<T> {
  let reached = false;
  try {
    return await withTransaction(async () => {
      const current = await lockedRevocationEpoch(teamId);
      reached = true;
      return fn(current);
    });
  } catch (error) {
    if (!reached) return fn(null);
    throw error;
  }
}

/**
 * Whether stored output may be projected now. `completed` output with NULL (historical) provenance stays
 * readable; a NULL streaming partial does not. 0 is readable. A positive epoch is readable only when it
 * equals the current, verifiable revocation epoch. Anything malformed is not readable.
 */
export function outputReadable(
  stored: unknown,
  current: number | null,
  kind: "completed" | "partial",
): boolean {
  if (stored === null || stored === undefined) return kind === "completed";
  const epoch = typeof stored === "string" ? Number(stored) : stored;
  if (typeof epoch !== "number" || !Number.isSafeInteger(epoch) || epoch < 0) return false;
  if (epoch === 0) return true;
  return current !== null && epoch === current;
}

/** Whether stored output is certified for reuse as model input (history): 0, or the current epoch. */
export function outputReusable(stored: unknown, current: number | null): boolean {
  if (stored === null || stored === undefined) return false;
  return outputReadable(stored, current, "completed");
}
