import "server-only";

import type { DbClient } from "@/lib/db/types";
import { runSql, withTransaction } from "@/lib/db/pg/pool";
import {
  buildIdentityAuthoritySnapshot,
  advanceIdentityRepairCursor,
  beginIdentityRepairBatch,
  IdentitySnapshotChangedError,
  markIdentityRepairAwaitingCache,
  markIdentityRepairRetry,
  readOwnedIdentityRepairState,
  requestIdentityRepair,
  tryLockAttributionRepairTurn,
  validateIdentityAuthorityRevision,
  type IdentityAuthoritySnapshot,
} from "@/lib/identity/authority";
import { parseAuthorRefs, resolveItemAuthorMember } from "@/lib/attribution/resolve-authors";
import { providerIdentityState } from "@/lib/identity/resolve";
import { syncGdriveContributionEvidence } from "@/lib/ingest/gdrive-contribution-store";
import { lockItemAttribution } from "@/lib/ingest/item-attribution-lock";
import { COMMON_REPAIR_ELIGIBLE, readCommonRepairEligibility } from "@/lib/ingest/repair-eligibility";

/** What one call did with the team's repair turn. */
export type RepairTurn =
  /** It owned the turn and committed one bounded batch. */
  | "scanned"
  /** Another owner holds this team's turn. Not a failure: that owner is making the progress. */
  | "busy"
  /** A recorded failure's retry deadline has not passed (only when the caller honors deadlines). */
  | "deferred"
  /** The scan is finished at this revision; finalization is owed and is a turn of its own. */
  | "awaiting_cache"
  /** This revision is already complete: nothing to do. */
  | "complete";

export interface ReattributeSummary {
  scanned: number;
  updated: number;
  versionsUpdated: number;
  contributionsUpdated: number;
  /** The revision the turn ran at; 0 when the turn was `busy` before any state could be read. */
  revision: number;
  /** The scan is not known to be finished at `revision`. */
  partial: boolean;
  turn: RepairTurn;
}

/**
 * Items per owned batch. The batch is ONE transaction that holds the team's identity-authority lock
 * from its first statement to its commit, so its size bounds how long an identity mutation, a Drive
 * commit, a correction or a cache read on this team can wait behind the repair.
 */
export const REPAIR_TURN_BATCH = 100;

interface ItemRow {
  id: string;
  member_id: string | null;
  member_id_locked: boolean;
  frontmatter: Record<string, unknown>;
}

interface VersionRow {
  id: string;
  member_id: string | null;
  frontmatter: Record<string, unknown>;
}

/** Only a durable, explicit unlink may erase established human credit. An unresolved identity that
 * has never been reviewed remains conservative and leaves prior credit alone. */
function explicitlyUnlinked(
  snapshot: IdentityAuthoritySnapshot,
  frontmatter: Record<string, unknown>,
): boolean {
  return parseAuthorRefs(frontmatter).some((ref) => {
    if (ref.provider && ref.externalId
        && providerIdentityState(snapshot.map, ref.provider, ref.externalId) === "unlinked") return true;
    const email = ref.email?.trim().toLowerCase();
    return Boolean(email && providerIdentityState(snapshot.map, "email-alias", email) === "unlinked");
  });
}

function nextCredit(
  snapshot: IdentityAuthoritySnapshot,
  frontmatter: Record<string, unknown>,
  current: string | null,
): string | null {
  const resolved = resolveItemAuthorMember(snapshot.map, frontmatter, snapshot.connectorIds);
  if (resolved) return resolved;
  const currentDeactivated = Boolean(
    current && snapshot.map.activeMemberIds && !snapshot.map.activeMemberIds.has(current),
  );
  if (current && (
    snapshot.connectorIds.has(current)
    || explicitlyUnlinked(snapshot, frontmatter)
    || (currentDeactivated && parseAuthorRefs(frontmatter).length > 0)
  )) return null;
  return current;
}

/** One atomic, revision-fenced attribution write. All identity, item and version supporting reads
 * complete successfully before their transaction can commit any mutation. */
