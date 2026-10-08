import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ApiAuth } from "@/lib/api/auth";
import type { ItemPayload } from "@/lib/api/schemas";
import { createGroup, grantProjectToGroup } from "@/lib/access/groups";
import { addAuthorAlias, removeAuthorAlias } from "@/lib/admin/aliases";
import { deleteMember } from "@/lib/admin/members";
import { attributeIncomingItem } from "@/lib/attribution/resolve-authors";
import { getPool } from "@/lib/db/pg/pool";
import type { DbClient } from "@/lib/db/types";
import { buildIdentityAuthoritySnapshot } from "@/lib/identity/authority";
import { ingestApiItem, ingestItem } from "@/lib/ingest";
import { applyAttributionCorrection } from "@/lib/ingest/attribution-correction";
import { reattributeItems, repairAttributionItem } from "@/lib/ingest/reattribute";
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
 * COMMON ATTRIBUTION REPAIR over Google Drive documents, against real PostgreSQL (AIO-1167) — the
 * observable half of `test/gdrive-common-repair.test.ts`.
 *
 * Spec. A Drive document is stored `external` (its unit tier; claim memberships are the authority).
 * The team-wide repair that follows an alias link/remap/unlink or a member deactivation used to
 * select and admit only non-external rows, so it skipped every Drive document and then declared the
 * team complete with their credit stale. Therefore, with documents ingested through the PUBLIC
 * authorized Drive path (so the storage really is `external`):
 *
 *   1. alias link, remap and unlink, and member deactivation — each through its production writer —
 *      converge the current item, EVERY historical version from its own retained author, and the
 *      contribution evidence, before the team's repair is `complete`;
 *   2. the trust root is the persisted same-team `gdrive` mapping alone: it works with a NULL
 *      `connection_id`, with no active claim, and with the connection disconnected;
 *   3. a correction lock read under the item lock wins; a stale-revision worker writes nothing;
 *   4. a failed mapping, provenance, evidence or cache step never yields a false completion, and
 *      never advances past an item it did not repair;
 *   5. a generic external client item, forged Drive frontmatter, a foreign team's mapping and a
 *      non-Drive mapping stay excluded, with their stored credit unchanged.
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

/**
 * One revision of a Drive document through the PUBLIC ingest owner, attributed exactly as the items
 * route attributes it: an identity-authority snapshot, then the fenced Drive commit.
 */
async function pushDoc(c: Connection, providerId: string, body: string, editor: Person) {
  const payload = {
    project: "drive-repair", path: `gdrive/${providerId}.md`, kind: "deliverable", access: "team",
    actor: "gdrive-sync", body, content_sha256: sha(body),
    frontmatter: {
      source: "gdrive", source_id: providerId, connection_id: c.integrationId, title: `Doc ${providerId}`,
      authors: [{ provider: "gdrive", external_id: editor.key, email: editor.email, role: "editor" }],
      contributions: [{ external_id: editor.key, email: editor.email, role: "editor", at: new Date().toISOString() }],
    },
  } as ItemPayload;
  const { opts } = await attributeIncomingItem(db(), c.auth.teamId, payload, c.auth.memberId);
  return ingestApiItem(db(), c.auth, payload, "team", opts, "team", c.execution);
}

/** A document with TWO revisions by two different accounts: `first` wrote v1, `second` the current one. */
async function twoAuthorDoc(c: Connection, first: Person, second: Person): Promise<string> {
  const providerId = `doc-${randomUUID().slice(0, 8)}`;
  const created = await pushDoc(c, providerId, "first revision", first);
  expect(created.status).toBe("created");
  const updated = await pushDoc(c, providerId, "second revision", second);
  expect(updated).toMatchObject({ status: "updated", id: created.id });
  return created.id;
}

