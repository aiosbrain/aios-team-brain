import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import { publishGoogleDriveOAuthCredential } from "@/lib/integrations/gdrive-oauth";
import { provisionGdriveConnectorPrincipal } from "@/lib/integrations/gdrive-authority";
import { setIntegrationStatus, upsertIntegration } from "@/lib/integrations/manage";
import { approvedAudienceProject } from "../datamechanics/helpers";
import { BASE_URL, db, issueKeyFor, keyHeaders, seedTeam, type Seed } from "./http-helpers";

/**
 * AIO-1167 R44 T2 — the Drive credential's SUCCESS path over real HTTP: a real `next start` server,
 * real Postgres, and a controlled Google token endpoint on loopback (the HTTP setup's fake).
 *
 * Spec (accepted spec, real HTTP + persistence). A connection bootstrapped through the verified OAuth
 * publisher brokers a short-lived access token to its bound connector, refreshes it again on demand,
 * and after a selection save still uses the SAME stored credential. Nothing secret crosses the wire.
 * A wrong principal, team or integration gets nothing; a pause and a provider revocation stop issuance.
 */

async function bootstrap(seed: Seed, refreshToken = `refresh-${randomUUID().slice(0, 8)}`) {
  await db().from("members").update({ role: "admin" }).eq("id", seed.memberId).eq("team_id", seed.teamId);
  const audience = await approvedAudienceProject(seed);
  const name = `docs-${randomUUID().slice(0, 6)}`;
  await publishGoogleDriveOAuthCredential({
    teamId: seed.teamId, memberId: seed.memberId, integrationName: name,
    clientId: "oauth-client", clientSecret: "oauth-client-secret-never-leaves", subject: "acct-http",
    email: null, emailVerified: false, refreshToken, grantMode: "files",
    scopes: ["openid", "https://www.googleapis.com/auth/drive.file"],
  });
  const { data: row } = await db().from("integrations").select("id,config")
    .eq("team_id", seed.teamId).eq("type", "gdrive").eq("name", name).single();
  const integration = row as { id: string; config: Record<string, unknown> };
  // The Admin's selection: files and the approved audience (the credential fields stay the publisher's).
  await upsertIntegration(db(), { teamId: seed.teamId, memberId: seed.memberId }, {
    type: "gdrive", name, status: "enabled",
    config: { ...integration.config, fileIds: ["Doc"], selectionState: "selected", audienceProjectIds: [audience] },
  });
  const connector = await provisionGdriveConnectorPrincipal({
    teamId: seed.teamId, integrationId: integration.id, actorMemberId: seed.memberId,
  });
  return { name, integrationId: integration.id, connectorKey: connector.key, refreshToken };
}

async function acquire(key: string, seed: Seed, integrationId: string) {
  const owner = randomUUID();
  const response = await fetch(`${BASE_URL}/api/v1/integrations/gdrive/execution`, {
    method: "POST", headers: keyHeaders(key, seed.teamSlug),
    body: JSON.stringify({ action: "acquire", integration_id: integrationId, owner }),
  });
  const body = await response.json() as { generation: number; fence: number };
  return { status: response.status, ref: { integration_id: integrationId, generation: body.generation, fence: body.fence, owner } };
}

async function token(key: string, team: string, ref: Record<string, unknown>) {
  const response = await fetch(`${BASE_URL}/api/v1/integrations/gdrive/token`, {
    method: "POST", headers: keyHeaders(key, team), body: JSON.stringify(ref),
  });
  return { status: response.status, raw: await response.text(), cache: response.headers.get("cache-control") };
}

const SECRETS = ["oauth-client-secret-never-leaves", "refresh-"];

describe("Drive broker success over real HTTP (R44 T2)", () => {
  it("bootstraps, issues, refreshes, survives a selection save, and never discloses the credential", async () => {
    const seed = await seedTeam();
    const c = await bootstrap(seed);
    const acquired = await acquire(c.connectorKey, seed, c.integrationId);
    expect(acquired.status).toBe(200);

    const first = await token(c.connectorKey, seed.teamSlug, acquired.ref);
    expect(first.status).toBe(200);
    expect(first.cache).toContain("no-store");
    const grant = JSON.parse(first.raw);
    expect(grant).toMatchObject({
      access_token: `fake-access-for-${c.refreshToken}`,
      scopes: ["https://www.googleapis.com/auth/drive.file"],
      account: { subject: "subject:acct-http" },
    });
    expect(Date.parse(grant.expires_at)).toBeGreaterThan(Date.now());
    for (const secret of SECRETS) expect(first.raw.replace(grant.access_token, "")).not.toContain(secret);

    // Refresh: asked again, the broker refreshes again from the same stored credential.
    const second = await token(c.connectorKey, seed.teamSlug, acquired.ref);
    expect(second.status).toBe(200);
    expect(JSON.parse(second.raw).access_token).toBe(`fake-access-for-${c.refreshToken}`);

    // A selection save keeps the stored credential: a fresh execution still brokers with it.
    const { data: row } = await db().from("integrations").select("config").eq("id", c.integrationId).single();
    await upsertIntegration(db(), { teamId: seed.teamId, memberId: seed.memberId }, {
      type: "gdrive", name: c.name, status: "enabled",
      config: { ...(row as { config: Record<string, unknown> }).config, fileIds: ["Doc", "Other"] },
    });
    const reacquired = await acquire(c.connectorKey, seed, c.integrationId);
    expect(reacquired.status).toBe(200);
    expect(JSON.parse((await token(c.connectorKey, seed.teamSlug, reacquired.ref)).raw).access_token)
      .toBe(`fake-access-for-${c.refreshToken}`);
  });

  it("a wrong principal, team or integration gets no token", async () => {
    const seed = await seedTeam();
    const c = await bootstrap(seed);
    const acquired = await acquire(c.connectorKey, seed, c.integrationId);
    const ordinary = await issueKeyFor(seed, "team");
    expect((await token(ordinary.key, seed.teamSlug, acquired.ref)).status).toBe(403);
    const other = await seedTeam();
    expect((await token(c.connectorKey, other.teamSlug, acquired.ref)).status).toBe(401);
    const sibling = await bootstrap(seed);
    const wrong = await token(c.connectorKey, seed.teamSlug, { ...acquired.ref, integration_id: sibling.integrationId });
    expect(wrong.status).toBe(403);
    expect(wrong.raw).not.toContain("fake-access-for-");
  });

  it("a pause and a provider revocation stop issuance", async () => {
    const seed = await seedTeam();
    const c = await bootstrap(seed);
    const acquired = await acquire(c.connectorKey, seed, c.integrationId);
    await setIntegrationStatus(db(), { teamId: seed.teamId, memberId: seed.memberId }, c.integrationId, "disabled");
    const paused = await token(c.connectorKey, seed.teamSlug, acquired.ref);
    expect(paused.status).toBe(409);
    expect(paused.raw).not.toContain("fake-access-for-");

    const revokedSeed = await seedTeam();
    const revoked = await bootstrap(revokedSeed, "revoked-refresh");
    const execution = await acquire(revoked.connectorKey, revokedSeed, revoked.integrationId);
    const refused = await token(revoked.connectorKey, revokedSeed.teamSlug, execution.ref);
    expect(refused.status).toBe(409);
    expect(JSON.parse(refused.raw).error.code).toBe("reconnect_required");
  });
});
