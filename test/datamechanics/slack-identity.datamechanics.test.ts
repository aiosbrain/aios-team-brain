import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { setMemberIdentity, removeMemberIdentity } from "@/lib/identity/member-identities";
import { syncSlackIdentities } from "@/lib/ingest/sources/slack-identity";
import { syncProviderIdentities } from "@/lib/identity/provider-sync";
import { buildIdentityMap, resolveByProviderId } from "@/lib/identity/resolve";
import { readSlackTeamGenerations } from "@/lib/ingest/slack-message-ledger";
import { transactionCapability } from "@/lib/projects/context/transaction";
import { deleteMember, rollbackMemberCreation } from "@/lib/admin/members";
import { activateInvitedMembership, ensureAuthUser, linkMemberByEmail } from "@/lib/auth/pg-login";
import { db, seedTeam, transactionSessionDecoratedDb } from "./helpers";

const generation = (teamId: string) => transactionCapability(db()).transaction(async (s) =>
  (await readSlackTeamGenerations(s, teamId)).identityGeneration);

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
  it("bumps only actual Slack create, remap and remove transitions", async () => {
    const seed = await seedTeam();
    const other = await addMember(seed.teamId);
    expect(await generation(seed.teamId)).toBe("0");

    await setMemberIdentity(db(), seed.teamId, seed.memberId,
      { provider: "slack", externalId: "U-revision", handle: "first" });
    expect(await generation(seed.teamId)).toBe("1");
    await setMemberIdentity(db(), seed.teamId, seed.memberId,
      { provider: "slack", externalId: "U-revision", handle: "renamed" });
    expect(await generation(seed.teamId)).toBe("1");
    const conflict = await setMemberIdentity(db(), seed.teamId, other,
      { provider: "slack", externalId: "U-revision" });
    expect(conflict.conflict).toBe(true);
    expect(await generation(seed.teamId)).toBe("1");
    await setMemberIdentity(db(), seed.teamId, other,
      { provider: "slack", externalId: "U-revision" }, { force: true });
    expect(await generation(seed.teamId)).toBe("2");
    await setMemberIdentity(db(), seed.teamId, other,
      { provider: "linear", externalId: "L-revision" });
    expect(await generation(seed.teamId)).toBe("2");
    expect((await removeMemberIdentity(db(), seed.teamId,
      { provider: "slack", externalId: "U-revision" })).removed).toBe(true);
    expect(await generation(seed.teamId)).toBe("3");
    expect((await removeMemberIdentity(db(), seed.teamId,
      { provider: "slack", externalId: "U-revision" })).removed).toBe(false);
    await removeMemberIdentity(db(), seed.teamId, { provider: "linear", externalId: "L-revision" });
    expect(await generation(seed.teamId)).toBe("3");
  });

  it("rolls back a Slack mapping change when its generation bump fails", async () => {
    const seed = await seedTeam();
    const other = await addMember(seed.teamId);
    const failing = transactionSessionDecoratedDb(db(), (session) => ({ ...session,
      executeSql: async <T = Record<string, unknown>>(sql: string, params?: unknown[]) => {
        if (sql.includes("insert into slack_team_state") && sql.includes("identity_generation")) {
          throw new Error("generation unavailable");
        }
        return session.executeSql<T>(sql, params);
      },
    }));
    await expect(setMemberIdentity(failing, seed.teamId, seed.memberId,
      { provider: "slack", externalId: "U-failure" })).rejects.toThrow("generation unavailable");
    expect(resolveByProviderId(await buildIdentityMap(db(), seed.teamId), "slack", "U-failure")).toBeNull();
    expect(await generation(seed.teamId)).toBe("0");

    await setMemberIdentity(db(), seed.teamId, seed.memberId,
      { provider: "slack", externalId: "U-failure" });
    await expect(setMemberIdentity(failing, seed.teamId, other,
      { provider: "slack", externalId: "U-failure" }, { force: true }))
      .rejects.toThrow("generation unavailable");
    expect(resolveByProviderId(await buildIdentityMap(db(), seed.teamId), "slack", "U-failure"))
      .toBe(seed.memberId);
    await expect(removeMemberIdentity(failing, seed.teamId,
      { provider: "slack", externalId: "U-failure" })).rejects.toThrow("generation unavailable");
    expect(resolveByProviderId(await buildIdentityMap(db(), seed.teamId), "slack", "U-failure"))
      .toBe(seed.memberId);
    expect(await generation(seed.teamId)).toBe("1");
  });

  it("bumps for member hard-delete cascades, including invite rollback", async () => {
    const seed = await seedTeam();
    const removed = await addMember(seed.teamId);
    const { data: member } = await db().from("members").select("email").eq("id", removed).single();
    await setMemberIdentity(db(), seed.teamId, removed,
      { provider: "slack", externalId: "U-hard-delete" });
    const result = await deleteMember(db(), seed.teamId, member.email as string, { hard: true });
    expect(result.deleted).toBe(true);
    expect(resolveByProviderId(await buildIdentityMap(db(), seed.teamId), "slack", "U-hard-delete"))
      .toBeNull();
    expect(await generation(seed.teamId)).toBe("2");

    const rolledBack = await addMember(seed.teamId);
    await setMemberIdentity(db(), seed.teamId, rolledBack,
      { provider: "slack", externalId: "U-invite-rollback" });
    await rollbackMemberCreation(db(), seed.teamId, rolledBack);
    expect(resolveByProviderId(await buildIdentityMap(db(), seed.teamId), "slack", "U-invite-rollback"))
      .toBeNull();
    expect(await generation(seed.teamId)).toBe("4");
  });

  it("rolls back a hard-delete cascade when its Slack generation bump fails", async () => {
    const seed = await seedTeam();
    const removed = await addMember(seed.teamId);
    const { data: member } = await db().from("members").select("email").eq("id", removed).single();
    await setMemberIdentity(db(), seed.teamId, removed,
      { provider: "slack", externalId: "U-hard-rollback" });
    const failing = transactionSessionDecoratedDb(db(), (session) => ({ ...session,
      executeSql: async <T = Record<string, unknown>>(sql: string, params?: unknown[]) => {
        if (sql.includes("insert into slack_team_state") && sql.includes("identity_generation")) {
          throw new Error("generation unavailable");
        }
        return session.executeSql<T>(sql, params);
      },
    }));
    await expect(deleteMember(failing, seed.teamId, member.email as string, { hard: true }))
      .rejects.toThrow("generation unavailable");
    expect(resolveByProviderId(await buildIdentityMap(db(), seed.teamId), "slack", "U-hard-rollback"))
      .toBe(removed);
    expect(await generation(seed.teamId)).toBe("1");
  });

  it("bumps on a linked member's active roster transitions, once per transition", async () => {
    const seed = await seedTeam();
    const { data: member } = await db().from("members").select("email").eq("id", seed.memberId).single();
    const email = member.email as string;
    await setMemberIdentity(db(), seed.teamId, seed.memberId,
      { provider: "slack", externalId: "U-lifecycle" });
    expect(await generation(seed.teamId)).toBe("1");
    await deleteMember(db(), seed.teamId, email);
    expect(await generation(seed.teamId)).toBe("2");
    await deleteMember(db(), seed.teamId, email);
    expect(await generation(seed.teamId)).toBe("2");

    const invited = await addMember(seed.teamId);
    const { data: invite } = await db().from("members").select("email").eq("id", invited).single();
    await db().from("members").update({ status: "invited" }).eq("id", invited);
    await setMemberIdentity(db(), seed.teamId, invited,
      { provider: "slack", externalId: "U-invited" });
    expect(await generation(seed.teamId)).toBe("3");
    const authId = await ensureAuthUser(invite.email as string);
    await linkMemberByEmail(authId, invite.email as string, seed.teamId);
    expect(await generation(seed.teamId)).toBe("4");
    await linkMemberByEmail(authId, invite.email as string, seed.teamId);
    expect(await generation(seed.teamId)).toBe("4");

    const deferred = await addMember(seed.teamId);
    await db().from("members").update({ status: "invited" }).eq("id", deferred);
    await setMemberIdentity(db(), seed.teamId, deferred,
      { provider: "slack", externalId: "U-deferred" });
    const deferredEmail = (await db().from("members").select("email").eq("id", deferred).single()).data.email as string;
    const deferredAuth = await ensureAuthUser(deferredEmail);
    await linkMemberByEmail(deferredAuth, deferredEmail);
    expect(await generation(seed.teamId)).toBe("5");
    await activateInvitedMembership(seed.teamId, deferredAuth);
    expect(await generation(seed.teamId)).toBe("6");
    await activateInvitedMembership(seed.teamId, deferredAuth);
    expect(await generation(seed.teamId)).toBe("6");
  });
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
  it("links only on an exact roster or alias email, never on the email-local-part heuristic (AC-07)", async () => {
    // AIO-1170 review P2-01 / spec: Slack auto-sync accepts ONLY an exact email match and disables heuristic
    // matching "without changing unrelated provider behavior". The shared resolver's softer fallback (an email's
    // local part matched to a team actor_handle, once the domain is in the roster) is a GUESS, and a wrong guess is
    // a mis-credit that this writer's identity-generation bump now carries straight into the timeline.
    const seed = await seedTeam();
    const { data: alex } = await db().from("members")
      .insert({ team_id: seed.teamId, email: "alex.smith@corp.com", display_name: "Alex Smith", actor_handle: "alex",
        role: "member", tier: "team", status: "active" })
      .select("id").single();
    const alexId = (alex as { id: string }).id;

    const res = await syncSlackIdentities(db(), seed.teamId, [
      { id: "U0GUESS1", displayName: "A Different Alex", email: "alex@corp.com" }, // local part == handle, NOT the member's email
      { id: "U0EXACT1", displayName: "Alex Smith", email: "alex.smith@corp.com" }, // exact roster email
    ]);
    expect(res).toMatchObject({ scanned: 2, mapped: 1, skipped: 1 });
    const map = await buildIdentityMap(db(), seed.teamId);
    expect(resolveByProviderId(map, "slack", "U0GUESS1")).toBeNull();
    expect(resolveByProviderId(map, "slack", "U0EXACT1")).toBe(alexId);

    // Non-vacuity: the SAME guess through an unrelated provider still maps, so it is the Slack path that changed,
    // and the input above really did resolve heuristically.
    const plane = await syncProviderIdentities(db(), seed.teamId, "plane",
      [{ id: "P0GUESS1", displayName: "A Different Alex", email: "alex@corp.com" }]);
    expect(plane).toMatchObject({ scanned: 1, mapped: 1 });
    expect(resolveByProviderId(await buildIdentityMap(db(), seed.teamId), "plane", "P0GUESS1")).toBe(alexId);
  });

  it("does not launder a heuristic link through another provider's identity row, and refuses an email with two candidates", async () => {
    // AIO-1170 fix-review FX-02. (a) The resolver folds every provider identity row's email into its exact-match map,
    // and a Plane/Linear heuristic link writes `email: u.email` on its row, so a guess made for another provider
    // became an "exact" Slack match on the next tick. (b) The spec asks for exactly ONE roster/alias candidate; a map
    // that keeps the last writer silently picks one when two members claim an email.
    const seed = await seedTeam();
    const insertMember = async (email: string, handle: string) => {
      const { data } = await db().from("members")
        .insert({ team_id: seed.teamId, email, display_name: handle, actor_handle: handle, role: "member", tier: "team", status: "active" })
        .select("id").single();
      return (data as { id: string }).id;
    };
    const alexId = await insertMember("alex.smith@corp.com", "alex");
    await syncProviderIdentities(db(), seed.teamId, "plane", [{ id: "P0LAUNDER", displayName: "x", email: "alex@corp.com" }]);
    const laundered = await syncSlackIdentities(db(), seed.teamId, [{ id: "U0LAUNDER", displayName: "A Different Alex", email: "alex@corp.com" }]);
    expect(laundered).toMatchObject({ scanned: 1, mapped: 0, skipped: 1 });
    expect(resolveByProviderId(await buildIdentityMap(db(), seed.teamId), "slack", "U0LAUNDER")).toBeNull();

    // Two candidates for one email: member A's own email is also member B's alias.
    const aId = await insertMember("shared@corp.com", "amy");
    const bId = await insertMember("b@corp.com", "bob");
    await db().from("member_emails").insert([
      { team_id: seed.teamId, member_id: bId, email: "shared@corp.com" },
      { team_id: seed.teamId, member_id: bId, email: "solo@corp.com" },
    ]);
    const res = await syncSlackIdentities(db(), seed.teamId, [
      { id: "U0AMBIG", displayName: "Shared", email: "shared@corp.com" }, // A's email AND B's alias: two candidates
      { id: "U0ONE", displayName: "Solo", email: "solo@corp.com" },        // exactly one candidate (B's alias)
      { id: "U0EXACT", displayName: "Alex", email: "alex.smith@corp.com" }, // exactly one candidate (alex's email)
    ]);
    expect(res).toMatchObject({ scanned: 3, mapped: 2, skipped: 1 });
    const map = await buildIdentityMap(db(), seed.teamId);
    expect(resolveByProviderId(map, "slack", "U0AMBIG")).toBeNull();
    expect(resolveByProviderId(map, "slack", "U0ONE")).toBe(bId);
    expect(resolveByProviderId(map, "slack", "U0EXACT")).toBe(alexId);
    expect(aId).not.toBe(bId);
  });

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
    expect(await generation(seed.teamId)).toBe("2"); // manual U7 + newly mapped U9
    await syncSlackIdentities(db(), seed.teamId, [
      { id: "U9", displayName: "Alice renamed", email: "alice@corp.com" },
      { id: "U7", displayName: "Alice Alt", email: "alice@corp.com" },
    ]);
    expect(await generation(seed.teamId)).toBe("2"); // display edit and collision are not remaps
  });
});
