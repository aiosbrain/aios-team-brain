import "server-only";

import type { DbClient } from "@/lib/db/types";
import { acquireWithLockTimeout, withBoundedLockWaits } from "@/lib/db/pg/bounded-lock";
import { runSql, withTransaction } from "@/lib/db/pg/pool";
import { lockItemAttribution } from "@/lib/ingest/item-attribution-lock";
import { reconcileItemUnit, retractItemUnit } from "@/lib/projects/context/units";
import {
  closeGdriveManagedMembership,
  ensureGdriveClaimMembership,
} from "@/lib/projects/context/memberships";
import { advanceAuthorizationEpoch } from "@/lib/access/authorization-epoch";

export interface GdriveClaimInput {
  teamId: string;
  integrationId: string;
  providerId: string;
  itemId: string;
  generation: number;
  audienceProjectIds: readonly string[];
}

const PROVIDER_LOCK = `select pg_advisory_xact_lock(hashtextextended($1, 0))`;
const providerLockKey = (teamId: string, providerId: string) => `${teamId}:gdrive:${providerId}`;

/**
 * One serialization key for every mutation of a team's exact Drive provider identity. The wait is
 * bounded. In the Drive commit order it follows the connection authority and the project rows, and
 * precedes every item-attribution advisory and item row.
 */
export async function lockGdriveProvider(teamId: string, providerId: string): Promise<void> {
  await acquireWithLockTimeout(PROVIDER_LOCK, [providerLockKey(teamId, providerId)]);
}

/**
 * Every provider identity one transaction will mutate, up front and in one deterministic order —
 * for a writer that touches several (source reconciliation). Taking them one at a time between
 * item-row work would put a provider wait behind held item rows, the inverse of ingest.
 */
export async function lockGdriveProviders(teamId: string, providerIds: readonly string[]): Promise<void> {
  const ordered = [...new Set(providerIds)].sort();
  if (ordered.length === 0) return;
  await withBoundedLockWaits(async () => {
    for (const providerId of ordered) await runSql(PROVIDER_LOCK, [providerLockKey(teamId, providerId)]);
  });
}

/**
 * Everything one reconciliation pass locks below its connection and project rows, taken before its
 * first write and in the shared ingest order: every provider identity, their mapping rows, then for
 * the COMPLETE set of items those providers name — this connection's claims and the canonical
 * mappings — every item-attribution advisory in ascending id order, and only then the item rows in
 * the same order. The per-provider retirement that follows only re-enters locks it already holds,
 * so no provider, advisory or item wait ever sits behind a held item row.
 *
 * The advisories are part of the order, not of what reconciliation writes: every other writer of
 * these rows takes advisory → row, and a pass that went straight to the rows would hold a row a
 * correction or ingest is about to ask for while they hold the advisory it never took.
 *
 * The item set is read once the provider keys and mapping rows are held. This connection's claims
 * are written only under their provider key and the mapping rows are locked, so the items the
 * retirement goes on to touch cannot change between that read and their row locks.
 */
export async function lockGdriveReconciliationSet(
  teamId: string,
  integrationId: string,
  providerIds: readonly string[],
): Promise<void> {
  const ordered = [...new Set(providerIds)].sort();
  if (ordered.length === 0) return;
  await lockGdriveProviders(teamId, ordered);
  await withBoundedLockWaits(async () => {
    await runSql(
      `select provider_id from source_item_mappings
        where team_id=$1 and source='gdrive' and provider_id=any($2::text[])
        order by provider_id for update`,
      [teamId, ordered],
    );
    const { rows: named } = await runSql<{ item_id: string }>(
      `select c.item_id from gdrive_item_claims c
        where c.team_id=$1 and c.integration_id=$2 and c.provider_id=any($3::text[])
       union
       select m.item_id from source_item_mappings m
        where m.team_id=$1 and m.source='gdrive' and m.provider_id=any($3::text[])`,
      [teamId, integrationId, ordered],
    );
    const itemIds = [...new Set(named.map((row) => row.item_id))].sort();
    if (itemIds.length === 0) return;
    for (const itemId of itemIds) await lockItemAttribution(teamId, itemId);
    await runSql(
      `select id from items where team_id=$1 and id=any($2::uuid[]) order by id for update`,
      [teamId, itemIds],
    );
  });
}

async function canonicalMappedItem(teamId: string, providerId: string): Promise<string | null> {
  const { rows } = await runSql<{ item_id: string }>(
    `select item_id from source_item_mappings
      where team_id=$1 and source='gdrive' and provider_id=$2 for update`,
    [teamId, providerId],
  );
  return rows[0]?.item_id ?? null;
}

