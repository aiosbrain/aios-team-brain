import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { GET as itemsGET } from "@/app/api/v1/items/route";
import type { ApiAuth } from "@/lib/api/auth";
import type { ItemPayload } from "@/lib/api/schemas";
import { canSeeItem } from "@/lib/access/enforce";
import { addMemberToGroup, createGroup, grantProjectToGroup } from "@/lib/access/groups";
import { issueApiKey } from "@/lib/admin/keys";
import { attributeIncomingItem } from "@/lib/attribution/resolve-authors";
import { getPool } from "@/lib/db/pg/pool";
import { ingestApiItem, ingestItem } from "@/lib/ingest";
import { stageGdriveReconciliation } from "@/lib/ingest/source-reconcile";
import {
  acquireGdriveExecution,
  provisionGdriveConnectorPrincipal,
  withGdriveExecutionCommit,
  type GdriveExecutionRef,
} from "@/lib/integrations/gdrive-authority";
import { upsertIntegration } from "@/lib/integrations/manage";
import { loadSchema } from "../../scripts/pg-load-schema.mjs";
import { db, seedTeam, sha, type Seed } from "./helpers";

/**
 * DOUBLE REPLAY of the Drive claims migration over POPULATED active claims, against real PostgreSQL
 * with the real deploy loader (AIO-1167, Stage-4 HOLD remediation M1).
 *
 * Spec. `pg-load-schema.mjs` replays every effective migration on every deploy.
 * `20260922130000_gdrive_audience_claims.sql` moves a claimed Drive item to the `external` tier —
 * and used to do so to EVERY actively claimed item on every replay, already external or not. That
 * gave unchanged content a new `updated_at` and a new row version on every deploy, and so handed
 * every unchanged Drive document to every `updated_at`-based incremental pull. Therefore, with the
 * documents written through the application's own owners and each replay its own committed pass:
 *
 *   1. the first pass converts ONLY a claimed row whose tier really differs (a pre-claims row the
 *      same migration adopts). An already-external claimed row is not written at all;
 *   2. a second replay writes nothing: exact `updated_at` and row version (`xmin`, `ctid`) for every
 *      row, the converted one included;
 *   3. an inactive claim, and no claim, are not a reason to write a row — whatever its tier;
 *   4. item-version history and contribution evidence are byte-for-byte what they were;
 *   5. an incremental pull from a watermark taken before a replay does not re-emit an unchanged
 *      document — and does emit one that really changed.
 *
 * Each pass is the loader's own session, and each migration its own committed statement: inside
 * one transaction `now()` is constant, which would hide exactly this defect.
 */

interface Connection {
  integrationId: string;
  auth: ApiAuth;
  execution: GdriveExecutionRef;
}

async function adminSeed(): Promise<Seed> {
  const seed = await seedTeam();
  await db().from("members").update({ role: "admin" }).eq("id", seed.memberId).eq("team_id", seed.teamId);
  return seed;
}

/** A connection whose audience project the seed member can see, with a live execution. */
async function driveConnection(seed: Seed): Promise<Connection> {
  const { data: project, error } = await db().from("projects")
    .insert({ team_id: seed.teamId, slug: `aud-${randomUUID().slice(0, 8)}`, name: "Drive audience", kind: "initiative" })
    .select("id").single();
  if (error || !project) throw new Error(`audience fixture failed: ${error?.message}`);
  const audienceProjectId = (project as { id: string }).id;
  const group = await createGroup(db(), seed.teamId, `aud-${randomUUID().slice(0, 8)}`, "Audience", seed.memberId);
  if (!group.ok) throw new Error(`audience group fixture failed: ${group.error}`);
  expect((await addMemberToGroup(db(), seed.teamId, group.groupId!, seed.memberId, seed.memberId)).ok).toBe(true);
  expect((await grantProjectToGroup(db(), seed.teamId, audienceProjectId, group.groupId!, seed.memberId)).ok).toBe(true);

  const row = await upsertIntegration(db(), { teamId: seed.teamId, memberId: seed.memberId }, {
    type: "gdrive", name: `drive-${randomUUID().slice(0, 8)}`, status: "enabled",
    config: {
      fileIds: ["doc"], folderIds: [], sharedDriveIds: [], recursive: false,
      selectionState: "selected", authMode: "service_account", audienceProjectIds: [audienceProjectId],
    },
  });
  const issued = await provisionGdriveConnectorPrincipal({
    teamId: seed.teamId, integrationId: row.id, actorMemberId: seed.memberId,
  });
  const { data: keyRow } = await db().from("api_keys").select("id").eq("key_id", issued.keyId).single();
  const auth: ApiAuth = {
    teamId: seed.teamId, memberId: issued.memberId, memberTier: "team", memberRole: "member",
    apiKeyId: (keyRow as { id: string }).id, actorHandle: "gdrive-sync",
    displayName: "Google Drive Sync", email: null, isConnector: true,
  };
  const acquired = await acquireGdriveExecution(auth, row.id, randomUUID());
  return {
    integrationId: row.id, auth,
    execution: { integrationId: row.id, generation: acquired.generation, fence: acquired.fence, owner: acquired.owner },
  };
}