export async function repairAttributionItem(
  db: DbClient,
  snapshot: IdentityAuthoritySnapshot,
  itemId: string,
  hooks: {
    beforeItemLock?: (itemId: string) => Promise<void>;
    afterItemLock?: (itemId: string) => Promise<void>;
  } = {},
): Promise<{ item: number; versions: number; contributions: number }> {
  return withTransaction(async () => {
    await validateIdentityAuthorityRevision(snapshot.teamId, snapshot.revision);
    await hooks.beforeItemLock?.(itemId);
    await lockItemAttribution(snapshot.teamId,itemId);
    await hooks.afterItemLock?.(itemId);
    const { rows: items } = await runSql<ItemRow>(
      `select id,member_id,member_id_locked,frontmatter
         from items where team_id=$1 and id=$2 for update`,
      [snapshot.teamId, itemId],
    );
    const item = items[0];
    // The candidate read was unlocked: it nominated this item, it did not admit it. Eligibility is
    // decided here, by a statement of its own issued AFTER the row lock was acquired — so it reads
    // the tier of the locked row and whatever mapping is committed now, not what a statement that
    // had to wait for the lock saw when it started. A failed read throws: the transaction rolls
    // back and the cursor does not move.
    const eligible = item ? await readCommonRepairEligibility(snapshot.teamId, itemId) : false;
    if (!item || !eligible) {
      await advanceIdentityRepairCursor({
        teamId: snapshot.teamId, revision: snapshot.revision, itemId,
        itemUpdated: 0, versionsUpdated: 0, contributionsUpdated: 0,
      });
      return { item: 0, versions: 0, contributions: 0 };
    }
    // Read and lock the complete version ledger before deciding or writing either level.
    const { rows: versions } = await runSql<VersionRow>(
      `select v.id,v.member_id,v.frontmatter
         from item_versions v where v.item_id=$1 order by v.created_at,v.id for update`,
      [itemId],
    );
    const itemNext = item.member_id_locked
      ? item.member_id
      : nextCredit(snapshot, item.frontmatter ?? {}, item.member_id);
    const versionNext = item.member_id_locked
      ? []
      : versions.map((version) => ({
        id: version.id,
        current: version.member_id,
        next: nextCredit(snapshot, version.frontmatter ?? {}, version.member_id),
      }));

    let itemUpdated = 0;
    let versionsUpdated = 0;
    if (!item.member_id_locked && itemNext !== item.member_id) {
      const result = await runSql(
        `update items set member_id=$3,updated_at=now()
          where team_id=$1 and id=$2 and member_id_locked=false`,
        [snapshot.teamId,itemId,itemNext],
      );
      itemUpdated = result.rowCount;
    }
    for (const version of versionNext) {
      if (version.next === version.current) continue;
      const result = await runSql(`update item_versions set member_id=$2 where id=$1`, [
        version.id,version.next,
      ]);
      versionsUpdated += result.rowCount;
    }
    const contribution = await syncGdriveContributionEvidence(
      db,snapshot.teamId,itemId,item.frontmatter ?? {},snapshot.map,
      {
        memberIdLocked:item.member_id_locked,memberId:item.member_id,
        authorityRevision:snapshot.revision,
      },
    );
    await advanceIdentityRepairCursor({
      teamId: snapshot.teamId,revision:snapshot.revision,itemId,
      itemUpdated,versionsUpdated,contributionsUpdated:contribution.observed,
    });
    return { item: itemUpdated, versions: versionsUpdated, contributions: contribution.observed };
  });
}

