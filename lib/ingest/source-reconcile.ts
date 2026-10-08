import "server-only";

import type { DbClient } from "@/lib/db/types";
import { runSql, withTransaction } from "@/lib/db/pg/pool";
import { purgeItemIds, type PurgeResult } from "./purge";
import {
  lockGdriveProvider,
  lockGdriveReconciliationSet,
  reconcileGdriveItemClaims,
  retireGdriveItemClaim,
} from "@/lib/projects/context/gdrive-claims";
import { advanceAuthorizationEpoch } from "@/lib/access/authorization-epoch";

/** Provider ids one reconcile request may carry — and so the size of one staged snapshot page. */
export const GDRIVE_SNAPSHOT_PAGE_LIMIT = 10_000;
/** Members one staged snapshot may hold: the ceiling on what a connector can make the brain retain. */
export const GDRIVE_SNAPSHOT_MEMBER_LIMIT = 1_000_000;

/**
 * A complete selection too large for one request. Its membership arrives as pages that all name one
 * snapshot; every page is held in `gdrive_snapshot_members` and establishes nothing. The page
 * marked complete finalizes it: in that one transaction the whole staged membership is checked
 * against the declared total, absence is retired exactly as for a single-request snapshot, and the
 * staged rows are removed.
 */
export interface GdriveStagedSnapshot {
  snapshotId: string;
  /**
   * The execution staging it. Pages staged under another generation are discarded; pages staged
   * under another fence are discarded too, unless this execution proves them with `resume`.
   */
  generation: number;
  fence: number;
  /** Required on the finalizing page: the distinct provider ids in the whole snapshot. */
  total?: number;
  /**
   * A successor execution continuing an upload its predecessor deferred. It states exactly what it
   * believes is held — how many members, and the sha256 of them in byte order, newline-joined. Only
   * if the held rows are that set are they adopted under this fence; a snapshot name alone never
   * carries a predecessor's pages forward.
   */
  resume?: { members: number; digest: string };
  /** Report what is held for this snapshot and change nothing. */
  inspect?: boolean;
}

export interface GdriveReconcileInput {
  connectionId: string;
  removedProviderIds?: string[];
  snapshot?: { complete: boolean; providerIds: string[]; staged?: GdriveStagedSnapshot };
  reason: string;
}

export interface StagedGdriveReconciliation {
  candidates: number;
  snapshotApplied: boolean;
  cleanupQueued: number;
  /** Members held for a staged snapshot that is not finalized yet. */
  snapshotStaged?: number;
}

