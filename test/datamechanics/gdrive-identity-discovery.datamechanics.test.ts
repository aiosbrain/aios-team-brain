import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";

import { POST as executionPOST } from "@/app/api/v1/integrations/gdrive/execution/route";
import { deleteMember } from "@/lib/admin/members";
import type { ApiAuth } from "@/lib/api/auth";
import { getPool } from "@/lib/db/pg/pool";
import { removeMemberIdentity, setMemberIdentity } from "@/lib/identity/member-identities";
import { buildIdentityMap, resolveByProviderId } from "@/lib/identity/resolve";
import { provisionGdriveConnectorPrincipal } from "@/lib/integrations/gdrive-authority";
import { discoverGdriveContributorIdentities } from "@/lib/integrations/gdrive-identity-discovery";
import { upsertIntegration } from "@/lib/integrations/manage";
import { approvedAudienceProject, db, seedTeam, type Seed } from "./helpers";

/**
 * AIO-1167 R44 F1 — the fenced Drive boundary links an observed stable collaborator id to its member.
 *
 * Spec (AC-08). Under a LIVE execution, an observation carrying `permission:P` and an email that
 * resolves to exactly one active member A creates the shared identity link P → A (visible in the
 * identity registry, with a mapping revision and repair obligation), so later observations of P
 * credit A whatever email they carry. It never transfers or overrides: a replay whose email now
 * resolves to B leaves P → A; an unlink tombstone, a manual mapping, an ambiguous or deactivated
 * email, or one id seen with two emails creates nothing. A stale or foreign execution links nothing.
 */

function post(url: string, key: string, team: string, body: unknown) {
  return new Request(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "X-AIOS-Team": team, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }) as NextRequest;
}

async function member(seed: Seed, name: string) {
  const email = `${name}-${randomUUID().slice(0, 6)}@example.com`;
  const { data } = await db().from("members").insert({
    team_id: seed.teamId, email, display_name: name, actor_handle: `${name}-${randomUUID().slice(0, 6)}`,
    role: "member", tier: "team", status: "active",
  }).select("id").single();
  return { id: (data as { id: string }).id, email };
}

async function world() {
  const seed = await seedTeam();
  await db().from("members").update({ role: "admin" }).eq("id", seed.memberId).eq("team_id", seed.teamId);
  const audience = await approvedAudienceProject(seed);
  const conn = (await upsertIntegration(db(), { teamId: seed.teamId, memberId: seed.memberId }, {
    type: "gdrive", name: "docs", status: "enabled",
    config: { fileIds: ["d"], folderIds: [], sharedDriveIds: [], recursive: false, selectionState: "selected",
      authMode: "service_account", audienceProjectIds: [audience] },
  })).id;
  const issued = await provisionGdriveConnectorPrincipal({ teamId: seed.teamId, integrationId: conn, actorMemberId: seed.memberId });
  const { data: keyRow } = await db().from("api_keys").select("id").eq("key_id", issued.keyId).single();
  const owner = randomUUID();
  const acquired = await executionPOST(post("http://test/api/v1/integrations/gdrive/execution", issued.key, seed.teamSlug, {
    action: "acquire", integration_id: conn, owner,
  }));
  expect(acquired.status).toBe(200);
  const lease = await acquired.json() as { generation: number; fence: number };
  const auth: ApiAuth = {
    teamId: seed.teamId, memberId: issued.memberId, apiKeyId: (keyRow as { id: string }).id, memberTier: "team",
    memberRole: "member", actorHandle: "gdrive-sync", displayName: "Google Drive Sync", email: null, isConnector: true,
  };
  const ref = { integrationId: conn, generation: lease.generation, fence: lease.fence, owner };
  const a = await member(seed, "alice");
  const b = await member(seed, "bob");
  return { seed, auth, ref, a, b };
}

const observed = (email: string, id = "permission:P") => ({
  source: "gdrive",
  contributions: [{ external_id: id, email, role: "editor", at: "2026-10-20T10:00:00Z" }],
});

async function mapped(teamId: string, id = "permission:P") {
  const { rows } = await getPool().query<{ member_id: string }>(
    "select member_id from member_identities where team_id=$1 and provider='gdrive' and external_id=$2", [teamId, id]);
  return rows.map((row) => row.member_id);
}

