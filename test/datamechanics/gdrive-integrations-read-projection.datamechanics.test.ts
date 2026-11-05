import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";

import { GET as integrationsGET } from "@/app/api/v1/integrations/route";
import { POST as executionPOST } from "@/app/api/v1/integrations/gdrive/execution/route";
import { issueApiKey, revokeApiKey } from "@/lib/admin/keys";
import { getPool } from "@/lib/db/pg/pool";
import { provisionGdriveConnectorPrincipal } from "@/lib/integrations/gdrive-authority";
import { setIntegrationSecret, setIntegrationStatus, upsertIntegration } from "@/lib/integrations/manage";
import { approvedAudienceProject, db, placeMemberByTier, seedTeam, type Seed } from "./helpers";

/**
 * AIO-1167 R42 F5 — Drive account and selection metadata on `GET /api/v1/integrations` belongs to the
 * connection's bound, live connector principal only (user policy decision, 2026-10-27).
 *
 * Spec.
 *   · The key a Drive connection is BOUND to (its live `gdrive-sync` connector principal) reads that
 *     connection's full stored config — the fields its sidecar overlays onto the run — enabled or
 *     paused, and that same key is the one the execution boundary admits.
 *   · Every other key — an ordinary team member, an external-tier member, a Drive connector key
 *     that is unbound, rotated away, out of the Everyone group, or bound to a DIFFERENT connection —
 *     still discovers the row (id, type, name, status) but reads its Drive config as `authMode` only:
 *     no account email or subject, scopes, selected ids, audience projects or service-account
 *     identity.
 *   · Non-Drive rows, the response shape, the revoked-key and wrong-team refusals are unchanged.
 *
 * Every forbidden value is really stored (asserted from SQL first), so each "absent" assertion is
 * made against data that has it.
 */

const ACCOUNT = "drive-owner@example.com";
const SUBJECT = "subject:acct-f5";
const SCOPE = "https://www.googleapis.com/auth/drive.file";
const FILE_ID = "FileF5Marker";
const FOLDER_ID = "FolderF5Marker";
const SHARED_DRIVE_ID = "SharedDriveF5Marker";
const SA_IDENTITY = "sync-bot@project-f5.iam.gserviceaccount.com";
const GOOGLE_SECRET = JSON.stringify({
  client_id: "oauth-client", client_secret: "never-return-this", refresh_token: "never-return-refresh",
  token_uri: "https://oauth2.googleapis.com/token", scopes: [SCOPE], account_subject: SUBJECT,
});

async function driveConnection(seed: Seed, name: string, marker: string) {
  const audienceProjectId = await approvedAudienceProject(seed);
  const config = {
    fileIds: [`${FILE_ID}-${marker}`], folderIds: [`${FOLDER_ID}-${marker}`],
    sharedDriveIds: [`${SHARED_DRIVE_ID}-${marker}`], recursive: true,
    selectionState: "selected", projectSlug: "docs", access: "team", authMode: "oauth",
    authenticatedAccount: ACCOUNT, authenticatedAccountEmailVerified: true,
    authenticatedAccountId: SUBJECT, scopeSet: [SCOPE], audienceProjectIds: [audienceProjectId],
    serviceAccountIdentity: SA_IDENTITY,
  };
  const row = await upsertIntegration(db(), { teamId: seed.teamId, memberId: seed.memberId }, {
    type: "gdrive", name, status: "enabled", config,
  });
  await setIntegrationSecret(db(), { teamId: seed.teamId, memberId: seed.memberId }, row.id, GOOGLE_SECRET);
  const { rows } = await getPool().query<{ config: Record<string, unknown> }>(
    `select config from integrations where id=$1 and team_id=$2`, [row.id, seed.teamId],
  );
  return { id: row.id, name, audienceProjectId, stored: rows[0].config };
}

async function provision(seed: Seed, integrationId: string) {
  await db().from("members").update({ role: "admin" }).eq("id", seed.memberId).eq("team_id", seed.teamId);
  const issued = await provisionGdriveConnectorPrincipal({
    teamId: seed.teamId, integrationId, actorMemberId: seed.memberId,
  });
  const { data } = await db().from("api_keys").select("id").eq("key_id", issued.keyId).single();
  return { key: issued.key, apiKeyId: (data as { id: string }).id, memberId: issued.memberId };
}