/** A staged snapshot that cannot be held, or cannot be finalized as the complete set it claims to be. */
export class GdriveSnapshotError extends Error {
  constructor(
    readonly code: "snapshot_incomplete" | "snapshot_too_large" | "snapshot_resume_mismatch",
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** What the brain holds for one staged snapshot of the current generation, under any fence. */
async function heldSnapshot(
  teamId: string,
  connectionId: string,
  staged: GdriveStagedSnapshot,
): Promise<{ members: number; digest: string }> {
  // Byte order ("C") and a newline join: the one canonical form the connector can reproduce.
  const { rows } = await runSql<{ members: string | number; digest: string }>(
    `select count(*)::bigint as members,
            encode(sha256(convert_to(
              coalesce(string_agg(provider_id, E'\\n' order by provider_id collate "C"), ''), 'UTF8')), 'hex') as digest
       from gdrive_snapshot_members
      where team_id=$1 and integration_id=$2 and snapshot_id=$3 and generation=$4`,
    [teamId, connectionId, staged.snapshotId, staged.generation],
  );
  return { members: Number(rows[0]?.members ?? 0), digest: rows[0]?.digest ?? "" };
}

/**
 * Hold one page of a staged snapshot and return how many members the snapshot now has. A connection
 * holds one snapshot: pages of any other, or of an execution that no longer owns the connection,
 * are dropped here, so an abandoned upload is bounded by the next one. A replayed page is the same
 * rows again. The caller's transaction owns all of it — a refusal leaves the staged set as it was.
 *
 * The one way a predecessor's pages survive a change of hands is `resume`: the successor states the
 * exact set it expects to find, and the held rows are adopted under its fence only if they are that
 * set. The route fences every request before it gets here, so an execution whose fence is no longer
 * current can neither stage nor finalize.
 */
async function stageSnapshotPage(
  teamId: string,
  connectionId: string,
  staged: GdriveStagedSnapshot,
  providerIds: readonly string[],
  finalizing: boolean,
): Promise<number> {
  if (staged.inspect) return (await heldSnapshot(teamId, connectionId, staged)).members;
  await runSql(
    `delete from gdrive_snapshot_members
      where team_id=$1 and integration_id=$2 and (snapshot_id<>$3 or generation<>$4)`,
    [teamId, connectionId, staged.snapshotId, staged.generation],
  );
  if (staged.resume) {
    const held = await heldSnapshot(teamId, connectionId, staged);
    if (held.members !== staged.resume.members || held.digest !== staged.resume.digest) {
      throw new GdriveSnapshotError(
        "snapshot_resume_mismatch",
        "the staged Google Drive snapshot is not the membership this execution expected to continue",
        409,
      );
    }
    await runSql(
      `update gdrive_snapshot_members set fence=$5
        where team_id=$1 and integration_id=$2 and snapshot_id=$3 and generation=$4 and fence<>$5`,
      [teamId, connectionId, staged.snapshotId, staged.generation, staged.fence],
    );
  } else {
    await runSql(
      `delete from gdrive_snapshot_members
        where team_id=$1 and integration_id=$2 and snapshot_id=$3 and fence<>$4`,
      [teamId, connectionId, staged.snapshotId, staged.fence],
    );
  }
  if (providerIds.length > 0) {
    await runSql(
      `insert into gdrive_snapshot_members(team_id,integration_id,snapshot_id,generation,fence,provider_id)
       select $1::uuid,$2::uuid,$3::uuid,$4::bigint,$5::bigint,page.provider_id
         from unnest($6::text[]) as page(provider_id)
       on conflict do nothing`,
      [teamId, connectionId, staged.snapshotId, staged.generation, staged.fence, providerIds],
    );
  }
  const { rows } = await runSql<{ count: string | number }>(
    `select count(*)::bigint as count from gdrive_snapshot_members
      where team_id=$1 and integration_id=$2 and snapshot_id=$3`,
    [teamId, connectionId, staged.snapshotId],
  );
  const members = Number(rows[0]?.count ?? 0);
  if (members > GDRIVE_SNAPSHOT_MEMBER_LIMIT) {
    throw new GdriveSnapshotError(
      "snapshot_too_large",
      `a staged Google Drive snapshot holds at most ${GDRIVE_SNAPSHOT_MEMBER_LIMIT} documents`,
      422,
    );
  }
  // Completion is a claim about the whole set. A lost page, or a finalization replayed after its
  // pages were consumed, does not add up to the declared total — and then nothing is absent.
  if (finalizing && members !== staged.total) {
    throw new GdriveSnapshotError(
      "snapshot_incomplete",
      `staged Google Drive snapshot holds ${members} of ${staged.total ?? "an undeclared number of"} documents`,
      409,
    );
  }
  return members;
}

/** Short authoritative phase. No graph call or physical item/cache deletion is allowed here. */
export async function stageGdriveReconciliation(
  db: DbClient,
  teamId: string,
  input: GdriveReconcileInput,
  actor: { memberId?: string | null; apiKeyId?: string | null } = {},
): Promise<StagedGdriveReconciliation> {
  const connectionId = input.connectionId.trim();
  if (!connectionId) throw new Error("gdrive reconciliation requires a connection id");

  return withTransaction(async () => {
    const snapshotApplied = input.snapshot?.complete === true;
    const explicit = [...new Set((input.removedProviderIds ?? []).map((id) => id.trim()).filter(Boolean))];
    const staged = input.snapshot?.staged;
    const pageIds = input.snapshot
      ? [...new Set(input.snapshot.providerIds.map((id) => id.trim()).filter(Boolean))]
      : [];
    // A staged page is held before anything is decided, and decides nothing unless it finalizes.
    const snapshotStaged = staged
      ? await stageSnapshotPage(teamId, connectionId, staged, pageIds, snapshotApplied)
      : undefined;
    const selected = snapshotApplied && !staged ? pageIds : [];
    const { rows } = staged && snapshotApplied
      // The same absence rule, read against the staged membership instead of one request's array.
      ? await runSql<{ provider_id: string }>(
          `select c.provider_id from gdrive_item_claims c
            where c.team_id=$1 and c.integration_id=$2 and c.active
              and (c.provider_id=any($3::text[])
                   or not exists (
                     select 1 from gdrive_snapshot_members s
                      where s.team_id=c.team_id and s.integration_id=c.integration_id
                        and s.snapshot_id=$4 and s.provider_id=c.provider_id))
            order by c.provider_id`,
          [teamId, connectionId, explicit, staged.snapshotId],
        )
      : await runSql<{ provider_id: string }>(
          `select provider_id from gdrive_item_claims
            where team_id=$1 and integration_id=$2 and active
              and (provider_id=any($3::text[])
                   or ($4::boolean and not (provider_id=any($5::text[]))))
            order by provider_id`,
          [teamId, connectionId, explicit, snapshotApplied, selected],
        );
    // Same order as Drive ingest: the connection authority and audience project rows (held by the
    // route's execution commit) come first, then EVERY provider identity this pass will touch and
    // its mapping row, then every item-attribution advisory and the complete set of item rows, both
    // in id order — all before the first retirement. A provider, advisory or item taken later,
    // between retirements, would wait behind item rows this transaction already holds while an
    // ingest or correction holding it waits on one of them.
    await lockGdriveReconciliationSet(teamId, connectionId, rows.map((row) => row.provider_id));
    let cleanupQueued = 0;
    for (const row of rows) {
      const retired = await retireGdriveItemClaim(db, teamId, connectionId, row.provider_id, {
        reason: input.reason,
        actor,
      });
      if (retired.itemId && !retired.survives) cleanupQueued++;
    }
    if (rows.length > 0) await advanceAuthorizationEpoch(teamId);
    if (!staged) return { candidates: rows.length, snapshotApplied, cleanupQueued };
    if (!snapshotApplied) return { candidates: rows.length, snapshotApplied, cleanupQueued, snapshotStaged };
    // Finalized: the membership has been applied and commits with its own removal.
    await runSql(
      `delete from gdrive_snapshot_members where team_id=$1 and integration_id=$2`,
      [teamId, connectionId],
    );
    return { candidates: rows.length, snapshotApplied, cleanupQueued };
  });
}

interface CleanupRow {
  provider_id: string;
  item_id: string;
  reason: string;
  actor_member_id: string | null;
  actor_api_key_id: string | null;
}

/** Retry physical cleanup after suppression commits, rechecking restoration under the provider lock. */
export async function drainGdriveCleanupObligations(
  db: DbClient,
  teamId: string,
  limit = 100,
  testHooks: { purgeItemIds?: typeof purgeItemIds } = {},
): Promise<PurgeResult & { pending: number; restored: number; failed: number }> {
  const { rows: queued } = await runSql<{ provider_id: string }>(
    `select provider_id from gdrive_cleanup_obligations
      where team_id=$1 order by updated_at,provider_id limit $2`,
    [teamId, limit],
  );
  let items = 0;
  let episodes = 0;
  let restored = 0;
  let failed = 0;
  for (const queuedRow of queued) {
    try {
      const result = await withTransaction(async () => {
        await lockGdriveProvider(teamId, queuedRow.provider_id);
        const { rows } = await runSql<CleanupRow>(
          `select provider_id,item_id,reason,actor_member_id,actor_api_key_id
             from gdrive_cleanup_obligations
            where team_id=$1 and provider_id=$2 for update`,
          [teamId, queuedRow.provider_id],
        );
        const obligation = rows[0];
        if (!obligation) return { items: 0, episodes: 0, restored: false };
        const { rows: activeRows } = await runSql<{ active: boolean }>(
          `select exists(select 1 from gdrive_item_claims
                          where team_id=$1 and provider_id=$2 and item_id=$3 and active) as active`,
          [teamId, obligation.provider_id, obligation.item_id],
        );
        if (activeRows[0]?.active) {
          await reconcileGdriveItemClaims(db, teamId, obligation.item_id);
          await runSql(
            `delete from gdrive_cleanup_obligations where team_id=$1 and provider_id=$2`,
            [teamId, obligation.provider_id],
          );
          return { items: 0, episodes: 0, restored: true };
        }
        const purged = await (testHooks.purgeItemIds ?? purgeItemIds)(db, teamId, [obligation.item_id], obligation.reason, {
          actor: {
            memberId: obligation.actor_member_id,
            apiKeyId: obligation.actor_api_key_id,
          },
          scope: `gdrive:${obligation.provider_id}`,
          requireCachePurge: true,
        });
        await runSql(
          `delete from gdrive_cleanup_obligations where team_id=$1 and provider_id=$2`,
          [teamId, obligation.provider_id],
        );
        return { ...purged, restored: false };
      });
      items += result.items;
      episodes += result.episodes;
      if (result.restored) restored++;
    } catch (error) {
      failed++;
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
      await runSql(
        `update gdrive_cleanup_obligations
            set attempt_count=attempt_count+1,last_error=$3,updated_at=now()
          where team_id=$1 and provider_id=$2`,
        [teamId, queuedRow.provider_id, message],
      ).catch(() => undefined);
    }
  }
  const { rows: pendingRows } = await runSql<{ count: string | number }>(
    `select count(*)::bigint as count from gdrive_cleanup_obligations where team_id=$1`,
    [teamId],
  );
  return { items, episodes, restored, failed, pending: Number(pendingRows[0]?.count ?? 0) };
}

/** Convenience for non-route callers: stage first, then drain in a distinct transaction. */
export async function reconcileGdriveItems(
  db: DbClient,
  teamId: string,
  input: GdriveReconcileInput,
  actor: { memberId?: string | null; apiKeyId?: string | null } = {},
): Promise<PurgeResult & StagedGdriveReconciliation & { pending: number; restored: number; failed: number }> {
  const staged = await stageGdriveReconciliation(db, teamId, input, actor);
  const cleaned = await drainGdriveCleanupObligations(db, teamId);
  return { ...staged, ...cleaned };
}
