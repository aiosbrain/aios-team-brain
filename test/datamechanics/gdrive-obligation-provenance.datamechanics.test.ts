import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ApiAuth } from "@/lib/api/auth";
import type { ItemPayload } from "@/lib/api/schemas";
import { createGroup, grantProjectToGroup } from "@/lib/access/groups";
import { attributeIncomingItem } from "@/lib/attribution/resolve-authors";
import { getPool } from "@/lib/db/pg/pool";
import { removeMemberIdentity, setMemberIdentity } from "@/lib/identity/member-identities";
import { ingestApiItem, ingestItem } from "@/lib/ingest";
import { applyAttributionCorrection } from "@/lib/ingest/attribution-correction";
import { drainIdentityRepairs, runIdentityRepairObligation } from "@/lib/ingest/identity-repair";
import { repairAttributionNow } from "@/lib/ingest/reconcile-attribution";
import { stageGdriveReconciliation } from "@/lib/ingest/source-reconcile";
import {
  acquireGdriveExecution,
  provisionGdriveConnectorPrincipal,
  withGdriveExecutionCommit,
  type GdriveExecutionRef,
} from "@/lib/integrations/gdrive-authority";
import { disconnectGdriveIntegration, upsertIntegration } from "@/lib/integrations/manage";
import { db, seedTeam, sha, type Seed } from "./helpers";

