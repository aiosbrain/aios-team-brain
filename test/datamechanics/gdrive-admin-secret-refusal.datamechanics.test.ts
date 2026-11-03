import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getPool } from "@/lib/db/pg/pool";
import { saveGdriveConnectionConfig } from "@/lib/integrations/gdrive-authority";
import { setIntegrationSecret, upsertIntegration } from "@/lib/integrations/manage";
import { setMemberIdentity } from "@/lib/identity/member-identities";
import { approvedAudienceProject, db, seedTeam, type Seed } from "./helpers";

/**
 * AIO-1167 R43 F1 — a Drive credential enters only through the verified OAuth publication.
 *
 * Spec (AC-01 credential authority, AC-03/05 account namespace, AC-08 verified association). The
 * generic Admin actions must not write a Drive secret — not a malformed one, and not a complete,
 * VALID credential for some other Google account (which would read Drive under a stale account
 * label). So, for an existing OAuth connection:
 *   · `saveIntegration` with any non-empty secret is refused BEFORE any read, provider call or write,
 *     whatever the selection does (unchanged, narrowed, or adding a root that would need proof);
 *   · `rotateSecret` on a Drive row is refused the same way;
 *   · refusal leaves the row byte-for-byte: ciphertext, config, status, and the authority row's
 *     generation, fence, credential and progress revisions; Drive identity mappings unchanged;
 *   · a new connection with a secret leaves no row; service-account mode is refused too (its keys
 *     stay with the local sidecar); another team's id and a non-Admin rotate nothing;
 *   · the config owner itself cannot write a secret; an empty-secret selection save still works,
 *     and non-Drive rotation still works.
 */

