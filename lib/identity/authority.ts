import "server-only";

import type { DbClient } from "@/lib/db/types";
import { withBoundedLockWaits } from "@/lib/db/pg/bounded-lock";
import { ambientTransactionClient, runSql, withTransaction } from "@/lib/db/pg/pool";
import { connectorMemberIds } from "@/lib/attribution/resolve-authors";
import { buildIdentityMap, type IdentityMap } from "@/lib/identity/resolve";
import { advanceAuthorizationEpoch } from "@/lib/access/authorization-epoch";

export class IdentitySnapshotChangedError extends Error {
  constructor() {
    super("identity mapping changed during attribution repair; retrying from the current revision");
    this.name = "IdentitySnapshotChangedError";
  }
}

export interface IdentityAuthoritySnapshot {
  teamId: string;
  revision: number;
  repairStatus: "pending" | "running" | "retry" | "awaiting_cache" | "complete";
  cursorItemId: string | null;
  map: IdentityMap;
  connectorIds: ReadonlySet<string>;
}

export async function lockIdentityAuthority(teamId: string): Promise<void> {
  await runSql(`select pg_advisory_xact_lock(hashtextextended($1,0))`, [
    `${teamId}:identity-authority`,
  ]);
}

export interface IdentityMutationBoundaryHooks {
  /** Test-only scheduling point immediately before the first authority lock attempt. */
  beforeAuthorityLocks?: () => Promise<void>;
  /** Test-only scheduling point after every team authority is held, before affected rows. */
  afterAuthorityLocks?: () => Promise<void>;
}

/**
 * Acquire the application-owned identity mutation boundary in a deterministic order.
 *
 * Every writer that can change roster attribution authority (`members`, `member_emails`, or
 * `member_identities`) must enter here before it locks or mutates an affected row. The database
 * trigger deliberately performs revision bookkeeping only; it is not a substitute for this
 * ordering boundary. Sorting matters for the email-login path, which can update the same person
 * across several teams in one transaction.
 *
 * This lower-level form is for an existing transaction whose caller still has work after taking
 * the locks. Prefer `withIdentityMutationBoundary` for ordinary writers.
 */
export async function lockIdentityMutationAuthorities(
  teamIds: readonly string[],
  hooks: IdentityMutationBoundaryHooks = {},
): Promise<readonly string[]> {
  const ordered = [...new Set(teamIds.filter(Boolean))].sort((a, b) => a.localeCompare(b));
  await hooks.beforeAuthorityLocks?.();
  for (const teamId of ordered) await lockIdentityAuthority(teamId);
  await hooks.afterAuthorityLocks?.();
  return ordered;
}

/** Run an identity-authority mutation atomically under the shared, sorted lock boundary. */
export async function withIdentityMutationBoundary<T>(
  teamIds: readonly string[] | string,
  fn: () => Promise<T>,
  hooks: IdentityMutationBoundaryHooks = {},
): Promise<T> {
  const ids = typeof teamIds === "string" ? [teamIds] : teamIds;
  return withTransaction(async () => {
    await lockIdentityMutationAuthorities(ids, hooks);
    return fn();
  });
}

async function ensureAuthorityRow(teamId: string): Promise<void> {
  await runSql(
    `insert into team_identity_authority(
       team_id,revision,repair_revision,repair_status,completed_at
     ) values ($1,1,1,'complete',now()) on conflict (team_id) do nothing`,
    [teamId],
  );
}

/** Build the complete resolver snapshot while holding the same transaction-scoped lock used by
 * every DB-triggered mapping writer. No member/alias/provider/connector read is optional here. */