/** Publish/reconnect one connection claim, then derive context solely from all surviving claims. */
export async function recordGdriveItemClaim(db: DbClient, input: GdriveClaimInput): Promise<void> {
  await withTransaction(async () => {
    await lockGdriveProvider(input.teamId, input.providerId);
    const mappedItemId = await canonicalMappedItem(input.teamId, input.providerId);
    if (mappedItemId !== input.itemId) {
      throw new Error("Google Drive claim does not match the canonical provider item");
    }
    const { rows: beforeRows } = await runSql<{ item_id: string; active: boolean; project_ids: string[] }>(
      `select c.item_id,c.active,coalesce(array_agg(cp.project_id order by cp.project_id)
         filter (where cp.project_id is not null),'{}'::uuid[]) as project_ids
         from gdrive_item_claims c left join gdrive_item_claim_projects cp
           on cp.team_id=c.team_id and cp.integration_id=c.integration_id and cp.provider_id=c.provider_id
        where c.team_id=$1 and c.integration_id=$2 and c.provider_id=$3
        group by c.item_id,c.active`,
      [input.teamId, input.integrationId, input.providerId],
    );
    const desiredProjects = [...new Set(input.audienceProjectIds)].sort();
    const before = beforeRows[0];
    const authorityChanged = !before || !before.active || before.item_id !== input.itemId
      || JSON.stringify(before.project_ids ?? []) !== JSON.stringify(desiredProjects);
    const { rows } = await runSql<{ item_id: string }>(
      `insert into gdrive_item_claims(team_id,integration_id,provider_id,item_id,generation)
       values ($1,$2,$3,$4,$5)
       on conflict (team_id,integration_id,provider_id) do update set
         active=true, generation=excluded.generation, last_seen_at=now(), revoked_at=null
       where gdrive_item_claims.item_id=excluded.item_id
       returning item_id`,
      [input.teamId, input.integrationId, input.providerId, input.itemId, input.generation],
    );
    if (rows[0]?.item_id !== input.itemId) {
      throw new Error("Google Drive claim conflicts with the canonical provider item");
    }
    await runSql(
      `delete from gdrive_item_claim_projects
        where team_id=$1 and integration_id=$2 and provider_id=$3`,
      [input.teamId, input.integrationId, input.providerId],
    );
    await runSql(
      `insert into gdrive_item_claim_projects(team_id,integration_id,provider_id,project_id)
       select $1,$2,$3,p.id from projects p
        where p.team_id=$1 and p.id=any($4::uuid[])
       on conflict do nothing`,
      [input.teamId, input.integrationId, input.providerId, desiredProjects],
    );
    await reconcileGdriveItemClaims(db, input.teamId, input.itemId);
    await runSql(
      `delete from gdrive_cleanup_obligations where team_id=$1 and provider_id=$2`,
      [input.teamId, input.providerId],
    );
    if (authorityChanged) await advanceAuthorizationEpoch(input.teamId);
  });
}

/** Retire only this connection's claim. Returns true when another connection still owns the item. */
export async function retireGdriveItemClaim(
  db: DbClient,
  teamId: string,
  integrationId: string,
  providerId: string,
  cleanup: {
    reason: string;
    actor?: { memberId?: string | null; apiKeyId?: string | null };
  },
): Promise<{ itemId: string | null; survives: boolean }> {
  await lockGdriveProvider(teamId, providerId);
  const mappedItemId = await canonicalMappedItem(teamId, providerId);
  const { rows } = await runSql<{ item_id: string }>(
    `update gdrive_item_claims set active=false, revoked_at=now(), last_seen_at=now()
      where team_id=$1 and integration_id=$2 and provider_id=$3 and active
      returning item_id`,
    [teamId, integrationId, providerId],
  );
  const itemId = rows[0]?.item_id ?? null;
  if (!itemId) return { itemId: null, survives: false };
  if (mappedItemId !== itemId) throw new Error("Google Drive claim/mapping identity mismatch");
  const { rows: survivorRows } = await runSql<{ survives: boolean }>(
    `select exists(select 1 from gdrive_item_claims
                    where team_id=$1 and item_id=$2 and active) as survives`,
    [teamId, itemId],
  );
  const survives = survivorRows[0]?.survives === true;
  if (survives) {
    // A survivor whose own connection's audience was narrowed away still retains the content, but
    // places it nowhere; that must not block this connection's revocation.
    await reconcileGdriveItemClaims(db, teamId, itemId, { allowUnplaced: true });
    await runSql(`delete from gdrive_cleanup_obligations where team_id=$1 and provider_id=$2`, [teamId, providerId]);
  } else {
    const retracted = await retractItemUnit(db, teamId, itemId);
    if (!retracted.ok) throw new Error(`Drive visibility suppression failed: ${retracted.error}`);
    await runSql(
      `insert into gdrive_cleanup_obligations(
         team_id,provider_id,item_id,reason,actor_member_id,actor_api_key_id
       ) values ($1,$2,$3,$4,$5,$6)
       on conflict (team_id,provider_id) do update set
         item_id=excluded.item_id,reason=excluded.reason,
         actor_member_id=excluded.actor_member_id,actor_api_key_id=excluded.actor_api_key_id,
         last_error=null,updated_at=now()`,
      [teamId, providerId, itemId, cleanup.reason,
        cleanup.actor?.memberId ?? null, cleanup.actor?.apiKeyId ?? null],
    );
  }
  return { itemId, survives };
}