const editor = () => ({
  key: `permission:editor-${randomUUID().slice(0, 8)}`,
  email: `editor-${randomUUID().slice(0, 8)}@provider.example`,
});

// No top-level date key on purpose: nothing but the migration under test has a reason to write
// these rows on a replay.
const driveFrontmatter = (providerId: string, who: { key: string; email: string }, connectionId?: string) => ({
  source: "gdrive", source_id: providerId, title: `Doc ${providerId}`,
  ...(connectionId ? { connection_id: connectionId } : {}),
  authors: [{ provider: "gdrive", external_id: who.key, email: who.email, role: "editor" }],
  contributions: [{ external_id: who.key, email: who.email, role: "editor", at: "2026-09-21T08:30:00Z" }],
});

/** One revision of a Drive document through the PUBLIC, claimed ingest path. */
async function pushDoc(c: Connection, providerId: string, body: string) {
  const payload = {
    project: "drive-docs", path: `gdrive/${providerId}.md`, kind: "deliverable", access: "team",
    actor: "gdrive-sync", body, content_sha256: sha(body),
    frontmatter: driveFrontmatter(providerId, editor(), c.integrationId),
  } as ItemPayload;
  const { opts } = await attributeIncomingItem(db(), c.auth.teamId, payload, c.auth.memberId);
  return ingestApiItem(db(), c.auth, payload, "team", opts, "team", c.execution);
}

/**
 * A Drive document as it was stored BEFORE claims existed: team tier, written by an ordinary
 * principal, its provider mapping carrying (or not) the connection it came through.
 */
async function preClaimsDoc(seed: Seed, providerId: string, connectionId: string | null): Promise<string> {
  const body = `pre-claims ${providerId}`;
  const result = await ingestItem(
    db(), { teamId: seed.teamId, memberId: seed.memberId, apiKeyId: randomUUID() },
    {
      project: "drive-legacy", path: `gdrive/${providerId}.md`, kind: "deliverable", access: "team", actor: "legacy",
      body, content_sha256: sha(body), frontmatter: driveFrontmatter(providerId, editor()),
    } as ItemPayload,
    "team",
  );
  await getPool().query("update items set access='team' where id=$1", [result.id]);
  await getPool().query(
    "update source_item_mappings set connection_id=$3 where team_id=$1 and source='gdrive' and provider_id=$2",
    [seed.teamId, providerId, connectionId]);
  return result.id;
}

interface ItemRow { id: string; access: string; updated_at: string; xmin: string; ctid: string }

/** Tier, timestamp and physical row version of each item — what a no-op must leave identical. */
async function itemRows(ids: string[]): Promise<Map<string, ItemRow>> {
  const { rows } = await getPool().query<ItemRow>(
    `select id, access::text as access, updated_at::text as updated_at, xmin::text as xmin, ctid::text as ctid
       from items where id = any($1::uuid[])`, [ids]);
  return new Map(rows.map((row) => [row.id, row]));
}

