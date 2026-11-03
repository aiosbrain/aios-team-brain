import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";

import { POST as executionPOST } from "@/app/api/v1/integrations/gdrive/execution/route";
import { POST as reconcilePOST } from "@/app/api/v1/items/source-reconcile/route";
import { canSeeItem } from "@/lib/access/enforce";
import type { ApiAuth } from "@/lib/api/auth";
import { getPool } from "@/lib/db/pg/pool";
import { ensureProjectGraphPointer } from "@/lib/graph/project-pointer";
import { provisionGdriveConnectorPrincipal, withGdriveExecutionCommit } from "@/lib/integrations/gdrive-authority";
import { upsertIntegration } from "@/lib/integrations/manage";
import { recordGdriveItemClaim } from "@/lib/projects/context/gdrive-claims";
import { db, driveFixture, seedTeam, type Seed } from "./helpers";

/**
 * AIO-1167 R44 C2 — losing an audience grant (or the destination itself) never blocks REVOCATION.
 *
 * Spec (AC-05/06/07). A connection whose audience is P1+P2 has claimed a document. When P1 loses its
 * grant — or P1 is deleted — before the sidecar acquires an execution, or while it holds one:
 *   · the execution can still be acquired (it is how removals reach the brain);
 *   · a provider-confirmed removal is applied: the document leaves every audience of that
 *     connection, the authorization epoch advances and cleanup is queued/drained;
 *   · CONTENT publication stays grant-validated: a publish commit is refused with the non-terminal
 *     `audience_unavailable` (the sidecar keeps that one document and continues);
 *   · a surviving, still-authorized claim from ANOTHER connection keeps its own audience.
 */

async function member(seed: Seed): Promise<string> {
  const { data } = await db().from("members").insert({
    team_id: seed.teamId, email: `${randomUUID()}@test.local`, display_name: "Reader",
    actor_handle: `reader-${randomUUID().slice(0, 8)}`, role: "member", tier: "team", status: "active",
  }).select("id").single();
  return (data as { id: string }).id;
}

/** A project only `memberId` can read, through its own person group. */
async function privateAudience(seed: Seed, memberId: string, slug: string): Promise<string> {
  const { data: group } = await db().from("groups").insert({
    team_id: seed.teamId, slug: `person-${randomUUID()}`, name: slug, person_member_id: memberId,
  }).select("id").single();
  await db().from("group_members").insert({ team_id: seed.teamId, group_id: (group as { id: string }).id, member_id: memberId });
  const { data: project } = await db().from("projects").insert({
    team_id: seed.teamId, slug: `${slug}-${randomUUID().slice(0, 6)}`, name: slug, kind: "initiative",
  }).select("id").single();
  const projectId = (project as { id: string }).id;
  await db().from("project_groups").insert({ team_id: seed.teamId, project_id: projectId, group_id: (group as { id: string }).id });
  const pointer = await ensureProjectGraphPointer(db(), { teamId: seed.teamId, projectId });
  if (!pointer.ok) throw new Error(pointer.error);
  return projectId;
}

async function connection(seed: Seed, name: string, audience: string[]): Promise<string> {
  const row = await upsertIntegration(db(), { teamId: seed.teamId, memberId: seed.memberId }, {
    type: "gdrive", name, status: "enabled",
    config: {
      fileIds: ["shared-doc"], folderIds: [], sharedDriveIds: [], recursive: false,
      selectionState: "selected", authMode: "service_account", audienceProjectIds: audience,
    },
  });
  return row.id;
}

function post(url: string, key: string, team: string, body: unknown) {
  return new Request(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "X-AIOS-Team": team, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }) as NextRequest;
}

async function epoch(teamId: string): Promise<number> {
  const { rows } = await getPool().query<{ epoch: string }>("select epoch from team_authorization_epochs where team_id=$1", [teamId]);
  return rows[0] ? Number(rows[0].epoch) : 1;
}

interface World {
  seed: Seed; readerP1: string; readerP2: string; p1: string; p2: string; conn: string; itemId: string;
  key: string; connectorMemberId: string; apiKeyId: string;
}

async function world(): Promise<World> {
  const seed = await seedTeam();
  await db().from("members").update({ role: "admin" }).eq("id", seed.memberId).eq("team_id", seed.teamId);
  const readerP1 = await member(seed);
  const readerP2 = await member(seed);
  const p1 = await privateAudience(seed, readerP1, "drive-p1");
  const p2 = await privateAudience(seed, readerP2, "drive-p2");
  const conn = await connection(seed, "revocable", [p1, p2]);
  const item = await driveFixture(seed, {
    project: "drive-storage", path: "gdrive/shared-doc.md", body: "revocable Drive body",
    frontmatter: { source: "gdrive", source_id: "shared-doc" },
  }, { unclaimed: true });
  await recordGdriveItemClaim(db(), {
    teamId: seed.teamId, integrationId: conn, providerId: "shared-doc", itemId: item.id,
    generation: 1, audienceProjectIds: [p1, p2],
  });
  const issued = await provisionGdriveConnectorPrincipal({ teamId: seed.teamId, integrationId: conn, actorMemberId: seed.memberId });
  const { data: keyRow } = await db().from("api_keys").select("id").eq("key_id", issued.keyId).single();
  expect(await canSeeItem(db(), { teamId: seed.teamId, memberId: readerP1 }, item.id)).toBe(true);
  expect(await canSeeItem(db(), { teamId: seed.teamId, memberId: readerP2 }, item.id)).toBe(true);
  return {
    seed, readerP1, readerP2, p1, p2, conn, itemId: item.id, key: issued.key,
    connectorMemberId: issued.memberId, apiKeyId: (keyRow as { id: string }).id,
  };
}

