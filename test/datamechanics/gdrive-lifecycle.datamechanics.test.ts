import { describe, expect, it } from "vitest";
import { approvedAudienceProject, db, ingest, seedTeam, type Seed } from "./helpers";
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
      connection_id: "product-docs",
      source_ts: "2026-09-01T00:00:00Z",
    };
    const first = await ingest(seed, {
      project: "docs-one", path: "gdrive/provider-id-with-case.md", body: "version one",
      access: "team", frontmatter,
    });
    const moved = await ingest(seed, {
      project: "docs-two", path: "gdrive/moved-name.md", body: "version two",
      access: "team", frontmatter,
    });
    expect(moved.id).toBe(first.id);

    await purgeItemIds(db(), seed.teamId, [first.id], "verified Drive access removal");
    const restored = await ingest(seed, {
      project: "docs-two", path: "gdrive/restored.md", body: "restored body",
      access: "team", frontmatter,
    });
    expect(restored.id).toBe(first.id);

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
    const item = await ingest(seed, {
      project: "docs",
      path: "gdrive/revoked.md",
      body: "restricted provider content",
      access: "team",
      frontmatter: {
        source: "gdrive",
        source_id: "RevokedDoc",
        connection_id: conn.id,
        source_ts: "2026-09-01T00:00:00Z",
      },
    });
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
