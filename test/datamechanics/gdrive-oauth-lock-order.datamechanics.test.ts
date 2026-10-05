import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { deleteMember } from "@/lib/admin/members";
import { getPool } from "@/lib/db/pg/pool";
import { setMemberIdentity } from "@/lib/identity/member-identities";
import {
  acquireGdriveAdminTestAuthority,
  authorizeGdriveAdminTestCall,
  provisionGdriveConnectorPrincipal,
  publishGdriveVerifiedConfig,
} from "@/lib/integrations/gdrive-authority";
import {
  GoogleIdentityConflictError,
  InvalidGoogleOAuthInitiatorError,
  publishGoogleDriveOAuthCredential,
} from "@/lib/integrations/gdrive-oauth";
import { getIntegrationWithSecret, setIntegrationSecret, upsertIntegration } from "@/lib/integrations/manage";
import { db, seedTeam, type Seed } from "./helpers";

/**
 * The Google Drive CONNECTION acquisition order against real PostgreSQL (AIO-1167) — the
 * observable half of `test/gdrive-authority-lock-order.test.ts`.
 *
 * Spec. OAuth publication, Admin test/config, connector provisioning/rotation and a roster hard
 * deletion all take the team IDENTITY AUTHORITY before a connection row or a member row. So for any
 * two of them, in EITHER winner order:
 *
 *   1. the loser waits at the identity authority, holding no other advisory lock — it has not taken
 *      the named integration advisory, and therefore no connection row and no member row;
 *   2. both finish (no deadlock, nothing retried);
 *   3. the outcome is the serial one: a publication that lost to its initiating Admin's deletion is
 *      refused and leaves the prior connection — or NO connection, not even a reservation —
 *      behind; one that won is durable and survives the deletion that follows it.
 *
 * And an OAuth publication is atomic: a verified-identity conflict discovered at its very end rolls
 * back the reservation, the config, the credential, the first mapping and the audits with it.
 *
 * Lock state is read from `pg_locks` on a connection of its own.
 */

const STORED_SECRET = JSON.stringify({
  client_id: "oauth-client", client_secret: "stored-secret", refresh_token: "stored-refresh",
  token_uri: "https://oauth2.googleapis.com/token", account_subject: "subject:acct-1",
});

interface World {
  seed: Seed;
  /** The Admin who initiates OAuth and runs Admin tests — and who gets hard-deleted. */
  initiator: { id: string; email: string };
  /** A second Admin: keeps the team administrable, and is who a verified account resolves to. */
  other: { id: string; email: string };
}

async function world(): Promise<World> {
  const seed = await seedTeam();
  await db().from("members").update({ role: "admin" }).eq("id", seed.memberId).eq("team_id", seed.teamId);
  const { data: self } = await db().from("members").select("email").eq("id", seed.memberId).single();
  const otherEmail = `other-${randomUUID().slice(0, 8)}@example.com`;
  const { data: other, error } = await db().from("members").insert({
    team_id: seed.teamId, email: otherEmail, display_name: "Other Admin",
    actor_handle: `other-${randomUUID().slice(0, 8)}`, role: "admin", tier: "team", status: "active",
  }).select("id").single();
  if (error || !other) throw new Error(`second admin fixture failed: ${error?.message}`);
  return {
    seed,
    initiator: { id: seed.memberId, email: (self as { email: string }).email },
    other: { id: (other as { id: string }).id, email: otherEmail },
  };
}

/** An enabled OAuth connection with a stored credential, created by the initiator. */
async function existingConnection(w: World, name: string): Promise<string> {
  const auth = { teamId: w.seed.teamId, memberId: w.initiator.id };
  const row = await upsertIntegration(db(), auth, {
    type: "gdrive", name, status: "enabled",
    config: {
      fileIds: ["Kept"], folderIds: [], sharedDriveIds: [], recursive: false,
      selectionState: "selected", access: "team", authMode: "oauth",
      authenticatedAccount: "docs@example.com", authenticatedAccountId: "subject:acct-1",
    },
  });
  await setIntegrationSecret(db(), auth, row.id, STORED_SECRET);
  return row.id;
}

