import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import { revokeApiKey } from "@/lib/admin/keys";
import { provisionGdriveConnectorPrincipal } from "@/lib/integrations/gdrive-authority";
import { setIntegrationSecret, upsertIntegration } from "@/lib/integrations/manage";
import { approvedAudienceProject } from "../datamechanics/helpers";
import { BASE_URL, db, issueKeyFor, keyHeaders, seedTeam, type Seed } from "./http-helpers";

/**
 * AIO-1167 — the Drive metadata boundary over REAL HTTP (accepted spec: real HTTP authenticated
 * visibility/metadata matrix; user-approved policy).
 *
 * Spec. `GET /api/v1/integrations` lets any team key DISCOVER a Drive row (id, type, name, status), but
 * a Drive row's account and selection metadata — account, scopes, selected ids, audience — is returned
 * only to that connection's live BOUND connector key. Ordinary team keys, external-tier keys and a
 * connector bound to another connection read the Drive config as `authMode` only. Another team's
 * presentation and a revoked key are refused. No response carries a credential. (The same matrix is
 * proven against real Postgres in-process by gdrive-integrations-read-projection; this pins the wire:
 * routing, header authentication and the JSON a real `next start` server returns.)
 */

const SECRET = "oauth-client-secret-never-on-the-wire";

async function driveConnection(seed: Seed, name: string, fileId: string) {
  await db().from("members").update({ role: "admin" }).eq("id", seed.memberId).eq("team_id", seed.teamId);
  const audience = await approvedAudienceProject(seed);
  const auth = { teamId: seed.teamId, memberId: seed.memberId };
  const config = {
    fileIds: [fileId], folderIds: [], sharedDriveIds: [], recursive: false, selectionState: "selected",
    projectSlug: "docs", access: "team", authMode: "oauth", authenticatedAccount: "owner@example.com",
    authenticatedAccountId: "subject:acct-http", scopeSet: ["https://www.googleapis.com/auth/drive.file"],
    audienceProjectIds: [audience],
  };
  const row = await upsertIntegration(db(), auth, { type: "gdrive", name, status: "enabled", config });
  await setIntegrationSecret(db(), auth, row.id, JSON.stringify({
    client_id: "client", client_secret: SECRET, refresh_token: "refresh-never-on-the-wire", grant_mode: "files",
    scopes: ["https://www.googleapis.com/auth/drive.file"], account_subject: "subject:acct-http",
  }));
  const connector = await provisionGdriveConnectorPrincipal({ teamId: seed.teamId, integrationId: row.id, actorMemberId: seed.memberId });
  return { id: row.id, key: connector.key, keyId: connector.keyId };
}

async function read(key: string, team: string) {
  const response = await fetch(`${BASE_URL}/api/v1/integrations`, { headers: keyHeaders(key, team) });
  const raw = await response.text();
  const rows = response.ok ? (JSON.parse(raw) as { integrations: { id: string; config: Record<string, unknown> }[] }).integrations : [];
  return { status: response.status, raw, config: (id: string) => rows.find((row) => row.id === id)?.config };
}

describe("GET /api/v1/integrations — the Drive metadata boundary over real HTTP", () => {
  it("only the bound connector reads its Drive metadata; every other key discovers authMode only", async () => {
    const seed = await seedTeam();
    const a = await driveConnection(seed, `docs-a-${randomUUID().slice(0, 6)}`, "DocA");
    const b = await driveConnection(seed, `docs-b-${randomUUID().slice(0, 6)}`, "DocB");

    const bound = await read(a.key, seed.teamSlug);
    expect(bound.status).toBe(200);
    expect(bound.config(a.id)).toMatchObject({
      fileIds: ["DocA"], authenticatedAccount: "owner@example.com", authenticatedAccountId: "subject:acct-http",
    });
    expect(bound.config(b.id), "another connection's metadata is not the bound key's").toEqual({ authMode: "oauth" });

    const team = await issueKeyFor(seed, "team");
    const external = await issueKeyFor(seed, "external");
    for (const [who, key] of [["ordinary team key", team.key], ["external key", external.key]] as const) {
      const result = await read(key, seed.teamSlug);
      expect(result.status, who).toBe(200);
      expect(result.config(a.id), who).toEqual({ authMode: "oauth" });
      expect(result.config(b.id), who).toEqual({ authMode: "oauth" });
      expect(result.raw, who).not.toContain("owner@example.com");
      expect(result.raw, who).not.toContain("DocA");
    }

    for (const result of [bound, await read(b.key, seed.teamSlug)]) {
      expect(result.raw).not.toContain(SECRET);
      expect(result.raw).not.toContain("refresh-never-on-the-wire");
    }
  });

  it("another team's presentation and a revoked connector key are refused", async () => {
    const seed = await seedTeam();
    const a = await driveConnection(seed, `docs-${randomUUID().slice(0, 6)}`, "DocA");
    const other = await seedTeam();
    expect((await read(a.key, other.teamSlug)).status).toBe(401);
    const { data: keyRow } = await db().from("api_keys").select("id").eq("key_id", a.keyId).single();
    await revokeApiKey(db(), seed.teamId, (keyRow as { id: string }).id);
    expect((await read(a.key, seed.teamSlug)).status).toBe(401);
  });
});
