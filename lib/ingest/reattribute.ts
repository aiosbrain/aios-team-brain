import "server-only";

import type { DbClient } from "@/lib/db/types";
import { runSql, withTransaction } from "@/lib/db/pg/pool";
import {
  buildIdentityAuthoritySnapshot,
  advanceIdentityRepairCursor,
  markIdentityRepairAwaitingCache,
  markCurrentIdentityRepairRetry,
  markIdentityRepairRetry,
  markIdentityRepairRunning,
  validateIdentityAuthorityRevision,
  type IdentityAuthoritySnapshot,
} from "@/lib/identity/authority";
import { parseAuthorRefs, resolveItemAuthorMember } from "@/lib/attribution/resolve-authors";
import { providerIdentityState } from "@/lib/identity/resolve";
import { syncGdriveContributionEvidence } from "@/lib/ingest/gdrive-contribution-store";
import { lockItemAttribution } from "@/lib/ingest/item-attribution-lock";

export interface ReattributeSummary {
  scanned: number;
  updated: number;
  versionsUpdated: number;
  contributionsUpdated: number;
  revision: number;
  partial: boolean;
}

interface ItemRow {
  id: string;
  member_id: string | null;
  member_id_locked: boolean;
  frontmatter: Record<string, unknown>;
  access: string;
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
      `select id,member_id,member_id_locked,frontmatter,access::text as access
         from items where team_id=$1 and id=$2 for update`,
      [snapshot.teamId, itemId],
    );
    const item = items[0];
    if (!item || item.access === "external") {
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

/** Bounded, durable team repair. A mapping change resets the DB cursor and invalidates the snapshot;
 * the caller retries under the new revision rather than letting an old worker publish. */
export async function reattributeItems(
  db: DbClient,
  teamId: string,
  opts: { batchSize?: number; afterSnapshot?: (revision: number) => Promise<void> } = {},
): Promise<ReattributeSummary> {
  const batchSize = Math.max(1,Math.min(500,opts.batchSize ?? 250));
  let snapshot: IdentityAuthoritySnapshot;
  try {
    snapshot=await buildIdentityAuthoritySnapshot(db,teamId);
  } catch (error) {
    await markCurrentIdentityRepairRetry(teamId,error).catch(()=>{});
    throw error;
  }
  try {
    await markIdentityRepairRunning(teamId,snapshot.revision);
    await opts.afterSnapshot?.(snapshot.revision);
    const { rows: candidates } = await runSql<{ id: string }>(
      `select id from items
        where team_id=$1 and access::text<>'external' and ($2::uuid is null or id>$2::uuid)
        order by id limit $3`,
      [teamId,snapshot.cursorItemId,batchSize],
    );
    let updated=0;
    let versionsUpdated=0;
    let contributionsUpdated=0;
    for (const candidate of candidates) {
      const result = await repairAttributionItem(db,snapshot,candidate.id);
      updated += result.item;
      versionsUpdated += result.versions;
      contributionsUpdated += result.contributions;
    }
    const partial = candidates.length === batchSize;
    if (!partial) await markIdentityRepairAwaitingCache(teamId,snapshot.revision);
    return {
      scanned:candidates.length,updated,versionsUpdated,contributionsUpdated,
      revision:snapshot.revision,partial,
    };
  } catch (error) {
    await markIdentityRepairRetry(teamId,snapshot.revision,error).catch(() => {});
    throw error;
  }
}