/**
 * TRUSTED PROVENANCE for the Google identity OBLIGATION repair, against real PostgreSQL (AIO-1167)
 * — the observable half of `test/gdrive-obligation-provenance.test.ts`.
 *
 * Spec. Linking, remapping or unlinking a Google identity enqueues an obligation that rewrites the
 * retained Drive credit naming that identity. It used to nominate any row whose FRONTMATTER said
 * `source: gdrive` and named the identity — text a pusher writes — so forged provenance could have
 * a client's stored credit rewritten, or erased on unlink. Therefore, with documents ingested
 * through the PUBLIC authorized Drive path:
 *
 *   1. only a row with a persisted same-team `gdrive` mapping AND current Drive source evidence is
 *      nominated, and the same is rechecked under the item lock before anything is written;
 *   2. forged frontmatter on an unmapped row, a mapping in another team and a same-team mapping
 *      from another source establish nothing — link AND unlink leave those rows exactly as stored;
 *   3. the mapping is the root even with a NULL connection id, no active claim and a disconnected
 *      integration;
 *   4. a row that stops being a Drive document between nomination and its lock is scanned past;
 *   5. a failed provenance read moves nothing — no credit, no obligation cursor — and a retry heals;
 *   6. a correction lock still wins, a newer mapping revision still fences a stale worker, and the
 *      team-wide repair's own cursor is never touched.
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

async function member(seed: Seed, name: string): Promise<{ id: string; email: string }> {
  const email = `${name.toLowerCase()}-${randomUUID().slice(0, 8)}@roster.example`;
  const { data, error } = await db().from("members").insert({
    team_id: seed.teamId, email, display_name: name,
    actor_handle: `${name.toLowerCase()}-${randomUUID().slice(0, 8)}`,
    role: "member", tier: "team", status: "active", is_connector: false,
  }).select("id").single();
  if (error || !data) throw new Error(`member fixture failed: ${error?.message}`);
  return { id: (data as { id: string }).id, email };
}

/** A connection with its bound connector principal and a live execution — what the worker holds. */
async function driveConnection(seed: Seed): Promise<Connection> {
  const { data: project, error } = await db().from("projects")
    .insert({ team_id: seed.teamId, slug: `aud-${randomUUID().slice(0, 8)}`, name: "Drive audience", kind: "initiative" })
    .select("id").single();
  if (error || !project) throw new Error(`audience fixture failed: ${error?.message}`);
  const audienceProjectId = (project as { id: string }).id;
  const group = await createGroup(db(), seed.teamId, `aud-${randomUUID().slice(0, 8)}`, "Audience", seed.memberId);
  if (!group.ok) throw new Error(`audience group fixture failed: ${group.error}`);
  const granted = await grantProjectToGroup(db(), seed.teamId, audienceProjectId, group.groupId!, seed.memberId);
  if (!granted.ok) throw new Error("audience grant fixture failed");

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

/** One Google account as the provider reports it: a stable id and an address. */
interface Person { key: string; email: string }
const person = (label: string): Person => ({
  key: `permission:${label}-${randomUUID().slice(0, 8)}`,
  email: `${label}-${randomUUID().slice(0, 8)}@provider.example`,
});

const driveFrontmatter = (sourceId: string, connectionId: string, editor: Person) => ({
  source: "gdrive", source_id: sourceId, connection_id: connectionId, title: `Doc ${sourceId}`,
  authors: [{ provider: "gdrive", external_id: editor.key, email: editor.email, role: "editor" }],
  contributions: [{ external_id: editor.key, email: editor.email, role: "editor", at: new Date().toISOString() }],
});

/** One revision of a Drive document through the PUBLIC ingest owner, exactly as the items route. */
async function pushDoc(c: Connection, editor: Person, body = "a real drive document"): Promise<{ id: string; providerId: string }> {
  const providerId = `doc-${randomUUID().slice(0, 8)}`;
  const payload = {
    project: "drive-repair", path: `gdrive/${providerId}.md`, kind: "deliverable", access: "team",
    actor: "gdrive-sync", body, content_sha256: sha(body),
    frontmatter: driveFrontmatter(providerId, c.integrationId, editor),
  } as ItemPayload;
  const { opts } = await attributeIncomingItem(db(), c.auth.teamId, payload, c.auth.memberId);
  const result = await ingestApiItem(db(), c.auth, payload, "team", opts, "team", c.execution);
  expect(result.status).toBe("created");
  return { id: result.id, providerId };
}

/**
 * An ordinary pushed item with stored credit — and FORGED Drive provenance: on the row and on its
 * retained version, the source, a document id, this team's real connection id, and the identity
 * under repair among its authors and contributions. Everything a pusher could write.
 */
async function forgedItem(seed: Seed, c: Connection, path: string, access: "team" | "external", editor: Person, creditedTo: string) {
  const body = `content of ${path}`;
  const result = await ingestItem(
    db(), { teamId: seed.teamId, memberId: seed.memberId, apiKeyId: randomUUID() },
    {
      project: "client-work", path, kind: "deliverable", access, actor: "client", body, content_sha256: sha(body),
      frontmatter: { source: "notion", authors: [{ email: editor.email, role: "author" }] },
    } as ItemPayload,
    access, { authorMemberId: creditedTo },
  );
  const forged = JSON.stringify(driveFrontmatter(`forged-${randomUUID().slice(0, 8)}`, c.integrationId, editor));
  await getPool().query("update items set frontmatter=$2::jsonb where id=$1", [result.id, forged]);
  await getPool().query("update item_versions set frontmatter=$2::jsonb where item_id=$1", [result.id, forged]);
  return result.id;
}

async function credit(itemId: string) {
  const pool = getPool();
  const item = (await pool.query<{ member_id: string | null; member_id_locked: boolean; source: string | null }>(
    "select member_id, member_id_locked, frontmatter->>'source' as source from items where id=$1", [itemId])).rows[0];
  const versions = (await pool.query<{ member_id: string | null }>(
    "select member_id from item_versions where item_id=$1 order by created_at, id", [itemId])).rows.map((row) => row.member_id);
  const evidence = (await pool.query<{ member_id: string | null; diagnostic: string | null }>(
    "select member_id, diagnostic from gdrive_contribution_evidence where item_id=$1 order by email", [itemId])).rows;
  return { item, versions, evidence };
}

type ObligationInput = Parameters<typeof runIdentityRepairObligation>[1];

async function obligationRow(seed: Seed, externalId: string, revision: number) {
  const { rows } = await getPool().query<{
    status: string; cursor_item_id: string | null; items_scanned: number; items_updated: number; last_error: string | null;
  }>(
    `select status, cursor_item_id, items_scanned::int as items_scanned, items_updated::int as items_updated, last_error
       from identity_repair_obligations
      where team_id=$1 and provider='gdrive' and external_id=$2 and mapping_revision=$3`,
    [seed.teamId, externalId, revision]);
  return rows[0];
}

const obligationOf = (seed: Seed, externalId: string, revision: number): ObligationInput => ({
  team_id: seed.teamId, provider: "gdrive", external_id: externalId, mapping_revision: revision,
  cursor_item_id: null, items_scanned: 0, items_updated: 0, versions_updated: 0, contributions_updated: 0,
});

/** The team-wide repair's own durable progress — which an obligation must never move. */
async function commonCursor(seed: Seed) {
  const { rows } = await getPool().query(
    `select revision::int as revision, repair_status, cursor_item_id, items_scanned::int as items_scanned,
            items_updated::int as items_updated, versions_updated::int as versions_updated, attempts, updated_at::text as updated_at
       from team_identity_authority where team_id=$1`, [seed.teamId]);
  return rows[0];
}

/**
 * Real-statement fault injection: every statement but the matching ones reaches PostgreSQL through
 * the application's own pool; a matching one is rejected as the driver would reject a failed read.
 */
async function withFailingStatements<T>(shouldFail: (sql: string) => boolean, fn: () => Promise<T>): Promise<{ outcome: T; hits: number }> {
  type Callable = (...args: unknown[]) => unknown;
  const pool = getPool() as unknown as { query: Callable; connect: Callable };
  const ownQuery = Object.prototype.hasOwnProperty.call(pool, "query");
  const ownConnect = Object.prototype.hasOwnProperty.call(pool, "connect");
  const originalQuery = pool.query;
  const originalConnect = pool.connect;
  const wrapped = new Map<{ query: Callable }, { query: Callable; own: boolean }>();
  let hits = 0;
  const fails = (text: unknown) => typeof text === "string" && shouldFail(text.replace(/\s+/g, " ").trim());
  const injected = () => Object.assign(new Error("injected read failure"), { code: "58030" });

  pool.query = (...args) => {
    if (fails(args[0])) { hits++; return Promise.reject(injected()); }
    return originalQuery.apply(pool, args);
  };
  pool.connect = (...args) => {
    // The callback form is the pool's own internal checkout for `pool.query`; leave it alone.
    if (typeof args[0] === "function") return originalConnect.apply(pool, args);
    return Promise.resolve(originalConnect.apply(pool, args)).then((client) => {
      const surface = client as { query: Callable };
      if (!wrapped.has(surface)) {
        const original = surface.query;
        wrapped.set(surface, { query: original, own: Object.prototype.hasOwnProperty.call(surface, "query") });
        surface.query = (...queryArgs) => {
          if (fails(queryArgs[0])) { hits++; return Promise.reject(injected()); }
          return original.apply(surface, queryArgs);
        };
      }
      return client;
    });
  };
  try {
    const outcome = await fn();
    return { outcome, hits };
  } finally {
    if (ownQuery) pool.query = originalQuery; else delete (pool as { query?: Callable }).query;
    if (ownConnect) pool.connect = originalConnect; else delete (pool as { connect?: Callable }).connect;
    for (const [surface, original] of wrapped) {
      if (original.own) surface.query = original.query; else delete (surface as { query?: Callable }).query;
    }
  }
}

const link = (seed: Seed, memberId: string, who: Person, opts: Parameters<typeof setMemberIdentity>[4] = {}) =>
  setMemberIdentity(db(), seed.teamId, memberId, { provider: "gdrive", externalId: who.key, email: who.email }, opts);

const drain = () => drainIdentityRepairs(db(), { maxObligations: 20, batchSize: 10 });

describe("AIO-1167 the Drive identity obligation repairs only documents its persisted mapping names (real Postgres)", () => {
  it("NEGATIVE CONTROLS: forged frontmatter, a foreign team's mapping and a non-Drive mapping establish nothing — on link AND on unlink — and the common cursor never moves", async () => {
    const seed = await adminSeed();
    const otherTeam = await seedTeam();
    const c = await driveConnection(seed);
    const alice = await member(seed, "Alice");
    const editor = person("editor");
    const stale = seed.memberId; // the credit every control row starts with

    const drive = await pushDoc(c, editor);
    const forgedExternal = await forgedItem(seed, c, "client/forged-external.md", "external", editor, stale);
    const forgedTeam = await forgedItem(seed, c, "client/forged-team.md", "team", editor, stale);
    const foreign = await forgedItem(seed, c, "client/foreign-mapping.md", "external", editor, stale);
    const otherSource = await forgedItem(seed, c, "client/other-source.md", "external", editor, stale);
    // A gdrive mapping for this very item id — in ANOTHER team.
    await getPool().query(
      `insert into source_item_mappings (team_id, source, provider_id, item_id, connection_id, canonical_path)
       values ($1, 'gdrive', 'foreign-doc', $2, null, 'client/foreign-mapping.md')`, [otherTeam.teamId, foreign]);
    // A same-team mapping for this item — from a source that is not Drive.
    await getPool().query(
      `insert into source_item_mappings (team_id, source, provider_id, item_id, connection_id, canonical_path)
       values ($1, 'notion', 'notion-page', $2, null, 'client/other-source.md')`, [seed.teamId, otherSource]);
    const controls = [forgedExternal, forgedTeam, foreign, otherSource];
    const storedControls = await Promise.all(controls.map(credit));
    for (const stored of storedControls) {
      // Each one claims to be a Drive document, in every way a row can claim it.
      expect(stored.item).toMatchObject({ member_id: stale, source: "gdrive" });
      expect(stored.evidence).toEqual([]);
    }
    expect((await credit(drive.id)).item).toMatchObject({ member_id: null, source: "gdrive" });

    // ── LINK ────────────────────────────────────────────────────────────────────────────────────
    const linked = await link(seed, alice.id, editor);
    const before = await commonCursor(seed);
    expect(await drain()).toMatchObject({ failed: 0, partial: 0 });

    const repaired = await credit(drive.id);
    expect(repaired.item.member_id).toBe(alice.id);
    expect(repaired.versions).toEqual([alice.id]);
    expect(repaired.evidence).toEqual([{ member_id: alice.id, diagnostic: null }]);
    // Exactly one row was ever nominated: the controls were not candidates at all.
    expect(await obligationRow(seed, editor.key, linked.mappingRevision!))
      .toMatchObject({ status: "complete", items_scanned: 1, items_updated: 1 });
    for (const [index, id] of controls.entries()) expect(await credit(id), `control ${id} was repaired on link`).toEqual(storedControls[index]);
    // The obligation has a cursor of its own; the team-wide repair's is exactly where it was.
    expect(await commonCursor(seed)).toEqual(before);

    // ── UNLINK: the direction that used to ERASE the stored credit of a forged row ───────────────
    const removed = await removeMemberIdentity(db(), seed.teamId, { provider: "gdrive", externalId: editor.key },
      { expectedRevision: linked.mappingRevision });
    expect(removed.removed).toBe(true);
    const beforeUnlink = await commonCursor(seed);
    expect(await drain()).toMatchObject({ failed: 0 });
    expect((await credit(drive.id)).item.member_id).toBeNull();
    expect((await credit(drive.id)).versions).toEqual([null]);
    for (const [index, id] of controls.entries()) expect(await credit(id), `control ${id} was rewritten on unlink`).toEqual(storedControls[index]);
    expect(await commonCursor(seed)).toEqual(beforeUnlink);

    // The team-wide repair is a different drain with a different rule and its own progress: it
    // still converges, and still never admits an unmapped external row.
    const common = await repairAttributionNow(db(), seed.teamId, seed.teamSlug, { maxBatches: 10, batchSize: 20 });
    expect(common).toMatchObject({ status: "complete" });
    expect((await commonCursor(seed)).repair_status).toBe("complete");
    for (const id of [forgedExternal, foreign, otherSource]) expect((await credit(id)).item.member_id).toBe(stale);
  }, 90_000);

  it("POSITIVE after DISCONNECT: a NULL connection id, no active claim, no lease and a disabled integration — the mapping alone is enough", async () => {
    const seed = await adminSeed();
    const c = await driveConnection(seed);
    const alice = await member(seed, "Alice");
    const editor = person("editor");
    const drive = await pushDoc(c, editor, "retained after disconnect");

    // Final-claim retirement (staged: the item is retained, cleanup still owed), then disconnect.
    await withGdriveExecutionCommit(c.auth, c.execution, () => stageGdriveReconciliation(
      db(), seed.teamId,
      { connectionId: c.integrationId, removedProviderIds: [drive.providerId], reason: "removed upstream" },
      { memberId: c.auth.memberId, apiKeyId: c.auth.apiKeyId },
    ));
    await disconnectGdriveIntegration(db(), { teamId: seed.teamId, memberId: seed.memberId }, c.integrationId);
    const { rows: retained } = await getPool().query<{
      active_claims: number; status: string; lease_owner: string | null; connection_id: string | null;
    }>(
      `select (select count(*)::int from gdrive_item_claims k where k.team_id=$1 and k.item_id=$2 and k.active) as active_claims,
              n.status, a.lease_owner, m.connection_id
         from items i
         join source_item_mappings m on m.team_id=i.team_id and m.item_id=i.id and m.source='gdrive'
         join integrations n on n.id=$3
         join gdrive_connection_authority a on a.integration_id=n.id
        where i.id=$2`, [seed.teamId, drive.id, c.integrationId]);
    expect(retained).toEqual([{ active_claims: 0, status: "disabled", lease_owner: null, connection_id: null }]);

    const linked = await link(seed, alice.id, editor);
    expect(await drain()).toMatchObject({ failed: 0, partial: 0 });
    expect(await obligationRow(seed, editor.key, linked.mappingRevision!)).toMatchObject({ status: "complete", items_scanned: 1 });
    const now = await credit(drive.id);
    expect(now.item.member_id).toBe(alice.id);
    expect(now.versions).toEqual([alice.id]);
    expect(now.evidence).toEqual([{ member_id: alice.id, diagnostic: null }]);
  }, 90_000);

  it("BARRIER: a document that stops being Drive-sourced between nomination and its lock is scanned past; its neighbour is repaired", async () => {
    const seed = await adminSeed();
    const c = await driveConnection(seed);
    const alice = await member(seed, "Alice");
    const editor = person("editor");
    const docs = [await pushDoc(c, editor, "first"), await pushDoc(c, editor, "second")];
    const linked = await link(seed, alice.id, editor);

    // Both rows are nominated. Before the first one's attribution advisory is taken, its current
    // content stops being a Drive document — committed by another session.
    const changed: string[] = [];
    const stored = new Map<string, Awaited<ReturnType<typeof credit>>>();
    for (const doc of docs) stored.set(doc.id, await credit(doc.id));
    const result = await runIdentityRepairObligation(db(), obligationOf(seed, editor.key, linked.mappingRevision!), {
      batchSize: 10,
      hooks: {
        beforeItemLock: async (itemId) => {
          if (changed.length) return;
          changed.push(itemId);
          // On the pool, not the repair's own transaction: another session's committed write.
          await getPool().query(
            `update items set frontmatter = jsonb_set(frontmatter, '{source}', '"notion"') where id=$1`, [itemId]);
        },
      },
    });
    expect(result).toEqual({ status: "complete", scanned: 2 });
    expect(changed).toHaveLength(1);
    const skipped = docs.find((doc) => doc.id === changed[0])!;
    const kept = docs.find((doc) => doc.id !== changed[0])!;

    // The recheck read the row as it is under the lock, not as the nomination saw it: nothing of
    // this row — credit, version ledger, evidence — was rewritten.
    const untouched = await credit(skipped.id);
    expect(untouched.item).toMatchObject({ member_id: null, source: "notion" });
    expect(untouched.versions).toEqual([null]);
    expect(untouched.evidence).toEqual(stored.get(skipped.id)!.evidence);
    expect(untouched.evidence.map((row) => row.member_id)).toEqual([null]);
    expect((await credit(kept.id)).item.member_id).toBe(alice.id);
    // Scanned past, not failed: the cursor covered both, one was updated, the obligation is done.
    expect(await obligationRow(seed, editor.key, linked.mappingRevision!))
      .toMatchObject({ status: "complete", items_scanned: 2, items_updated: 1, last_error: null });
  }, 90_000);

  it("FAIL CLOSED: a failed provenance read moves neither credit nor the obligation cursor; the retry heals", async () => {
    const seed = await adminSeed();
    const c = await driveConnection(seed);
    const alice = await member(seed, "Alice");
    const editor = person("editor");
    const docs = [await pushDoc(c, editor, "first"), await pushDoc(c, editor, "second")];
    const linked = await link(seed, alice.id, editor);
    const obligation = obligationOf(seed, editor.key, linked.mappingRevision!);
    const before = await Promise.all(docs.map((doc) => credit(doc.id)));
    const common = await commonCursor(seed);

    // The SECOND item's read fails: the first item's credit, version and evidence writes are
    // already in that batch's transaction when it does.
    let provenanceReads = 0;
    const failed = await withFailingStatements(
      (sql) => /\) as drive_provenance from items i where/i.test(sql) && ++provenanceReads === 2,
      () => runIdentityRepairObligation(db(), obligation, { batchSize: 10 }).then(() => null, (error: unknown) => error),
    );
    expect(provenanceReads).toBe(2);
    expect(failed.hits, "the injected failure never fired").toBe(1);
    expect(failed.outcome).toMatchObject({ message: expect.stringContaining("injected read failure") });

    expect(await Promise.all(docs.map((doc) => credit(doc.id)))).toEqual(before);
    expect(await obligationRow(seed, editor.key, linked.mappingRevision!)).toMatchObject({
      status: "retry", cursor_item_id: null, items_scanned: 0, items_updated: 0,
      last_error: expect.stringContaining("injected read failure"),
    });
    expect(await commonCursor(seed)).toEqual(common);

    // The durable obligation is still there, and a healthy attempt discharges it.
    expect(await runIdentityRepairObligation(db(), obligation, { batchSize: 10 })).toEqual({ status: "complete", scanned: 2 });
    for (const doc of docs) expect((await credit(doc.id)).item.member_id).toBe(alice.id);
    expect(await obligationRow(seed, editor.key, linked.mappingRevision!))
      .toMatchObject({ status: "complete", items_scanned: 2, items_updated: 2, last_error: null });
  }, 90_000);

  it("a CORRECTION committed while the obligation worker is paused wins: it is read under the item lock", async () => {
    const seed = await adminSeed();
    const c = await driveConnection(seed);
    const alice = await member(seed, "Alice");
    const editor = person("editor");
    const drive = await pushDoc(c, editor, "corrected to nobody");
    const linked = await link(seed, alice.id, editor);

    let release!: () => void;
    let ready!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const snapshotted = new Promise<void>((resolve) => { ready = resolve; });
    const paused = runIdentityRepairObligation(db(), obligationOf(seed, editor.key, linked.mappingRevision!), {
      hooks: { afterSnapshot: async () => { ready(); await gate; } },
    });
    paused.catch(() => undefined);
    try {
      await snapshotted;
      const correction = await applyAttributionCorrection(db(), seed.teamId, {
        kind: "reassign", match: { itemId: drive.id }, toMember: "nobody",
      }, { memberId: seed.memberId }, 1);
      expect(correction).toMatchObject({ ok: true, updated: 1 });
    } finally {
      release();
    }
    await expect(paused).resolves.toEqual({ status: "complete", scanned: 1 });

    const now = await credit(drive.id);
    expect(now.item).toMatchObject({ member_id: null, member_id_locked: true });
    expect(now.versions).toEqual([null]);
    expect(now.evidence).toEqual([{ member_id: null, diagnostic: "manual_credit_nobody" }]);
  }, 90_000);

  it("a NEWER mapping revision fences a paused stale worker: it writes nothing, and the current obligation repairs the document", async () => {
    const seed = await adminSeed();
    const c = await driveConnection(seed);
    const alice = await member(seed, "Alice");
    const bob = await member(seed, "Bob");
    const editor = person("editor");
    const drive = await pushDoc(c, editor, "remapped mid-repair");
    const first = await link(seed, alice.id, editor);

    let release!: () => void;
    let ready!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const snapshotted = new Promise<void>((resolve) => { ready = resolve; });
    // P snapshots "the identity is Alice's" and is paused before its batch.
    const workerP = runIdentityRepairObligation(db(), obligationOf(seed, editor.key, first.mappingRevision!), {
      hooks: { afterSnapshot: async () => { ready(); await gate; } },
    });
    workerP.catch(() => undefined);
    let second!: Awaited<ReturnType<typeof link>>;
    try {
      await snapshotted;
      second = await link(seed, bob.id, editor, { force: true, expectedRevision: first.mappingRevision });
    } finally {
      release();
    }
    await expect(workerP).rejects.toThrow(/identity mapping changed/);
    // The stale worker published nothing and made no progress on its superseded obligation.
    expect((await credit(drive.id)).item.member_id).toBeNull();
    const superseded = await obligationRow(seed, editor.key, first.mappingRevision!);
    expect(superseded.status).not.toBe("complete");
    expect(superseded).toMatchObject({ cursor_item_id: null, items_scanned: 0, items_updated: 0 });

    // The current mapping's obligation is the one that runs.
    expect(await runIdentityRepairObligation(db(), obligationOf(seed, editor.key, second.mappingRevision!)))
      .toEqual({ status: "complete", scanned: 1 });
    const now = await credit(drive.id);
    expect(now.item.member_id).toBe(bob.id);
    expect(now.versions).toEqual([bob.id]);
    expect(now.evidence).toEqual([{ member_id: bob.id, diagnostic: null }]);
    expect(second.mappingRevision).toBeGreaterThan(first.mappingRevision!);
    // And the superseded one, run again, recognises that it is obsolete.
    expect(await runIdentityRepairObligation(db(), obligationOf(seed, editor.key, first.mappingRevision!)))
      .toMatchObject({ status: "obsolete" });
    expect((await credit(drive.id)).item.member_id).toBe(bob.id);
  }, 90_000);
});