describe("Drive identity discovery at the fenced ingest boundary (R44 F1, real Postgres)", () => {
  it("links an unmapped stable id to the one member its email names, and never transfers it", async () => {
    const w = await world();
    const outcome = await discoverGdriveContributorIdentities(db(), w.auth, w.ref, observed(w.a.email.toUpperCase()));
    expect(outcome.linked).toBe(1);
    expect(await mapped(w.seed.teamId)).toEqual([w.a.id]);
    const map = await buildIdentityMap(db(), w.seed.teamId, { strict: true });
    expect(resolveByProviderId(map, "gdrive", "permission:P")).toBe(w.a.id);
    const { rows: obligations } = await getPool().query(
      "select 1 from identity_repair_obligations where team_id=$1 and provider='gdrive' and external_id='permission:P'",
      [w.seed.teamId]);
    expect(obligations.length).toBeGreaterThan(0);

    // A replay whose email now belongs to B: no transfer.
    const replay = await discoverGdriveContributorIdentities(db(), w.auth, w.ref, observed(w.b.email));
    expect(replay.linked).toBe(0);
    expect(await mapped(w.seed.teamId)).toEqual([w.a.id]);
  });

  it("a deliberate unlink tombstone and a manual mapping stand", async () => {
    const w = await world();
    await setMemberIdentity(db(), w.seed.teamId, w.a.id, { provider: "gdrive", externalId: "permission:P" });
    await removeMemberIdentity(db(), w.seed.teamId, { provider: "gdrive", externalId: "permission:P" });
    await discoverGdriveContributorIdentities(db(), w.auth, w.ref, observed(w.a.email));
    expect(await mapped(w.seed.teamId)).toEqual([]);

    await setMemberIdentity(db(), w.seed.teamId, w.b.id, { provider: "gdrive", externalId: "permission:M" });
    await discoverGdriveContributorIdentities(db(), w.auth, w.ref, observed(w.a.email, "permission:M"));
    expect(await mapped(w.seed.teamId, "permission:M")).toEqual([w.b.id]);
  });

  it.each(["ambiguous", "deactivated", "two-emails"] as const)("%s evidence links nothing", async (kind) => {
    const w = await world();
    let frontmatter = observed(w.a.email);
    if (kind === "ambiguous") {
      // One address carried by two members' provider identities: the linking map refuses it.
      const shared = `shared-${randomUUID().slice(0, 6)}@example.com`;
      await setMemberIdentity(db(), w.seed.teamId, w.a.id, { provider: "slack", externalId: `U-${randomUUID().slice(0, 6)}`, email: shared });
      await setMemberIdentity(db(), w.seed.teamId, w.b.id, { provider: "slack", externalId: `U-${randomUUID().slice(0, 6)}`, email: shared });
      frontmatter = observed(shared);
    } else if (kind === "deactivated") {
      await deleteMember(db(), w.seed.teamId, w.a.email);
    } else {
      frontmatter = { source: "gdrive", contributions: [
        { external_id: "permission:P", email: w.a.email, role: "editor", at: "2026-10-20T10:00:00Z" },
        { external_id: "permission:P", email: w.b.email, role: "commenter", at: "2026-10-21T10:00:00Z" },
      ] };
    }
    const outcome = await discoverGdriveContributorIdentities(db(), w.auth, w.ref, frontmatter);
    expect(outcome.linked).toBe(0);
    expect(await mapped(w.seed.teamId)).toEqual([]);
  });

  it("a stale execution links nothing", async () => {
    const w = await world();
    await expect(discoverGdriveContributorIdentities(db(), w.auth, { ...w.ref, fence: w.ref.fence + 5 }, observed(w.a.email)))
      .rejects.toMatchObject({ code: "stale_execution" });
    expect(await mapped(w.seed.teamId)).toEqual([]);
  });
});

describe("Drive identity discovery under a concurrent mapping decision (R44 F1)", () => {
  it("an unlink committed while discovery waits on the identity wins: nothing is linked", async () => {
    const w = await world();
    const holder = await getPool().connect();
    let discovering: Promise<unknown> | undefined;
    try {
      // Another writer holds THIS identity's lock and is about to record a deliberate unlink.
      await holder.query("begin");
      await holder.query("select pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`${w.seed.teamId}:identity:gdrive:permission:P`]);
      discovering = discoverGdriveContributorIdentities(db(), w.auth, w.ref, observed(w.a.email));
      // Discovery reaches the identity lock and waits there.
      let waiting = 0;
      for (let tries = 0; tries < 320 && waiting === 0; tries++) {
        const { rows } = await getPool().query<{ n: number }>(
          "select count(*)::int as n from pg_stat_activity where datname=current_database() and wait_event_type='Lock'");
        waiting = rows[0].n;
        if (waiting === 0) await new Promise((r) => setTimeout(r, 25));
      }
      expect(waiting, "discovery is parked on the identity lock").toBeGreaterThan(0);
      await holder.query(
        `insert into member_identity_mapping_state(team_id,provider,external_id,member_id,revision,state)
         values ($1,'gdrive','permission:P',null,1,'unlinked')`,
        [w.seed.teamId],
      );
      await holder.query("commit");
    } finally {
      await holder.query("rollback").catch(() => undefined);
      holder.release();
    }
    const outcome = await discovering as Record<string, number>;
    expect(outcome.linked).toBe(0);
    expect(outcome.reviewed).toBe(1);
    expect(await mapped(w.seed.teamId)).toEqual([]);
  }, 30_000);
});