/** An ordinary item with stored credit and a generic author signal, at a chosen tier. */
async function clientItem(seed: Seed, path: string, access: "team" | "external", authorEmail: string, creditedTo: string) {
  const body = `content of ${path}`;
  const result = await ingestItem(
    db(), { teamId: seed.teamId, memberId: seed.memberId, apiKeyId: randomUUID() },
    {
      project: "client-work", path, kind: "deliverable", access, actor: "client", body, content_sha256: sha(body),
      frontmatter: { source: "notion", authors: [{ email: authorEmail, role: "author" }] },
    } as ItemPayload,
    access, { authorMemberId: creditedTo },
  );
  return result.id;
}

async function credit(itemId: string) {
  const pool = getPool();
  const item = (await pool.query<{ member_id: string | null; member_id_locked: boolean; access: string }>(
    "select member_id, member_id_locked, access::text as access from items where id=$1", [itemId])).rows[0];
  const versions = (await pool.query<{ author: string | null; member_id: string | null }>(
    `select frontmatter->'authors'->0->>'email' as author, member_id
       from item_versions where item_id=$1 order by created_at, id`, [itemId])).rows;
  const evidence = (await pool.query<{ email: string; member_id: string | null; diagnostic: string | null; authority_revision: string | null }>(
    `select email, member_id, diagnostic, authority_revision
       from gdrive_contribution_evidence where item_id=$1 order by email`, [itemId])).rows;
  return { item, versions, evidence };
}

async function authority(seed: Seed) {
  const { rows } = await getPool().query<{
    repair_status: string; revision: string; cursor_item_id: string | null; last_error: string | null;
  }>("select repair_status, revision, cursor_item_id, last_error from team_identity_authority where team_id=$1", [seed.teamId]);
  return { ...rows[0], revision: Number(rows[0].revision) };
}

const repair = (seed: Seed, client: DbClient = db()) =>
  repairAttributionNow(client, seed.teamId, seed.teamSlug, { maxBatches: 10, batchSize: 20 });

/** Run the team repair to completion and require that it IS complete. */
async function repairToCompletion(seed: Seed) {
  const summary = await repair(seed);
  expect(summary.partial).toBe(false);
  expect(await authority(seed)).toMatchObject({ repair_status: "complete" });
  return summary;
}

/**
 * Real-statement fault injection: every statement but the matching ones reaches PostgreSQL through
 * the application's own pool; a matching one is rejected as the driver would reject a failed read.
 */