export async function buildIdentityAuthoritySnapshot(
  db: DbClient,
  teamId: string,
): Promise<IdentityAuthoritySnapshot> {
  return withTransaction(async () => {
    await lockIdentityAuthority(teamId);
    await ensureAuthorityRow(teamId);
    const { rows } = await runSql<{
      revision: string | number;
      repair_revision: string | number;
      repair_status: IdentityAuthoritySnapshot["repairStatus"];
      cursor_item_id: string | null;
    }>(
      `select revision,repair_revision,repair_status,cursor_item_id
         from team_identity_authority where team_id=$1 for update`,
      [teamId],
    );
    const state = rows[0];
    if (!state || Number(state.repair_revision) !== Number(state.revision)) {
      throw new Error("identity authority state is incomplete");
    }
    const [map, connectorIds] = await Promise.all([
      buildIdentityMap(db, teamId, { strict: true }),
      connectorMemberIds(db, teamId, { strict: true }),
    ]);
    return {
      teamId,
      revision: Number(state.revision),
      repairStatus: state.repair_status,
      cursorItemId: state.cursor_item_id,
      map,
      connectorIds,
    };
  });
}

/** Must be called inside the write transaction, before any attribution mutation. */
export async function validateIdentityAuthorityRevision(
  teamId: string,
  revision: number,
): Promise<void> {
  await lockIdentityAuthority(teamId);
  const { rows } = await runSql<{ revision: string | number; repair_revision: string | number }>(
    `select revision,repair_revision from team_identity_authority where team_id=$1 for update`,
    [teamId],
  );
  if (!rows[0]
      || Number(rows[0].revision) !== revision
      || Number(rows[0].repair_revision) !== revision) {
    throw new IdentitySnapshotChangedError();
  }
}

/**
 * ATTRIBUTION REPAIR TURN — the one ownership boundary of the team-wide (common) repair.
 *
 * Every common-repair entry point — the dedicated scheduler, the ingest-chain backstop, the Admin
 * hooks and the manual button — takes this lock first in each of its transactions, BEFORE the
 * identity-authority lock, and never waits for it: a team whose turn is owned elsewhere is `busy`,
 * which is an answer, not a failure. It is transaction-scoped on purpose. The owner holds it for
 * exactly one bounded batch — whose item, version, evidence and cursor writes commit together — or
 * for one finalization, and PostgreSQL releases it at that commit or rollback, including when the
 * owning process dies. Nothing has to notice a crash and nothing has to expire.
 *
 * The lock serializes repair OWNERS only. Identity mutations, Drive commits and corrections do not
 * take it; they queue on the identity-authority lock as before and run between batches. Neither
 * does a REQUEST for a repair (`requestIdentityRepair`): like a mutation it only enqueues, and an
 * enqueue that could be turned away as `busy` would be lost.
 */
export async function tryLockAttributionRepairTurn(teamId: string): Promise<boolean> {
  // A transaction-scoped lock taken outside a transaction is released by the statement that took
  // it: the caller would proceed believing it owned a turn it never held.
  if (!ambientTransactionClient()) {
    throw new Error("an attribution repair turn can only be owned inside a transaction");
  }
  const { rows } = await runSql<{ acquired: boolean | null }>(
    `select pg_try_advisory_xact_lock(hashtextextended($1,0)) as acquired`,
    [`${teamId}:attribution-repair-turn`],
  );
  const acquired = rows[0]?.acquired;
  if (rows.length !== 1 || typeof acquired !== "boolean") {
    throw new Error("attribution repair turn ownership could not be read");
  }
  return acquired;
}

export interface OwnedIdentityRepairState {
  revision: number;
  repairStatus: IdentityAuthoritySnapshot["repairStatus"];
  cursorItemId: string | null;
  /** A recorded failure's retry deadline has not passed yet. */
  deferred: boolean;
}

/**
 * The durable repair state as the turn's owner sees it: read under the identity-authority lock,
 * after ownership. Whatever the caller read before it owned the turn — a snapshot's revision and
 * cursor, a scheduler's discovery — was only a nomination; another owner may have advanced, failed
 * or finished the revision since, and a mutation may have replaced it.
 */