export interface ReattributeOptions {
  batchSize?: number;
  /**
   * This call REQUESTS a repair at the current revision rather than only continuing one: a
   * revision whose scan has finished is durably reopened — committed, with its cursor reset —
   * before anything is scanned (`requestIdentityRepair`). The request is written whether or not
   * this caller then gets the turn. The manual button and the direct `reattributeItems` request;
   * the scheduler, the backstop and the post-mutation hooks do not, because the mutation they
   * follow already enqueued its repair.
   */
  request?: boolean;
  /** A recorded failure's retry deadline defers the turn. The scheduler honors it; an explicit
   * manual repair does not. */
  honorRetryDeadline?: boolean;
  /** Test-only scheduling point: the request has committed; no turn has been asked for yet. */
  afterRequest?: () => Promise<void>;
  /** Test-only scheduling point: the snapshot is built and NOTHING is held. */
  afterSnapshot?: (revision: number) => Promise<void>;
  /** Test-only scheduling point: the turn and the identity authority are held, nothing written. */
  afterOwnership?: () => Promise<void>;
  /** Test-only scheduling point: one item's repair is written, the batch is not committed. */
  afterItem?: (itemId: string) => Promise<void>;
  /** Test-only scheduling point: a failed turn has rolled back and its failure is not yet recorded. */
  beforeFailureRecord?: () => Promise<void>;
}

/**
 * One SCAN TURN of the team-wide repair: at most one bounded batch, owned and atomic.
 *
 * Two transactions, each of which takes the team's repair turn before the identity-authority lock
 * and gives up at once (`busy`) if another owner has it:
 *
 *   1. the complete resolver snapshot, read under the authority lock and then RELEASED — it is the
 *      expensive read, and holding the turn across it would only lengthen what everyone else waits;
 *   2. the batch. Once it owns the turn it rereads the durable state, because the snapshot was only
 *      a nomination: a newer revision throws (the caller retries from the current one; nothing an
 *      old snapshot resolved is published), a revision another owner finished is a no-op, and the
 *      cursor used is the one committed NOW. Every item, version and evidence write of the batch,
 *      its cursor and its status commit together or not at all.
 *
 * A failure rolls the whole batch back; only then is the durable retry state written, in its own
 * transaction. `busy`, a deferred deadline and a healthy partial batch write no failure state.
 *
 * By itself a turn only CONTINUES durable work: a revision it finds complete, or already scanned,
 * is left exactly as it is. With `request` a transaction of its own, before those two, reopens such
 * a revision and commits, so the scan that follows is a scan of durably pending work like any
 * other — a complete revision is never scanned as complete. That request is an enqueue, not a
 * turn: it does not take the turn and cannot be `busy`, so it outlives both a failure of anything
 * that comes after it and another owner holding the turn when it is made.
 */
