import "server-only";

import type { DbClient } from "@/lib/db/types";
import { runSql, withTransaction } from "@/lib/db/pg/pool";
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

export async function markIdentityRepairRunning(teamId: string, revision: number): Promise<void> {
  await withTransaction(async () => {
    await validateIdentityAuthorityRevision(teamId, revision);
    await runSql(
      `update team_identity_authority
          set repair_status='running',attempts=attempts+1,last_error=null,next_attempt_at=null,updated_at=now()
        where team_id=$1 and revision=$2 and repair_revision=$2`,
      [teamId, revision],
    );
  });
}

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
          set repair_status='retry',last_error=$3,
              next_attempt_at=now() + (least(3600,power(2,least(attempts,10)))::text || ' seconds')::interval,
              updated_at=now()
        where team_id=$1 and revision=$2 and repair_revision=$2 and repair_status<>'complete'`,
      [teamId, revision, message],
    );
  });
}

/** Snapshot construction can fail before its revision is returned. Record that complete-read
 * failure against whichever revision is still current; the team lock prevents mislabeling a newer
 * mutation that commits concurrently. */
export async function markCurrentIdentityRepairRetry(teamId: string, error: unknown): Promise<void> {
  const message=(error instanceof Error ? error.message : String(error)).slice(0,1000);
  await withTransaction(async()=>{
    await lockIdentityAuthority(teamId);
    await ensureAuthorityRow(teamId);
    await runSql(
      `update team_identity_authority set repair_status='retry',attempts=attempts+1,last_error=$2,
              next_attempt_at=now() + (least(3600,power(2,least(attempts,10)))::text || ' seconds')::interval,
              updated_at=now(),completed_at=null
        where team_id=$1`,
      [teamId,message],
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
