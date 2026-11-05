import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import { canSeeItem } from "@/lib/access/enforce";
import { upsertIntegration } from "@/lib/integrations/manage";
import { ensureProjectGraphPointer } from "@/lib/graph/project-pointer";
import { recordGdriveItemClaim } from "@/lib/projects/context/gdrive-claims";
import { reconcileGdriveItems, stageGdriveReconciliation } from "@/lib/ingest/source-reconcile";
import { runSql } from "@/lib/db/pg/pool";
import { db, driveFixture, seedTeam, type Seed } from "./helpers";

// AIO-1167 R66 — the PostgreSQL side of retained explicit-trash replay freshness.
//
// The claim owner (`reconcileGdriveItems`) receives only a provider id: it cannot tell an obsolete
// trash removal from a current one, so the Google sidecar is the only place freshness can be decided
// (ingestion/tests/test_gdrive_cross_stream_trash.py pins that it re-verifies and never sends the
// obsolete removal). This file pins what reaches the database in each case: with the obsolete
// removal SUPPRESSED, a restoration another worker published — its content, versions and source-time
// contribution evidence — survives later complete reconciliation and the cleanup drain without
// another upsert; REPLAYED, the same removal would retire the restored claim and, on the last one,
// purge the content. Only refused or committed-but-lost removals that left an item behind are
// modelled here; a lost last-claim removal had already purged before the restoration re-created it.

async function audience(seed: Seed, memberId: string, slug: string): Promise<string> {
  const { data: group } = await db().from("groups").insert({
    team_id: seed.teamId, slug: `person-${randomUUID()}`, name: slug, person_member_id: memberId,
  }).select("id").single();
  await db().from("group_members").insert({
    team_id: seed.teamId, group_id: (group as { id: string }).id, member_id: memberId,
  });
  const { data: project } = await db().from("projects").insert({
    team_id: seed.teamId, slug, name: slug, kind: "initiative",
  }).select("id").single();
  const projectId = (project as { id: string }).id;
  await db().from("project_groups").insert({
    team_id: seed.teamId, project_id: projectId, group_id: (group as { id: string }).id,
  });
  const pointer = await ensureProjectGraphPointer(db(), { teamId: seed.teamId, projectId });
  if (!pointer.ok) throw new Error(pointer.error);
  return projectId;
}

async function connection(seed: Seed, name: string, projectId: string): Promise<string> {
  const row = await upsertIntegration(db(), { teamId: seed.teamId, memberId: seed.memberId }, {
    type: "gdrive", name, status: "enabled",
    config: {
      fileIds: ["restored-doc"], folderIds: [], sharedDriveIds: [], recursive: false,
      selectionState: "selected", authMode: "service_account", audienceProjectIds: [projectId],
    },
  });
  return row.id;
}

async function restoredItem(seed: Seed, providerId: string, claims: Array<[string, string]>) {
  const sourceAt = new Date(Date.now() - 3_600_000).toISOString();
  const item = await driveFixture(seed, {
    project: "drive-restored", path: `gdrive/${providerId}.md`, body: `restored body ${providerId}`,
    frontmatter: {
      source: "gdrive", source_id: providerId, title: `Restored ${providerId}`, source_ts: sourceAt,
      authors: [{ provider: "gdrive", external_id: "permission:restorer", role: "editor" }],
      contributions: [{ external_id: "permission:restorer", role: "editor", at: sourceAt }],
    },
  }, { unclaimed: true });
  for (const [integrationId, projectId] of claims) {
    await recordGdriveItemClaim(db(), {
      teamId: seed.teamId, integrationId, providerId, itemId: item.id, generation: 1,
      audienceProjectIds: [projectId],
    });
  }
  return item;
}

async function evidence(teamId: string, itemId: string) {
  const [item, versions, contributions] = await Promise.all([
    runSql<{ body: string }>(`select body from items where id=$1`, [itemId]),
    runSql<{ n: string }>(`select count(*)::text as n from item_versions where item_id=$1`, [itemId]),
    runSql<{ n: string }>(
      `select count(*)::text as n from gdrive_contribution_evidence where team_id=$1 and item_id=$2`,
      [teamId, itemId],
    ),
  ]);
  return {
    body: item.rows[0]?.body ?? null,
    versions: Number(versions.rows[0]?.n ?? 0),
    contributions: Number(contributions.rows[0]?.n ?? 0),
  };
}

async function claimActive(teamId: string, integrationId: string, providerId: string) {
  const { rows } = await runSql<{ active: boolean }>(
    `select active from gdrive_item_claims where team_id=$1 and integration_id=$2 and provider_id=$3`,
    [teamId, integrationId, providerId],
  );
  return rows[0]?.active ?? false;
}

