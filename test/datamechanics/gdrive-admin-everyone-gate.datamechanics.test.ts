import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * AIO-1167 R86 F4 — every Drive Admin publication re-checks the ESTABLISHED Admin gate, under lock
 * (real Postgres).
 *
 * Spec (Astra R86 adjudication F4). `requireTeamAdmin` admits role `admin` + status `active` + actual
 * builtin Everyone membership. The Drive Admin publications — OAuth credential publication, the Admin
 * refresh/preview, a verified selection, an ordinary config save (new or existing connection) — re-check
 * that same predicate at their final boundary (`lockActiveTeamAdmin`), locking the member row then its
 * Everyone membership row. An Admin removed from Everyone after the initial authorization (during the
 * OAuth exchange, the provider refresh, a preview) publishes nothing: credentials, config, generation and
 * audit are unchanged, and a provisional connection is rolled back. Role/status loss and a membership read
 * failure refuse too. Against a concurrent sanctioned removal (which locks the member row first) both
 * interleavings are serialized: removal first → the publication waits, then refuses; publication first →
 * the removal waits, then lands after it.
 */

const pg = vi.hoisted(() => ({ failEveryoneRead: false }));
vi.mock("@/lib/db/pg/pool", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db/pg/pool")>();
  const runSql = (async (...args: Parameters<typeof actual.runSql>) => {
    if (pg.failEveryoneRead && /for share of gm/.test(String(args[0]))) throw new Error("membership read failed");
    return actual.runSql(...args);
  }) as typeof actual.runSql;
  return { ...actual, runSql };
});
const epochHook = vi.hoisted(() => ({ hold: null as null | { entered: () => void; release: Promise<void> } }));
vi.mock("@/lib/access/authorization-epoch", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/access/authorization-epoch")>();
  return {
    ...real,
    advanceAuthorizationEpoch: async (teamId: string) => {
      const epoch = await real.advanceAuthorizationEpoch(teamId);
      const hold = epochHook.hold;
      if (hold) {
        epochHook.hold = null;
        hold.entered();
        await hold.release;
      }
      return epoch;
    },
  };
});

import { removeMemberFromGroup } from "@/lib/access/groups";
import { getPool } from "@/lib/db/pg/pool";
import {
  acquireGdriveAdminTestAuthority, publishGdriveVerifiedSelection, refreshGdriveAdminAccess, saveGdriveConnectionConfig,
} from "@/lib/integrations/gdrive-authority";
import { InvalidGoogleOAuthInitiatorError, publishGoogleDriveOAuthCredential } from "@/lib/integrations/gdrive-oauth";
import { setIntegrationSecret, upsertIntegration } from "@/lib/integrations/manage";
import { adminClient } from "@/lib/db/admin";
import { approvedAudienceProject, db, placeMemberByTier, seedTeam } from "./helpers";

afterEach(() => {
  pg.failEveryoneRead = false;
  epochHook.hold = null;
  vi.restoreAllMocks();
});

const DRIVE_FILE = "https://www.googleapis.com/auth/drive.file";
const STORED_SECRET = JSON.stringify({
  client_id: "oauth-client", client_secret: "stored-secret", refresh_token: "stored-refresh",
  token_uri: "https://oauth2.googleapis.com/token", account_subject: "subject:acct-1",
  scopes: ["openid", DRIVE_FILE], grant_mode: "files",
});

async function world() {
  const seed = await seedTeam();
  await db().from("members").update({ role: "admin" }).eq("id", seed.memberId).eq("team_id", seed.teamId);
  const { data: other } = await db().from("members").insert({
    team_id: seed.teamId, email: `other-${randomUUID().slice(0, 8)}@example.com`, display_name: "Other Admin",
    actor_handle: `other-${randomUUID().slice(0, 8)}`, role: "admin", tier: "team", status: "active",
  }).select("id").single();
  const otherId = (other as { id: string }).id;
  await placeMemberByTier(seed.teamId, otherId, "team");
  const { rows } = await getPool().query<{ id: string }>(
    `select id from groups where team_id=$1 and slug='everyone' and is_builtin`, [seed.teamId]);
  const auth = { teamId: seed.teamId, memberId: seed.memberId };
  const name = `admin-${randomUUID().slice(0, 8)}`;
  const audience = await approvedAudienceProject(seed);
  const row = await upsertIntegration(db(), auth, {
    type: "gdrive", name, status: "enabled",
    config: {
      fileIds: ["Kept"], folderIds: [], sharedDriveIds: [], recursive: false, selectionState: "selected",
      access: "team", authMode: "oauth", authenticatedAccount: "docs@example.com",
      authenticatedAccountId: "subject:acct-1", scopeSet: [DRIVE_FILE], audienceProjectIds: [audience],
    },
  });
  await setIntegrationSecret(db(), auth, row.id, STORED_SECRET);
  const removeFromEveryone = () => removeMemberFromGroup(db(), seed.teamId, rows[0].id, seed.memberId, otherId);
  return { seed, auth, name, integrationId: row.id, audience, removeFromEveryone };
}
type W = Awaited<ReturnType<typeof world>>;

