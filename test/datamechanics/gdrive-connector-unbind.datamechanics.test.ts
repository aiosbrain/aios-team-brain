import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ApiAuth } from "@/lib/api/auth";
import type { ItemPayload } from "@/lib/api/schemas";
import { createGroup, grantProjectToGroup } from "@/lib/access/groups";
import { deleteMember, rollbackMemberCreation } from "@/lib/admin/members";
import { getPool, runSql } from "@/lib/db/pg/pool";
import type { DbClient } from "@/lib/db/types";
import { ingestApiItem } from "@/lib/ingest";
import {
  acquireGdriveExecution,
  authorizeGdriveProviderCall,
  checkpointGdriveExecution,
  provisionGdriveConnectorPrincipal,
  withGdriveExecutionCommit,
  type GdriveExecutionRef,
} from "@/lib/integrations/gdrive-authority";
import { setIntegrationSecret, upsertIntegration } from "@/lib/integrations/manage";
import { db, seedTeam, sha, type Seed } from "./helpers";

/**
 * Unbinding a Drive connector before its member is hard-deleted, against real PostgreSQL (AIO-1167).
 *
 * Spec. A connection's binding is a PAIR — connector member and connector API key, both set or both
 * null (a table CHECK). The foreign keys clear the two one at a time, so a raw delete of a bound
 * connector member fails closed. `deleteMember({ hard: true })` and `rollbackMemberCreation`
 * therefore unbind first (`unbindGdriveConnectorMember`), inside their own identity-mutation
 * transaction:
 *
 *   1. every connection bound to the member has BOTH ids cleared in one statement, with its
 *      generation and fence advanced exactly once and its lease dropped — an execution acquired
 *      under the old binding is refused;
 *   2. nothing else changes: the credential, the progress, the claims, the content and its
 *      attribution survive, and the connection can be provisioned again;
 *   3. it is atomic with the deletion: a delete that fails afterwards rolls back the unbinding, the
 *      generation/fence/lease change and the audit;
 *   4. it is audited with the prior member and key ROW ids and the acting principal — never key
 *      material;
 *   5. deletion and provisioning/rotation/execution serialize at the identity authority, in either
 *      order;
 *   6. a soft disable, and the deletion of a member that is not a connector, are unchanged.
 */

const STORED_SECRET = JSON.stringify({
  client_id: "oauth-client", client_secret: "stored-secret", refresh_token: "stored-refresh",
  token_uri: "https://oauth2.googleapis.com/token", account_subject: "subject:acct-1",
});

interface Bound {
  integrationId: string;
  auth: ApiAuth;
  execution: GdriveExecutionRef;
  progressRevision: number;
  /** The provisioned key as handed to the sidecar: `aios_<keyId>_<secret>`. */
  key: string;
  keyRowId: string;
}

async function adminSeed(): Promise<Seed> {
  const seed = await seedTeam();
  await db().from("members").update({ role: "admin" }).eq("id", seed.memberId).eq("team_id", seed.teamId);
  return seed;
}

async function bind(seed: Seed, integrationId: string): Promise<Bound> {
  const issued = await provisionGdriveConnectorPrincipal({
    teamId: seed.teamId, integrationId, actorMemberId: seed.memberId,
  });
  const { data: keyRow } = await db().from("api_keys").select("id").eq("key_id", issued.keyId).single();
  const auth: ApiAuth = {
    teamId: seed.teamId, memberId: issued.memberId, memberTier: "team", memberRole: "member",
    apiKeyId: (keyRow as { id: string }).id, actorHandle: "gdrive-sync",
    displayName: "Google Drive Sync", email: null, isConnector: true,
  };
  const acquired = await acquireGdriveExecution(auth, integrationId, randomUUID());
  return {
    integrationId, auth, key: issued.key, keyRowId: auth.apiKeyId,
    execution: { integrationId, generation: acquired.generation, fence: acquired.fence, owner: acquired.owner },
    progressRevision: acquired.progressRevision,
  };
}