export async function readOwnedIdentityRepairState(teamId: string): Promise<OwnedIdentityRepairState> {
  await lockIdentityAuthority(teamId);
  await ensureAuthorityRow(teamId);
  const { rows } = await runSql<{
    revision: string | number;
    repair_revision: string | number;
    repair_status: IdentityAuthoritySnapshot["repairStatus"];
    cursor_item_id: string | null;
    deferred: boolean | null;
  }>(
    `select revision,repair_revision,repair_status,cursor_item_id,
            (next_attempt_at is not null and next_attempt_at>now()) as deferred
       from team_identity_authority where team_id=$1 for update`,
    [teamId],
  );
  const state = rows[0];
  if (rows.length !== 1 || !state
      || Number(state.repair_revision) !== Number(state.revision)
      || typeof state.deferred !== "boolean") {
    throw new Error("identity authority state is incomplete");
  }
  return {
    revision: Number(state.revision),
    repairStatus: state.repair_status,
    cursorItemId: state.cursor_item_id,
    deferred: state.deferred,
  };
}

/**
 * A REQUEST to repair the team again at its CURRENT revision — the explicit "re-apply the current
 * mappings to what is stored" of the manual button and the direct repair call. Every roster or
 * mapping change enqueues its own repair through the trigger; this is the only other way one is
 * enqueued, and it is just as durable: the revision goes back to `pending` with its cursor and
 * counters cleared, exactly as a new revision starts, and that is COMMITTED — in a transaction of
 * its own — before the snapshot is read or any row is scanned. Attribution-dependent reads are
 * fenced from that commit until the strict finalization, like any other repair.
 *
 * A REQUEST DOES NOT TAKE THE TURN, AND IS NEVER `busy`. It is an enqueue, not a repair: like the
 * trigger's, its write is serialized by the identity-authority lock alone. It must be. A request
 * that had to own the turn would be refused exactly when it matters — while another owner is
 * finalizing — and that owner would then mark the revision complete with nothing durable left to
 * say a rescan was asked for. Instead the request WAITS, for at most one bounded lock wait, behind
 * whoever holds the authority lock — an owner holds it for one batch or one finalization — and is
 * applied to the state that owner committed: a finalization that completed is reopened; a last
 * batch that reached `awaiting_cache` is reopened; and an owner that had not yet begun rereads,
 * under its own turn, a row that is pending again and finalizes nothing. Either way the request
 * is on the authority row before this function returns. A wait that times out is an error the
 * caller is given (55P03), and writes no failure state.
 *
 * The turn still has exactly one owner at a time: this function scans nothing and finalizes
 * nothing. Whoever takes the next turn — this caller, if the turn is free, or the scheduler in any
 * process, after any restart — finds pending work with no cursor.
 *
 * What a request reopens is every state in which the stored cursor is NOT a promise that the rows
 * behind it are right for this request:
 *
 *   complete, awaiting_cache   the scan finished before the request was made;
 *   retry                      the last turn failed. Its cursor may be the end of a finished scan
 *                              (a failed finalization) or anywhere before it, and nothing durable
 *                              says which — so an explicit request starts over rather than trust it.
 *                              It also retries now: a request is not held by a backoff.
 *
 * It does not touch a repair that is `pending` or `running`: that scan is in healthy progress under
 * this same revision, and restarting it would let repeated requests hold a long repair at its first
 * batch forever. And it creates no revision — no mapping changed, and nothing that validated the
 * current one is invalidated.
 *
 * Without a request a finished revision is never reopened: a turn that finds one does nothing.
 */
export async function requestIdentityRepair(teamId: string): Promise<boolean> {
  return withTransaction(() => withBoundedLockWaits(async () => {
    await lockIdentityAuthority(teamId);
    await ensureAuthorityRow(teamId);
    const { rowCount } = await runSql(
      `update team_identity_authority
          set repair_status='pending',cursor_item_id=null,
              items_scanned=0,items_updated=0,versions_updated=0,contributions_updated=0,
              attempts=0,last_error=null,next_attempt_at=null,updated_at=now(),completed_at=null
        where team_id=$1 and repair_revision=revision
          and repair_status in ('complete','awaiting_cache','retry')`,
      [teamId],
    );
    return rowCount > 0;
  }));
}

/** Which turn a team needs next. Unlocked and advisory: it only routes; the turn decides again
 * under ownership. A team with no authority row has never had a mapping change. */
export async function peekIdentityRepairStatus(
  teamId: string,
): Promise<IdentityAuthoritySnapshot["repairStatus"] | null> {
  const { rows } = await runSql<{ repair_status: IdentityAuthoritySnapshot["repairStatus"] }>(
    `select repair_status from team_identity_authority where team_id=$1`,
    [teamId],
  );
  return rows[0]?.repair_status ?? null;
}