async function withFailingStatements<T>(pattern: RegExp, fn: () => Promise<T>): Promise<{ outcome: T; hits: number }> {
  type Callable = (...args: unknown[]) => unknown;
  const pool = getPool() as unknown as { query: Callable; connect: Callable };
  const ownQuery = Object.prototype.hasOwnProperty.call(pool, "query");
  const ownConnect = Object.prototype.hasOwnProperty.call(pool, "connect");
  const originalQuery = pool.query;
  const originalConnect = pool.connect;
  const wrapped = new Map<{ query: Callable }, { query: Callable; own: boolean }>();
  let hits = 0;
  const fails = (text: unknown) => typeof text === "string" && pattern.test(text.replace(/\s+/g, " ").trim());
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

/** The real client, except that one builder operation on one table answers with an error envelope. */
function failingBuilder(table: string, operation: "upsert" | "delete", message: string): DbClient {
  const real = db();
  const failed = { data: null, error: { message } };
  const answer: Record<string, unknown> = {
    then: (resolve: (value: unknown) => unknown) => resolve(failed),
  };
  for (const chained of ["eq", "select", "in"]) answer[chained] = () => answer;
  return new Proxy(real as object, {
    get(target, prop, receiver) {
      if (prop !== "from") return Reflect.get(target, prop, receiver);
      return (name: string) => {
        const query = (target as { from: (n: string) => unknown }).from(name) as object;
        if (name !== table) return query;
        return new Proxy(query, {
          get(inner, key, innerReceiver) {
            return key === operation ? () => answer : Reflect.get(inner, key, innerReceiver);
          },
        });
      };
    },
  }) as DbClient;
}

describe("AIO-1167 common repair admits Drive documents by their persisted mapping (real Postgres)", () => {
  it("alias LINK, REMAP and UNLINK converge the external Drive item, each version from its own author, and the evidence — before completion", async () => {
    const seed = await adminSeed();
    const c = await driveConnection(seed);
    const alice = await member(seed, "Alice");
    const bob = await member(seed, "Bob");
    const first = person("first");
    const second = person("second");
    const itemId = await twoAuthorDoc(c, first, second);

    // The premise: storage is `external`, and the mapping carries no connection id.
    const { rows: mapping } = await getPool().query<{ connection_id: string | null }>(
      "select connection_id from source_item_mappings where team_id=$1 and item_id=$2 and source='gdrive'",
      [seed.teamId, itemId]);
    expect(mapping).toEqual([{ connection_id: null }]);
    const stored = await credit(itemId);
    expect(stored.item).toMatchObject({ access: "external", member_id: null, member_id_locked: false });
    expect(stored.versions).toEqual([
      { author: first.email, member_id: null },
      { author: second.email, member_id: null },
    ]);
    expect(stored.evidence.map((row) => [row.email, row.member_id]).sort())
      .toEqual([[first.email, null], [second.email, null]].sort());
    await repairToCompletion(seed);

    // ── LINK: the first editor is Bob, the current editor is Alice ──────────────────────────────
    expect(await addAuthorAlias(db(), seed.teamId, bob.id, first.email)).toMatchObject({ aliased: true });
    expect(await addAuthorAlias(db(), seed.teamId, alice.id, second.email)).toMatchObject({ aliased: true });
    // Pending, and not yet converged: nothing may call this team complete now.
    expect(await authority(seed)).toMatchObject({ repair_status: "pending" });
    expect((await credit(itemId)).item.member_id).toBeNull();

    const linked = await repairToCompletion(seed);
    expect(linked.scanned).toBeGreaterThanOrEqual(1);
    let revision = (await authority(seed)).revision;
    let now = await credit(itemId);
    expect(now.item).toMatchObject({ access: "external", member_id: alice.id });
    // History is NOT the current author's: the first revision stays with whoever wrote it.
    expect(now.versions).toEqual([
      { author: first.email, member_id: bob.id },
      { author: second.email, member_id: alice.id },
    ]);
    expect(now.evidence.map((row) => [row.email, row.member_id, row.diagnostic, Number(row.authority_revision)]).sort())
      .toEqual([[first.email, bob.id, null, revision], [second.email, alice.id, null, revision]].sort());

    // ── REMAP: the current editor's address now belongs to Bob ──────────────────────────────────
    expect(await addAuthorAlias(db(), seed.teamId, bob.id, second.email, { force: true })).toMatchObject({ aliased: true });
    expect(await authority(seed)).toMatchObject({ repair_status: "pending" });
    await repairToCompletion(seed);
    revision = (await authority(seed)).revision;
    now = await credit(itemId);
    expect(now.item.member_id).toBe(bob.id);
    expect(now.versions.map((row) => row.member_id)).toEqual([bob.id, bob.id]);
    expect(now.evidence.every((row) => row.member_id === bob.id && Number(row.authority_revision) === revision)).toBe(true);

    // ── UNLINK: the current editor's address is no longer anyone's ──────────────────────────────
    expect(await removeAuthorAlias(db(), seed.teamId, second.email)).toEqual({ removed: true });
    await repairToCompletion(seed);
    revision = (await authority(seed)).revision;
    now = await credit(itemId);
    expect(now.item.member_id).toBeNull();
    // The first revision's author is still linked: its credit is not dragged down with the current one.
    expect(now.versions).toEqual([
      { author: first.email, member_id: bob.id },
      { author: second.email, member_id: null },
    ]);
    expect(now.evidence.map((row) => [row.email, row.member_id, Number(row.authority_revision)]).sort())
      .toEqual([[first.email, bob.id, revision], [second.email, null, revision]].sort());
  }, 60_000);

  it("member DEACTIVATION clears the deactivated member's Drive credit — item, their versions and their evidence — and leaves the rest", async () => {
    const seed = await adminSeed();
    const c = await driveConnection(seed);
    const carol = await member(seed, "Carol");
    const dave = await member(seed, "Dave");
    const first = person("first");
    const second = person("second");
    const itemId = await twoAuthorDoc(c, first, second);
    await addAuthorAlias(db(), seed.teamId, dave.id, first.email);
    await addAuthorAlias(db(), seed.teamId, carol.id, second.email);
    await repairToCompletion(seed);
    expect((await credit(itemId)).versions.map((row) => row.member_id)).toEqual([dave.id, carol.id]);

    // The production roster writer: a soft delete.
    expect(await deleteMember(db(), seed.teamId, carol.email)).toMatchObject({ deleted: true, mode: "soft" });
    expect(await authority(seed)).toMatchObject({ repair_status: "pending" });
    await repairToCompletion(seed);

    const now = await credit(itemId);
    expect(now.item.member_id).toBeNull();
    expect(now.versions).toEqual([
      { author: first.email, member_id: dave.id },
      { author: second.email, member_id: null },
    ]);
    expect(now.evidence.map((row) => [row.email, row.member_id]).sort())
      .toEqual([[first.email, dave.id], [second.email, null]].sort());
  }, 60_000);

  it("the mapping is the trust root after DISCONNECT: no active claim, no lease, a disabled connection, a NULL connection id", async () => {
    const seed = await adminSeed();
    const c = await driveConnection(seed);
    const alice = await member(seed, "Alice");
    const editor = person("editor");
    const providerId = `doc-${randomUUID().slice(0, 8)}`;
    const created = await pushDoc(c, providerId, "retained after disconnect", editor);
    await repairToCompletion(seed);

    // Final-claim retirement (staged: the item is retained, cleanup still owed), then disconnect.
    await withGdriveExecutionCommit(c.auth, c.execution, () => stageGdriveReconciliation(
      db(), seed.teamId,
      { connectionId: c.integrationId, removedProviderIds: [providerId], reason: "removed upstream" },
      { memberId: c.auth.memberId, apiKeyId: c.auth.apiKeyId },
    ));
    await disconnectGdriveIntegration(db(), { teamId: seed.teamId, memberId: seed.memberId }, c.integrationId);
    const { rows: retained } = await getPool().query<{
      active_claims: number; status: string; lease_owner: string | null; connection_id: string | null; access: string;
    }>(
      `select (select count(*)::int from gdrive_item_claims k where k.team_id=$1 and k.item_id=$2 and k.active) as active_claims,
              n.status, a.lease_owner, m.connection_id, i.access::text as access
         from items i
         join source_item_mappings m on m.team_id=i.team_id and m.item_id=i.id and m.source='gdrive'
         join integrations n on n.id=$3
         join gdrive_connection_authority a on a.integration_id=n.id
        where i.id=$2`, [seed.teamId, created.id, c.integrationId]);
    expect(retained).toEqual([{ active_claims: 0, status: "disabled", lease_owner: null, connection_id: null, access: "external" }]);

    await addAuthorAlias(db(), seed.teamId, alice.id, editor.email);
    await repairToCompletion(seed);
    const now = await credit(created.id);
    expect(now.item.member_id).toBe(alice.id);
    expect(now.versions.map((row) => row.member_id)).toEqual([alice.id]);
    expect(now.evidence.map((row) => row.member_id)).toEqual([alice.id]);
  }, 60_000);

  it("NEGATIVE CONTROLS: a generic external item, forged Drive frontmatter, a foreign team's mapping and a non-Drive mapping are never selected and keep their credit", async () => {
    const seed = await adminSeed();
    const otherTeam = await seedTeam();
    const c = await driveConnection(seed);
    const alice = await member(seed, "Alice");
    const editor = person("editor");
    const stale = seed.memberId; // the credit every control row starts with

    // Positive controls: a real Drive document, and a team-tier twin of the client items.
    const drive = await pushDoc(c, `doc-${randomUUID().slice(0, 8)}`, "a real drive document", editor);
    const teamTwin = await clientItem(seed, "client/team-twin.md", "team", editor.email, stale);

    const generic = await clientItem(seed, "client/generic.md", "external", editor.email, stale);
    const forged = await clientItem(seed, "client/forged.md", "external", editor.email, stale);
    const foreign = await clientItem(seed, "client/foreign-mapping.md", "external", editor.email, stale);
    const otherSource = await clientItem(seed, "client/other-source.md", "external", editor.email, stale);
    // FORGED provenance, on the row and on its retained version: source, id, authors,
    // contributions and this team's real connection id. Everything a pusher could write.
    const forgedFrontmatter = JSON.stringify({
      source: "gdrive", source_id: "forged-doc", connection_id: c.integrationId,
      authors: [{ provider: "gdrive", external_id: editor.key, email: editor.email, role: "editor" }],
      contributions: [{ external_id: editor.key, email: editor.email, role: "editor", at: new Date().toISOString() }],
    });
    await getPool().query("update items set frontmatter=$2::jsonb where id=$1", [forged, forgedFrontmatter]);
    await getPool().query("update item_versions set frontmatter=$2::jsonb where item_id=$1", [forged, forgedFrontmatter]);
    // A gdrive mapping for this very item id — in ANOTHER team.
    await getPool().query(
      `insert into source_item_mappings (team_id, source, provider_id, item_id, connection_id, canonical_path)
       values ($1, 'gdrive', 'foreign-doc', $2, null, 'client/foreign-mapping.md')`, [otherTeam.teamId, foreign]);
    // A same-team mapping for this item — from a source that is not Drive.
    await getPool().query(
      `insert into source_item_mappings (team_id, source, provider_id, item_id, connection_id, canonical_path)
       values ($1, 'notion', 'notion-page', $2, null, 'client/other-source.md')`, [seed.teamId, otherSource]);
    const controls = [generic, forged, foreign, otherSource];
    for (const id of controls) {
      expect((await credit(id)).item).toMatchObject({ access: "external", member_id: stale });
    }
    await repairToCompletion(seed);

    // The author every one of these rows names now resolves to Alice.
    await addAuthorAlias(db(), seed.teamId, alice.id, editor.email);
    const summary = await repairToCompletion(seed);

    // Exactly the two eligible rows were selected: the controls were never candidates.
    expect(summary.scanned).toBe(2);
    expect((await credit(drive.id)).item).toMatchObject({ access: "external", member_id: alice.id });
    expect((await credit(teamTwin)).item).toMatchObject({ access: "team", member_id: alice.id });
    for (const id of controls) {
      const kept = await credit(id);
      expect(kept.item, `control ${id} was repaired`).toMatchObject({ access: "external", member_id: stale });
      expect(kept.versions.map((row) => row.member_id)).toEqual([stale]);
      expect(kept.evidence, "an excluded row was given contribution evidence").toEqual([]);
    }
  }, 60_000);

  it("UNDER THE ITEM LOCK the same rule is applied again: a nominated but unmapped external row is skipped, a mapped one is repaired", async () => {
    const seed = await adminSeed();
    const otherTeam = await seedTeam();
    const c = await driveConnection(seed);
    const alice = await member(seed, "Alice");
    const editor = person("editor");
    const stale = seed.memberId;
    const drive = await pushDoc(c, `doc-${randomUUID().slice(0, 8)}`, "a real drive document", editor);
    const generic = await clientItem(seed, "client/generic.md", "external", editor.email, stale);
    const foreign = await clientItem(seed, "client/foreign-mapping.md", "external", editor.email, stale);
    await getPool().query(
      `insert into source_item_mappings (team_id, source, provider_id, item_id, connection_id, canonical_path)
       values ($1, 'gdrive', 'foreign-doc', $2, null, 'client/foreign-mapping.md')`, [otherTeam.teamId, foreign]);
    await addAuthorAlias(db(), seed.teamId, alice.id, editor.email);

    // Each item is handed straight to the per-item owner, as if a candidate read had nominated it.
    const snapshot = await buildIdentityAuthoritySnapshot(db(), seed.teamId);
    for (const id of [generic, foreign]) {
      expect(await repairAttributionItem(db(), snapshot, id)).toEqual({ item: 0, versions: 0, contributions: 0 });
      expect((await credit(id)).item.member_id).toBe(stale);
      // Skipped is not failed: the cursor moves past it.
      expect((await authority(seed)).cursor_item_id).toBe(id);
    }
    expect(await repairAttributionItem(db(), snapshot, drive.id)).toEqual({ item: 1, versions: 1, contributions: 1 });
    expect((await credit(drive.id)).item.member_id).toBe(alice.id);
  }, 60_000);

  it("a CORRECTION committed while the repair is paused wins: it is read under the item lock", async () => {
    const seed = await adminSeed();
    const c = await driveConnection(seed);
    const alice = await member(seed, "Alice");
    const editor = person("editor");
    const drive = await pushDoc(c, `doc-${randomUUID().slice(0, 8)}`, "corrected to nobody", editor);
    await addAuthorAlias(db(), seed.teamId, alice.id, editor.email);

    let release!: () => void;
    let ready!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const snapshotted = new Promise<void>((resolve) => { ready = resolve; });
    const paused = reattributeItems(db(), seed.teamId, {
      batchSize: 10, afterSnapshot: async () => { ready(); await gate; },
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
    await expect(paused).resolves.toMatchObject({ partial: false });

    const now = await credit(drive.id);
    expect(now.item).toMatchObject({ member_id: null, member_id_locked: true });
    expect(now.versions.map((row) => row.member_id)).toEqual([null]);
    expect(now.evidence.map((row) => [row.member_id, row.diagnostic])).toEqual([[null, "manual_credit_nobody"]]);
  }, 60_000);

  it("a STALE-REVISION worker writes nothing to a Drive document; the current revision's repair does", async () => {
    const seed = await adminSeed();
    const c = await driveConnection(seed);
    const alice = await member(seed, "Alice");
    const bob = await member(seed, "Bob");
    const editor = person("editor");
    const drive = await pushDoc(c, `doc-${randomUUID().slice(0, 8)}`, "remapped mid-repair", editor);
    await addAuthorAlias(db(), seed.teamId, alice.id, editor.email);

    let release!: () => void;
    let ready!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const snapshotted = new Promise<void>((resolve) => { ready = resolve; });
    // P snapshots "the address is Alice's" and is paused before it selects a single item.
    const workerP = reattributeItems(db(), seed.teamId, {
      batchSize: 10, afterSnapshot: async () => { ready(); await gate; },
    });
    workerP.catch(() => undefined);
    try {
      await snapshotted;
      await addAuthorAlias(db(), seed.teamId, bob.id, editor.email, { force: true });
      await repairToCompletion(seed);
    } finally {
      release();
    }
    await expect(workerP).rejects.toThrow(/identity mapping changed/);

    const now = await credit(drive.id);
    const current = await authority(seed);
    expect(now.item.member_id).toBe(bob.id);
    expect(now.versions.map((row) => row.member_id)).toEqual([bob.id]);
    expect(now.evidence.map((row) => [row.member_id, Number(row.authority_revision)])).toEqual([[bob.id, current.revision]]);
    expect(current).toMatchObject({ repair_status: "complete" });
  }, 60_000);

  it.each([
    ["the candidate selection's mapping read", /^select i\.id from items i where i\.team_id=\$1 and \(i\.access::text/i],
    ["the under-lock mapping recheck", /\) as eligible from items i where/i],
    ["the version provenance read", /from item_versions v where v\.item_id=\$1/i],
  ])("FAIL CLOSED: when %s fails, nothing is repaired, the cursor does not move and the team is not complete", async (_name, pattern) => {
    const seed = await adminSeed();
    const c = await driveConnection(seed);
    const alice = await member(seed, "Alice");
    const editor = person("editor");
    const drive = await pushDoc(c, `doc-${randomUUID().slice(0, 8)}`, "read failure", editor);
    await repairToCompletion(seed);
    await addAuthorAlias(db(), seed.teamId, alice.id, editor.email);
    const before = await credit(drive.id);

    const failed = await withFailingStatements(pattern, () => repair(seed).then(() => null, (error: unknown) => error));
    expect(failed.hits, "the injected failure never fired").toBeGreaterThanOrEqual(1);
    expect(failed.outcome).toMatchObject({ message: expect.stringContaining("injected read failure") });

    expect(await credit(drive.id)).toEqual(before);
    expect(await authority(seed)).toMatchObject({
      repair_status: "retry", cursor_item_id: null, last_error: expect.stringContaining("injected read failure"),
    });

    // The durable obligation is still there, and a healthy pass discharges it.
    await repairToCompletion(seed);
    expect((await credit(drive.id)).item.member_id).toBe(alice.id);
  }, 60_000);

  it("FAIL CLOSED: an evidence write failure rolls the item and version credit back with it — no partial repair, no completion", async () => {
    const seed = await adminSeed();
    const c = await driveConnection(seed);
    const alice = await member(seed, "Alice");
    const editor = person("editor");
    const drive = await pushDoc(c, `doc-${randomUUID().slice(0, 8)}`, "evidence failure", editor);
    await repairToCompletion(seed);
    await addAuthorAlias(db(), seed.teamId, alice.id, editor.email);
    const before = await credit(drive.id);

    await expect(repair(seed, failingBuilder("gdrive_contribution_evidence", "upsert", "injected evidence outage")))
      .rejects.toThrow(/injected evidence outage/);
    // The item and version updates of that transaction went with the failed evidence write.
    expect(await credit(drive.id)).toEqual(before);
    expect(await authority(seed)).toMatchObject({
      repair_status: "retry", cursor_item_id: null, last_error: expect.stringContaining("injected evidence outage"),
    });

    await repairToCompletion(seed);
    const now = await credit(drive.id);
    expect(now.item.member_id).toBe(alice.id);
    expect(now.evidence.map((row) => row.member_id)).toEqual([alice.id]);
  }, 60_000);

  it("NO FALSE COMPLETION: a cache purge failure after the Drive credit converged leaves the team in retry, not complete", async () => {
    const seed = await adminSeed();
    const c = await driveConnection(seed);
    const alice = await member(seed, "Alice");
    const editor = person("editor");
    const drive = await pushDoc(c, `doc-${randomUUID().slice(0, 8)}`, "cache failure", editor);
    await repairToCompletion(seed);
    await addAuthorAlias(db(), seed.teamId, alice.id, editor.email);

    await expect(repair(seed, failingBuilder("work_timeline_cache", "delete", "injected purge outage")))
      .rejects.toThrow(/injected purge outage/);
    // Durable credit is repaired; completion is fenced on the strict purge and did not happen.
    expect((await credit(drive.id)).item.member_id).toBe(alice.id);
    expect(await authority(seed)).toMatchObject({
      repair_status: "retry", last_error: expect.stringContaining("injected purge outage"),
    });

    await repairToCompletion(seed);
  }, 60_000);
});
