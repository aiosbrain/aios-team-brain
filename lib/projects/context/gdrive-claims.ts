import "server-only";

import type { DbClient } from "@/lib/db/types";
import { runSql, withTransaction } from "@/lib/db/pg/pool";
import { reconcileItemUnit, retractItemUnit } from "@/lib/projects/context/units";
import {
  closeGdriveManagedMembership,
  ensureIncludeMembership,
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

/** One serialization key for every mutation of a team's exact Drive provider identity. */
export async function lockGdriveProvider(teamId: string, providerId: string): Promise<void> {
  await runSql(`select pg_advisory_xact_lock(hashtextextended($1, 0))`, [
    `${teamId}:gdrive:${providerId}`,
  ]);
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
    await reconcileGdriveItemClaims(db, teamId, itemId);
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

export async function reconcileGdriveItemClaims(db: DbClient, teamId: string, itemId: string): Promise<void> {
  const unit = await reconcileItemUnit(db, teamId, itemId);
  if (!unit.ok || !unit.unitId) throw new Error(`Drive context unit: ${unit.error ?? "missing"}`);
  const { rows } = await runSql<{ project_id: string }>(
    `select distinct cp.project_id
       from gdrive_item_claims c join gdrive_item_claim_projects cp
         on cp.team_id=c.team_id and cp.integration_id=c.integration_id and cp.provider_id=c.provider_id
      where c.team_id=$1 and c.item_id=$2 and c.active`,
    [teamId, itemId],
  );
  const desired = new Set(rows.map((row) => row.project_id));
  if (desired.size === 0) throw new Error("Drive item has no approved surviving audience claim");
  for (const projectId of desired) {
    const opened = await ensureIncludeMembership(db, teamId, {
      projectId,
      contextUnitId: unit.unitId,
      method: "gdrive_claim",
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