/** Version history, contribution evidence and claims of the team, with their physical row versions. */
async function ledgers(seed: Seed, ids: string[]) {
  const pool = getPool();
  const versions = (await pool.query(
    `select v.id, v.item_id, v.member_id, v.content_sha256, v.created_at::text as created_at, v.xmin::text as xmin, v.ctid::text as ctid
       from item_versions v where v.item_id = any($1::uuid[]) order by v.item_id, v.created_at, v.id`, [ids])).rows;
  const evidence = (await pool.query(
    `select e.item_id, e.evidence_key, e.member_id, e.authority_revision::text as authority_revision,
            e.updated_at::text as updated_at, e.xmin::text as xmin, e.ctid::text as ctid
       from gdrive_contribution_evidence e where e.team_id=$1 order by e.item_id, e.evidence_key`, [seed.teamId])).rows;
  return { versions, evidence };
}

async function claims(seed: Seed) {
  const { rows } = await getPool().query<{ item_id: string; active: boolean; xmin: string }>(
    "select item_id, active, xmin::text as xmin from gdrive_item_claims where team_id=$1 order by provider_id", [seed.teamId]);
  return rows;
}

const watermark = async (): Promise<string> =>
  (await getPool().query<{ t: string }>("select clock_timestamp()::text as t")).rows[0].t;

/** The real deploy loader, as `preDeployCommand` runs it: its own session, every step committed. */
const replay = () => loadSchema({ databaseUrl: process.env.DATABASE_URL, env: {}, logger: { log: () => {} } });

