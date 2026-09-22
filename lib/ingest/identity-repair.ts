import "server-only";

import type { DbClient } from "@/lib/db/types";
import { runSql, withTransaction } from "@/lib/db/pg/pool";
import type { IdentityMap } from "@/lib/identity/resolve";
import { resolveItemAuthorMember } from "@/lib/attribution/resolve-authors";
import { syncGdriveContributionEvidence } from "@/lib/ingest/gdrive-contribution-store";
import { purgeTeamLearningCachesStrict } from "@/lib/ingest/reconcile-attribution";
import { advanceAuthorizationEpoch } from "@/lib/access/authorization-epoch";
import {
  buildIdentityAuthoritySnapshot,
  validateIdentityAuthorityRevision,
} from "@/lib/identity/authority";
import { lockItemAttribution } from "@/lib/ingest/item-attribution-lock";

const DEFAULT_BATCH = 100;

interface Obligation {
  team_id: string;
  provider: string;
  external_id: string;
  mapping_revision: string | number;
  cursor_item_id: string | null;
  items_scanned: string | number;
  items_updated: string | number;
  versions_updated: string | number;
  contributions_updated: string | number;
}

function hasRetainedGdriveEvidence(frontmatter: Record<string, unknown>): boolean {
  return frontmatter.source === "gdrive" && (
    (Array.isArray(frontmatter.authors) && frontmatter.authors.length > 0) ||
    (Array.isArray(frontmatter.contributions) && frontmatter.contributions.length > 0)
  );
}

async function currentObligation(obligation: Obligation): Promise<Obligation | null> {
  const { rows } = await runSql<Obligation>(
    `select team_id,provider,external_id,mapping_revision,cursor_item_id,
            items_scanned,items_updated,versions_updated,contributions_updated
       from identity_repair_obligations
      where team_id=$1 and provider=$2 and external_id=$3 and mapping_revision=$4
        and status in ('pending','running','retry')
      for update`,
    [obligation.team_id, obligation.provider, obligation.external_id, obligation.mapping_revision],
  );
  return rows[0] ?? null;
}

async function mappingStillCurrent(obligation: Obligation): Promise<boolean> {
  const { rows } = await runSql<{ revision: string | number }>(
    `select revision from member_identity_mapping_state
      where team_id=$1 and provider=$2 and external_id=$3 for update`,
    [obligation.team_id, obligation.provider, obligation.external_id],
  );
  return Number(rows[0]?.revision) === Number(obligation.mapping_revision);
}

async function repairOneItem(
  db: DbClient,
  teamId: string,
  itemId: string,
  map: IdentityMap,
  connectors: ReadonlySet<string>,
  authorityRevision: number,
): Promise<{ item: number; versions: number; contributions: number }> {
  await lockItemAttribution(teamId,itemId);
  const { rows } = await runSql<{
    id: string;
    member_id: string | null;
    member_id_locked: boolean;
    frontmatter: Record<string, unknown>;
  }>(
    `select id,member_id,member_id_locked,frontmatter from items
      where team_id=$1 and id=$2 for update`,
    [teamId, itemId],
  );
  const item = rows[0];
  if (!item) return { item: 0, versions: 0, contributions: 0 };
  let itemUpdates = 0;
  let versionUpdates = 0;
  if (!item.member_id_locked) {
    const resolved = resolveItemAuthorMember(map, item.frontmatter ?? {}, connectors);
    const next = resolved ?? (hasRetainedGdriveEvidence(item.frontmatter ?? {}) ? null : item.member_id);
    if (next !== item.member_id) {
      const result = await runSql(
        `update items set member_id=$3,updated_at=now()
          where team_id=$1 and id=$2 and member_id_locked=false`,
        [teamId, itemId, next],
      );
      itemUpdates += result.rowCount;
    }
    const { rows: versions } = await runSql<{
      id: string;
      member_id: string | null;
      frontmatter: Record<string, unknown>;
    }>(
      `select v.id,v.member_id,v.frontmatter from item_versions v
        join items i on i.id=v.item_id
       where i.team_id=$1 and i.id=$2 and i.member_id_locked=false
       order by v.created_at,v.id for update of v`,
      [teamId, itemId],
    );
    for (const version of versions) {
      const resolvedVersion = resolveItemAuthorMember(map, version.frontmatter ?? {}, connectors);
      const nextVersion = resolvedVersion ?? (
        hasRetainedGdriveEvidence(version.frontmatter ?? {}) ? null : version.member_id
      );
      if (nextVersion === version.member_id) continue;
      const result = await runSql(`update item_versions set member_id=$2 where id=$1`, [
        version.id, nextVersion,
      ]);
      versionUpdates += result.rowCount;
    }
  }
  const contribution = await syncGdriveContributionEvidence(
    db, teamId, itemId, item.frontmatter ?? {}, map,
    {
      memberIdLocked:item.member_id_locked,memberId:item.member_id,
      authorityRevision,
    },
  );
  return { item: itemUpdates, versions: versionUpdates, contributions: contribution.observed };
}

