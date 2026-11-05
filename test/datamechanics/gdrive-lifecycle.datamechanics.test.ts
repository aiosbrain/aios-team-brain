import { describe, expect, it } from "vitest";
import { approvedAudienceProject, db, driveFixture, fencedDriveWriter, ingest, seedTeam, type Seed } from "./helpers";
import { purgeItemIds } from "@/lib/ingest/purge";
import { reconcileGdriveItems } from "@/lib/ingest/source-reconcile";
import { recordGdriveItemClaim } from "@/lib/projects/context/gdrive-claims";
import { upsertIntegration } from "@/lib/integrations/manage";

async function connection(seed: Seed): Promise<{ id: string; projectId: string }> {
  const projectId = await approvedAudienceProject(seed);
  const row = await upsertIntegration(db(), { teamId: seed.teamId, memberId: seed.memberId }, {
    type: "gdrive", name: "product-docs", status: "enabled",
    config: { fileIds: [], folderIds: [], sharedDriveIds: [], recursive: false,
      selectionState: "selected", authMode: "service_account", audienceProjectIds: [projectId] },
  });
  return { id: row.id, projectId };
}

describe("AIO-1167 Google Drive stable identity (real Postgres)", () => {
  it("AC-05: exact provider identity survives path/project moves and purge/restore", async () => {
    const seed = await seedTeam();
    const frontmatter = {
      source: "gdrive",
      source_id: "Provider-ID-With-Case",
      source_ts: "2026-09-01T00:00:00Z",
    };
    // The connector's writes go through the fenced commit, the one Drive content-write authority.
    const fenced = await fencedDriveWriter(seed);
    const first = await fenced.push({
      project: "docs-one", path: "gdrive/provider-id-with-case.md", body: "version one", frontmatter,
    });
    const moved = await fenced.push({
      project: "docs-two", path: "gdrive/moved-name.md", body: "version two", frontmatter,
    });
    expect(moved.id).toBe(first.id);
    // The same move through the direct writer is not Drive authority (AIO-1167).
    await expect(ingest(seed, {
      project: "docs-two", path: "gdrive/moved-name.md", body: "direct version",
      access: "team", frontmatter,
    })).rejects.toMatchObject({ code: "connector_principal_required", status: 403 });

    await purgeItemIds(db(), seed.teamId, [first.id], "verified Drive access removal");
    // Nor is a direct restore of the tombstoned document.
    await expect(ingest(seed, {
      project: "docs-two", path: "gdrive/restored.md", body: "direct restore",
      access: "team", frontmatter,
    })).rejects.toMatchObject({ code: "connector_principal_required", status: 403 });
    const restored = await fenced.push({
      project: "docs-two", path: "gdrive/restored.md", body: "restored body", frontmatter,
    });
    expect(restored.id).toBe(first.id);
    expect((await db().from("items").select("body").eq("id", first.id).single()).data)
      .toMatchObject({ body: "restored body" });

    const { data: mapping } = await db()
      .from("source_item_mappings")
      .select("provider_id, item_id, connection_id")
      .eq("team_id", seed.teamId)
      .eq("source", "gdrive")
      .single();
    expect(mapping).toMatchObject({
      provider_id: "Provider-ID-With-Case", item_id: first.id, connection_id: null,
    });
  });

  it("AC-05/06: incomplete snapshots retain content; a positive tombstone purges content and versions", async () => {
    const seed = await seedTeam();
    const conn = await connection(seed);
    // Written by the fenced commit; the claim under test is the one recorded below for `conn`.
    const item = await driveFixture(seed, {
      project: "docs",
      path: "gdrive/revoked.md",
      body: "restricted provider content",
      frontmatter: {
        source: "gdrive",
        source_id: "RevokedDoc",
        source_ts: "2026-09-01T00:00:00Z",
      },
    }, { unclaimed: true, access: "team" });
    await recordGdriveItemClaim(db(), {
      teamId: seed.teamId, integrationId: conn.id, providerId: "RevokedDoc",
      itemId: item.id, generation: 1, audienceProjectIds: [conn.projectId],
    });

    const incomplete = await reconcileGdriveItems(db(), seed.teamId, {
      connectionId: conn.id,
      snapshot: { complete: false, providerIds: [] },
      reason: "incomplete provider listing",
    });
    expect(incomplete.items).toBe(0);
    expect((await db().from("items").select("id").eq("id", item.id).maybeSingle()).data)
      .toMatchObject({ id: item.id });

    const removed = await reconcileGdriveItems(db(), seed.teamId, {
      connectionId: conn.id,
      removedProviderIds: ["RevokedDoc"],
      reason: "provider access revocation",
    });
    expect(removed.items).toBe(1);
    expect((await db().from("items").select("id").eq("id", item.id).maybeSingle()).data).toBeNull();
    expect((await db().from("item_versions").select("id").eq("item_id", item.id)).data).toEqual([]);
  });
});
