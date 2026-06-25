import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { setMemberIdentity } from "@/lib/identity/member-identities";
import { syncSlackIdentities } from "@/lib/ingest/sources/slack-identity";
import { buildIdentityMap, resolveByProviderId } from "@/lib/identity/resolve";
import { db, seedTeam } from "./helpers";

async function addMember(teamId: string): Promise<string> {
  const { data, error } = await db()
    .from("members")
    .insert({ team_id: teamId, email: `m-${randomUUID()}@test.local`, display_name: "Other", actor_handle: `h-${randomUUID().slice(0, 8)}`, role: "member", tier: "team", status: "active" })
    .select("id")
    .single();
  if (error || !data) throw new Error(`addMember failed: ${error?.message}`);
  return (data as { id: string }).id;
}

describe("setMemberIdentity (real Postgres)", () => {
  it("creates, updates-in-place, blocks a cross-member remap, and force-remaps", async () => {
    const seed = await seedTeam();
    const other = await addMember(seed.teamId);

    const c = await setMemberIdentity(db(), seed.teamId, seed.memberId, { provider: "slack", externalId: "U1", handle: "alice", email: "a@x.com" });
    expect(c.created).toBe(true);

    const u = await setMemberIdentity(db(), seed.teamId, seed.memberId, { provider: "slack", externalId: "U1", handle: "alice2" });
    expect(u.updated).toBe(true);

    // a DIFFERENT member, no force → conflict, mapping unchanged
    const conflict = await setMemberIdentity(db(), seed.teamId, other, { provider: "slack", externalId: "U1" });
    expect(conflict.conflict).toBe(true);
    let map = await buildIdentityMap(db(), seed.teamId);
    expect(resolveByProviderId(map, "slack", "U1")).toBe(seed.memberId);

    // force → remap to the other member
    const forced = await setMemberIdentity(db(), seed.teamId, other, { provider: "slack", externalId: "U1" }, { force: true });
    expect(forced.updated).toBe(true);
    map = await buildIdentityMap(db(), seed.teamId);
    expect(resolveByProviderId(map, "slack", "U1")).toBe(other);
  });
});

describe("syncSlackIdentities (real Postgres)", () => {
  it("maps Slack users to members by email; skips non-matches; never clobbers a manual mapping", async () => {
    const seed = await seedTeam(); // member A
    const other = await addMember(seed.teamId); // member B
    // A is reachable by the git-alias email
    await db().from("member_emails").insert({ team_id: seed.teamId, member_id: seed.memberId, email: "alice@corp.com" });
    // A pre-existing MANUAL mapping for U7 → B must survive a conflicting email-based sync.
    await setMemberIdentity(db(), seed.teamId, other, { provider: "slack", externalId: "U7", handle: "manual" }, { force: true });

    const res = await syncSlackIdentities(db(), seed.teamId, [
      { id: "U9", displayName: "Alice", email: "alice@corp.com" }, // resolves → A
      { id: "U8", displayName: "Ext", email: "nobody@elsewhere.io" }, // no member → skip
      { id: "U7", displayName: "Alice Alt", email: "alice@corp.com" }, // resolves → A but U7 manually → B
    ]);
    expect(res).toMatchObject({ scanned: 3, mapped: 1, skipped: 2 });

    const map = await buildIdentityMap(db(), seed.teamId);
    expect(resolveByProviderId(map, "slack", "U9")).toBe(seed.memberId); // synced
    expect(resolveByProviderId(map, "slack", "U7")).toBe(other); // manual mapping preserved
    expect(resolveByProviderId(map, "slack", "U8")).toBeNull(); // never mapped
  });
});