/** An enabled OAuth connection with a stored credential, a granted audience and a bound connector. */
async function connection(seed: Seed): Promise<Bound> {
  const { data: project, error } = await db().from("projects")
    .insert({ team_id: seed.teamId, slug: `aud-${randomUUID().slice(0, 8)}`, name: "Drive audience", kind: "initiative" })
    .select("id").single();
  if (error || !project) throw new Error(`audience fixture failed: ${error?.message}`);
  const audienceProjectId = (project as { id: string }).id;
  const group = await createGroup(db(), seed.teamId, `aud-${randomUUID().slice(0, 8)}`, "Audience", seed.memberId);
  if (!group.ok) throw new Error(`audience group fixture failed: ${group.error}`);
  const granted = await grantProjectToGroup(db(), seed.teamId, audienceProjectId, group.groupId!, seed.memberId);
  if (!granted.ok) throw new Error("audience grant fixture failed");
  const owner = { teamId: seed.teamId, memberId: seed.memberId };
  const row = await upsertIntegration(db(), owner, {
    type: "gdrive", name: `drive-${randomUUID().slice(0, 8)}`, status: "enabled",
    config: {
      fileIds: ["doc"], folderIds: [], sharedDriveIds: [], recursive: false,
      selectionState: "selected", access: "team", authMode: "oauth",
      authenticatedAccount: "docs@example.com", authenticatedAccountId: "subject:acct-1",
      audienceProjectIds: [audienceProjectId],
    },
  });
  await setIntegrationSecret(db(), owner, row.id, STORED_SECRET);
  return bind(seed, row.id);
}

async function pushDoc(c: Bound, providerId: string, body: string) {
  return ingestApiItem(db(), c.auth, {
    project: "drive-unbind", path: `gdrive/${providerId}.md`, kind: "deliverable", access: "team",
    actor: "gdrive-sync", body, content_sha256: sha(body),
    frontmatter: { source: "gdrive", source_id: providerId, connection_id: c.integrationId },
  } as ItemPayload, "team", { authorMemberId: null }, "team", c.execution);
}

interface AuthorityState {
  connector_member_id: string | null;
  connector_api_key_id: string | null;
  generation: number;
  fence: number;
  lease_owner: string | null;
  lease_until: string | null;
  progress: Record<string, unknown>;
  progress_revision: number;
  updated_at: string;
}

async function authorityOf(integrationId: string): Promise<AuthorityState> {
  const { rows } = await getPool().query<AuthorityState>(
    `select connector_member_id, connector_api_key_id, generation::int as generation, fence::int as fence,
            lease_owner, lease_until, progress, progress_revision::int as progress_revision, updated_at
       from gdrive_connection_authority where integration_id=$1`, [integrationId]);
  return rows[0];
}

async function auditsOf(seed: Seed, action: string) {
  const { rows } = await getPool().query<{ actor_kind: string; member_id: string | null; target_id: string | null; meta: Record<string, unknown> }>(
    "select actor_kind, member_id, target_id, meta from audit_log where team_id=$1 and action=$2 order by id",
    [seed.teamId, action]);
  return rows;
}

async function emailOf(memberId: string): Promise<string> {
  const { rows } = await getPool().query<{ email: string }>("select email from members where id=$1", [memberId]);
  return rows[0].email;
}

const memberExists = async (memberId: string) =>
  (await getPool().query("select 1 from members where id=$1", [memberId])).rows.length === 1;

function gate() {
  let release!: () => void;
  let reached!: () => void;
  const open = new Promise<void>((resolve) => { release = resolve; });
  const at = new Promise<void>((resolve) => { reached = resolve; });
  return { open, at, release, reached };
}

type Settled<T> = Promise<{ value: T | null; error: unknown }>;
const settled = <T>(promise: Promise<T>): Settled<T> =>
  promise.then((value) => ({ value, error: null }), (error: unknown) => ({ value: null, error }));