describe("AIO-1167 the claims migration replays as a no-op over converged active claims (real Postgres, real loader)", () => {
  it("first pass converts only a claimed row whose tier differs; a second replay preserves every row's exact updated_at and row version, the ledgers, and what an incremental pull emits", async () => {
    const seed = await adminSeed();
    const c = await driveConnection(seed);

    // ── populated through the application's own owners ────────────────────────────────────────
    // An ACTIVE claim on an item that is already external, with two revisions of history.
    const converged = await pushDoc(c, "converged", "first revision");
    expect((await pushDoc(c, "converged", "second revision"))).toMatchObject({ status: "updated", id: converged.id });
    // An active-then-RETIRED claim: the document is retained (cleanup owed), its claim inactive.
    const retired = await pushDoc(c, "retired", "access later withdrawn");
    await withGdriveExecutionCommit(c.auth, c.execution, () => stageGdriveReconciliation(
      db(), seed.teamId,
      { connectionId: c.integrationId, removedProviderIds: ["retired"], reason: "removed upstream" },
      { memberId: c.auth.memberId, apiKeyId: c.auth.apiKeyId },
    ));
    // Pre-claims rows, all TEAM tier: one the migration adopts (its mapping names the connection),
    // one it cannot (no connection on the mapping), and one with only an INACTIVE claim.
    const adoptable = await preClaimsDoc(seed, "adoptable", c.integrationId);
    const unclaimed = await preClaimsDoc(seed, "unclaimed", null);
    const inactiveOnly = await preClaimsDoc(seed, "inactive-only", null);
    await getPool().query(
      `insert into gdrive_item_claims (team_id, integration_id, provider_id, item_id, active, generation, revoked_at)
       values ($1, $2, 'inactive-only', $3, false, $4, now())`,
      [seed.teamId, c.integrationId, inactiveOnly, c.execution.generation]);
    // And an ordinary item no claim ever named.
    const plainBody = "an ordinary note";
    const plain = (await ingestItem(
      db(), { teamId: seed.teamId, memberId: seed.memberId, apiKeyId: randomUUID() },
      { project: "notes", path: "notes/plain.md", kind: "deliverable", access: "team", actor: "tester",
        body: plainBody, content_sha256: sha(plainBody), frontmatter: { source: "notion" } } as ItemPayload,
      "team",
    )).id;

    const all = [converged.id, retired.id, adoptable, unclaimed, inactiveOnly, plain];
    const before = await itemRows(all);
    const ledgersBefore = await ledgers(seed, all);
    // The premise, read back rather than assumed.
    expect(before.get(converged.id)!.access).toBe("external");
    expect(before.get(retired.id)!.access).toBe("external");
    for (const id of [adoptable, unclaimed, inactiveOnly, plain]) expect(before.get(id)!.access).toBe("team");
    const claimsBefore = await claims(seed);
    const activeClaims = (rows: Awaited<ReturnType<typeof claims>>) => rows.filter((claim) => claim.active).map((claim) => claim.item_id).sort();
    const claimOf = (rows: Awaited<ReturnType<typeof claims>>, itemId: string) => rows.find((claim) => claim.item_id === itemId);
    // Exactly one ACTIVE claim to begin with; the retired document and the inactive-only row have none.
    expect(activeClaims(claimsBefore)).toEqual([converged.id]);
    expect(claimOf(claimsBefore, inactiveOnly)).toMatchObject({ active: false });
    expect(ledgersBefore.versions.filter((v) => v.item_id === converged.id)).toHaveLength(2);
    const hadEvidence = new Set(ledgersBefore.evidence.map((e) => e.item_id as string));
    expect(hadEvidence.has(converged.id)).toBe(true);

    // What an incremental consumer has already pulled: the converged document, visible to it.
    const viewer = { teamId: seed.teamId, memberId: seed.memberId };
    expect(await canSeeItem(db(), viewer, converged.id)).toBe(true);
    const { key } = await issueApiKey(db(), seed.teamId, seed.memberId, "incremental-pull");
    const pulledSince = async (since: string): Promise<string[]> => {
      const response = await itemsGET(new NextRequest(
        `http://test.local/api/v1/items?since=${encodeURIComponent(since)}`, { headers: { authorization: `Bearer ${key}` } }));
      expect(response.status).toBe(200);
      return ((await response.json()) as { items: { id: string }[] }).items.map((item) => item.id);
    };
    expect(await pulledSince("1970-01-01T00:00:00Z")).toContain(converged.id);
    const beforeFirstPass = await watermark();

    // ── FIRST PASS ──────────────────────────────────────────────────────────────────────────
    await replay();
    const afterFirst = await itemRows(all);
    // The one row whose tier differed under an active claim (the adoption gave it that claim).
    expect(afterFirst.get(adoptable)).toMatchObject({ access: "external" });
    expect(afterFirst.get(adoptable)!.xmin).not.toBe(before.get(adoptable)!.xmin);
    expect(Date.parse(afterFirst.get(adoptable)!.updated_at)).toBeGreaterThan(Date.parse(before.get(adoptable)!.updated_at));
    // Every other row — the already-external active claim above all — was not written at all.
    for (const id of [converged.id, retired.id, unclaimed, inactiveOnly, plain]) {
      expect(afterFirst.get(id), `the first pass rewrote ${id}`).toEqual(before.get(id));
    }
    // The adoption gave that one row its claim; the existing claims were not rewritten, and neither
    // the retired document nor the inactive-only row was reactivated.
    const claimsAfterFirst = await claims(seed);
    expect(activeClaims(claimsAfterFirst)).toEqual([adoptable, converged.id].sort());
    expect(claimOf(claimsAfterFirst, converged.id)).toEqual(claimOf(claimsBefore, converged.id));
    expect(claimOf(claimsAfterFirst, inactiveOnly)).toEqual(claimOf(claimsBefore, inactiveOnly));
    // Version history is untouched, and so is every piece of contribution evidence that existed:
    // the same rows, the same credit, the same row versions — nothing rewritten, nothing duplicated.
    const ledgersAfterFirst = await ledgers(seed, all);
    expect(ledgersAfterFirst.versions).toEqual(ledgersBefore.versions);
    expect(ledgersAfterFirst.evidence.filter((e) => hadEvidence.has(e.item_id as string))).toEqual(ledgersBefore.evidence);
    // An unchanged document is not handed to the incremental pull again.
    expect(await pulledSince(beforeFirstPass)).not.toContain(converged.id);

    // ── SECOND REPLAY: a later deploy, its own session, its own clock ─────────────────────────
    const beforeSecondPass = await watermark();
    await replay();
    // Exact `updated_at` and row identity/version for EVERY row, the converted one included.
    expect(await itemRows(all)).toEqual(afterFirst);
    expect(await claims(seed)).toEqual(claimsAfterFirst);
    expect(await ledgers(seed, all)).toEqual(ledgersAfterFirst);
    expect(await pulledSince(beforeSecondPass)).toEqual([]);
    expect(await pulledSince(beforeFirstPass)).not.toContain(converged.id);

    // The pull is not blind: a document that really changes after the watermark IS emitted.
    expect(await pushDoc(c, "converged", "third revision")).toMatchObject({ status: "updated", id: converged.id });
    expect(await pulledSince(beforeSecondPass)).toEqual([converged.id]);
  }, 180_000);
});