/**
 * Is claim destination `cp.project_id` still in its connection's CURRENT approved audience
 * (`integrations i`)? A claim records the audience its connection approved when it was last seen;
 * an Admin may narrow that audience afterwards, and the narrowed audience governs at once — a
 * destination the connection no longer approves authorizes nothing, whatever an older claim says.
 * A malformed or missing audience approves nothing (fail closed).
 */
const DESTINATION_STILL_APPROVED = `(i.type = 'gdrive' and exists (
    select 1 from jsonb_array_elements_text(
      case when jsonb_typeof(i.config->'audienceProjectIds') = 'array'
           then i.config->'audienceProjectIds' else '[]'::jsonb end) approved(project_id)
     where lower(approved.project_id) = cp.project_id::text))`;

export interface ReconcileGdriveClaimsOptions {
  /**
   * An item whose surviving claims all name destinations their connections no longer approve is
   * placed NOWHERE (every Drive-managed placement closed, a retraction left standing) instead of
   * failing. For writers that narrow or retire authority: they must never be blocked by a document
   * a narrowed audience left unplaced. A writer publishing a claim leaves this off, so a claim that
   * would place its document nowhere fails its ingest as before.
   */
  allowUnplaced?: boolean;
}

export async function reconcileGdriveItemClaims(
  db: DbClient,
  teamId: string,
  itemId: string,
  opts: ReconcileGdriveClaimsOptions = {},
): Promise<void> {
  // Every destination a surviving claim names that its connection STILL approves, each with the
  // claims behind it. `is_current` marks a claim last recorded under its connection's CURRENT
  // generation by an enabled connection — the only kind that can OPEN a placement (the membership
  // writer re-verifies this itself; the flag here only decides which claim to present to it).
  const { rows } = await runSql<{
    project_id: string;
    integration_id: string;
    provider_id: string;
    is_current: boolean;
  }>(
    `select cp.project_id, c.integration_id, c.provider_id,
            (c.generation = a.generation and i.type = 'gdrive' and i.status = 'enabled') as is_current
       from gdrive_item_claims c
       join gdrive_item_claim_projects cp
         on cp.team_id=c.team_id and cp.integration_id=c.integration_id and cp.provider_id=c.provider_id
       join gdrive_connection_authority a
         on a.team_id=c.team_id and a.integration_id=c.integration_id
       join integrations i
         on i.team_id=c.team_id and i.id=c.integration_id
      where c.team_id=$1 and c.item_id=$2 and c.active and ${DESTINATION_STILL_APPROVED}
      order by cp.project_id, c.integration_id, c.provider_id`,
    [teamId, itemId],
  );
  const desired = new Set(rows.map((row) => row.project_id));
  if (desired.size === 0) {
    const { rows: claimed } = await runSql<{ claimed: boolean }>(
      `select exists(select 1 from gdrive_item_claims
                      where team_id=$1 and item_id=$2 and active) as claimed`,
      [teamId, itemId],
    );
    if (!opts.allowUnplaced || claimed[0]?.claimed !== true) {
      throw new Error("Drive item has no approved surviving audience claim");
    }
  }
  // The one caller that may reverse a retraction — and only when a surviving claim still has an
  // approved destination. Re-derived from those claims alone; a document left unplaced by a narrowed
  // audience keeps whatever suppression it has.
  const unit = await reconcileItemUnit(db, teamId, itemId, { reactivate: desired.size > 0 });
  if (!unit.ok || !unit.unitId) throw new Error(`Drive context unit: ${unit.error ?? "missing"}`);
  const authorizing = new Map<string, { integration_id: string; provider_id: string }>();
  for (const row of rows) {
    if (row.is_current && !authorizing.has(row.project_id)) authorizing.set(row.project_id, row);
  }
  for (const projectId of desired) {
    const claim = authorizing.get(projectId);
    // Named only by a superseded-generation or paused connection: the destination stays in
    // `desired`, so an existing placement is not closed here, but nothing new is opened for it.
    if (!claim) continue;
    // All-or-nothing: one refused destination fails the whole reconcile, and with it the
    // surrounding ingest/revocation transaction — a document is never placed in half its audience.
    const opened = await ensureGdriveClaimMembership(db, teamId, {
      projectId,
      contextUnitId: unit.unitId,
      integrationId: claim.integration_id,
      providerId: claim.provider_id,
    });
    if (!opened.ok) throw new Error(`Drive audience membership: ${opened.error}`);
  }
  const { rows: current } = await runSql<{ project_id: string }>(
    `select project_id from project_context_memberships
      where team_id=$1 and context_unit_id=$2 and valid_to is null
        and decision='include' and method in ('gdrive_claim','ingestion_project')`,
    [teamId, unit.unitId],
  );
  for (const row of current) {
    if (!desired.has(row.project_id)) {
      const closed = await closeGdriveManagedMembership(db, teamId, unit.unitId, row.project_id);
      if (!closed.ok) throw new Error(`Drive audience close: ${closed.error}`);
    }
  }
}

