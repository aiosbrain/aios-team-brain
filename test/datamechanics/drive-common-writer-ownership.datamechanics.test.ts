import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { NextRequest } from "next/server";
import type { ItemPayload } from "@/lib/api/schemas";
import { issueApiKey } from "@/lib/admin/keys";
import { resolveApproval, runAction } from "@/lib/actions";
import { getPool } from "@/lib/db/pg/pool";
import { ingestItem } from "@/lib/ingest";
import { disconnectGdriveIntegration, setIntegrationStatus } from "@/lib/integrations/manage";
import { db, fencedDriveWriter, ingest, seedTeam, sha, type Seed } from "./helpers";

/**
 * AIO-1167 (HIGH) — the COMMON ingest writer enforces Google Drive ownership itself (real Postgres).
 *
 * Spec. `ingestItem` is reachable without the Drive execution fence — most directly through
 * `POST /api/v1/actions → runAction → note.create`, immediately or after an approval, with a
 * caller-chosen project, path, body and access. Whatever the caller, a write whose canonical target
 * belongs to Google Drive is refused on the row the writer has LOCKED, before any changed or
 * unchanged mutation, unless it is the validated fenced commit. Ownership is a same-team
 * `source_item_mappings(source='gdrive')` row (whatever its null legacy connection id, whatever the
 * row's own frontmatter now says, whether or not any claim is active) or stored Drive provenance.
 * A paused or disconnected connector makes no difference; action policy, an API key, a Drive-sourced
 * payload and a lookalike internal option are not authority. Ordinary writes and valid fenced Drive
 * writes are unchanged.
 */

const REFUSED = { code: "connector_principal_required", status: 403 };

interface DriveDoc {
  seed: Seed;
  writer: Awaited<ReturnType<typeof fencedDriveWriter>>;
  itemId: string;
  providerId: string;
  project: string;
  path: string;
  body: string;
}

/** A claimed Drive document, written by the fenced commit, with versions, evidence and a placement. */
async function driveDoc(): Promise<DriveDoc> {
  const seed = await seedTeam();
  const writer = await fencedDriveWriter(seed);
  const providerId = `owned-${randomUUID().slice(0, 8)}`;
  const project = "drive-owned";
  const body = "the connector's authorized body";
  const at = new Date(Date.now() - 3_600_000).toISOString();
  const created = await writer.push({
    project, path: `gdrive/${providerId}.md`, body,
    frontmatter: {
      source_id: providerId, title: `Doc ${providerId}`, source_ts: at,
      authors: [{ provider: "gdrive", external_id: `permission:${providerId}`, role: "editor" }],
      contributions: [{ external_id: `permission:${providerId}`, role: "editor", at }],
    },
  }, { authorMemberId: seed.memberId });
  expect(created.status).toBe("created");
  const { rows } = await getPool().query<{ path: string }>("select path from items where id=$1", [created.id]);
  return { seed, writer, itemId: created.id, providerId, project, path: rows[0].path, body };
}

/** Every row a write could change for the document, with its physical row version. */
async function state(doc: DriveDoc) {
  const pool = getPool();
  const rows = async (sql: string, params: unknown[]) =>
    (await pool.query<{ row: string; xmin: string }>(sql, params)).rows;
  return {
    item: await rows(
      "select row_to_json(t)::text as row, t.xmin::text as xmin from items t where t.id=$1", [doc.itemId]),
    versions: await rows(
      "select row_to_json(t)::text as row, t.xmin::text as xmin from item_versions t where t.item_id=$1 order by 1", [doc.itemId]),
    mappings: await rows(
      "select row_to_json(t)::text as row, t.xmin::text as xmin from source_item_mappings t where t.team_id=$1 and t.item_id=$2 order by 1",
      [doc.seed.teamId, doc.itemId]),
    claims: await rows(
      "select row_to_json(t)::text as row, t.xmin::text as xmin from gdrive_item_claims t where t.team_id=$1 and t.provider_id=$2 order by 1",
      [doc.seed.teamId, doc.providerId]),
    claimProjects: await rows(
      "select row_to_json(t)::text as row, t.xmin::text as xmin from gdrive_item_claim_projects t where t.team_id=$1 and t.provider_id=$2 order by 1",
      [doc.seed.teamId, doc.providerId]),
    evidence: await rows(
      "select row_to_json(t)::text as row, t.xmin::text as xmin from gdrive_contribution_evidence t where t.item_id=$1 order by 1", [doc.itemId]),
    units: await rows(
      "select row_to_json(t)::text as row, t.xmin::text as xmin from project_context_units t where t.source_item_id=$1 order by 1", [doc.itemId]),
    memberships: await rows(
      `select row_to_json(m)::text as row, m.xmin::text as xmin from project_context_memberships m
         join project_context_units u on u.id = m.context_unit_id where u.source_item_id=$1 order by 1`, [doc.itemId]),
  };
}