export async function takeRepairScanTurn(
  db: DbClient,
  teamId: string,
  opts: ReattributeOptions = {},
): Promise<ReattributeSummary> {
  const batchSize = Math.max(1,Math.min(500,opts.batchSize ?? REPAIR_TURN_BATCH));
  const nothing = (turn: RepairTurn, revision: number, partial: boolean): ReattributeSummary => ({
    scanned:0,updated:0,versionsUpdated:0,contributionsUpdated:0,revision,partial,turn,
  });
  if (opts.request) {
    // THE REQUEST IS ITS OWN COMMIT, AND IT IS NOT A TURN. It is durable before this caller even
    // asks whether the turn is free (`requestIdentityRepair`), for two reasons.
    //
    // It must not depend on the snapshot: that is a strict read that can fail, and a request that
    // shared its transaction would be rolled back with it — the row would then be marked `retry`
    // still carrying the finished scan's cursor, and the retry would scan nothing, finalize, and
    // lift the fence over rows nobody revisited.
    //
    // And it must not depend on the turn: another owner may hold it — finalizing — and a request
    // answered `busy` there would leave that owner to mark the revision complete with no record
    // that a rescan was asked for. So the request is written first, behind whoever holds the
    // authority lock, and only then does this caller try for a turn. If the turn is busy the
    // answer below is still `busy`; the difference is that the work is already on the authority
    // row, where the scheduler — in any process, after any restart — finds it without being told.
    //
    // A failure of the request itself enqueued nothing and records nothing: it is simply reported.
    await requestIdentityRepair(teamId);
    await opts.afterRequest?.();
  }
  let nominated: IdentityAuthoritySnapshot | null;
  // The revision this turn is working, as soon as it is known: a failure is recorded against that
  // revision and no other (`markIdentityRepairRetry`).
  const working: { revision: number | null } = { revision: null };
  try {
    nominated=await withTransaction(async () => {
      if (!await tryLockAttributionRepairTurn(teamId)) return null;
      working.revision=(await readOwnedIdentityRepairState(teamId)).revision;
      return buildIdentityAuthoritySnapshot(db,teamId);
    });
  } catch (error) {
    // The snapshot transaction has rolled back and holds nothing. Between here and the record a
    // mapping change can commit a newer revision — and it can be repaired to completion.
    await opts.beforeFailureRecord?.();
    if (working.revision !== null) {
      await markIdentityRepairRetry(teamId,working.revision,error).catch(()=>{});
    }
    throw error;
  }
  if (!nominated) return nothing("busy",0,true);
  const snapshot = nominated;
  try {
    await opts.afterSnapshot?.(snapshot.revision);
    return await withTransaction(async () => {
      if (!await tryLockAttributionRepairTurn(teamId)) return nothing("busy",snapshot.revision,true);
      const state = await readOwnedIdentityRepairState(teamId);
      if (state.revision !== snapshot.revision) throw new IdentitySnapshotChangedError();
      if (state.repairStatus === "complete") return nothing("complete",state.revision,false);
      if (state.repairStatus === "awaiting_cache") return nothing("awaiting_cache",state.revision,false);
      if (opts.honorRetryDeadline && state.deferred) return nothing("deferred",state.revision,true);
      await opts.afterOwnership?.();
      await beginIdentityRepairBatch(teamId,snapshot.revision);
      const owned: IdentityAuthoritySnapshot = {
        ...snapshot,repairStatus:"running",cursorItemId:state.cursorItemId,
      };
      const { rows: candidates } = await runSql<{ id: string }>(
        `select i.id from items i
          where i.team_id=$1 and ${COMMON_REPAIR_ELIGIBLE} and ($2::uuid is null or i.id>$2::uuid)
          order by i.id limit $3`,
        [teamId,owned.cursorItemId,batchSize],
      );
      let updated=0;
      let versionsUpdated=0;
      let contributionsUpdated=0;
      for (const candidate of candidates) {
        const result = await repairAttributionItem(db,owned,candidate.id);
        updated += result.item;
        versionsUpdated += result.versions;
        contributionsUpdated += result.contributions;
        await opts.afterItem?.(candidate.id);
      }
      const partial = candidates.length === batchSize;
      if (!partial) await markIdentityRepairAwaitingCache(teamId,snapshot.revision);
      return {
        scanned:candidates.length,updated,versionsUpdated,contributionsUpdated,
        revision:snapshot.revision,partial,turn:"scanned" as const,
      };
    });
  } catch (error) {
    // The batch has rolled back. A superseded snapshot is not a failure of the current revision.
    if (!(error instanceof IdentitySnapshotChangedError)) {
      await opts.beforeFailureRecord?.();
      await markIdentityRepairRetry(teamId,snapshot.revision,error).catch(() => {});
    }
    throw error;
  }
}

/**
 * The DIRECT form: re-apply the team's current identity mappings to its stored rows, one bounded
 * batch per call. Calling it IS a request — it always was: a team whose revision had already been
 * marked complete (every roster change on a team with nothing yet to repair is) was scanned all the
 * same, which is how rows that predate a rule, or were stored around the attributing route, get put
 * right. The request is now a durable step of its own, committed before the scan and whoever owns
 * the turn (`ReattributeOptions.request`), and a scan in progress is continued, not restarted.
 */
export async function reattributeItems(
  db: DbClient,
  teamId: string,
  opts: ReattributeOptions = {},
): Promise<ReattributeSummary> {
  return takeRepairScanTurn(db,teamId,{ ...opts,request:true });
}