/** Everything a Drive Admin publication could change. */
async function published(w: W) {
  const { rows } = await getPool().query(
    `select i.config, i.secret_ciphertext, i.status, a.generation, a.credential_revision
       from integrations i join gdrive_connection_authority a on a.integration_id=i.id where i.id=$1`, [w.integrationId]);
  const audits = (await getPool().query(
    `select action from audit_log where team_id=$1 and target_type='integration' order by created_at`, [w.seed.teamId])).rows;
  const connections = (await getPool().query(
    `select name from integrations where team_id=$1 and type='gdrive' order by name`, [w.seed.teamId])).rows;
  return { row: rows[0], audits, connections };
}

const oauth = (w: W, name = w.name) => ({
  teamId: w.seed.teamId, memberId: w.seed.memberId, integrationName: name, clientId: "oauth-client",
  clientSecret: "new-secret", subject: `acct-${randomUUID().slice(0, 8)}`, email: null, emailVerified: false,
  refreshToken: "published-refresh", scopes: [DRIVE_FILE], grantMode: "files" as const,
});

async function waitsOnLock(pattern: string): Promise<boolean> {
  for (let tries = 0; tries < 400; tries++) {
    const { rows } = await getPool().query<{ n: number }>(
      `select count(*)::int as n from pg_stat_activity
        where datname=current_database() and wait_event_type='Lock' and query ilike $1`, [pattern]);
    if (rows[0].n > 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

describe("an Admin removed from Everyone after authorization publishes nothing", () => {
  it("OAuth publication, to an existing connection and to a new (provisional) one", async () => {
    const w = await world();
    const before = await published(w);
    expect((await w.removeFromEveryone()).ok).toBe(true); // during the OAuth exchange
    await expect(publishGoogleDriveOAuthCredential(oauth(w))).rejects.toBeInstanceOf(InvalidGoogleOAuthInitiatorError);
    await expect(publishGoogleDriveOAuthCredential(oauth(w, `fresh-${randomUUID().slice(0, 8)}`)))
      .rejects.toBeInstanceOf(InvalidGoogleOAuthInitiatorError);
    expect(await published(w)).toEqual(before);
  });

  it("the Admin refresh/preview refuses after its provider call", async () => {
    const w = await world();
    const authority = await acquireGdriveAdminTestAuthority({ teamId: w.seed.teamId, memberId: w.seed.memberId, integrationName: w.name });
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      expect((await w.removeFromEveryone()).ok).toBe(true); // while the refresh is in flight
      return Response.json({ access_token: "short-lived", scope: DRIVE_FILE });
    });
    const before = await published(w);
    await expect(refreshGdriveAdminAccess(authority)).rejects.toMatchObject({ code: "admin_authority_changed" });
    expect(await published(w)).toEqual(before);
  });

  it("a verified selection and an ordinary save (existing and new connection)", async () => {
    const w = await world();
    const authority = await acquireGdriveAdminTestAuthority({ teamId: w.seed.teamId, memberId: w.seed.memberId, integrationName: w.name });
    expect((await w.removeFromEveryone()).ok).toBe(true); // after the preview, before publication
    const before = await published(w);

    await expect(publishGdriveVerifiedSelection(authority, ["Kept", "Added"])).rejects.toMatchObject({ code: "admin_authority_changed" });
    const config = { ...before.row.config, fileIds: [], audienceProjectIds: [w.audience] };
    await expect(saveGdriveConnectionConfig(adminClient(), w.auth, { name: w.name, config }))
      .rejects.toMatchObject({ code: "admin_authority_changed" });
    await expect(saveGdriveConnectionConfig(adminClient(), w.auth, {
      name: `fresh-${randomUUID().slice(0, 8)}`,
      config: { fileIds: [], folderIds: [], sharedDriveIds: [], recursive: false, selectionState: "absent",
        authMode: "service_account", audienceProjectIds: [w.audience] },
    })).rejects.toMatchObject({ code: "admin_authority_changed" });
    expect(await published(w)).toEqual(before);
  });

  it.each(["role lost", "deactivated", "membership read fails"] as const)("%s: an ordinary save refuses and writes nothing", async (loss) => {
    const w = await world();
    const before = await published(w);
    if (loss === "role lost") await getPool().query(`update members set role='member' where id=$1`, [w.seed.memberId]);
    if (loss === "deactivated") await getPool().query(`update members set status='disabled' where id=$1`, [w.seed.memberId]);
    if (loss === "membership read fails") pg.failEveryoneRead = true;
    await expect(saveGdriveConnectionConfig(adminClient(), w.auth, {
      name: w.name, config: { ...before.row.config, fileIds: [], audienceProjectIds: [w.audience] },
    })).rejects.toThrow();
    pg.failEveryoneRead = false;
    expect(await published(w)).toEqual(before);
  });
});

describe("a publication and a concurrent Everyone removal serialize, both interleavings", () => {
  it("the held Everyone membership row itself is locked: a deletion that bypasses the member row still waits", async () => {
    const w = await world();
    let reached!: () => void;
    const atLocks = new Promise<void>((resolve) => { reached = resolve; });
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const publication = publishGoogleDriveOAuthCredential(oauth(w), { afterLocks: async () => { reached(); await held; } });
    await atLocks;
    const direct = getPool().query(
      `delete from group_members gm using groups g
        where g.id=gm.group_id and gm.member_id=$1 and g.slug='everyone' and g.is_builtin /* r86-direct */`,
      [w.seed.memberId]);
    expect(await waitsOnLock("%r86-direct%"), "the membership row was not locked by the publication").toBe(true);
    release();
    await expect(publication).resolves.toBeTruthy();
    await direct;
  });

  it("removal first: the publication waits on the member row, then refuses", async () => {
    const w = await world();
    const before = await published(w);
    let entered!: () => void;
    const removing = new Promise<void>((resolve) => { entered = resolve; });
    let open!: () => void;
    epochHook.hold = { entered: () => entered(), release: new Promise<void>((resolve) => { open = resolve; }) };

    const removal = w.removeFromEveryone();
    await removing; // membership deleted, member row held, transaction still open
    const save = saveGdriveConnectionConfig(adminClient(), w.auth, {
      name: w.name, config: { ...before.row.config, fileIds: [], audienceProjectIds: [w.audience] },
    }).then(() => "saved", (e: unknown) => (e as { code?: string }).code);
    expect(await waitsOnLock("%from members where id=$1 and team_id=$2 for update%"), "the publication waited on the removal").toBe(true);
    open();
    expect((await removal).ok).toBe(true);
    expect(await save).toBe("admin_authority_changed");
    expect(await published(w)).toEqual(before);
  });

  it("publication first: the removal waits until the credential is published, then lands", async () => {
    const w = await world();
    const before = await published(w);
    let reached!: () => void;
    const atLocks = new Promise<void>((resolve) => { reached = resolve; });
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });

    const publication = publishGoogleDriveOAuthCredential(oauth(w), { afterLocks: async () => { reached(); await held; } });
    await atLocks; // the Admin + Everyone membership are checked and locked
    const removal = w.removeFromEveryone();
    expect(await waitsOnLock("%for no key update%"), "the removal waited on the publication").toBe(true);
    release();
    await expect(publication).resolves.toBeTruthy();
    expect((await removal).ok).toBe(true);
    const after = await published(w);
    expect(Number(after.row.credential_revision), "the new credential was published").toBeGreaterThan(Number(before.row.credential_revision));
    const { rows } = await getPool().query(
      `select 1 from group_members gm join groups g on g.id=gm.group_id
        where gm.member_id=$1 and g.slug='everyone' and g.is_builtin`, [w.seed.memberId]);
    expect(rows).toEqual([]);
  });
});