const h = vi.hoisted(() => ({ admin: null as null | { teamId: string; memberId: string } }));
vi.mock("@/lib/auth/guard", () => ({ requireTeamAdmin: async () => h.admin }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const { saveIntegration, rotateSecret } = await import("@/app/t/[team]/admin/integrations/actions");

const STORED = JSON.stringify({
  client_id: "oauth-client", client_secret: "client-secret", refresh_token: "stored-refresh",
  token_uri: "https://oauth2.googleapis.com/token", scopes: ["https://www.googleapis.com/auth/drive.file"],
  grant_mode: "files", account_subject: "subject:acct-1",
});
/** A syntactically complete, usable-looking credential for a DIFFERENT Google account. */
const OTHER_ACCOUNT = JSON.stringify({
  client_id: "oauth-client", client_secret: "client-secret", refresh_token: "someone-elses-refresh",
  token_uri: "https://oauth2.googleapis.com/token", scopes: ["https://www.googleapis.com/auth/drive.readonly"],
  account_subject: "subject:someone-else",
});
const SECRETS = [["malformed text", "x"], ["a complete other-account credential", OTHER_ACCOUNT]] as const;

beforeEach(() => { h.admin = null; });
afterEach(() => vi.restoreAllMocks());

async function oauthConnection(seed: Seed, name: string) {
  await db().from("members").update({ role: "admin" }).eq("id", seed.memberId).eq("team_id", seed.teamId);
  const audience = await approvedAudienceProject(seed);
  const auth = { teamId: seed.teamId, memberId: seed.memberId };
  const row = await upsertIntegration(db(), auth, {
    type: "gdrive", name, status: "enabled",
    config: {
      fileIds: ["keep", "drop"], folderIds: [], sharedDriveIds: [], recursive: false, selectionState: "selected",
      access: "team", authMode: "oauth", authenticatedAccount: "docs@example.com",
      authenticatedAccountEmailVerified: true, authenticatedAccountId: "subject:acct-1",
      scopeSet: ["https://www.googleapis.com/auth/drive.file"], audienceProjectIds: [audience],
    },
  });
  await setIntegrationSecret(db(), auth, row.id, STORED);
  await setMemberIdentity(db(), seed.teamId, seed.memberId, { provider: "gdrive", externalId: "subject:acct-1" },
    { actor: { kind: "member", memberId: seed.memberId } });
  h.admin = { teamId: seed.teamId, memberId: seed.memberId };
  return { id: row.id, audience };
}

/** Everything a credential write could move, read raw. */
async function snapshot(teamId: string, integrationId: string) {
  const pool = getPool();
  const integration = (await pool.query(
    `select config, status, secret_ciphertext, updated_at from integrations where id=$1 and team_id=$2`,
    [integrationId, teamId])).rows[0];
  const authority = (await pool.query(
    `select generation, fence, credential_revision, progress_revision, scope_hash, lease_owner
       from gdrive_connection_authority where integration_id=$1`, [integrationId])).rows[0];
  const identities = (await pool.query(
    `select member_id, external_id from member_identities where team_id=$1 and provider='gdrive' order by external_id`,
    [teamId])).rows;
  return { integration, authority, identities };
}

const selection = (fileIds: string[], audience: string, authMode = "oauth") =>
  `fileIds=${fileIds.join("|")}, audienceProjectIds=${audience}, authMode=${authMode}`;

describe("saveIntegration refuses any Drive secret before reading, verifying or writing (R43 F1)", () => {
  for (const [label, secret] of SECRETS) {
    it.each([
      ["unchanged selection", ["keep", "drop"]],
      ["narrowed selection", ["keep"]],
      ["an added root (would need provider proof)", ["keep", "drop", "added"]],
    ])(`${label}, %s: refused, nothing changes, no provider call`, async (_case, fileIds) => {
      const seed = await seedTeam();
      const conn = await oauthConnection(seed, "secret-save");
      const before = await snapshot(seed.teamId, conn.id);
      const provider = vi.spyOn(globalThis, "fetch");

      const result = await saveIntegration(seed.teamSlug, {
        type: "gdrive", name: "secret-save", selection: selection(fileIds, conn.audience), secret,
      });

      expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/Reconnect with Google/) });
      expect(result.error).not.toMatch(/refresh|someone-else|subject:/);
      expect(provider).not.toHaveBeenCalled();
      expect(await snapshot(seed.teamId, conn.id)).toEqual(before);
    });
  }

  it("a NEW connection submitted with a secret leaves no row", async () => {
    const seed = await seedTeam();
    await db().from("members").update({ role: "admin" }).eq("id", seed.memberId).eq("team_id", seed.teamId);
    const audience = await approvedAudienceProject(seed);
    h.admin = { teamId: seed.teamId, memberId: seed.memberId };
    const result = await saveIntegration(seed.teamSlug, {
      type: "gdrive", name: "never-created", selection: selection([], audience), secret: OTHER_ACCOUNT,
    });
    expect(result.ok).toBe(false);
    const { rows } = await getPool().query(`select 1 from integrations where team_id=$1 and name='never-created'`, [seed.teamId]);
    expect(rows).toEqual([]);
  });

  it("service-account mode with a secret is refused too (keys stay with the local sidecar)", async () => {
    const seed = await seedTeam();
    const conn = await oauthConnection(seed, "sa-secret");
    const before = await snapshot(seed.teamId, conn.id);
    const result = await saveIntegration(seed.teamSlug, {
      type: "gdrive", name: "sa-secret", selection: selection(["keep"], conn.audience, "service_account"),
      secret: JSON.stringify({ type: "service_account", private_key: "-----BEGIN PRIVATE KEY-----" }),
    });
    expect(result.ok).toBe(false);
    expect(await snapshot(seed.teamId, conn.id)).toEqual(before);
  });

  it("an empty-secret selection save still works (and keeps the credential)", async () => {
    const seed = await seedTeam();
    const conn = await oauthConnection(seed, "plain-save");
    const before = await snapshot(seed.teamId, conn.id);
    expect(await saveIntegration(seed.teamSlug, {
      type: "gdrive", name: "plain-save", selection: selection(["keep"], conn.audience), secret: "",
    })).toEqual({ ok: true });
    const after = await snapshot(seed.teamId, conn.id);
    expect(after.integration.secret_ciphertext).toBe(before.integration.secret_ciphertext);
    expect(after.authority.credential_revision).toBe(before.authority.credential_revision);
    expect(after.integration.config).toMatchObject({ fileIds: ["keep"], authenticatedAccountId: "subject:acct-1" });
  });
});