/** The owner starts a batch. Called inside the owned transaction, after the reread: the status and
 * the cleared failure commit with the batch, or not at all. A healthy batch is not an attempt —
 * `attempts` counts failures (see `markIdentityRepairRetry`), so a long repair that converges batch
 * by batch does not inflate the backoff a later real failure would get. */
export async function beginIdentityRepairBatch(teamId: string, revision: number): Promise<void> {
  await runSql(
    `update team_identity_authority
        set repair_status='running',last_error=null,next_attempt_at=null,updated_at=now()
      where team_id=$1 and revision=$2 and repair_revision=$2`,
    [teamId, revision],
  );
}

/**
 * Durable failure state for a turn that did not commit. Written by its caller AFTER the failed
 * turn's transaction has rolled back — in a transaction of its own, so the record survives the
 * rollback.
 *
 * It is ALWAYS scoped to the revision the failed turn was working, and there is no unscoped form.
 * Between the rollback and this write the authority lock is free: a mapping change may commit a
 * newer revision, and that revision may even be repaired to completion. A failure recorded against
 * "whatever is current" would then mark the new revision `retry`, give it the old one's error and
 * backoff, and — if it had completed — fence reads that were open and schedule work that is not
 * owed. So this is a no-op when the failed revision is no longer current, and a no-op when the
 * current revision is complete; a turn that failed before it could read which revision it was
 * working records nothing at all.
 */
export async function markIdentityRepairRetry(
  teamId: string,
  revision: number,
  error: unknown,
): Promise<void> {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 1000);
  await withTransaction(async () => {
    await lockIdentityAuthority(teamId);
    await runSql(
      `update team_identity_authority
          set repair_status='retry',attempts=attempts+1,last_error=$3,
              next_attempt_at=now() + (least(3600,power(2,least(attempts+1,10)))::text || ' seconds')::interval,
              updated_at=now()
        where team_id=$1 and revision=$2 and repair_revision=$2 and repair_status<>'complete'`,
      [teamId, revision, message],
    );
  });
}

export async function advanceIdentityRepairCursor(input: {
  teamId: string;
  revision: number;
  itemId: string;
  itemUpdated: number;
  versionsUpdated: number;
  contributionsUpdated: number;
}): Promise<void> {
  // Caller already holds the team lock and validated the revision in this transaction.
  await runSql(
    `update team_identity_authority set
       cursor_item_id=$3,items_scanned=items_scanned+1,
       items_updated=items_updated+$4,versions_updated=versions_updated+$5,
       contributions_updated=contributions_updated+$6,updated_at=now()
     where team_id=$1 and revision=$2 and repair_revision=$2`,
    [input.teamId,input.revision,input.itemId,input.itemUpdated,input.versionsUpdated,input.contributionsUpdated],
  );
}

export async function markIdentityRepairAwaitingCache(teamId: string, revision: number): Promise<void> {
  await withTransaction(async () => {
    await validateIdentityAuthorityRevision(teamId, revision);
    await runSql(
      `update team_identity_authority set repair_status='awaiting_cache',updated_at=now()
        where team_id=$1 and revision=$2 and repair_revision=$2`,
      [teamId, revision],
    );
  });
}

export async function completeIdentityRepair(teamId: string, revision: number): Promise<void> {
  await withTransaction(async () => {
    await validateIdentityAuthorityRevision(teamId, revision);
    const { rowCount } = await runSql(
      `update team_identity_authority set repair_status='complete',last_error=null,next_attempt_at=null,
              completed_at=now(),updated_at=now()
        where team_id=$1 and revision=$2 and repair_revision=$2 and repair_status='awaiting_cache'`,
      [teamId, revision],
    );
    if (rowCount !== 1) throw new IdentitySnapshotChangedError();
    // Completion and the healthy-cache generation become visible atomically. A purge failure leaves
    // the repair incomplete; an older in-flight builder can never publish under this new epoch.
    await advanceAuthorizationEpoch(teamId);
  });
}
