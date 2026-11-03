import { describe, expect, it } from "vitest";

import { getPool } from "@/lib/db/pg/pool";
import { reconcileGdriveItems } from "@/lib/ingest/source-reconcile";
import { upsertIntegration } from "@/lib/integrations/manage";
import { recordGdriveItemClaim } from "@/lib/projects/context/gdrive-claims";
import { approvedAudienceProject, db, driveFixture, seedTeam, type Seed } from "./helpers";

/**
 * AIO-1167 R49 F6 — the D1 complete-snapshot payload against the REAL claim owner (real Postgres).
 *
 * When a bound root is verified lost (D1), the sidecar's next all-stream reconciliation is a
 * COMPLETE snapshot of connection A that simply omits the lost root's documents. The sidecar tests
 * prove that payload's shape with a claim double; this proves what the brain does with it:
 *   · a document A omits but connection B also claims is NOT removed — only A's claim retires, B's
 *     stays active;
 *   · a document only A claimed, and A omits, is removed;
 *   · a document A's snapshot still holds keeps A's claim and its content.
 */

async function connection(seed: Seed, name: string, projectId: string): Promise<string> {
  return (await upsertIntegration(db(), { teamId: seed.teamId, memberId: seed.memberId }, {
    type: "gdrive", name, status: "enabled",
    config: {
      fileIds: [], folderIds: ["root"], sharedDriveIds: [], recursive: true,
      selectionState: "selected", authMode: "service_account", audienceProjectIds: [projectId],
    },
  })).id;
}

async function claimed(seed: Seed, providerId: string, connections: string[], projectId: string): Promise<string> {
  const item = await driveFixture(seed, {
    project: "drive-storage", path: `gdrive/${providerId}.md`, body: `body of ${providerId}`,
    frontmatter: { source: "gdrive", source_id: providerId },
  }, { unclaimed: true });
  for (const integrationId of connections) {
    await recordGdriveItemClaim(db(), {
      teamId: seed.teamId, integrationId, providerId, itemId: item.id, generation: 1, audienceProjectIds: [projectId],
    });
  }
  return item.id;
}

async function activeClaims(integrationId: string): Promise<string[]> {
  const { rows } = await getPool().query<{ provider_id: string }>(
    "select provider_id from gdrive_item_claims where integration_id=$1 and active order by provider_id", [integrationId]);
  return rows.map((row) => row.provider_id);
}

async function exists(itemId: string): Promise<boolean> {
  return (await db().from("items").select("id").eq("id", itemId).maybeSingle()).data !== null;
}

describe("D1 complete snapshot with an overlapping connection (R49 F6, real Postgres)", () => {
  it("retires only connection A's claims; B's claim keeps the shared document", async () => {
    const seed = await seedTeam();
    const project = await approvedAudienceProject(seed);
    const a = await connection(seed, "drive-a", project);
    const b = await connection(seed, "drive-b", project);
    const shared = await claimed(seed, "doc-shared", [a, b], project);   // under A's lost root, and claimed by B
    const onlyA = await claimed(seed, "doc-only-a", [a], project);        // under A's lost root only
    const kept = await claimed(seed, "doc-kept", [a], project);           // under A's surviving root

    // The D1 payload: A's complete snapshot without the lost root's documents.
    await reconcileGdriveItems(db(), seed.teamId, {
      connectionId: a,
      snapshot: { complete: true, providerIds: ["doc-kept"] },
      reason: "complete multi-stream gdrive scope generation 1",
    });

    expect(await activeClaims(a)).toEqual(["doc-kept"]);
    expect(await activeClaims(b)).toEqual(["doc-shared"]);
    expect(await exists(shared)).toBe(true);
    expect(await exists(onlyA)).toBe(false);
    expect(await exists(kept)).toBe(true);
  });
});