describe("AIO-1167 R66 retained explicit-trash replay (real Postgres)", () => {
  it.each([
    ["refused", "last-claim"],
    ["refused", "other-connection"],
    ["lost", "other-connection"],
  ] as const)(
    "a %s removal never replayed keeps the %s restoration through complete reconciliation and cleanup",
    async (sink, other) => {
      const seed = await seedTeam();
      const { data: peer } = await db().from("members").insert({
        team_id: seed.teamId, email: `${randomUUID()}@test.local`, display_name: "Peer",
        actor_handle: `peer-${randomUUID()}`, role: "member", tier: "team", status: "active",
      }).select("id").single();
      const projectA = await audience(seed, seed.memberId, `restored-a-${sink}-${other}`);
      const projectB = await audience(seed, (peer as { id: string }).id, `restored-b-${sink}-${other}`);
      const connectionA = await connection(seed, `restored-a-${sink}-${other}`, projectA);
      const connectionB = await connection(seed, `restored-b-${sink}-${other}`, projectB);
      const providerId = `restored-doc-${randomUUID()}`;
      const claims: Array<[string, string]> = [[connectionA, projectA]];
      if (other === "other-connection") claims.push([connectionB, projectB]);
      const item = await restoredItem(seed, providerId, claims);

      if (sink === "lost") {
        // W1's removal was COMMITTED, its acknowledgment lost: A's claim was retired…
        await reconcileGdriveItems(db(), seed.teamId, {
          connectionId: connectionA, removedProviderIds: [providerId],
          reason: "Google Drive removal, trash, or access denial",
        });
        expect(await claimActive(seed.teamId, connectionA, providerId)).toBe(false);
      }
      // …and W2's acknowledged restoration records A's claim (the push path), through another file.
      await recordGdriveItemClaim(db(), {
        teamId: seed.teamId, integrationId: connectionA, providerId, itemId: item.id, generation: 1,
        audienceProjectIds: [projectA],
      });
      const restored = await evidence(seed.teamId, item.id);
      expect(restored.body).toContain("restored body");
      expect(restored.versions).toBeGreaterThan(0);

      // The sidecar re-verifies W1's retained trash and supersedes it: NO removal reaches the owner.
      // Later complete reconciliation (the restored document is in A's snapshot) and the cleanup drain.
      await reconcileGdriveItems(db(), seed.teamId, {
        connectionId: connectionA, snapshot: { complete: true, providerIds: [providerId] },
        reason: "complete snapshot",
      });
      expect(await claimActive(seed.teamId, connectionA, providerId)).toBe(true);
      expect(await evidence(seed.teamId, item.id)).toEqual(restored);
      expect(await canSeeItem(db(), { teamId: seed.teamId, memberId: seed.memberId }, item.id)).toBe(true);
      const { rows: queued } = await runSql<{ n: string }>(
        `select count(*)::text as n from gdrive_cleanup_obligations where team_id=$1 and provider_id=$2`,
        [seed.teamId, providerId],
      );
      expect(Number(queued[0]?.n ?? 0)).toBe(0);
    },
  );

  it.each(["last-claim", "other-connection"] as const)(
    "the claim owner cannot tell an obsolete removal apart: replayed (%s), it would retire the restoration",
    async (other) => {
      // The contrast the sidecar gate exists for: given only the provider id, the owner retires the
      // restored claim — and on the last claim stages the content for purge.
      const seed = await seedTeam();
      const { data: peer } = await db().from("members").insert({
        team_id: seed.teamId, email: `${randomUUID()}@test.local`, display_name: "Peer",
        actor_handle: `peer-${randomUUID()}`, role: "member", tier: "team", status: "active",
      }).select("id").single();
      const projectA = await audience(seed, seed.memberId, `obsolete-a-${other}`);
      const projectB = await audience(seed, (peer as { id: string }).id, `obsolete-b-${other}`);
      const connectionA = await connection(seed, `obsolete-a-${other}`, projectA);
      const connectionB = await connection(seed, `obsolete-b-${other}`, projectB);
      const providerId = `obsolete-doc-${randomUUID()}`;
      const claims: Array<[string, string]> = [[connectionA, projectA]];
      if (other === "other-connection") claims.push([connectionB, projectB]);
      const item = await restoredItem(seed, providerId, claims);

      const staged = await stageGdriveReconciliation(db(), seed.teamId, {
        connectionId: connectionA, removedProviderIds: [providerId],
        reason: "Google Drive removal, trash, or access denial",
      });
      expect(await claimActive(seed.teamId, connectionA, providerId)).toBe(false);
      expect(await canSeeItem(db(), { teamId: seed.teamId, memberId: seed.memberId }, item.id)).toBe(false);
      expect(staged.cleanupQueued).toBe(other === "last-claim" ? 1 : 0);
      if (other === "other-connection") {
        expect(await claimActive(seed.teamId, connectionB, providerId)).toBe(true);
      }
    },
  );
});
