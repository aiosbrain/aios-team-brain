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
}

/**
 * COMMON REPAIR ELIGIBILITY — one rule, applied to the bounded candidate selection and again to
 * each item once its attribution advisory and its row are held. `i` is the `items` row.
 *
 * A team-tier row is repairable. An `external` row is not — it is a client's content, and its
 * stored credit is never rewritten from roster state — with ONE exception: a Google Drive document.
 * Drive documents are stored `external` by construction (the unit tier is the conservative one;
 * claim memberships are the authority), so the tier alone would exclude every one of them.
 *
 * What makes an external row a Drive document is the PERSISTED same-team provider mapping, and
 * nothing else. Not its frontmatter, authors or contributions (a pusher writes those), not a
 * connection id on the payload or on the mapping (the mapping's is NULL by design), not an active
 * claim, a live lease or an enabled integration: the mapping is written only by the ingest owner
 * for a provider identity it resolved, and it outlives disconnect and a paired staging restore.
 *
 * THROUGH COMMIT. The recheck takes no provider or mapping lock — either would come after the item
 * row, the inverse of provider → path → attribution → item. It does not need one. `access` is read
 * from the locked row. And a mapping, once it names an item, keeps naming it: `lib/ingest/index.ts`
 * is the only writer, it only ever inserts a row for a provider identity (do-nothing on conflict)
 * and afterwards updates that row's project/path by item id; no application path deletes a mapping
 * or changes its `item_id`, `source` or `team_id`, and the row survives its item's purge as a
 * tombstone (`test/guards/source-item-mapping-stability.test.ts` holds that line). So an
 * eligibility read that is true under the item lock stays true until this transaction ends.
 *
 * The only transition is the other way — an unmapped row gaining a mapping when the ingest owner
 * adopts it. A Drive commit does that under the item's attribution advisory, so it queues behind
 * this repair or is seen by it. A row adopted after the cursor has passed it is not revisited at
 * this revision: it was not a Drive document when the repair looked, and the adopting ingest
 * attributes the current row itself.
 */
const REPAIR_ELIGIBLE = `(i.access::text <> 'external' or exists (
  select 1 from source_item_mappings m
   where m.team_id = i.team_id and m.item_id = i.id and m.source = 'gdrive'))`;

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
    let eligible = false;
    if (item) {
      const { rows: eligibility } = await runSql<{ eligible: boolean | null }>(
        `select ${REPAIR_ELIGIBLE} as eligible from items i where i.team_id=$1 and i.id=$2`,
        [snapshot.teamId, itemId],
      );
      const answer = eligibility[0]?.eligible;
      if (eligibility.length !== 1 || typeof answer !== "boolean") {
        throw new Error("repair eligibility could not be read for a locked item");
      }
      eligible = answer;
    }
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
      `select i.id from items i
        where i.team_id=$1 and ${REPAIR_ELIGIBLE} and ($2::uuid is null or i.id>$2::uuid)
        order by i.id limit $3`,
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
