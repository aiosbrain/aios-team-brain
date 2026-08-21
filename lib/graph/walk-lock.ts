import "server-only";
import { getPool } from "@/lib/db/pg/pool";

/**
 * Cross-instance lease for one team's projection pass (walk + reconcile) — TICKFIT-2, Codex diff
 * review H1.
 *
 * The projector's in-process `inFlight` single-flight cannot see a second brain instance, and a
 * Railway deploy overlap runs two. Two instances walking the same unconverged page both read
 * "missing / stale ledger" and both push — and the ledger cannot stop that, because the `''`
 * reservation sentinel is BY DESIGN read as "never landed, re-push" (that is reconcile's re-queue
 * mechanism). Graphiti does not dedupe, so the duplicate facts and the extraction spend are
 * permanent. That race predates TICKFIT-2 (its window was one item's push duration); the page
 * snapshot would have widened it to "every item the other instance finishes while this one walks
 * the page". This lease closes the class rather than the widening.
 *
 * Mechanism: a Postgres SESSION advisory lock held on a dedicated pooled client for the pass. The
 * client is checked out but NOT in a transaction, so the pool's idle-in-transaction reaper does not
 * apply; if the instance dies, its backend dies and the lock releases — lease semantics with no
 * expiry bookkeeping. `pg_try_advisory_lock` never blocks: a locked-out team is SKIPPED this tick
 * and counted (`lockedOut` → ingest_runs meta → the recording gate), never silently.
 *
 * Release discipline: the unlock must run on the SAME connection; if it fails, the client is
 * DESTROYED (`release(err)`) rather than returned — a pooled connection carrying a leaked session
 * lock would lock every later caller out of that team until the pool recycled it.
 */
export const GRAPH_PROJECTION_LOCK_NS = 7_341_002; // arbitrary fixed namespace for the 2-arg advisory lock

export interface ProjectionLease {
  release(): Promise<void>;
}

export async function acquireProjectionLease(teamId: string): Promise<ProjectionLease | null> {
  const client = await getPool().connect();
  let acquired = false;
  try {
    const { rows } = await client.query<{ ok: boolean }>(
      "select pg_try_advisory_lock($1::int, hashtext($2::text)) as ok",
      [GRAPH_PROJECTION_LOCK_NS, teamId]
    );
    acquired = rows[0]?.ok === true;
  } finally {
    if (!acquired) client.release();
  }
  if (!acquired) return null;
  return {
    async release() {
      try {
        await client.query("select pg_advisory_unlock($1::int, hashtext($2::text))", [GRAPH_PROJECTION_LOCK_NS, teamId]);
        client.release();
      } catch (err) {
        client.release(err instanceof Error ? err : new Error(String(err)));
      }
    },
  };
}