const publication = (w: World, name: string, over: { subject?: string; email?: string } = {}) => ({
  teamId: w.seed.teamId, memberId: w.initiator.id, integrationName: name,
  clientId: "oauth-client", clientSecret: "new-secret",
  subject: over.subject ?? `acct-${randomUUID().slice(0, 8)}`,
  // An exact roster address of the OTHER Admin: the publication writes both verified mappings.
  email: over.email ?? w.other.email, name: "Verified Account",
  refreshToken: "published-refresh", scopes: ["https://www.googleapis.com/auth/drive.file"],
});

function gate() {
  let release!: () => void;
  let reached!: () => void;
  const open = new Promise<void>((resolve) => { release = resolve; });
  const at = new Promise<void>((resolve) => { reached = resolve; });
  return { open, at, release, reached };
}

/** Backends waiting on an advisory lock, each with the number of advisory locks it already holds. */
async function advisoryWaiters(): Promise<{ pid: number; held: number }[]> {
  const { rows } = await getPool().query<{ pid: number; held: number }>(
    `select w.pid,
            (select count(*)::int from pg_locks g
              where g.pid = w.pid and g.locktype = 'advisory' and g.granted) as held
       from pg_locks w join pg_database d on d.oid = w.database
      where d.datname = current_database() and w.locktype = 'advisory' and not w.granted`);
  return rows;
}

/**
 * Wait until exactly one backend is queued on an advisory lock, and require that it holds none.
 * The identity authority is the first advisory lock on every path here, and the named integration
 * advisory comes after it and before any connection or member row — so "waiting, holding no
 * advisory" is "waiting at the identity authority, holding nothing of the connection".
 */
