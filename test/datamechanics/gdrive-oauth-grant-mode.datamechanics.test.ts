import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { POST as executionPOST } from "@/app/api/v1/integrations/gdrive/execution/route";
import { POST as tokenPOST } from "@/app/api/v1/integrations/gdrive/token/route";
import { GET as oauthCallbackGET } from "@/app/api/auth/gdrive/callback/route";
import { createGoogleDriveOAuthState, GDRIVE_OAUTH_BINDING_COOKIE } from "@/lib/auth/gdrive-oauth-state";
import { getPool } from "@/lib/db/pg/pool";
import { setMemberIdentity } from "@/lib/identity/member-identities";
import { provisionGdriveConnectorPrincipal } from "@/lib/integrations/gdrive-authority";
import {
  GoogleGrantOutsideModeError,
  IncompatibleStoredGoogleCredentialError,
  publishGoogleDriveOAuthCredential,
} from "@/lib/integrations/gdrive-oauth";
import { setIntegrationSecret, upsertIntegration } from "@/lib/integrations/manage";
import { decryptSecret } from "@/lib/secrets/crypto";
import { approvedAudienceProject, db, seedTeam, type Seed } from "./helpers";

/**
 * AIO-1167 R43 F3 (least privilege for the chosen mode) and F4 (bounded callback failures), against
 * real Postgres.
 *
 *   · The broker enforces the credential's recorded mode on EVERY refresh: a refresh reporting
 *     broader authority is refused, audited, and its token withheld; an in-mode refresh is issued.
 *   · The publisher reuses a stored refresh credential only when its recorded grant was made under
 *     the same mode and fits it; otherwise nothing changes — row, credential, authority revisions,
 *     identity mappings. A compatible reuse records the stored credential's own grant.
 *   · An exchanged grant outside the mode publishes nothing (not even a reservation).
 *   · End to end through the real callback: a broader grant in files mode, or Google unreachable,
 *     publishes nothing, leaves the prior connection and mappings unchanged, consumes the state, and
 *     a replay is refused with no further provider call.
 */

const G = "https://www.googleapis.com/auth/";
const FILE = `${G}drive.file`;
const READONLY = `${G}drive.readonly`;

const admin = vi.hoisted(() => ({ teamId: "", memberId: "" }));
vi.mock("@/lib/auth/guard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/guard")>()),
  requireTeamAdmin: async () => admin.teamId ? { ...admin } : null,
}));

afterEach(() => {
  vi.restoreAllMocks();
  admin.teamId = "";
  admin.memberId = "";
});

function credential(mode: "files" | "folders" | undefined, scopes: string[] | undefined) {
  return JSON.stringify({
    client_id: "oauth-client", client_secret: "client-secret", refresh_token: "stored-refresh",
    token_uri: "https://oauth2.googleapis.com/token", account_subject: "subject:acct-1",
    ...(scopes ? { scopes } : {}), ...(mode ? { grant_mode: mode } : {}),
  });
}

async function connection(seed: Seed, name: string, secret: string) {
  await db().from("members").update({ role: "admin" }).eq("id", seed.memberId).eq("team_id", seed.teamId);
  const audience = await approvedAudienceProject(seed);
  const auth = { teamId: seed.teamId, memberId: seed.memberId };
  const row = await upsertIntegration(db(), auth, {
    type: "gdrive", name, status: "enabled",
    config: {
      fileIds: ["Kept"], folderIds: [], sharedDriveIds: [], recursive: false, selectionState: "selected",
      access: "team", authMode: "oauth", authenticatedAccountId: "subject:acct-1", scopeSet: [FILE],
      audienceProjectIds: [audience],
    },
  });
  await setIntegrationSecret(db(), auth, row.id, secret);
  await setMemberIdentity(db(), seed.teamId, seed.memberId, { provider: "gdrive", externalId: "subject:acct-1" },
    { actor: { kind: "member", memberId: seed.memberId } });
  admin.teamId = seed.teamId;
  admin.memberId = seed.memberId;
  return row.id;
}

async function snapshot(teamId: string, name: string) {
  const pool = getPool();
  const integration = (await pool.query(
    `select id, config, status, secret_ciphertext, updated_at from integrations where team_id=$1 and type='gdrive' and name=$2`,
    [teamId, name])).rows[0] ?? null;
  const authority = integration ? (await pool.query(
    `select generation, fence, credential_revision, progress_revision, scope_hash from gdrive_connection_authority where integration_id=$1`,
    [integration.id])).rows[0] : null;
  const identities = (await pool.query(
    `select member_id, external_id from member_identities where team_id=$1 and provider='gdrive' order by external_id`,
    [teamId])).rows;
  return { integration, authority, identities };
}

