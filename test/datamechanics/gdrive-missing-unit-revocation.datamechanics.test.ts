import { describe, expect, it } from "vitest";

import { canSeeItem } from "@/lib/access/enforce";
import { authorizationEpoch } from "@/lib/access/authorization-epoch";
import { getPool } from "@/lib/db/pg/pool";
import { drainGdriveCleanupObligations, stageGdriveReconciliation } from "@/lib/ingest/source-reconcile";
import { upsertIntegration } from "@/lib/integrations/manage";
import { backfillTeamContext } from "@/lib/projects/context/backfill";
import { recordGdriveItemClaim } from "@/lib/projects/context/gdrive-claims";
import { reconcileItemUnit } from "@/lib/projects/context/units";
import { approvedAudienceProject, db, driveFixture, seedTeam, type Seed } from "./helpers";

/**
 * AIO-1167 R44 C1 — a claimed document whose context unit is missing (a supported migration state:
 * the audience migration captured legacy units before adoption and deleted them) must not roll back
 * its reconciliation batch.
 *
 * Spec (AC-05/06). In one explicit-removal batch, and in one complete-snapshot batch, a missing-unit
 * claim and an ordinary claim BOTH retire: the transaction commits, cleanup obligations are durable
 * (they survive a "restart" — nothing drained them yet), the authorization epoch advances, and the
 * missing-unit document gets a durable retracted unit — so neither context backfill nor an ordinary
 * unit mirror can make it visible again. Genuine failures still fail (the owner only absorbs a
 * missing unit).
 */

async function world() {
  const seed = await seedTeam();
  const general = await approvedAudienceProject(seed);
  const conn = (await upsertIntegration(db(), { teamId: seed.teamId, memberId: seed.memberId }, {
    type: "gdrive", name: "migrated", status: "enabled",
    config: {
      fileIds: ["doc-orphan", "doc-normal"], folderIds: [], sharedDriveIds: [], recursive: false,
      selectionState: "selected", authMode: "service_account", audienceProjectIds: [general],
    },
  })).id;
  const items: Record<string, string> = {};
  for (const providerId of ["doc-orphan", "doc-normal"]) {
    const item = await driveFixture(seed, {
      project: "drive-storage", path: `gdrive/${providerId}.md`, body: `body of ${providerId}`,
      frontmatter: { source: "gdrive", source_id: providerId },
    }, { unclaimed: true });
    await recordGdriveItemClaim(db(), {
      teamId: seed.teamId, integrationId: conn, providerId, itemId: item.id, generation: 1, audienceProjectIds: [general],
    });
    items[providerId] = item.id;
  }
  // The migrated state: the adopted claim's legacy unit is gone.
  await getPool().query("delete from project_context_units where team_id=$1 and source_item_id=$2", [seed.teamId, items["doc-orphan"]]);
  expect(await canSeeItem(db(), { teamId: seed.teamId, memberId: seed.memberId }, items["doc-normal"])).toBe(true);
  return { seed, conn, items };
}

async function unitState(seed: Seed, itemId: string) {
  const { rows } = await getPool().query<{ state: string }>(
    "select state from project_context_units where team_id=$1 and source_item_id=$2", [seed.teamId, itemId]);
  return rows.map((row) => row.state);
}

async function activeClaims(conn: string) {
  const { rows } = await getPool().query("select provider_id from gdrive_item_claims where integration_id=$1 and active", [conn]);
  return rows;
}

async function obligations(seed: Seed) {
  const { rows } = await getPool().query<{ provider_id: string }>(
    "select provider_id from gdrive_cleanup_obligations where team_id=$1 order by provider_id", [seed.teamId]);
  return rows.map((row) => row.provider_id);
}

describe("a missing context unit does not block revocation (R44 C1, real Postgres)", () => {
  it.each([
    ["an explicit-removal batch", { removedProviderIds: ["doc-orphan", "doc-normal"] }],
    ["a complete-snapshot batch", { snapshot: { complete: true, providerIds: [] } }],
  ] as const)("%s retires both claims, durably and irreversibly", async (_case, input) => {
    const { seed, conn, items } = await world();
    const before = await authorizationEpoch(db(), seed.teamId);

    await stageGdriveReconciliation(db(), seed.teamId, { connectionId: conn, reason: "provider-confirmed removal", ...input });

    expect(await activeClaims(conn)).toEqual([]);
    expect(await authorizationEpoch(db(), seed.teamId)).toBeGreaterThan(before);
    // Durable: queued in the committed transaction, nothing has drained them.
    expect(await obligations(seed)).toEqual(["doc-normal", "doc-orphan"]);
    for (const itemId of Object.values(items)) {
      expect(await canSeeItem(db(), { teamId: seed.teamId, memberId: seed.memberId }, itemId)).toBe(false);
    }
    // The barrier: the missing unit now exists, retracted.
    expect(await unitState(seed, items["doc-orphan"])).toEqual(["retracted"]);

    // Neither backfill nor an ordinary mirror reopens it.
    await backfillTeamContext(db(), seed.teamId);
    expect((await reconcileItemUnit(db(), seed.teamId, items["doc-orphan"])).ok).toBe(true);
    expect(await unitState(seed, items["doc-orphan"])).toEqual(["retracted"]);
    expect(await canSeeItem(db(), { teamId: seed.teamId, memberId: seed.memberId }, items["doc-orphan"])).toBe(false);

    // And the queued cleanup still drains normally afterwards.
    const drained = await drainGdriveCleanupObligations(db(), seed.teamId);
    expect(drained.failed).toBe(0);
  });

  it("retraction is idempotent: retiring the same missing-unit document twice leaves one retracted unit", async () => {
    const { seed, conn, items } = await world();
    await stageGdriveReconciliation(db(), seed.teamId, { connectionId: conn, reason: "r", removedProviderIds: ["doc-orphan"] });
    await recordGdriveItemClaim(db(), {
      teamId: seed.teamId, integrationId: conn, providerId: "doc-orphan", itemId: items["doc-orphan"], generation: 1,
      audienceProjectIds: [(await approvedAudienceProject(seed))],
    }).catch(() => undefined);
    await stageGdriveReconciliation(db(), seed.teamId, { connectionId: conn, reason: "r", removedProviderIds: ["doc-orphan"] });
    expect(await unitState(seed, items["doc-orphan"])).toEqual(["retracted"]);
  });
});