async function loserWaitsAtTheIdentityAuthority(): Promise<void> {
  let seen: { pid: number; held: number }[] = [];
  for (let tries = 0; tries < 320; tries++) {
    seen = await advisoryWaiters();
    if (seen.length === 1) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  expect(seen, "expected exactly one backend queued on an advisory lock").toHaveLength(1);
  expect(seen[0].held, "the loser already holds an advisory lock: it is past the identity authority").toBe(0);
}

/**
 * Wait until exactly one backend is queued on a ROW lock (and none on an advisory lock): a writer
 * the test has parked on its last lock, holding everything it took before that.
 */
async function parkedOnARowLock(): Promise<void> {
  let waiting = -1;
  for (let tries = 0; tries < 320; tries++) {
    const { rows } = await getPool().query<{ n: number }>(
      `select count(*)::int as n from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock'`);
    waiting = rows[0].n;
    if (waiting === 1) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  expect(waiting, "expected exactly one backend parked on a lock").toBe(1);
  expect(await advisoryWaiters(), "the parked writer is waiting on an advisory lock, not its last row").toEqual([]);
}

/** An actor's outcome as a value: it never rejects, so it can always be awaited in a `finally`. */
type Settled<T> = Promise<{ value: T | null; error: unknown }>;
const settled = <T>(promise: Promise<T>): Settled<T> =>
  promise.then((value) => ({ value, error: null }), (error: unknown) => ({ value: null, error }));
type Deletion = Awaited<ReturnType<typeof deleteMember>>;
type Provisioned = Awaited<ReturnType<typeof provisionGdriveConnectorPrincipal>>;

async function connectionRow(w: World, name: string) {
  const { rows } = await getPool().query<{ id: string; status: string; created_by: string | null; has_secret: boolean }>(
    `select id, status, created_by, secret_ciphertext is not null as has_secret
       from integrations where team_id=$1 and type='gdrive' and name=$2`, [w.seed.teamId, name]);
  return rows[0] ?? null;
}

async function gdriveMappings(w: World) {
  const { rows } = await getPool().query<{ external_id: string; member_id: string }>(
    `select external_id, member_id from member_identities
      where team_id=$1 and provider='gdrive' order by external_id`, [w.seed.teamId]);
  return rows;
}

describe("AIO-1167 Drive connection order: identity authority first (real Postgres)", () => {
  it.each([
    { connection: "an existing connection", exists: true },
    { connection: "an absent connection", exists: false },
  ])("OAUTH × hard deletion of its initiating Admin, DELETION first, on $connection: the publication waits at the identity authority and is then refused whole", async ({ exists }) => {
    const w = await world();
    const name = `del-first-${randomUUID().slice(0, 8)}`;
    if (exists) await existingConnection(w, name);
    const before = exists ? await getIntegrationWithSecret(db(), w.seed.teamId, "gdrive", name) : null;

    const deleting = gate();
    const deletion = settled(deleteMember(db(), w.seed.teamId, w.initiator.email, {
      hard: true,
      // The identity authority is held; the member row is not locked yet.
      concurrencyHooks: { afterIdentityLock: async () => { deleting.reached(); await deleting.open; } },
    }));
    let oauth: Settled<void> | undefined;
    try {
      await deleting.at;
      oauth = settled(publishGoogleDriveOAuthCredential(publication(w, name)));
      await loserWaitsAtTheIdentityAuthority();
      // …and it has reserved nothing and locked no connection row.
      const probe = await getPool().connect();
      try {
        await probe.query("begin");
        const { rows } = await probe.query(
          "select id from integrations where team_id=$1 and type='gdrive' and name=$2 for update nowait",
          [w.seed.teamId, name]);
        expect(rows).toHaveLength(exists ? 1 : 0);
      } finally {
        await probe.query("rollback").catch(() => undefined);
        probe.release();
      }
    } finally {
      deleting.release();
      await deletion;
      await oauth;
    }
    expect((await deletion).value).toMatchObject({ deleted: true, mode: "hard" });
    expect((await oauth!).error).toBeInstanceOf(InvalidGoogleOAuthInitiatorError);

    if (exists) {
      // The previous connection is exactly as it was — minus the deleted Admin as its creator.
      const after = await getIntegrationWithSecret(db(), w.seed.teamId, "gdrive", name);
      expect(after?.config).toEqual(before?.config);
      expect(after?.secret).toBe(before?.secret);
      expect(await connectionRow(w, name)).toMatchObject({ status: "enabled", created_by: null, has_secret: true });
    } else {
      // No connection, and no reservation left behind by the refused publication.
      expect(await connectionRow(w, name)).toBeNull();
    }
    expect(await gdriveMappings(w), "a refused publication linked an identity").toEqual([]);
  }, 30_000);

  it.each([
    { connection: "an existing connection", exists: true },
    { connection: "an absent connection", exists: false },
  ])("OAUTH × hard deletion of its initiating Admin, OAUTH first, on $connection: the deletion waits at the identity authority; the publication is durable and survives it", async ({ exists }) => {
    const w = await world();
    const name = `oauth-first-${randomUUID().slice(0, 8)}`;
    if (exists) await existingConnection(w, name);
    const input = publication(w, name);

    const publishing = gate();
    // Paused holding everything: identity authority, named advisory, connection rows (a
    // reservation, when absent) and the initiating member's row.
    const oauth = settled(publishGoogleDriveOAuthCredential(input, {
      afterLocks: async () => { publishing.reached(); await publishing.open; },
    }));
    let deletion: Settled<Deletion> | undefined;
    try {
      await publishing.at;
      // Nothing of the publication — not the reservation either — is visible before it commits.
      if (!exists) expect(await connectionRow(w, name)).toBeNull();
      deletion = settled(deleteMember(db(), w.seed.teamId, w.initiator.email, { hard: true }));
      // It queues at the identity authority — not at the member row the publication holds, where
      // its own foreign-key actions would later need the connection rows the publication also holds.
      await loserWaitsAtTheIdentityAuthority();
    } finally {
      publishing.release();
      await oauth;
      await deletion;
    }
    expect((await oauth).error).toBeNull();
    expect((await deletion!).value).toMatchObject({ deleted: true, mode: "hard" });

    const stored = await getIntegrationWithSecret(db(), w.seed.teamId, "gdrive", name);
    expect(stored?.status).toBe("enabled");
    expect(stored?.config).toMatchObject({
      authMode: "oauth", authenticatedAccount: w.other.email,
      authenticatedAccountId: `subject:${input.subject}`,
      ...(exists ? { fileIds: ["Kept"], selectionState: "selected" } : { selectionState: "absent" }),
    });
    expect(stored?.secret).toContain("published-refresh");
    // The deleted Admin is gone as the creator; the connection and its credential are not.
    expect(await connectionRow(w, name)).toMatchObject({ created_by: null, has_secret: true });
    // Both verified mappings were written in the publication's transaction (nested, re-entrant).
    expect(await gdriveMappings(w)).toEqual([
      { external_id: `author-email:${w.other.email}`, member_id: w.other.id },
      { external_id: `subject:${input.subject}`, member_id: w.other.id },
    ].sort((a, b) => a.external_id.localeCompare(b.external_id)));
    const { rows: remaining } = await getPool().query("select 1 from members where id=$1", [w.initiator.id]);
    expect(remaining).toEqual([]);
  }, 30_000);

  it("OAUTH × connector provisioning, OAUTH first: provisioning waits at the identity authority; both finish", async () => {
    const w = await world();
    const name = `prov-after-${randomUUID().slice(0, 8)}`;
    const integrationId = await existingConnection(w, name);

    const publishing = gate();
    const oauth = settled(publishGoogleDriveOAuthCredential(publication(w, name), {
      afterLocks: async () => { publishing.reached(); await publishing.open; },
    }));
    let provisioning: Settled<Provisioned> | undefined;
    try {
      await publishing.at;
      provisioning = settled(provisionGdriveConnectorPrincipal({
        teamId: w.seed.teamId, integrationId, actorMemberId: w.other.id,
      }));
      await loserWaitsAtTheIdentityAuthority();
    } finally {
      publishing.release();
      await oauth;
      await provisioning;
    }
    expect((await oauth).error).toBeNull();
    const provisioned = await provisioning!;
    expect(provisioned.error).toBeNull();
    expect(provisioned.value).toMatchObject({ rotated: false });
    const { rows: authority } = await getPool().query<{ connector_member_id: string | null }>(
      "select connector_member_id from gdrive_connection_authority where integration_id=$1", [integrationId]);
    expect(authority[0].connector_member_id).toBe(provisioned.value!.memberId);
    expect((await getIntegrationWithSecret(db(), w.seed.teamId, "gdrive", name))?.secret).toContain("published-refresh");
  }, 30_000);

  it("OAUTH × connector key ROTATION, ROTATION first: the publication waits at the identity authority; both finish", async () => {
    const w = await world();
    const name = `rot-first-${randomUUID().slice(0, 8)}`;
    const integrationId = await existingConnection(w, name);
    const first = await provisionGdriveConnectorPrincipal({
      teamId: w.seed.teamId, integrationId, actorMemberId: w.other.id,
    });
    const { rows: bound } = await getPool().query<{ id: string }>(
      "select id from api_keys where key_id=$1", [first.keyId]);

    // Rotation revokes the previous key last of all. Holding that row parks the rotation while it
    // holds the identity authority, the connection rows and its acting Admin.
    const holder = await getPool().connect();
    let rotation: Settled<Provisioned> | undefined;
    let oauth: Settled<void> | undefined;
    try {
      await holder.query("begin");
      await holder.query("select 1 from api_keys where id=$1 for update", [bound[0].id]);
      rotation = settled(provisionGdriveConnectorPrincipal({
        teamId: w.seed.teamId, integrationId, actorMemberId: w.other.id,
      }));
      await parkedOnARowLock();

      oauth = settled(publishGoogleDriveOAuthCredential(publication(w, name)));
      await loserWaitsAtTheIdentityAuthority();
      await holder.query("rollback");
    } finally {
      await holder.query("rollback").catch(() => undefined);
      holder.release();
      await rotation;
      await oauth;
    }
    const rotated = await rotation!;
    expect(rotated.error).toBeNull();
    expect(rotated.value).toMatchObject({ rotated: true });
    expect((await oauth!).error).toBeNull();
    const { rows: keys } = await getPool().query<{ revoked: boolean }>(
      "select revoked_at is not null as revoked from api_keys where id=$1", [bound[0].id]);
    expect(keys).toEqual([{ revoked: true }]);
    expect((await getIntegrationWithSecret(db(), w.seed.teamId, "gdrive", name))?.secret).toContain("published-refresh");
  }, 30_000);

  it("ADMIN TEST × hard deletion of that Admin, DELETION first: the Admin call waits at the identity authority with the connection unlocked, then is refused", async () => {
    const w = await world();
    const name = `admin-del-${randomUUID().slice(0, 8)}`;
    const integrationId = await existingConnection(w, name);
    const authority = await acquireGdriveAdminTestAuthority({
      teamId: w.seed.teamId, memberId: w.initiator.id, integrationName: name,
    });

    const deleting = gate();
    const deletion = settled(deleteMember(db(), w.seed.teamId, w.initiator.email, {
      hard: true,
      concurrencyHooks: { afterIdentityLock: async () => { deleting.reached(); await deleting.open; } },
    }));
    let call: Settled<void> | undefined;
    try {
      await deleting.at;
      call = settled(authorizeGdriveAdminTestCall(authority));
      await loserWaitsAtTheIdentityAuthority();
      // It used to take the connection rows first and then wait for the member the deletion was
      // about to lock — while the deletion's foreign-key actions needed those very rows.
      const probe = await getPool().connect();
      try {
        await probe.query("begin");
        const { rows } = await probe.query(
          `select i.id from integrations i join gdrive_connection_authority a on a.integration_id=i.id
            where i.id=$1 for update of i, a nowait`, [integrationId]);
        expect(rows, "the waiting Admin call holds the connection rows").toHaveLength(1);
      } finally {
        await probe.query("rollback").catch(() => undefined);
        probe.release();
      }
    } finally {
      deleting.release();
      await deletion;
      await call;
    }
    expect((await deletion).value).toMatchObject({ deleted: true, mode: "hard" });
    expect((await call!).error).toMatchObject({ code: "admin_authority_changed" });
  }, 30_000);

  it("ADMIN CONFIG × hard deletion of that Admin, ADMIN first: the deletion waits at the identity authority; the verified config is published and survives", async () => {
    const w = await world();
    const name = `admin-first-${randomUUID().slice(0, 8)}`;
    await existingConnection(w, name);
    const authority = await acquireGdriveAdminTestAuthority({
      teamId: w.seed.teamId, memberId: w.initiator.id, integrationName: name,
    });

    // A share lock on the Admin's row parks the publication on its LAST lock: it then holds the
    // identity authority and the connection rows.
    const holder = await getPool().connect();
    let publish: Settled<void> | undefined;
    let deletion: Settled<Deletion> | undefined;
    try {
      await holder.query("begin");
      await holder.query("select 1 from members where id=$1 for share", [w.initiator.id]);
      publish = settled(publishGdriveVerifiedConfig(authority, { ...authority.config, fileIds: ["Kept", "Verified"] }));
      await parkedOnARowLock();

      deletion = settled(deleteMember(db(), w.seed.teamId, w.initiator.email, { hard: true }));
      // Not at the member row: there it could win the row the moment the holder lets go, and then
      // need the connection rows the publication is holding while the publication needs the member.
      await loserWaitsAtTheIdentityAuthority();
      await holder.query("rollback");
    } finally {
      await holder.query("rollback").catch(() => undefined);
      holder.release();
      await publish;
      await deletion;
    }
    expect((await publish!).error).toBeNull();
    expect((await deletion!).value).toMatchObject({ deleted: true, mode: "hard" });
    const stored = await getIntegrationWithSecret(db(), w.seed.teamId, "gdrive", name);
    expect(stored?.config).toMatchObject({ fileIds: ["Kept", "Verified"] });
    expect(await connectionRow(w, name)).toMatchObject({ status: "enabled", created_by: null, has_secret: true });
  }, 30_000);

  it("ADMIN CONFIG × OAUTH on one connection, both orders: the loser waits at the identity authority, and the publication reads the config under its row lock", async () => {
    const w = await world();

    // OAUTH first — the Admin publication then finds its credential snapshot superseded.
    const first = `cfg-after-${randomUUID().slice(0, 8)}`;
    await existingConnection(w, first);
    const stale = await acquireGdriveAdminTestAuthority({
      teamId: w.seed.teamId, memberId: w.other.id, integrationName: first,
    });
    const publishing = gate();
    const oauth1 = settled(publishGoogleDriveOAuthCredential(publication(w, first), {
      afterLocks: async () => { publishing.reached(); await publishing.open; },
    }));
    let config1: Settled<void> | undefined;
    try {
      await publishing.at;
      config1 = settled(publishGdriveVerifiedConfig(stale, { ...stale.config, fileIds: ["Kept", "Stale"] }));
      await loserWaitsAtTheIdentityAuthority();
    } finally {
      publishing.release();
      await oauth1;
      await config1;
    }
    expect((await oauth1).error).toBeNull();
    expect((await config1!).error).toMatchObject({ code: "admin_authority_changed" });
    expect((await getIntegrationWithSecret(db(), w.seed.teamId, "gdrive", first))?.config)
      .toMatchObject({ fileIds: ["Kept"], authenticatedAccount: w.other.email });

    // ADMIN CONFIG first — the publication then builds on the selection that just committed,
    // because it reads the reusable config from the row only after locking it.
    const second = `cfg-first-${randomUUID().slice(0, 8)}`;
    await existingConnection(w, second);
    const current = await acquireGdriveAdminTestAuthority({
      teamId: w.seed.teamId, memberId: w.other.id, integrationName: second,
    });
    const holder = await getPool().connect();
    let config2: Settled<void> | undefined;
    let oauth2: Settled<void> | undefined;
    try {
      await holder.query("begin");
      await holder.query("select 1 from members where id=$1 for share", [w.other.id]);
      config2 = settled(publishGdriveVerifiedConfig(current, { ...current.config, fileIds: ["Kept", "Verified"] }));
      await parkedOnARowLock();
      oauth2 = settled(publishGoogleDriveOAuthCredential(publication(w, second)));
      await loserWaitsAtTheIdentityAuthority();
      await holder.query("rollback");
    } finally {
      await holder.query("rollback").catch(() => undefined);
      holder.release();
      await config2;
      await oauth2;
    }
    expect((await config2!).error).toBeNull();
    expect((await oauth2!).error).toBeNull();
    const stored = await getIntegrationWithSecret(db(), w.seed.teamId, "gdrive", second);
    expect(stored?.config).toMatchObject({
      fileIds: ["Kept", "Verified"], authMode: "oauth", authenticatedAccount: w.other.email,
    });
    expect(stored?.secret).toContain("published-refresh");
  }, 45_000);

  it("ATOMIC: a verified-identity conflict found at the end rolls back the reservation, config, credential, first mapping and audits", async () => {
    const w = await world();
    const name = `conflict-${randomUUID().slice(0, 8)}`;
    // The author-email key for the initiator's address is already mapped, deliberately, to the
    // other Admin. The publication links the subject key first (no conflict, written) and only
    // then reaches the conflicting one.
    const taken = await setMemberIdentity(db(), w.seed.teamId, w.other.id, {
      provider: "gdrive", externalId: `author-email:${w.initiator.email.toLowerCase()}`,
    }, { actor: { kind: "member", memberId: w.other.id } });
    expect(taken).toMatchObject({ created: true, conflict: false });
    const auditsBefore = (await getPool().query<{ n: number }>(
      "select count(*)::int as n from audit_log where team_id=$1", [w.seed.teamId])).rows[0].n;
    const mappingsBefore = await gdriveMappings(w);

    const subject = `conflict-${randomUUID().slice(0, 8)}`;
    const outcome = await settled(publishGoogleDriveOAuthCredential(
      publication(w, name, { subject, email: w.initiator.email })));
    expect(outcome.error).toBeInstanceOf(GoogleIdentityConflictError);

    // Absent before, absent after: no reservation, so no config and no credential either.
    expect(await connectionRow(w, name)).toBeNull();
    // The subject mapping it had already written went with it.
    expect(await gdriveMappings(w)).toEqual(mappingsBefore);
    const { rows: obligations } = await getPool().query(
      "select 1 from identity_repair_obligations where team_id=$1 and external_id=$2",
      [w.seed.teamId, `subject:${subject}`]);
    expect(obligations).toEqual([]);
    const auditsAfter = (await getPool().query<{ n: number }>(
      "select count(*)::int as n from audit_log where team_id=$1", [w.seed.teamId])).rows[0].n;
    expect(auditsAfter, "a rolled-back publication left audit rows").toBe(auditsBefore);
  }, 30_000);

  it("AUTH LOSS: a publication by an Admin demoted before it runs is refused and leaves no reservation", async () => {
    const w = await world();
    const name = `demoted-${randomUUID().slice(0, 8)}`;
    await db().from("members").update({ role: "member" }).eq("id", w.initiator.id).eq("team_id", w.seed.teamId);
    const outcome = await settled(publishGoogleDriveOAuthCredential(publication(w, name)));
    expect(outcome.error).toBeInstanceOf(InvalidGoogleOAuthInitiatorError);
    expect(await connectionRow(w, name)).toBeNull();
    expect(await gdriveMappings(w)).toEqual([]);
  }, 30_000);
});