async function markRetry(obligation: Obligation, error: unknown): Promise<void> {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 1000);
  await runSql(
    `update identity_repair_obligations set status='retry',attempts=attempts+1,last_error=$5,
            next_attempt_at=now() + (least(3600, power(2,least(attempts,10)))::text || ' seconds')::interval,
            updated_at=now()
      where team_id=$1 and provider=$2 and external_id=$3 and mapping_revision=$4
        and status<>'complete'`,
    [obligation.team_id, obligation.provider, obligation.external_id, obligation.mapping_revision, message],
  );
}

/** Drain one revision-fenced repair in bounded item batches. Every batch serializes with the mapping
 * writer, and every item rechecks its correction lock under the item lock before credit changes. */
export async function runIdentityRepairObligation(
  db: DbClient,
  obligation: Obligation,
  opts: { batchSize?: number } = {},
): Promise<{ status: "partial" | "complete" | "obsolete"; scanned: number }> {
  const batchSize = Math.max(1, Math.min(500, opts.batchSize ?? DEFAULT_BATCH));
  try {
    const snapshot = await buildIdentityAuthoritySnapshot(db, obligation.team_id);
    const map = snapshot.map;
    const connectors = snapshot.connectorIds;
    const batch = await withTransaction(async () => {
      // Team-wide snapshot lock/revision always precedes the exact-identity lock.
      await validateIdentityAuthorityRevision(obligation.team_id, snapshot.revision);
      await runSql(`select pg_advisory_xact_lock(hashtextextended($1, 0))`, [
        `${obligation.team_id}:identity:${obligation.provider}:${obligation.external_id}`,
      ]);
      const current = await currentObligation(obligation);
      if (!current) return { status: "obsolete" as const, scanned: 0, finished: false };
      if (!await mappingStillCurrent(current)) {
        await runSql(
          `update identity_repair_obligations set status='obsolete',completed_at=now(),updated_at=now()
            where team_id=$1 and provider=$2 and external_id=$3 and mapping_revision=$4`,
          [current.team_id, current.provider, current.external_id, current.mapping_revision],
        );
        return { status: "obsolete" as const, scanned: 0, finished: false };
      }
      await runSql(
        `update identity_repair_obligations set status='running',attempts=attempts+1,
                last_error=null,next_attempt_at=null,updated_at=now()
          where team_id=$1 and provider=$2 and external_id=$3 and mapping_revision=$4`,
        [current.team_id, current.provider, current.external_id, current.mapping_revision],
      );
      const { rows: candidates } = await runSql<{ id: string }>(
        `select i.id from items i
          where i.team_id=$1 and i.frontmatter->>'source'='gdrive'
            and ($3::uuid is null or i.id>$3::uuid)
            and (
              exists (select 1 from jsonb_array_elements(
                case when jsonb_typeof(i.frontmatter->'authors')='array'
                     then i.frontmatter->'authors' else '[]'::jsonb end
              ) a where a->>'external_id'=$2
                    or ($5::text is not null and lower(a->>'email')=$5))
              or exists (select 1 from jsonb_array_elements(
                case when jsonb_typeof(i.frontmatter->'contributions')='array'
                     then i.frontmatter->'contributions' else '[]'::jsonb end
              ) c where c->>'external_id'=$2
                    or ($5::text is not null and lower(c->>'email')=$5))
            )
          order by i.id limit $4`,
        [
          current.team_id, current.external_id, current.cursor_item_id, batchSize,
          current.external_id.toLowerCase().startsWith("author-email:")
            ? current.external_id.slice("author-email:".length).toLowerCase()
            : null,
        ],
      );
      let itemUpdates = 0;
      let versionUpdates = 0;
      let contributionUpdates = 0;
      for (const candidate of candidates) {
        const result = await repairOneItem(
          db,current.team_id,candidate.id,map,connectors,snapshot.revision,
        );
        itemUpdates += result.item;
        versionUpdates += result.versions;
        contributionUpdates += result.contributions;
      }
      const last = candidates.at(-1)?.id ?? current.cursor_item_id;
      await runSql(
        `update identity_repair_obligations set cursor_item_id=$5,
                items_scanned=items_scanned+$6,items_updated=items_updated+$7,
                versions_updated=versions_updated+$8,contributions_updated=contributions_updated+$9,
                updated_at=now()
          where team_id=$1 and provider=$2 and external_id=$3 and mapping_revision=$4`,
        [current.team_id, current.provider, current.external_id, current.mapping_revision,
          last, candidates.length, itemUpdates, versionUpdates, contributionUpdates],
      );
      return {
        status: "partial" as const,
        scanned: candidates.length,
        finished: candidates.length < batchSize,
      };
    });
    if (batch.status === "obsolete") return batch;
    if (!batch.finished) return { status: "partial", scanned: batch.scanned };

    // A cache rebuild may have started after the mapping mutation's first epoch but before the last
    // item/version repair committed. Fence that in-flight payload now that all durable effects exist;
    // the strict purge below removes every persisted visibility variant before completion.
    await withTransaction(async () => {
      await validateIdentityAuthorityRevision(obligation.team_id, snapshot.revision);
      await advanceAuthorizationEpoch(obligation.team_id);
    });
    // Derived payloads contain names/credit. Delete every visibility variant before completion so
    // cached API/UI/summaries cannot serve the superseded mapping while rebuilding.
    const { rows: teams } = await runSql<{ slug: string }>(
      `select slug from teams where id=$1`, [obligation.team_id],
    );
    await purgeTeamLearningCachesStrict(db, obligation.team_id, teams[0]?.slug ?? "");
    return withTransaction(async () => {
      await validateIdentityAuthorityRevision(obligation.team_id, snapshot.revision);
      await runSql(`select pg_advisory_xact_lock(hashtextextended($1, 0))`, [
        `${obligation.team_id}:identity:${obligation.provider}:${obligation.external_id}`,
      ]);
      if (!await mappingStillCurrent(obligation)) {
        await runSql(
          `update identity_repair_obligations set status='obsolete',completed_at=now(),updated_at=now()
            where team_id=$1 and provider=$2 and external_id=$3 and mapping_revision=$4`,
          [obligation.team_id, obligation.provider, obligation.external_id, obligation.mapping_revision],
        );
        return { status: "obsolete" as const, scanned: batch.scanned };
      }
      await runSql(
        `update identity_repair_obligations set status='complete',completed_at=now(),updated_at=now(),
                last_error=null,next_attempt_at=null
          where team_id=$1 and provider=$2 and external_id=$3 and mapping_revision=$4`,
        [obligation.team_id, obligation.provider, obligation.external_id, obligation.mapping_revision],
      );
      return { status: "complete" as const, scanned: batch.scanned };
    });
  } catch (error) {
    await markRetry(obligation, error).catch(() => {});
    throw error;
  }
}

/** Scheduler/manual drain. Fair by oldest update and bounded by obligations + items per invocation. */
export async function drainIdentityRepairs(
  db: DbClient,
  opts: { maxObligations?: number; batchSize?: number } = {},
): Promise<{ attempted: number; complete: number; partial: number; failed: number }> {
  const max = Math.max(1, Math.min(100, opts.maxObligations ?? 20));
  const { rows } = await runSql<Obligation>(
    `select team_id,provider,external_id,mapping_revision,cursor_item_id,
            items_scanned,items_updated,versions_updated,contributions_updated
       from identity_repair_obligations
      where status in ('pending','running','retry')
        and (next_attempt_at is null or next_attempt_at<=now())
      order by updated_at,team_id,provider,external_id,mapping_revision
      limit $1`,
    [max],
  );
  const summary = { attempted: 0, complete: 0, partial: 0, failed: 0 };
  for (const obligation of rows) {
    summary.attempted++;
    try {
      const result = await runIdentityRepairObligation(db, obligation, { batchSize: opts.batchSize });
      if (result.status === "complete" || result.status === "obsolete") summary.complete++;
      else summary.partial++;
    } catch {
      summary.failed++;
    }
  }
  return summary;
}