async function memberKey(seed: Seed, tier: "team" | "external") {
  const { data, error } = await db().from("members").insert({
    team_id: seed.teamId, email: `${randomUUID()}@member.test`, display_name: `${tier} member`,
    actor_handle: `${tier}-${randomUUID().slice(0, 8)}`, role: "member", tier, status: "active",
  }).select("id").single();
  if (error || !data) throw new Error(error?.message);
  const memberId = (data as { id: string }).id;
  await placeMemberByTier(seed.teamId, memberId, tier);
  return (await issueApiKey(db(), seed.teamId, memberId, `${tier} key`)).key;
}

async function read(key: string, team: string, query = "?include_disabled=1") {
  const response = await integrationsGET(new NextRequest(`http://test/api/v1/integrations${query}`, {
    headers: { Authorization: `Bearer ${key}`, "X-AIOS-Team": team },
  }));
  const raw = await response.text();
  const rows = response.status === 200
    ? JSON.parse(raw).integrations as { id: string; type: string; name: string; config: Record<string, unknown>; status: string }[]
    : [];
  return { status: response.status, raw, byId: new Map(rows.map((row) => [row.id, row])), rows };
}

async function world() {
  const seed = await seedTeam();
  const a = await driveConnection(seed, "company-docs", "a");
  const b = await driveConnection(seed, "client-docs", "b");
  const slack = await upsertIntegration(db(), { teamId: seed.teamId, memberId: seed.memberId }, {
    type: "slack", name: "eng", config: { channelIds: ["C1"] },
  });
  // Fixture evidence: every forbidden value is really in the stored config.
  for (const value of [ACCOUNT, SUBJECT, SCOPE, `${FILE_ID}-a`, `${FOLDER_ID}-a`, `${SHARED_DRIVE_ID}-a`, SA_IDENTITY, a.audienceProjectId]) {
    expect(JSON.stringify(a.stored)).toContain(value);
  }
  return { seed, a, b, slackId: slack.id };
}

const FORBIDDEN = (marker: string, audienceProjectId: string) => [
  ACCOUNT, SUBJECT, SCOPE, `${FILE_ID}-${marker}`, `${FOLDER_ID}-${marker}`, `${SHARED_DRIVE_ID}-${marker}`,
  SA_IDENTITY, audienceProjectId, "authenticatedAccount", "audienceProjectIds", "scopeSet", "fileIds",
];

function expectDiscoveryOnly(
  result: Awaited<ReturnType<typeof read>>, conn: { id: string; name: string },
  marker: string, audienceProjectId: string,
) {
  const row = result.byId.get(conn.id);
  expect(row, "the Drive row stays discoverable").toBeDefined();
  expect(row).toEqual({ id: conn.id, type: "gdrive", name: conn.name, config: { authMode: "oauth" }, status: row!.status });
  for (const value of FORBIDDEN(marker, audienceProjectId)) {
    expect(JSON.stringify(row), value).not.toContain(value);
  }
}

