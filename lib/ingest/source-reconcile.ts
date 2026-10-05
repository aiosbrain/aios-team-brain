import "server-only";

import type { DbClient } from "@/lib/db/types";
import { runSql, withTransaction } from "@/lib/db/pg/pool";
import { purgeItemIds, type PurgeResult } from "./purge";
import {
  lockGdriveProvider,
  lockGdriveProviders,
  reconcileGdriveItemClaims,
  retireGdriveItemClaim,
} from "@/lib/projects/context/gdrive-claims";
import { advanceAuthorizationEpoch } from "@/lib/access/authorization-epoch";

export interface GdriveReconcileInput {
  connectionId: string;
  removedProviderIds?: string[];
  snapshot?: { complete: boolean; providerIds: string[] };
  reason: string;
}

export interface StagedGdriveReconciliation {
  candidates: number;
  snapshotApplied: boolean;
  cleanupQueued: number;
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
    const selected = input.snapshot?.complete
      ? [...new Set(input.snapshot.providerIds.map((id) => id.trim()).filter(Boolean))]
      : [];
    const { rows } = await runSql<{ provider_id: string }>(
      `select provider_id from gdrive_item_claims
        where team_id=$1 and integration_id=$2 and active
          and (provider_id=any($3::text[])
               or ($4::boolean and not (provider_id=any($5::text[]))))
        order by provider_id`,
      [teamId, connectionId, explicit, snapshotApplied, selected],
    );
    // Same order as Drive ingest: the connection authority (held by the route's execution commit)
    // comes first, then EVERY provider identity this pass will touch, and only then item rows. A
    // provider taken later, between retirements, would wait behind item rows this transaction
    // already holds while an ingest holding that provider waits on one of them.
    await lockGdriveProviders(teamId, rows.map((row) => row.provider_id));
    let cleanupQueued = 0;
    for (const row of rows) {
      const retired = await retireGdriveItemClaim(db, teamId, connectionId, row.provider_id, {
        reason: input.reason,
        actor,
      });
      if (retired.itemId && !retired.survives) cleanupQueued++;
    }
    if (rows.length > 0) await advanceAuthorizationEpoch(teamId);
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