/** Exactly one backend queued on an advisory lock, holding none: it waits at the identity authority. */
async function loserWaitsAtTheIdentityAuthority(): Promise<void> {
  let seen: { held: number }[] = [];
  for (let tries = 0; tries < 320; tries++) {
    seen = (await getPool().query<{ held: number }>(
      `select (select count(*)::int from pg_locks g
                where g.pid = w.pid and g.locktype = 'advisory' and g.granted) as held
         from pg_locks w join pg_database d on d.oid = w.database
        where d.datname = current_database() and w.locktype = 'advisory' and not w.granted`)).rows;
    if (seen.length === 1) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  expect(seen, "expected exactly one backend queued on an advisory lock").toHaveLength(1);
  expect(seen[0].held, "the loser is past the identity authority").toBe(0);
}

/** A connection's binding state and unbind audits, as the deleting transaction itself sees them. */
interface InsideTheDeletion {
  connector_member_id: string | null;
  connector_api_key_id: string | null;
  generation: number;
  fence: number;
  lease_owner: string | null;
  audits: number;
}

/**
 * The real client, except that deleting from `members` fails — after `observe` has looked at the
 * transaction from the inside, on the deletion's own connection.
 */
function failingMemberDelete(observe: () => Promise<void>): DbClient {
  const real = db();
  return new Proxy(real as object, {
    get(target, prop, receiver) {
      if (prop !== "from") return Reflect.get(target, prop, receiver);
      return (name: string) => {
        const query = (target as { from: (n: string) => unknown }).from(name) as object;
        if (name !== "members") return query;
        return new Proxy(query, {
          get(inner, key, innerReceiver) {
            if (key !== "delete") return Reflect.get(inner, key, innerReceiver);
            const failed: Record<string, unknown> = {
              then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
                observe().then(() => resolve({ data: null, error: { message: "injected member delete failure" } }), reject),
            };
            failed.eq = () => failed;
            return () => failed;
          },
        });
      };
    },
  }) as DbClient;
}

describe("AIO-1167 Drive connector unbinding before a hard member deletion (real Postgres)", () => {
  it("HARD DELETE of a connector bound to TWO connections: both pairs cleared together, one generation/fence step each, leases dropped — everything else preserved, audited, re-provisionable", async () => {
    const seed = await adminSeed();
    const first = await connection(seed);
    const second = await connection(seed);
    // One connector member per team: both connections are bound to it, each with its own key.
    expect(second.auth.memberId).toBe(first.auth.memberId);
    const connectorId = first.auth.memberId;
    const connectorEmail = await emailOf(connectorId);

    const doc = await pushDoc(first, "kept-doc", "retained content");
    expect(doc.status).toBe("created");
    const checkpointed = await checkpointGdriveExecution(first.auth, first.execution, { page_token: "resume-here" }, first.progressRevision);
    const before = { first: await authorityOf(first.integrationId), second: await authorityOf(second.integrationId) };
    expect(before.first).toMatchObject({ connector_member_id: connectorId, connector_api_key_id: first.keyRowId, lease_owner: first.execution.owner });
    expect(before.second).toMatchObject({ connector_member_id: connectorId, connector_api_key_id: second.keyRowId, lease_owner: second.execution.owner });
    const preserved = async () => ({
      credentials: (await getPool().query(
        "select id, status, secret_ciphertext, config from integrations where team_id=$1 and type='gdrive' order by id", [seed.teamId])).rows,
      claims: (await getPool().query(
        "select integration_id, provider_id, item_id, active, generation::text as generation from gdrive_item_claims where team_id=$1 order by integration_id, provider_id", [seed.teamId])).rows,
      content: (await getPool().query(
        "select id, body, member_id, member_id_locked, access::text as access from items where id=$1", [doc.id])).rows,
      mappings: (await getPool().query(
        "select provider_id, item_id, connection_id from source_item_mappings where team_id=$1 order by provider_id", [seed.teamId])).rows,
      obligations: (await getPool().query(
        "select provider, external_id, mapping_revision::text as mapping_revision, status from identity_repair_obligations where team_id=$1 order by 1, 2, 3", [seed.teamId])).rows,
    });
    const kept = await preserved();
    expect(kept.claims).toHaveLength(1);

    const actor = { kind: "member" as const, memberId: seed.memberId };
    expect(await deleteMember(db(), seed.teamId, connectorEmail, { hard: true, actor }))
      .toEqual({ deleted: true, mode: "hard", id: connectorId });

    // 1. Both bindings cleared as a pair; exactly ONE generation and fence step; no lease.
    for (const [bound, was] of [[first, before.first], [second, before.second]] as const) {
      const now = await authorityOf(bound.integrationId);
      expect(now).toMatchObject({
        connector_member_id: null, connector_api_key_id: null,
        generation: was.generation + 1, fence: was.fence + 1,
        lease_owner: null, lease_until: null,
      });
      // Progress is recovery state, not binding state.
      expect(now.progress).toEqual(was.progress);
      expect(now.progress_revision).toBe(was.progress_revision);
    }
    expect((await authorityOf(first.integrationId)).progress).toEqual({ page_token: "resume-here" });
    expect(checkpointed.progressRevision).toBe(before.first.progress_revision);
    // The member and its keys went by the ordinary foreign-key actions afterwards.
    expect(await memberExists(connectorId)).toBe(false);
    expect((await getPool().query("select 1 from api_keys where id = any($1::uuid[])", [[first.keyRowId, second.keyRowId]])).rows).toEqual([]);

    // 2. Nothing else changed.
    expect(await preserved()).toEqual(kept);

    // 4. Audited per connection, in integration-id order, by the acting Admin, with prior ROW ids.
    const unbound = await auditsOf(seed, "gdrive.connector_unbound");
    const ordered = [first, second].sort((a, b) => (a.integrationId < b.integrationId ? -1 : 1));
    expect(unbound).toEqual(ordered.map((bound) => ({
      actor_kind: "member", member_id: seed.memberId, target_id: bound.integrationId,
      meta: {
        reason: "member-deleted", connector_member_id: connectorId, connector_api_key_id: bound.keyRowId,
        generation: (bound === first ? before.first : before.second).generation + 1,
        fence: (bound === first ? before.first : before.second).fence + 1,
      },
    })));
    // The existing member-deletion audit is unchanged.
    expect(await auditsOf(seed, "member.deleted")).toEqual([
      { actor_kind: "member", member_id: seed.memberId, target_id: connectorId, meta: { email: connectorEmail } },
    ]);
    // No key material anywhere in the team's audit trail: not the key, its public id, its secret or its hash.
    const trail = JSON.stringify((await getPool().query("select action, meta from audit_log where team_id=$1", [seed.teamId])).rows);
    for (const bound of [first, second]) {
      // `aios_<keyId>_<secret>`: the key id is hex; the secret is base64url and may contain `_`.
      const keyId = bound.key.split("_")[1];
      const secret = bound.key.slice(`aios_${keyId}_`.length);
      expect(secret.length).toBeGreaterThan(20);
      for (const material of [bound.key, keyId, secret, createHash("sha256").update(secret).digest("hex")]) {
        expect(trail.includes(material), "key material reached the audit log").toBe(false);
      }
    }
    expect(trail).not.toContain("stored-refresh");

    // 1 (cont.). An execution acquired under the old binding is refused.
    for (const bound of [first, second]) {
      await expect(authorizeGdriveProviderCall(bound.auth, bound.execution))
        .rejects.toMatchObject({ code: "wrong_connection", status: 403 });
      await expect(withGdriveExecutionCommit(bound.auth, bound.execution, async () => "must not run"))
        .rejects.toMatchObject({ code: "wrong_connection", status: 403 });
    }

    // 2 (cont.). The connection is provisioned again — a fresh binding, not a rotation — and works
    // on the content and claim that were there all along.
    const rebound = await bind(seed, first.integrationId);
    expect(rebound.auth.memberId).not.toBe(connectorId);
    expect(await authorityOf(first.integrationId)).toMatchObject({
      connector_member_id: rebound.auth.memberId, connector_api_key_id: rebound.keyRowId,
      generation: before.first.generation + 2,
    });
    expect(await auditsOf(seed, "gdrive.connector_rebound")).toEqual([]);
    // The pre-deletion execution is stale even in the new principal's hands.
    await expect(authorizeGdriveProviderCall(rebound.auth, first.execution))
      .rejects.toMatchObject({ code: "stale_execution", status: 409 });
    await expect(pushDoc(rebound, "kept-doc", "content after re-provisioning"))
      .resolves.toMatchObject({ status: "updated", id: doc.id });
  }, 60_000);

  it("rollbackMemberCreation unbinds the same way, under its own actor and reason", async () => {
    const seed = await adminSeed();
    const bound = await connection(seed);
    const connectorId = bound.auth.memberId;
    const before = await authorityOf(bound.integrationId);

    await rollbackMemberCreation(db(), seed.teamId, connectorId, { actor: { kind: "member", memberId: seed.memberId } });

    expect(await memberExists(connectorId)).toBe(false);
    expect(await authorityOf(bound.integrationId)).toMatchObject({
      connector_member_id: null, connector_api_key_id: null,
      generation: before.generation + 1, fence: before.fence + 1, lease_owner: null, lease_until: null,
    });
    expect(await auditsOf(seed, "gdrive.connector_unbound")).toEqual([{
      actor_kind: "member", member_id: seed.memberId, target_id: bound.integrationId,
      meta: {
        reason: "member-creation-rolled-back", connector_member_id: connectorId,
        connector_api_key_id: bound.keyRowId, generation: before.generation + 1, fence: before.fence + 1,
      },
    }]);
    expect(await auditsOf(seed, "member.deleted")).toEqual([
      { actor_kind: "member", member_id: seed.memberId, target_id: connectorId, meta: { reason: "invite-rollback" } },
    ]);
    await expect(authorizeGdriveProviderCall(bound.auth, bound.execution))
      .rejects.toMatchObject({ code: "wrong_connection", status: 403 });
  }, 30_000);

  it.each([
    ["deleteMember({ hard: true })", (client: DbClient, seed: Seed, connector: { id: string; email: string }) =>
      deleteMember(client, seed.teamId, connector.email, { hard: true, actor: { kind: "member", memberId: seed.memberId } })],
    ["rollbackMemberCreation", (client: DbClient, seed: Seed, connector: { id: string; email: string }) =>
      rollbackMemberCreation(client, seed.teamId, connector.id, { actor: { kind: "member", memberId: seed.memberId } })],
  ] as const)("ATOMIC: when the member delete of %s fails after the unbinding, the pair, generation, fence, lease and audit all roll back", async (_name, remove) => {
    const seed = await adminSeed();
    const bound = await connection(seed);
    const connector = { id: bound.auth.memberId, email: await emailOf(bound.auth.memberId) };
    const before = await authorityOf(bound.integrationId);
    expect(before.lease_owner).toBe(bound.execution.owner);

    // What the deletion's own transaction looked like at the moment its delete was issued.
    const seen: InsideTheDeletion[] = [];
    const client = failingMemberDelete(async () => {
      const { rows } = await runSql<InsideTheDeletion>(
        `select a.connector_member_id, a.connector_api_key_id, a.generation::int as generation, a.fence::int as fence, a.lease_owner,
                (select count(*)::int from audit_log l where l.team_id=$2 and l.action='gdrive.connector_unbound') as audits
           from gdrive_connection_authority a where a.integration_id=$1`, [bound.integrationId, seed.teamId]);
      seen.push(rows[0]);
    });

    await expect(remove(client, seed, connector)).rejects.toThrow(/injected member delete failure/);

    // Non-vacuous: the unbinding HAD happened, in that transaction, before the delete failed.
    expect(seen).toEqual([{
      connector_member_id: null, connector_api_key_id: null,
      generation: before.generation + 1, fence: before.fence + 1, lease_owner: null, audits: 1,
    }]);
    // …and none of it survived: the authority row is byte-for-byte what it was.
    expect(await authorityOf(bound.integrationId)).toEqual(before);
    expect(await auditsOf(seed, "gdrive.connector_unbound")).toEqual([]);
    expect(await auditsOf(seed, "member.deleted")).toEqual([]);
    expect(await memberExists(connector.id)).toBe(true);
    // The binding still authorizes its live execution.
    await expect(authorizeGdriveProviderCall(bound.auth, bound.execution)).resolves.toMatchObject({ leaseExpiresAt: expect.anything() });
  }, 30_000);

  it("a RAW delete of a bound connector member still fails closed on the pair CHECK, changing nothing", async () => {
    const seed = await adminSeed();
    const bound = await connection(seed);
    const before = await authorityOf(bound.integrationId);
    const outcome = await getPool().query("delete from members where id=$1", [bound.auth.memberId])
      .then(() => null, (error: unknown) => error as { code?: string });
    expect(outcome, "an unsupported raw deletion of a bound connector succeeded").not.toBeNull();
    expect(outcome?.code).toBe("23514");
    expect(await authorityOf(bound.integrationId)).toEqual(before);
    expect(await memberExists(bound.auth.memberId)).toBe(true);
  }, 30_000);

  it("DELETION × PROVISIONING, deletion first: provisioning waits at the identity authority and then binds afresh", async () => {
    const seed = await adminSeed();
    const bound = await connection(seed);
    const connectorId = bound.auth.memberId;
    const before = await authorityOf(bound.integrationId);

    const deleting = gate();
    const deletion = settled(deleteMember(db(), seed.teamId, await emailOf(connectorId), {
      hard: true,
      concurrencyHooks: { afterIdentityLock: async () => { deleting.reached(); await deleting.open; } },
    }));
    let provisioning: Settled<Awaited<ReturnType<typeof provisionGdriveConnectorPrincipal>>> | undefined;
    try {
      await deleting.at;
      provisioning = settled(provisionGdriveConnectorPrincipal({
        teamId: seed.teamId, integrationId: bound.integrationId, actorMemberId: seed.memberId,
      }));
      await loserWaitsAtTheIdentityAuthority();
    } finally {
      deleting.release();
      await deletion;
      await provisioning;
    }
    expect((await deletion).value).toMatchObject({ deleted: true, mode: "hard" });
    const provisioned = await provisioning!;
    expect(provisioned.error).toBeNull();
    // It found the binding cleared: a first binding of a NEW connector member, not a rotation.
    expect(provisioned.value).toMatchObject({ rotated: false });
    expect(provisioned.value!.memberId).not.toBe(connectorId);
    expect(await authorityOf(bound.integrationId)).toMatchObject({
      connector_member_id: provisioned.value!.memberId, generation: before.generation + 2,
    });
  }, 30_000);

  it("DELETION × ROTATION, rotation first: the deletion waits at the identity authority, then unbinds the rotated pair", async () => {
    const seed = await adminSeed();
    const bound = await connection(seed);
    const connectorId = bound.auth.memberId;
    const connectorEmail = await emailOf(connectorId);
    const before = await authorityOf(bound.integrationId);

    // Rotation revokes the previous key last of all: holding that row parks it with the identity
    // authority, the connection rows and its acting Admin held.
    const holder = await getPool().connect();
    let rotation: Settled<Awaited<ReturnType<typeof provisionGdriveConnectorPrincipal>>> | undefined;
    let deletion: Settled<Awaited<ReturnType<typeof deleteMember>>> | undefined;
    try {
      await holder.query("begin");
      await holder.query("select 1 from api_keys where id=$1 for update", [bound.keyRowId]);
      rotation = settled(provisionGdriveConnectorPrincipal({
        teamId: seed.teamId, integrationId: bound.integrationId, actorMemberId: seed.memberId,
      }));
      let parked = -1;
      for (let tries = 0; tries < 320; tries++) {
        parked = (await getPool().query<{ n: number }>(
          `select count(*)::int as n from pg_stat_activity
            where datname = current_database() and wait_event_type = 'Lock'`)).rows[0].n;
        if (parked === 1) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(parked, "the rotation is not parked on its previous key").toBe(1);
      deletion = settled(deleteMember(db(), seed.teamId, connectorEmail, { hard: true }));
      await loserWaitsAtTheIdentityAuthority();
      await holder.query("rollback");
    } finally {
      await holder.query("rollback").catch(() => undefined);
      holder.release();
      await rotation;
      await deletion;
    }
    expect((await rotation!).value).toMatchObject({ rotated: true, memberId: connectorId });
    expect((await deletion!).value).toMatchObject({ deleted: true, mode: "hard" });
    // Rotation, then unbinding: two binding transitions, the second clearing the pair.
    expect(await authorityOf(bound.integrationId)).toMatchObject({
      connector_member_id: null, connector_api_key_id: null,
      generation: before.generation + 2, lease_owner: null,
    });
    const unbound = await auditsOf(seed, "gdrive.connector_unbound");
    expect(unbound).toHaveLength(1);
    // The pair it cleared was the ROTATED one.
    expect(unbound[0].meta).toMatchObject({ connector_member_id: connectorId, generation: before.generation + 2 });
    expect(unbound[0].meta.connector_api_key_id).not.toBe(bound.keyRowId);
    expect(await memberExists(connectorId)).toBe(false);
  }, 30_000);

  it("DELETION × EXECUTION, both orders: an in-flight commit finishes before the unbinding; a later call finds the connection unbound", async () => {
    const seed = await adminSeed();

    // EXECUTION first — the commit holds the identity authority, the connection and its principal.
    const running = await connection(seed);
    const runningEmail = await emailOf(running.auth.memberId);
    const committing = gate();
    const commit = settled(withGdriveExecutionCommit(running.auth, running.execution, async () => {
      committing.reached();
      await committing.open;
      return "committed";
    }));
    let deletion: Settled<Awaited<ReturnType<typeof deleteMember>>> | undefined;
    try {
      await committing.at;
      deletion = settled(deleteMember(db(), seed.teamId, runningEmail, { hard: true }));
      await loserWaitsAtTheIdentityAuthority();
    } finally {
      committing.release();
      await commit;
      await deletion;
    }
    expect(await commit).toEqual({ value: "committed", error: null });
    expect((await deletion!).value).toMatchObject({ deleted: true, mode: "hard" });
    expect(await authorityOf(running.integrationId)).toMatchObject({ connector_member_id: null, connector_api_key_id: null });

    // DELETION first — the execution call queues at the identity authority, then is refused.
    const other = await adminSeed();
    const waiting = await connection(other);
    const deleting = gate();
    const second = settled(deleteMember(db(), other.teamId, await emailOf(waiting.auth.memberId), {
      hard: true,
      concurrencyHooks: { afterIdentityLock: async () => { deleting.reached(); await deleting.open; } },
    }));
    let call: Settled<Awaited<ReturnType<typeof authorizeGdriveProviderCall>>> | undefined;
    try {
      await deleting.at;
      call = settled(authorizeGdriveProviderCall(waiting.auth, waiting.execution));
      await loserWaitsAtTheIdentityAuthority();
    } finally {
      deleting.release();
      await second;
      await call;
    }
    expect((await second).value).toMatchObject({ deleted: true, mode: "hard" });
    expect((await call!).error).toMatchObject({ code: "wrong_connection", status: 403 });
  }, 60_000);

  it("UNCHANGED: a soft disable keeps the binding, and deleting a member that is no connector touches no connection", async () => {
    const seed = await adminSeed();
    const bound = await connection(seed);
    const connectorId = bound.auth.memberId;
    const before = await authorityOf(bound.integrationId);

    // An ordinary member — hard-deleted, with a Drive connection present in the team.
    const { data: ordinary, error } = await db().from("members").insert({
      team_id: seed.teamId, email: `ordinary-${randomUUID().slice(0, 8)}@example.com`, display_name: "Ordinary",
      actor_handle: `ordinary-${randomUUID().slice(0, 8)}`, role: "member", tier: "team", status: "active",
    }).select("id, email").single();
    if (error || !ordinary) throw new Error(`ordinary member fixture failed: ${error?.message}`);
    const ordinaryMember = ordinary as { id: string; email: string };
    expect(await deleteMember(db(), seed.teamId, ordinaryMember.email, { hard: true }))
      .toEqual({ deleted: true, mode: "hard", id: ordinaryMember.id });
    expect(await memberExists(ordinaryMember.id)).toBe(false);
    expect(await authorityOf(bound.integrationId)).toEqual(before);
    expect(await auditsOf(seed, "gdrive.connector_unbound")).toEqual([]);
    await expect(authorizeGdriveProviderCall(bound.auth, bound.execution)).resolves.toMatchObject({ leaseExpiresAt: expect.anything() });
    const live = await authorityOf(bound.integrationId);

    // The connector itself, SOFT-disabled: the row survives, so does the binding — the connection
    // simply stops authorizing a disabled principal, as it always has.
    expect(await deleteMember(db(), seed.teamId, await emailOf(connectorId)))
      .toEqual({ deleted: true, mode: "soft", id: connectorId });
    expect(await memberExists(connectorId)).toBe(true);
    expect(await authorityOf(bound.integrationId)).toEqual(live);
    expect(await auditsOf(seed, "gdrive.connector_unbound")).toEqual([]);
    await expect(authorizeGdriveProviderCall(bound.auth, bound.execution))
      .rejects.toMatchObject({ code: "connector_principal_required", status: 403 });
  }, 30_000);
});