const publication = (seed: Seed, name: string, over: Partial<Parameters<typeof publishGoogleDriveOAuthCredential>[0]> = {}) => ({
  teamId: seed.teamId, memberId: seed.memberId, integrationName: name,
  clientId: "oauth-client", clientSecret: "client-secret", subject: "acct-1",
  email: null, emailVerified: false, grantMode: "files" as const, scopes: [FILE], ...over,
});

function post(url: string, key: string, team: string, body: unknown) {
  return new Request(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "X-AIOS-Team": team, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }) as NextRequest;
}

async function brokered(seed: Seed, integrationId: string, refreshScope: string) {
  const issued = await provisionGdriveConnectorPrincipal({ teamId: seed.teamId, integrationId, actorMemberId: seed.memberId });
  const owner = randomUUID();
  const acquired = await executionPOST(post("http://test/api/v1/integrations/gdrive/execution", issued.key, seed.teamSlug, {
    action: "acquire", integration_id: integrationId, owner,
  }));
  expect(acquired.status).toBe(200);
  const lease = await acquired.json() as { generation: number; fence: number };
  vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify({
    access_token: "refreshed-access-token", expires_in: 600, scope: refreshScope,
  }), { status: 200, headers: { "content-type": "application/json" } }));
  const response = await tokenPOST(post("http://test/api/v1/integrations/gdrive/token", issued.key, seed.teamSlug, {
    integration_id: integrationId, generation: lease.generation, fence: lease.fence, owner,
  }));
  return { response, raw: await response.text() };
}

async function audits(teamId: string, integrationId: string, action: string) {
  return (await getPool().query<{ meta: Record<string, unknown> }>(
    `select meta from audit_log where team_id=$1 and target_id=$2 and action=$3`, [teamId, integrationId, action])).rows;
}

describe("the broker enforces the recorded mode on every refresh (R43 F3)", () => {
  it("a files-mode credential whose refresh reports drive.readonly is refused, audited, and withheld", async () => {
    const seed = await seedTeam();
    const id = await connection(seed, "ceiling", credential("files", [FILE]));
    const { response, raw } = await brokered(seed, id, `openid ${FILE} ${READONLY}`);
    expect(response.status).toBe(409);
    expect(JSON.parse(raw).error.code).toBe("reconnect_required");
    expect(raw).not.toContain("refreshed-access-token");
    expect(await audits(seed.teamId, id, "gdrive.token_issued")).toEqual([]);
    expect((await audits(seed.teamId, id, "gdrive.token_denied")).map((a) => a.meta.grantOutsideMode)).toEqual(["broader"]);
  });

  it("an in-mode refresh is issued, with the granted scopes", async () => {
    const seed = await seedTeam();
    const id = await connection(seed, "in-mode", credential("files", [FILE]));
    const { response, raw } = await brokered(seed, id, `openid ${FILE}`);
    expect(response.status).toBe(200);
    expect(JSON.parse(raw)).toMatchObject({ access_token: "refreshed-access-token", scopes: ["openid", FILE] });
  });

  it("a folders-mode credential may refresh drive.readonly", async () => {
    const seed = await seedTeam();
    const id = await connection(seed, "folders-mode", credential("folders", [READONLY]));
    expect((await brokered(seed, id, `openid ${READONLY}`)).response.status).toBe(200);
  });
});