async function acquire(w: World) {
  const owner = randomUUID();
  const response = await executionPOST(post("http://test/api/v1/integrations/gdrive/execution", w.key, w.seed.teamSlug, {
    action: "acquire", integration_id: w.conn, owner,
  }));
  const body = await response.json() as { generation: number; fence: number; error?: { code: string } };
  return { response, body, owner };
}

async function remove(w: World, lease: { generation: number; fence: number }, owner: string) {
  return reconcilePOST(post("http://test/api/v1/items/source-reconcile", w.key, w.seed.teamSlug, {
    source: "gdrive", integration_id: w.conn, generation: lease.generation, fence: lease.fence, owner,
    removed_provider_ids: ["shared-doc"], reason: "provider-confirmed removal",
  }));
}

const loseGrant = (w: World) => getPool().query("delete from project_groups where team_id=$1 and project_id=$2", [w.seed.teamId, w.p1]);
const deleteProject = (w: World) => getPool().query("delete from projects where team_id=$1 and id=$2", [w.seed.teamId, w.p1]);

const connectorAuth = (w: World): ApiAuth => ({
  teamId: w.seed.teamId, memberId: w.connectorMemberId, apiKeyId: w.apiKeyId, memberTier: "team",
  memberRole: "member", actorHandle: "gdrive-sync", displayName: "Google Drive Sync", email: null, isConnector: true,
});

describe("revocation survives a lost audience grant (R44 C2, real Postgres)", () => {
  it.each([
    ["the grant is removed BEFORE acquisition", "before", loseGrant],
    ["the destination is deleted BEFORE acquisition", "before", deleteProject],
    ["the grant is removed DURING the run", "during", loseGrant],
  ] as const)("%s: acquisition and removal still work, publication is refused", async (_case, when, breakAudience) => {
    const w = await world();
    if (when === "before") await breakAudience(w);
    const acquired = await acquire(w);
    expect(acquired.response.status).toBe(200);
    if (when === "during") await breakAudience(w);

    // Content publication stays grant-validated, and refuses with a NON-terminal code.
    await expect(withGdriveExecutionCommit(connectorAuth(w), {
      integrationId: w.conn, generation: acquired.body.generation, fence: acquired.body.fence, owner: acquired.owner,
    }, async () => "published")).rejects.toMatchObject({ code: "audience_unavailable", status: 409 });

    const before = await epoch(w.seed.teamId);
    const removed = await remove(w, acquired.body, acquired.owner);
    expect(removed.status).toBe(200);
    expect(await canSeeItem(db(), { teamId: w.seed.teamId, memberId: w.readerP2 }, w.itemId)).toBe(false);
    expect(await canSeeItem(db(), { teamId: w.seed.teamId, memberId: w.readerP1 }, w.itemId)).toBe(false);
    expect(await epoch(w.seed.teamId)).toBeGreaterThan(before);
    const { rows: claims } = await getPool().query(
      "select 1 from gdrive_item_claims where integration_id=$1 and provider_id='shared-doc'", [w.conn]);
    expect(claims).toEqual([]);
  });

  it("a surviving, still-authorized claim from another connection keeps its audience", async () => {
    const w = await world();
    const other = await connection(w.seed, "still-authorized", [w.p2]);
    await recordGdriveItemClaim(db(), {
      teamId: w.seed.teamId, integrationId: other, providerId: "shared-doc", itemId: w.itemId,
      generation: 1, audienceProjectIds: [w.p2],
    });
    await loseGrant(w);
    const acquired = await acquire(w);
    expect(acquired.response.status).toBe(200);
    expect((await remove(w, acquired.body, acquired.owner)).status).toBe(200);
    expect(await canSeeItem(db(), { teamId: w.seed.teamId, memberId: w.readerP2 }, w.itemId)).toBe(true);
    expect(await canSeeItem(db(), { teamId: w.seed.teamId, memberId: w.readerP1 }, w.itemId)).toBe(false);
  });

  it("with a healthy audience, publication is still admitted (positive control)", async () => {
    const w = await world();
    const acquired = await acquire(w);
    await expect(withGdriveExecutionCommit(connectorAuth(w), {
      integrationId: w.conn, generation: acquired.body.generation, fence: acquired.body.fence, owner: acquired.owner,
    }, async (audience) => audience.projectIds.length)).resolves.toBe(2);
  });
});