const ordinaryAuth = (seed: Seed) => ({ teamId: seed.teamId, memberId: seed.memberId, apiKeyId: randomUUID() });

/** A plain, non-Drive payload at the document's own location. */
function plainAt(doc: DriveDoc, body: string, access: "team" | "external" = "external"): ItemPayload {
  return {
    project: doc.project, path: doc.path, kind: "deliverable", access, actor: "member",
    body, content_sha256: sha(body), frontmatter: { source: "notion" },
  } as ItemPayload;
}

async function allowNoteCreate(seed: Seed, effect: "allow" | "require_approval" = "allow") {
  const { error } = await db().from("policies").insert({
    team_id: seed.teamId, action: "note.create", resource: "*", effect, priority: 100,
  });
  expect(error).toBeNull();
}

const noteCreate = (doc: DriveDoc, body: string, access = "external") => ({
  type: "note.create", resource: "*", params: { project: doc.project, path: doc.path, body, access },
});

const principal = { role: "member" as const, tier: "team" as const, actor: "agent-on-behalf" };

describe("AIO-1167 the common writer refuses a Drive-owned target (real Postgres)", () => {
  it.each(["paused", "disconnected"] as const)(
    "policy-authorized note.create against a %s Drive document — changed body, access='external' — fails and changes nothing",
    async (connector) => {
      const doc = await driveDoc();
      if (connector === "paused") {
        await setIntegrationStatus(db(), { teamId: doc.seed.teamId, memberId: doc.seed.memberId }, doc.writer.integrationId, "disabled");
      } else {
        await disconnectGdriveIntegration(db(), { teamId: doc.seed.teamId, memberId: doc.seed.memberId }, doc.writer.integrationId);
      }
      await allowNoteCreate(doc.seed);
      const before = await state(doc);

      const outcome = await runAction(db(), {
        teamId: doc.seed.teamId, memberId: doc.seed.memberId, apiKeyId: null, principal,
        request: noteCreate(doc, "an agent's replacement body", "external"),
      });

      // The policy allowed the action; the writer still refused it.
      expect(outcome).toMatchObject({ decision: "allow", status: "failed" });
      expect(outcome.error).toMatch(/Google Drive execution authority/);
      expect(await state(doc)).toEqual(before);
    },
  );

  it("the same action over HTTP (POST /api/v1/actions) is a failed action, and the document is untouched", async () => {
    const doc = await driveDoc();
    await setIntegrationStatus(db(), { teamId: doc.seed.teamId, memberId: doc.seed.memberId }, doc.writer.integrationId, "disabled");
    await allowNoteCreate(doc.seed);
    const { key } = await issueApiKey(db(), doc.seed.teamId, doc.seed.memberId, "drive-ownership-actions");
    const before = await state(doc);

    const { POST } = await import("@/app/api/v1/actions/route");
    const res = await POST(new Request("http://test/api/v1/actions", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "X-AIOS-Team": doc.seed.teamSlug, "content-type": "application/json" },
      body: JSON.stringify(noteCreate(doc, "an HTTP replacement body", "external")),
    }) as unknown as NextRequest);

    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ decision: "allow", status: "failed" });
    expect(await state(doc)).toEqual(before);
  });

  it("an approval-resumed note.create is refused the same way when the admin approves it", async () => {
    const doc = await driveDoc();
    await disconnectGdriveIntegration(db(), { teamId: doc.seed.teamId, memberId: doc.seed.memberId }, doc.writer.integrationId);
    await allowNoteCreate(doc.seed, "require_approval");
    const queued = await runAction(db(), {
      teamId: doc.seed.teamId, memberId: doc.seed.memberId, apiKeyId: null, principal,
      request: noteCreate(doc, "approved replacement body", "external"),
    });
    expect(queued.status).toBe("pending_approval");
    const before = await state(doc);

    const resumed = await resolveApproval(db(), {
      approvalRequestId: queued.approvalRequestId!, decision: "approved", deciderMemberId: doc.seed.memberId,
    });

    expect(resumed).toMatchObject({ status: "approved", actionStatus: "failed" });
    expect(resumed.error).toMatch(/Google Drive execution authority/);
    expect(await state(doc)).toEqual(before);
  });

  it("the direct writer is refused by MAPPING alone — provenance missing or relabelled, null connection id, no active claim", async () => {
    const doc = await driveDoc();
    const { rows: mapping } = await getPool().query<{ connection_id: string | null }>(
      "select connection_id from source_item_mappings where team_id=$1 and item_id=$2", [doc.seed.teamId, doc.itemId]);
    // The premise: there is no connection id to read ownership from.
    expect(mapping).toEqual([{ connection_id: null }]);
    await getPool().query("update gdrive_item_claims set active=false, revoked_at=now() where team_id=$1 and item_id=$2",
      [doc.seed.teamId, doc.itemId]);

    for (const provenance of [{}, { source: "notion" }, { source: "gdrive-legacy", source_id: doc.providerId }]) {
      await getPool().query("update items set frontmatter=$2::jsonb where id=$1", [doc.itemId, JSON.stringify(provenance)]);
      const before = await state(doc);
      await expect(ingestItem(db(), ordinaryAuth(doc.seed), plainAt(doc, "overwritten by mapping-only owner"), "external"))
        .rejects.toMatchObject(REFUSED);
      expect(await state(doc)).toEqual(before);
    }
  });

  it("the direct writer is refused by stored PROVENANCE alone — a Drive row with no mapping", async () => {
    const seed = await seedTeam();
    const at = { project: "legacy-drive", path: "gdrive/provenance-only.md" };
    const legacy = await ingest(seed, { ...at, body: "legacy body", access: "team" });
    await getPool().query("update items set frontmatter=$2::jsonb where id=$1",
      [legacy.id, JSON.stringify({ source: "gdrive", source_id: "provenance-only" })]);
    const { rows: mappings } = await getPool().query("select 1 from source_item_mappings where item_id=$1", [legacy.id]);
    expect(mappings).toEqual([]);
    const before = (await getPool().query("select row_to_json(t)::text as row, t.xmin::text as xmin from items t where t.id=$1", [legacy.id])).rows;

    await expect(ingestItem(db(), ordinaryAuth(seed), {
      ...at, kind: "deliverable", access: "team", actor: "member", body: "overwrite", content_sha256: sha("overwrite"),
      frontmatter: { source: "notion" },
    } as ItemPayload, "team")).rejects.toMatchObject(REFUSED);

    expect((await getPool().query("select row_to_json(t)::text as row, t.xmin::text as xmin from items t where t.id=$1", [legacy.id])).rows)
      .toEqual(before);
  });

  it("an UNCHANGED-body write cannot heal tier, frontmatter, attribution or the sync stamp", async () => {
    const doc = await driveDoc();
    const other = (await db().from("members").insert({
      team_id: doc.seed.teamId, email: `${randomUUID()}@test.local`, display_name: "Other",
      actor_handle: `other-${randomUUID().slice(0, 8)}`, role: "member", tier: "team", status: "active",
    }).select("id").single()).data as { id: string };
    const before = await state(doc);

    await expect(ingestItem(db(), ordinaryAuth(doc.seed), {
      ...plainAt(doc, doc.body, "team"),
      frontmatter: { source: "notion", author: "someone else", title: "relabelled" },
    }, "team", { authorMemberId: other.id })).rejects.toMatchObject(REFUSED);

    expect(await state(doc)).toEqual(before);
  });

  it("a Drive-SOURCED direct payload, and a lookalike internal commit, are not Drive authority", async () => {
    const doc = await driveDoc();
    const before = await state(doc);
    const drivePayload = {
      project: doc.project, path: doc.path, kind: "deliverable", access: "external", actor: "gdrive-sync",
      body: "forged connector body", content_sha256: sha("forged connector body"),
      frontmatter: { source: "gdrive", source_id: doc.providerId, connection_id: doc.writer.integrationId },
    } as ItemPayload;

    await expect(ingestItem(db(), ordinaryAuth(doc.seed), drivePayload, "external")).rejects.toMatchObject(REFUSED);
    // An object shaped like the fenced owner's commit, built by the caller, is refused before it is used.
    const lookalike = {
      gdrive: {
        claim: { integrationId: doc.writer.integrationId, providerId: doc.providerId, generation: doc.writer.execution.generation, audienceProjectIds: [] },
        storageProjectId: randomUUID(),
        locks: { projectIds: new Set<string>(), pathKeys: new Set<string>(), itemIds: new Set<string>([doc.itemId]) },
      },
    } as unknown as Parameters<typeof ingestItem>[7];
    await expect(ingestItem(db(), ordinaryAuth(doc.seed), drivePayload, "external", undefined, "team", undefined, lookalike))
      .rejects.toMatchObject(REFUSED);

    expect(await state(doc)).toEqual(before);
  });

  it("RACE: Drive ownership that appears after the writer's unlocked candidate read is refused on the locked row, rolling back its project write", async () => {
    const seed = await seedTeam();
    const at = { project: `race-${randomUUID().slice(0, 8)}`, path: "notes/raced.md" };
    const existing = await ingest(seed, { ...at, body: "v1", access: "team", frontmatter: { source: "notion" } });
    const syncedBefore = (await getPool().query<{ last_synced_at: string }>(
      "select last_synced_at::text as last_synced_at from projects where id=$1", [existing.projectId])).rows[0].last_synced_at;

    let planted = 0;
    const outcome = await ingestItem(db(), ordinaryAuth(seed), {
      ...at, kind: "deliverable", access: "team", actor: "member", body: "v2", content_sha256: sha("v2"),
      frontmatter: { source: "notion" },
    } as ItemPayload, "team", undefined, "team", undefined, {
      concurrencyHooks: {
        // The writer holds its project and path and has read its candidate WITHOUT a lock. A Drive
        // mapping for this item commits now, on a connection of its own; only the locked check sees it.
        beforeAttributionLock: async (itemId) => {
          planted++;
          await getPool().query(
            `insert into source_item_mappings (team_id, source, provider_id, item_id, connection_id, project_id, canonical_path)
             values ($1, 'gdrive', $2, $3, null, $4, $5)`,
            [seed.teamId, `raced-${randomUUID().slice(0, 8)}`, itemId, existing.projectId, at.path]);
        },
      },
    }).then(() => null, (caught: unknown) => caught);

    expect(planted).toBe(1);
    expect(outcome).toMatchObject(REFUSED);
    const { data: stored } = await db().from("items").select("body, frontmatter").eq("id", existing.id).single();
    expect(stored).toMatchObject({ body: "v1", frontmatter: { source: "notion" } });
    const { data: versions } = await db().from("item_versions").select("id").eq("item_id", existing.id);
    expect(versions).toHaveLength(1);
    expect((await getPool().query<{ last_synced_at: string }>(
      "select last_synced_at::text as last_synced_at from projects where id=$1", [existing.projectId])).rows[0].last_synced_at)
      .toBe(syncedBefore);
  });

  it("CONTROLS: ordinary creates and updates — direct and through note.create — and valid fenced Drive writes still succeed", async () => {
    const doc = await driveDoc();
    await allowNoteCreate(doc.seed);
    const at = { project: "ordinary-notes", path: `notes/${randomUUID().slice(0, 8)}.md` };

    const created = await ingestItem(db(), ordinaryAuth(doc.seed), {
      ...at, kind: "deliverable", access: "team", actor: "member", body: "first", content_sha256: sha("first"),
      frontmatter: { source: "notion" },
    } as ItemPayload, "team");
    expect(created.status).toBe("created");
    const updated = await ingestItem(db(), ordinaryAuth(doc.seed), {
      ...at, kind: "deliverable", access: "team", actor: "member", body: "second", content_sha256: sha("second"),
      frontmatter: { source: "notion" },
    } as ItemPayload, "team");
    expect(updated).toMatchObject({ status: "updated", id: created.id });

    const note = { type: "note.create", resource: "*", params: { project: "agent-notes", path: "notes/agent.md", body: "agent v1" } };
    const first = await runAction(db(), { teamId: doc.seed.teamId, memberId: doc.seed.memberId, apiKeyId: null, principal, request: note });
    expect(first).toMatchObject({ status: "succeeded", result: { status: "created" } });
    const again = await runAction(db(), {
      teamId: doc.seed.teamId, memberId: doc.seed.memberId, apiKeyId: null, principal,
      request: { ...note, params: { ...note.params, body: "agent v2" } },
    });
    expect(again).toMatchObject({ status: "succeeded", result: { status: "updated" } });

    // The fenced commit is still the Drive writer: changed and unchanged replays both land.
    const replay = await doc.writer.push({
      project: doc.project, path: doc.path, body: "the connector's next body",
      frontmatter: { source_id: doc.providerId, title: `Doc ${doc.providerId}` },
    });
    expect(replay).toMatchObject({ status: "updated", id: doc.itemId });
    const unchanged = await doc.writer.push({
      project: doc.project, path: doc.path, body: "the connector's next body",
      frontmatter: { source_id: doc.providerId, title: `Doc ${doc.providerId}` },
    });
    expect(unchanged).toMatchObject({ status: "unchanged", id: doc.itemId });
    expect((await db().from("items").select("body").eq("id", doc.itemId).single()).data)
      .toMatchObject({ body: "the connector's next body" });
  });
});