describe("GET /api/v1/integrations — Drive metadata only for the bound live connector (R42 F5, real Postgres)", () => {
  it("the bound connector key reads its connection's full stored config, and is the key execution admits", async () => {
    const w = await world();
    const bound = await provision(w.seed, w.a.id);
    for (const query of ["", "?include_disabled=1"]) {
      const result = await read(bound.key, w.seed.teamSlug, query);
      expect(result.status, query).toBe(200);
      expect(result.byId.get(w.a.id)?.config, query).toEqual(w.a.stored);
      // Response shape is unchanged for every row.
      for (const row of result.rows) expect(Object.keys(row)).toEqual(["id", "type", "name", "config", "status"]);
      expect(result.raw).not.toContain("never-return");
    }
    // The same key the read trusted is the one the execution boundary admits for that connection.
    const acquired = await executionPOST(new Request("http://test/api/v1/integrations/gdrive/execution", {
      method: "POST",
      headers: { Authorization: `Bearer ${bound.key}`, "X-AIOS-Team": w.seed.teamSlug, "Content-Type": "application/json" },
      body: JSON.stringify({ action: "acquire", integration_id: w.a.id, owner: randomUUID() }),
    }) as NextRequest);
    expect(acquired.status).toBe(200);
  });

  it("the bound key keeps the full config of its PAUSED connection (the sidecar's pause re-read)", async () => {
    const w = await world();
    const bound = await provision(w.seed, w.a.id);
    await setIntegrationStatus(db(), { teamId: w.seed.teamId, memberId: w.seed.memberId }, w.a.id, "disabled");
    const result = await read(bound.key, w.seed.teamSlug);
    expect(result.byId.get(w.a.id)?.status).toBe("disabled");
    expect(result.byId.get(w.a.id)?.config).toEqual(w.a.stored);
  });

  it("a connector bound to ANOTHER connection gets only discovery for this one", async () => {
    const w = await world();
    const boundToB = await provision(w.seed, w.b.id);
    const result = await read(boundToB.key, w.seed.teamSlug);
    expect(result.byId.get(w.b.id)?.config).toEqual(w.b.stored);
    expectDiscoveryOnly(result, w.a, "a", w.a.audienceProjectId);
  });

  it.each(["team", "external"] as const)("an ordinary %s-tier key discovers Drive rows without their metadata", async (tier) => {
    const w = await world();
    await provision(w.seed, w.a.id);
    const result = await read(await memberKey(w.seed, tier), w.seed.teamSlug);
    expect(result.status).toBe(200);
    expectDiscoveryOnly(result, w.a, "a", w.a.audienceProjectId);
    expectDiscoveryOnly(result, w.b, "b", w.b.audienceProjectId);
  });

  it("an unbound key of the gdrive-sync connector member is not the bound principal", async () => {
    const w = await world();
    const bound = await provision(w.seed, w.a.id);
    const spare = await issueApiKey(db(), w.seed.teamId, bound.memberId, "unbound connector key");
    expectDiscoveryOnly(await read(spare.key, w.seed.teamSlug), w.a, "a", w.a.audienceProjectId);
  });

  // Outside Everyone the key's posture resolves to external, so it is not a team-tier connector
  // principal at all — the request still succeeds, with discovery only.
  it("a connector outside the builtin Everyone group is not LIVE: discovery only", async () => {
    const w = await world();
    const bound = await provision(w.seed, w.a.id);
    await getPool().query(
      `delete from group_members gm using groups g
        where g.id = gm.group_id and g.team_id = gm.team_id
          and gm.team_id = $1 and gm.member_id = $2 and g.slug = 'everyone' and g.is_builtin`,
      [w.seed.teamId, bound.memberId],
    );
    const result = await read(bound.key, w.seed.teamSlug);
    expect(result.status).toBe(200);
    expectDiscoveryOnly(result, w.a, "a", w.a.audienceProjectId);
  });

  it("a rotated-away connector key is refused outright; the new key reads the full config", async () => {
    const w = await world();
    const first = await provision(w.seed, w.a.id);
    const second = await provision(w.seed, w.a.id);
    const old = await read(first.key, w.seed.teamSlug);
    expect(old.status).toBe(401);
    expect(old.raw).not.toContain(ACCOUNT);
    expect((await read(second.key, w.seed.teamSlug)).byId.get(w.a.id)?.config).toEqual(w.a.stored);
  });

  it("a revoked bound key and a wrong-team presentation are refused, as before", async () => {
    const w = await world();
    const bound = await provision(w.seed, w.a.id);
    const other = await seedTeam();
    const wrongTeam = await read(bound.key, other.teamSlug);
    expect(wrongTeam.status).toBe(401);
    expect(wrongTeam.raw).not.toContain(ACCOUNT);
    await revokeApiKey(db(), w.seed.teamId, bound.apiKeyId);
    const revoked = await read(bound.key, w.seed.teamSlug);
    expect(revoked.status).toBe(401);
    expect(revoked.raw).not.toContain(ACCOUNT);
  });

  it("non-Drive rows keep their full config for every caller", async () => {
    const w = await world();
    const bound = await provision(w.seed, w.a.id);
    for (const key of [bound.key, await memberKey(w.seed, "team"), await memberKey(w.seed, "external")]) {
      expect((await read(key, w.seed.teamSlug)).byId.get(w.slackId)?.config).toEqual({ channelIds: ["C1"] });
    }
  });
});