describe("the publisher reuses a stored credential only within its recorded grant (R43 F3)", () => {
  it.each([
    ["broader stored grant (folders) under files consent", credential("folders", [READONLY])],
    ["stored grant with no recorded mode", credential(undefined, [FILE])],
    ["stored grant with no recorded scopes", credential("files", undefined)],
  ])("%s: refused, and nothing changes", async (_case, stored) => {
    const seed = await seedTeam();
    await connection(seed, "reuse-refused", stored);
    const before = await snapshot(seed.teamId, "reuse-refused");
    await expect(publishGoogleDriveOAuthCredential(publication(seed, "reuse-refused")))
      .rejects.toBeInstanceOf(IncompatibleStoredGoogleCredentialError);
    expect(await snapshot(seed.teamId, "reuse-refused")).toEqual(before);
  });

  it("a compatible stored grant is reused, recording the stored credential's own scopes", async () => {
    const seed = await seedTeam();
    await connection(seed, "reuse-ok", credential("files", [FILE]));
    await expect(publishGoogleDriveOAuthCredential(publication(seed, "reuse-ok", { scopes: ["openid", FILE] })))
      .resolves.toEqual({ status: "enabled" });
    const after = await snapshot(seed.teamId, "reuse-ok");
    const secret = JSON.parse(decryptSecret(after.integration.secret_ciphertext)) as Record<string, unknown>;
    expect(secret).toMatchObject({ refresh_token: "stored-refresh", grant_mode: "files", scopes: [FILE] });
    expect(after.integration.config.scopeSet).toEqual([FILE]);
  });

  it("an exchanged grant outside the mode publishes nothing — not even a reservation", async () => {
    const seed = await seedTeam();
    await db().from("members").update({ role: "admin" }).eq("id", seed.memberId).eq("team_id", seed.teamId);
    await expect(publishGoogleDriveOAuthCredential(publication(seed, "never-reserved", {
      refreshToken: "fresh-refresh", scopes: [FILE, READONLY],
    }))).rejects.toBeInstanceOf(GoogleGrantOutsideModeError);
    expect((await snapshot(seed.teamId, "never-reserved")).integration).toBeNull();
  });
});

describe("the real callback: refusals publish nothing and stay final (R43 F3 + F4)", () => {
  const BROWSER = "aio-1167-grant-mode-browser";
  const ENV = ["AUTH_SECRET", "GOOGLE_DRIVE_CLIENT_ID", "GOOGLE_DRIVE_CLIENT_SECRET", "GOOGLE_DRIVE_OAUTH_REDIRECT"] as const;

  async function begin(seed: Seed, name: string) {
    process.env.AUTH_SECRET = "aio-1167-data-mechanics-auth-secret";
    process.env.GOOGLE_DRIVE_CLIENT_ID = "oauth-client";
    process.env.GOOGLE_DRIVE_CLIENT_SECRET = "oauth-secret";
    process.env.GOOGLE_DRIVE_OAUTH_REDIRECT = "http://test/api/auth/gdrive/callback";
    const state = await createGoogleDriveOAuthState(db(), {
      teamId: seed.teamId, memberId: seed.memberId, integrationName: name, teamSlug: seed.teamSlug,
      mode: "files", browserBinding: BROWSER,
    });
    const call = () => oauthCallbackGET(new NextRequest(
      `http://test/api/auth/gdrive/callback?state=${encodeURIComponent(state)}&code=one-time-code`,
      { headers: { cookie: `${GDRIVE_OAUTH_BINDING_COOKIE}=${BROWSER}` } },
    ));
    return { state, call };
  }

  const previous = Object.fromEntries(ENV.map((name) => [name, process.env[name]]));
  afterEach(() => {
    for (const name of ENV) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  });

  async function consumed(teamId: string) {
    return (await getPool().query<{ used: boolean }>(
      `select used_at is not null as used from oauth_states where team_id=$1 and provider='gdrive'`, [teamId])).rows;
  }

  it.each([
    ["a broader grant in files mode", async () => new Response(JSON.stringify({
      access_token: "broad-access", refresh_token: "broad-refresh", scope: `openid ${FILE} ${READONLY}`,
    }), { status: 200, headers: { "content-type": "application/json" } }), 422],
    ["Google unreachable", async () => { throw new TypeError("fetch failed"); }, 503],
    ["a non-JSON token reply", async () => new Response("<html>oops</html>", { status: 200 }), 422],
  ] as const)("%s: prior connection and mappings unchanged, state consumed, replay refused", async (_case, reply, status) => {
    const seed = await seedTeam();
    await connection(seed, "callback-refusal", credential("files", [FILE]));
    const before = await snapshot(seed.teamId, "callback-refusal");
    const { call } = await begin(seed, "callback-refusal");
    const provider = vi.spyOn(globalThis, "fetch").mockImplementationOnce(reply);

    const response = await call();
    expect(response.status).toBe(status);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.text();
    expect(body).not.toMatch(/broad-access|broad-refresh|one-time-code|fetch failed|oops/);
    expect(await snapshot(seed.teamId, "callback-refusal")).toEqual(before);
    expect(await consumed(seed.teamId)).toEqual([{ used: true }]);

    expect((await call()).status).toBe(400);
    expect(provider).toHaveBeenCalledTimes(1);
    expect(await snapshot(seed.teamId, "callback-refusal")).toEqual(before);
  });
});