/**
 * Apply a connection's CURRENT approved audience to every document it claims, in the caller's
 * transaction, right after the caller wrote that connection's config.
 *
 * A narrowed audience takes effect when the Admin's save commits — not when each document is next
 * re-ingested, which a paused connection or a document that keeps failing may never do. Every live
 * claim by this connection loses the destinations the connection no longer approves (the claim
 * records only approved grants; a later re-widening restores nothing until a fenced sync records
 * the claim again), and each affected document is re-derived from its surviving claims: the dropped
 * destination's Drive-managed placement closes, another connection's still-approved placement
 * stays, and a document left with no approved destination is placed nowhere. Nothing is opened that
 * a current-generation claim did not already authorize, so this can only narrow. The authorization
 * epoch then advances in the same transaction, so every cache variant built under the wider
 * audience is refused from the commit on. A save that narrows nothing touches nothing.
 *
 * Status-independent by design: a paused or disconnected connection's retained documents are
 * narrowed exactly like an enabled one's.
 *
 * LOCK ORDER. The caller holds the connection rows in the shared Drive connection order (identity
 * authority → integration + connection authority) before it wrote the config. Below them this
 * takes every affected provider identity, mapping row, item-attribution advisory and item row up
 * front, in the source-reconciliation order (`lockGdriveReconciliationSet`). This connection's
 * claims are written only under its connection rows, which the caller holds, so the affected set
 * cannot grow behind that read.
 */
export async function applyGdriveConnectionAudience(
  db: DbClient,
  teamId: string,
  integrationId: string,
): Promise<{ items: number }> {
  return withTransaction(async () => {
    const { rows: planned } = await runSql<{ provider_id: string }>(
      `select distinct c.provider_id
         from gdrive_item_claims c
         join gdrive_item_claim_projects cp
           on cp.team_id=c.team_id and cp.integration_id=c.integration_id and cp.provider_id=c.provider_id
         join integrations i
           on i.team_id=c.team_id and i.id=c.integration_id
        where c.team_id=$1 and c.integration_id=$2 and c.active and not ${DESTINATION_STILL_APPROVED}
        order by c.provider_id`,
      [teamId, integrationId],
    );
    if (planned.length === 0) return { items: 0 };
    const providerIds = planned.map((row) => row.provider_id);
    await lockGdriveReconciliationSet(teamId, integrationId, providerIds);
    const { rows: narrowed } = await runSql<{ provider_id: string }>(
      `delete from gdrive_item_claim_projects cp
        using integrations i
        where cp.team_id=$1 and cp.integration_id=$2 and cp.provider_id=any($3::text[])
          and i.team_id=cp.team_id and i.id=cp.integration_id
          and not ${DESTINATION_STILL_APPROVED}
        returning cp.provider_id`,
      [teamId, integrationId, providerIds],
    );
    const { rows: claims } = await runSql<{ item_id: string }>(
      `select distinct item_id from gdrive_item_claims
        where team_id=$1 and integration_id=$2 and active and provider_id=any($3::text[])
        order by item_id`,
      [teamId, integrationId, [...new Set(narrowed.map((row) => row.provider_id))]],
    );
    for (const { item_id: itemId } of claims) {
      await reconcileGdriveItemClaims(db, teamId, itemId, { allowUnplaced: true });
    }
    if (claims.length > 0) await advanceAuthorizationEpoch(teamId);
    return { items: claims.length };
  });
}