describe("rotateSecret refuses Drive rows; other rows still rotate (R43 F1)", () => {
  it.each(SECRETS)("%s on a Drive row: refused, nothing changes", async (_label, secret) => {
    const seed = await seedTeam();
    const conn = await oauthConnection(seed, "rotate-drive");
    const before = await snapshot(seed.teamId, conn.id);
    const result = await rotateSecret(seed.teamSlug, conn.id, secret);
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/Reconnect with Google/) });
    expect(await snapshot(seed.teamId, conn.id)).toEqual(before);
  });

  it("another team's Drive id rotates nothing", async () => {
    const mine = await seedTeam();
    const theirs = await seedTeam();
    const foreign = await oauthConnection(theirs, "foreign-drive");
    const before = await snapshot(theirs.teamId, foreign.id);
    await db().from("members").update({ role: "admin" }).eq("id", mine.memberId).eq("team_id", mine.teamId);
    h.admin = { teamId: mine.teamId, memberId: mine.memberId };
    expect(await rotateSecret(mine.teamSlug, foreign.id, OTHER_ACCOUNT)).toMatchObject({ ok: false });
    expect(await snapshot(theirs.teamId, foreign.id)).toEqual(before);
  });

  it("a non-Admin rotates nothing and saves nothing", async () => {
    const seed = await seedTeam();
    const conn = await oauthConnection(seed, "not-admin");
    const before = await snapshot(seed.teamId, conn.id);
    h.admin = null;
    expect(await rotateSecret(seed.teamSlug, conn.id, OTHER_ACCOUNT)).toEqual({ ok: false, error: "admins only" });
    expect(await saveIntegration(seed.teamSlug, {
      type: "gdrive", name: "not-admin", selection: selection(["keep"], conn.audience), secret: OTHER_ACCOUNT,
    })).toEqual({ ok: false, error: "admins only" });
    expect(await snapshot(seed.teamId, conn.id)).toEqual(before);
  });

  it("a non-Drive (Slack) row still rotates", async () => {
    const seed = await seedTeam();
    await db().from("members").update({ role: "admin" }).eq("id", seed.memberId).eq("team_id", seed.teamId);
    const auth = { teamId: seed.teamId, memberId: seed.memberId };
    const slack = await upsertIntegration(db(), auth, { type: "slack", name: `eng-${randomUUID().slice(0, 6)}`, config: { channelIds: ["C1"] } });
    await setIntegrationSecret(db(), auth, slack.id, "xoxb-old");
    h.admin = { ...auth };
    const before = (await getPool().query(`select secret_ciphertext from integrations where id=$1`, [slack.id])).rows[0];
    expect(await rotateSecret(seed.teamSlug, slack.id, "xoxb-new")).toEqual({ ok: true });
    const after = (await getPool().query(`select secret_ciphertext from integrations where id=$1`, [slack.id])).rows[0];
    expect(after.secret_ciphertext).not.toBe(before.secret_ciphertext);
  });
});

describe("the Drive config owner cannot write a credential (R43 F1)", () => {
  it("a direct call carrying a secret writes config only", async () => {
    const seed = await seedTeam();
    const conn = await oauthConnection(seed, "owner-direct");
    const before = await snapshot(seed.teamId, conn.id);
    await saveGdriveConnectionConfig(db(), { teamId: seed.teamId, memberId: seed.memberId }, {
      name: "owner-direct",
      config: {
        fileIds: ["keep"], folderIds: [], sharedDriveIds: [], recursive: false, selectionState: "selected",
        access: "team", authMode: "oauth", audienceProjectIds: [conn.audience],
      },
      secret: OTHER_ACCOUNT,
    } as Parameters<typeof saveGdriveConnectionConfig>[2]);
    const after = await snapshot(seed.teamId, conn.id);
    expect(after.integration.secret_ciphertext).toBe(before.integration.secret_ciphertext);
    expect(after.authority.credential_revision).toBe(before.authority.credential_revision);
    expect(after.integration.config).toMatchObject({ fileIds: ["keep"], authenticatedAccountId: "subject:acct-1" });
  });
});
