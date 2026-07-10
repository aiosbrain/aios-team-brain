import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { GET as membersGET } from "@/app/api/v1/members/route";
import { GET as resolveGET } from "@/app/api/v1/identities/resolve/route";
import { issueApiKey } from "@/lib/admin/keys";
import { setMemberIdentity } from "@/lib/identity/member-identities";
import { db, seedTeam, type Seed } from "./helpers";

// HTTP edge for the two team-identity read endpoints. Both are team-tier only and
// have no RLS backstop, so the route handler is the sole gate. Verified against the
// real handlers + real Postgres:
//   - team key 200, external key 403 forbidden_tier
//   - /members?provider=slack narrows to members with a slack identity
//   - /identities/resolve maps a slack external_id → the right member (and 404 on miss)

const MEMBERS_URL = "http://test/api/v1/members";
const RESOLVE_URL = "http://test/api/v1/identities/resolve";

async function issueKeyFor(seed: Seed, tier: "team" | "external") {
  let memberId = seed.memberId;
  if (tier === "external") {
    const { data, error } = await db()
      .from("members")
      .insert({
        team_id: seed.teamId,
        email: `ext-${randomUUID().slice(0, 8)}@test.local`,
        display_name: "External",
        actor_handle: `ext-${randomUUID().slice(0, 8)}`,
        role: "member",
        tier: "external",
        status: "active",
      })
      .select("id")
      .single();
    if (error || !data) throw new Error(`external member seed failed: ${error?.message}`);
    memberId = (data as { id: string }).id;
  }
  const { key } = await issueApiKey(db(), seed.teamId, memberId, `${tier} key`);
  return key;
}

function get(route: (r: NextRequest) => Promise<Response>, url: string, key: string, teamSlug: string) {
  const req = new Request(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${key}`, "X-AIOS-Team": teamSlug },
  }) as unknown as NextRequest;
  return route(req);
}

describe("members + identity-resolve endpoints (real handlers, real Postgres)", () => {
  it("members: team key 200, external key 403", async () => {
    const seed = await seedTeam();
    const team = await issueKeyFor(seed, "team");
    const ext = await issueKeyFor(seed, "external");

    const ok = await get(membersGET, MEMBERS_URL, team, seed.teamSlug);
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { members: { id: string }[] };
    expect(body.members.length).toBeGreaterThanOrEqual(1);

    const forbidden = await get(membersGET, MEMBERS_URL, ext, seed.teamSlug);
    expect(forbidden.status).toBe(403);
  });

  it("members: carries avatar_url when the GitHub sync has populated it, null otherwise", async () => {
    const seed = await seedTeam();
    const team = await issueKeyFor(seed, "team");
    const { error } = await db()
      .from("members")
      .update({ github_login: "octocat", avatar_url: "https://avatars.githubusercontent.com/u/583231" })
      .eq("id", seed.memberId)
      .eq("team_id", seed.teamId);
    expect(error).toBeNull();
    const { data: unsynced, error: insertError } = await db()
      .from("members")
      .insert({
        team_id: seed.teamId,
        email: `unsynced-${randomUUID().slice(0, 8)}@test.local`,
        display_name: "Unsynced",
        actor_handle: `unsynced-${randomUUID().slice(0, 8)}`,
        role: "member",
        tier: "team",
        status: "active",
      })
      .select("id")
      .single();
    expect(insertError).toBeNull();
    const unsyncedId = (unsynced as { id: string }).id;

    const ok = await get(membersGET, MEMBERS_URL, team, seed.teamSlug);
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as {
      members: { id: string; github_login: string | null; avatar_url: string | null }[];
    };
    const synced = body.members.find((m) => m.id === seed.memberId);
    expect(synced?.github_login).toBe("octocat");
    expect(synced?.avatar_url).toBe("https://avatars.githubusercontent.com/u/583231");

    const fresh = body.members.find((m) => m.id === unsyncedId);
    expect(fresh?.github_login).toBeNull();
    expect(fresh?.avatar_url).toBeNull();
  });

  it("members: excludes connector service-accounts (e.g. the auto-provisioned plane-sync actor)", async () => {
    const seed = await seedTeam();
    const team = await issueKeyFor(seed, "team");
    const { data: connector, error } = await db()
      .from("members")
      .insert({
        team_id: seed.teamId,
        email: "plane-sync@connector.local",
        display_name: "Plane Sync",
        actor_handle: "plane-sync",
        role: "member",
        tier: "team",
        status: "active",
        is_connector: true,
      })
      .select("id")
      .single();
    expect(error).toBeNull();
    const connectorId = (connector as { id: string }).id;

    const ok = await get(membersGET, MEMBERS_URL, team, seed.teamSlug);
    const body = (await ok.json()) as { members: { id: string }[] };
    expect(body.members.some((m) => m.id === connectorId)).toBe(false);
    expect(body.members.some((m) => m.id === seed.memberId)).toBe(true);
  });

  it("resolve: slack external_id → member; provider filter; 404 on miss", async () => {
    const seed = await seedTeam();
    const team = await issueKeyFor(seed, "team");
    const slackId = `U${randomUUID().slice(0, 8).toUpperCase()}`;
    await setMemberIdentity(db(), seed.teamId, seed.memberId, {
      provider: "slack",
      externalId: slackId,
      handle: "tester",
    });

    const hit = await get(resolveGET, `${RESOLVE_URL}?provider=slack&external_id=${slackId}`, team, seed.teamSlug);
    expect(hit.status).toBe(200);
    const body = (await hit.json()) as { member: { id: string }; slack_id: string };
    expect(body.member.id).toBe(seed.memberId);
    expect(body.slack_id).toBe(slackId);

    const filtered = await get(membersGET, `${MEMBERS_URL}?provider=slack`, team, seed.teamSlug);
    const fbody = (await filtered.json()) as { members: { id: string }[] };
    expect(fbody.members.some((m) => m.id === seed.memberId)).toBe(true);

    const miss = await get(resolveGET, `${RESOLVE_URL}?provider=slack&external_id=UNOPE0000`, team, seed.teamSlug);
    expect(miss.status).toBe(404);
  });
});
