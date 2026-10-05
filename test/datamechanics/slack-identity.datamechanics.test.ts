import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { setMemberIdentity, removeMemberIdentity } from "@/lib/identity/member-identities";
import { SlackClient } from "@/lib/ingest/sources/slack";
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
      { id: "U0GUESS1", displayName: "A Different Alex", email: "alex@corp.com", isBot: false, isAppUser: false }, // local part == handle, NOT the member's email
      { id: "U0EXACT1", displayName: "Alex Smith", email: "alex.smith@corp.com", isBot: false, isAppUser: false }, // exact roster email
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
    const laundered = await syncSlackIdentities(db(), seed.teamId,
      [{ id: "U0LAUNDER", displayName: "A Different Alex", email: "alex@corp.com", isBot: false, isAppUser: false }]);
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
      { id: "U0AMBIG", displayName: "Shared", email: "shared@corp.com", isBot: false, isAppUser: false }, // A's email AND B's alias: two candidates
      { id: "U0ONE", displayName: "Solo", email: "solo@corp.com", isBot: false, isAppUser: false },        // exactly one candidate (B's alias)
      { id: "U0EXACT", displayName: "Alex", email: "alex.smith@corp.com", isBot: false, isAppUser: false }, // exactly one candidate (alex's email)
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
      { id: "U9", displayName: "Alice", email: "alice@corp.com", isBot: false, isAppUser: false }, // resolves → A
      { id: "U8", displayName: "Ext", email: "nobody@elsewhere.io", isBot: false, isAppUser: false }, // no member → skip
      { id: "U7", displayName: "Alice Alt", email: "alice@corp.com", isBot: false, isAppUser: false }, // resolves → A but U7 manually → B
    ]);
    expect(res).toMatchObject({ scanned: 3, mapped: 1, skipped: 2 });

    const map = await buildIdentityMap(db(), seed.teamId);
    expect(resolveByProviderId(map, "slack", "U9")).toBe(seed.memberId); // synced
    expect(resolveByProviderId(map, "slack", "U7")).toBe(other); // manual mapping preserved
    expect(resolveByProviderId(map, "slack", "U8")).toBeNull(); // never mapped
    expect(await generation(seed.teamId)).toBe("2"); // manual U7 + newly mapped U9
    const repeat = await syncSlackIdentities(db(), seed.teamId, [
      { id: "U9", displayName: "Alice renamed", email: "alice@corp.com", isBot: false, isAppUser: false },
      { id: "U7", displayName: "Alice Alt", email: "alice@corp.com", isBot: false, isAppUser: false },
    ]);
    // An unchanged generation alone would also be what a FILTERED no-op looks like. The repeat really
    // ran: both records were considered, U9's metadata was refreshed in place and U7's manual owner held.
    expect(repeat).toEqual({ scanned: 2, mapped: 1, skipped: 1 });
    expect(await slackIdentity(seed.teamId, "U9")).toMatchObject({ member_id: seed.memberId, handle: "Alice renamed" });
    expect(await slackIdentity(seed.teamId, "U7")).toMatchObject({ member_id: other });
    expect(await generation(seed.teamId)).toBe("2"); // display edit and collision are not remaps
  });
});

// ── AIO-1170 AC-07: directory classification decides who may be linked automatically ─────────────

interface SlackIdentityRow {
  external_id: string;
  member_id: string;
  handle: string;
  email: string;
}

/** Every live Slack identity row the team holds, in id order. */
async function slackIdentities(teamId: string): Promise<SlackIdentityRow[]> {
  const { data, error } = await db().from("member_identities")
    .select("external_id, member_id, handle, email").eq("team_id", teamId).eq("provider", "slack");
  if (error) throw new Error(`fixture: identity readback failed: ${error.message}`);
  return ((data ?? []) as SlackIdentityRow[]).sort((a, b) => (a.external_id < b.external_id ? -1 : a.external_id > b.external_id ? 1 : 0));
}

async function slackIdentity(teamId: string, externalId: string): Promise<SlackIdentityRow | null> {
  return (await slackIdentities(teamId)).find((row) => row.external_id === externalId) ?? null;
}

/** A fresh alias email that exactly ONE roster member claims — the condition for an automatic link. */
async function aliasFor(teamId: string, memberId: string, label: string): Promise<string> {
  const email = `${label}-${randomUUID()}@roster.test`;
  const { error } = await db().from("member_emails").insert({ team_id: teamId, member_id: memberId, email });
  if (error) throw new Error(`fixture: alias insert failed: ${error.message}`);
  return email;
}

describe("Slack directory classification gates automatic linking (AC-07, real Postgres)", () => {
  it("DIR-03 links no bot, app user, unclassified account or service account, even on an exact roster/alias email", async () => {
    const seed = await seedTeam();
    const rosterEmail = (await db().from("members").select("email").eq("id", seed.memberId).single()).data.email as string;
    // Each excluded account carries an email that exactly one member claims: nothing but its
    // classification stands between it and an automatic link.
    const excluded: Record<string, unknown>[] = [
      { id: "U0DIRBOT", displayName: "Deploy Bot", email: rosterEmail, isBot: true, isAppUser: false },
      { id: "U0DIRAPP", displayName: "Connected App", email: await aliasFor(seed.teamId, seed.memberId, "app"), isBot: false, isAppUser: true },
      { id: "U0DIRBOTH", displayName: "Bot App", email: await aliasFor(seed.teamId, seed.memberId, "both"), isBot: true, isAppUser: true },
      { id: "U0DIRUNKNOWN", displayName: "Unclassified", email: await aliasFor(seed.teamId, seed.memberId, "unknown") },
      { id: "U0DIRPARTIAL", displayName: "Half classified", email: await aliasFor(seed.teamId, seed.memberId, "partial"), isBot: false },
      { id: "U0DIRTYPED", displayName: "Wrongly typed", email: await aliasFor(seed.teamId, seed.memberId, "typed"), isBot: "false", isAppUser: "false" },
      { id: "U0DIRNULL", displayName: "Null flags", email: await aliasFor(seed.teamId, seed.memberId, "null"), isBot: null, isAppUser: null },
      { id: "USLACKBOT", displayName: "Slackbot", email: await aliasFor(seed.teamId, seed.memberId, "service"), isBot: false, isAppUser: false },
    ];
    const before = await generation(seed.teamId);

    // Together, and one at a time, so no excluded class can hide behind another.
    expect(await syncSlackIdentities(db(), seed.teamId, excluded as never)).toEqual({ scanned: 0, mapped: 0, skipped: 0 });
    for (const account of excluded) {
      expect(await syncSlackIdentities(db(), seed.teamId, [account] as never), String(account.id))
        .toEqual({ scanned: 0, mapped: 0, skipped: 0 });
    }
    expect(await slackIdentities(seed.teamId)).toEqual([]);
    const map = await buildIdentityMap(db(), seed.teamId);
    for (const account of excluded) expect(resolveByProviderId(map, "slack", account.id as string), String(account.id)).toBeNull();
    expect(await generation(seed.teamId)).toBe(before);

    // Control, under the SAME matching conditions: an explicit human carrying each of those exact
    // emails does link. So every email above was a real exactly-one-candidate match.
    const humans = excluded.map((account, index) => ({
      id: `U0DIRHUMAN${index}`, displayName: `Person ${index}`, email: account.email as string, isBot: false, isAppUser: false,
    }));
    expect(await syncSlackIdentities(db(), seed.teamId, humans)).toEqual({ scanned: humans.length, mapped: humans.length, skipped: 0 });
    const rows = await slackIdentities(seed.teamId);
    expect(rows.map((row) => row.external_id)).toEqual(humans.map((person) => person.id).sort());
    expect(rows.every((row) => row.member_id === seed.memberId)).toBe(true);
    expect(Number(await generation(seed.teamId))).toBe(Number(before) + humans.length);
  });

  it("DIR-04 still links an ordinary human, a guest, a single-channel guest and a deactivated human by exact email", async () => {
    const seed = await seedTeam();
    const other = await addMember(seed.teamId);
    const people = [
      { id: "U0DIRORDINARY", displayName: "Ordinary", email: await aliasFor(seed.teamId, seed.memberId, "ordinary"), isBot: false, isAppUser: false },
      { id: "U0DIRGUEST", displayName: "Guest", email: await aliasFor(seed.teamId, seed.memberId, "guest"), isBot: false, isAppUser: false, isRestricted: true },
      { id: "U0DIRSINGLE", displayName: "Single channel", email: await aliasFor(seed.teamId, other, "single"), isBot: false, isAppUser: false,
        isRestricted: true, isUltraRestricted: true },
      { id: "U0DIRDELETED", displayName: "Deactivated", email: await aliasFor(seed.teamId, other, "deleted"), isBot: false, isAppUser: false, deleted: true },
    ];
    const before = await generation(seed.teamId);
    expect(await syncSlackIdentities(db(), seed.teamId, [
      ...people,
      // A known human with no email stays unlinked (and available for an explicit manual link)…
      { id: "U0DIRNOEMAIL", displayName: "No email", isBot: false, isAppUser: false },
      // …and one whose email no member claims is considered and skipped.
      { id: "U0DIRSTRANGER", displayName: "Stranger", email: `stranger-${randomUUID()}@elsewhere.test`, isBot: false, isAppUser: false, deleted: true },
    ])).toEqual({ scanned: 5, mapped: 4, skipped: 1 });

    const rows = await slackIdentities(seed.teamId);
    expect(rows.map(({ external_id, member_id, handle }) => ({ external_id, member_id, handle }))).toEqual([
      { external_id: "U0DIRDELETED", member_id: other, handle: "Deactivated" },
      { external_id: "U0DIRGUEST", member_id: seed.memberId, handle: "Guest" },
      { external_id: "U0DIRORDINARY", member_id: seed.memberId, handle: "Ordinary" },
      { external_id: "U0DIRSINGLE", member_id: other, handle: "Single channel" },
    ]);
    expect(Number(await generation(seed.teamId))).toBe(Number(before) + 4);
  });

  it("DIR-05 leaves an existing mapping exactly as stored when its account is now a bot, app, unclassified or the service account", async () => {
    const seed = await seedTeam();
    const storedEmail = await aliasFor(seed.teamId, seed.memberId, "stored");
    // A DIFFERENT email than the stored one, and an exact match to the SAME owner: a refresh the
    // shared writer would happily apply if the record reached it.
    const incomingEmail = await aliasFor(seed.teamId, seed.memberId, "incoming");
    const classifications: [string, Record<string, unknown>][] = [
      ["U0KEEPBOT", { isBot: true, isAppUser: false }],
      ["U0KEEPAPP", { isBot: false, isAppUser: true }],
      ["U0KEEPUNKNOWN", {}],
      ["USLACKBOT", { isBot: false, isAppUser: false }],
      ["U0KEEPHUMAN", { isBot: false, isAppUser: false }],
    ];
    for (const [externalId] of classifications) {
      const linked = await setMemberIdentity(db(), seed.teamId, seed.memberId,
        { provider: "slack", externalId, handle: "Stored handle", email: storedEmail }, { explicit: true });
      expect(linked.created, externalId).toBe(true);
    }
    const before = await slackIdentities(seed.teamId);
    const generationBefore = await generation(seed.teamId);
    expect(before).toHaveLength(classifications.length);
    expect(before.every((row) => row.handle === "Stored handle" && row.email === storedEmail && row.member_id === seed.memberId)).toBe(true);

    const excluded = classifications.filter(([externalId]) => externalId !== "U0KEEPHUMAN")
      .map(([id, flags]) => ({ id, displayName: "Changed display name", email: incomingEmail, ...flags }));
    expect(await syncSlackIdentities(db(), seed.teamId, excluded as never)).toEqual({ scanned: 0, mapped: 0, skipped: 0 });
    // Ownership, handle and email are byte for byte what was stored; nothing was refreshed or removed.
    expect(await slackIdentities(seed.teamId)).toEqual(before);
    expect(await generation(seed.teamId)).toBe(generationBefore);

    // Control: the same incoming change on the explicit HUMAN's mapping is an ordinary in-place refresh.
    expect(await syncSlackIdentities(db(), seed.teamId, [
      { id: "U0KEEPHUMAN", displayName: "Changed display name", email: incomingEmail, isBot: false, isAppUser: false },
    ])).toEqual({ scanned: 1, mapped: 1, skipped: 0 });
    expect(await slackIdentity(seed.teamId, "U0KEEPHUMAN")).toMatchObject({
      member_id: seed.memberId, handle: "Changed display name", email: incomingEmail,
    });
    const untouched = (await slackIdentities(seed.teamId)).filter((row) => row.external_id !== "U0KEEPHUMAN");
    expect(untouched).toEqual(before.filter((row) => row.external_id !== "U0KEEPHUMAN"));
    // A metadata refresh is not an identity change.
    expect(await generation(seed.teamId)).toBe(generationBefore);
  });

  it("integrates the actual users.list projection with the actual adapter: only the classified humans link", async () => {
    const seed = await seedTeam();
    const email = {
      bot: await aliasFor(seed.teamId, seed.memberId, "bot"),
      app: await aliasFor(seed.teamId, seed.memberId, "app"),
      unknown: await aliasFor(seed.teamId, seed.memberId, "unknown"),
      service: await aliasFor(seed.teamId, seed.memberId, "service"),
      human: await aliasFor(seed.teamId, seed.memberId, "human"),
      guest: await aliasFor(seed.teamId, seed.memberId, "guest"),
    };
    const before = await generation(seed.teamId);
    const human = { is_bot: false, is_app_user: false };
    // A synthetic two-page `users.list`: the excluded group first, the human controls on the second page.
    const pages: { members: Record<string, unknown>[]; cursor?: string }[] = [
      { cursor: "directory-page-2", members: [
        { id: "U0INTBOT", name: "deploybot", profile: { real_name: "Deploy Bot", email: email.bot }, is_bot: true, is_app_user: false },
        { id: "U0INTAPP", name: "connected", profile: { real_name: "Connected App", email: email.app }, is_bot: false, is_app_user: true },
        { id: "U0INTUNKNOWN", name: "unclassified", profile: { real_name: "Unclassified", email: email.unknown } },
      ] },
      { members: [
        { id: "USLACKBOT", name: "slackbot", profile: { real_name: "Slackbot", email: email.service }, ...human },
        { id: "U0INTHUMAN", name: "person", profile: { display_name: "Person", email: email.human }, ...human },
        { id: "U0INTGUEST", name: "guest", profile: { display_name: "Guest", email: email.guest }, ...human, is_restricted: true, deleted: false },
      ] },
    ];

    // Only Slack HTTP is stubbed; the database is the real pool and does not go through fetch. Anything
    // that is not the expected `users.list` call fails here instead of reaching a network.
    const requests: URL[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: unknown) => {
      const url = new URL(String(input));
      requests.push(url);
      if (url.origin !== "https://slack.com" || url.pathname !== "/api/users.list") {
        throw new Error(`fixture: unexpected request to ${url.origin}${url.pathname}`);
      }
      const page = pages[requests.length - 1];
      if (!page) throw new Error("fixture: more users.list pages were requested than the provider has");
      return {
        ok: true, status: 200,
        json: async () => ({ ok: true, members: page.members, response_metadata: page.cursor ? { next_cursor: page.cursor } : {} }),
      };
    }) as unknown as typeof fetch;
    let directory: Awaited<ReturnType<SlackClient["usersDetailed"]>>;
    let result: Awaited<ReturnType<typeof syncSlackIdentities>>;
    try {
      // The client's return value goes STRAIGHT into the adapter: nothing is renamed or added between.
      directory = await new SlackClient("xoxb-synthetic-directory-token").usersDetailed();
      result = await syncSlackIdentities(db(), seed.teamId, directory);
    } finally {
      globalThis.fetch = realFetch;
    }

    expect(requests.map((url) => url.pathname)).toEqual(["/api/users.list", "/api/users.list"]);
    expect(requests.map((url) => url.searchParams.get("cursor"))).toEqual([null, "directory-page-2"]);

    // The directory keeps every record — bots and apps included — with what Slack said about each.
    const projected = directory as unknown as Record<string, unknown>[];
    expect(projected.map(({ id, displayName, email: address, isBot, isAppUser }) => ({ id, displayName, email: address, isBot, isAppUser }))).toEqual([
      { id: "U0INTBOT", displayName: "Deploy Bot", email: email.bot, isBot: true, isAppUser: false },
      { id: "U0INTAPP", displayName: "Connected App", email: email.app, isBot: false, isAppUser: true },
      { id: "U0INTUNKNOWN", displayName: "Unclassified", email: email.unknown, isBot: undefined, isAppUser: undefined },
      { id: "USLACKBOT", displayName: "Slackbot", email: email.service, isBot: false, isAppUser: false },
      { id: "U0INTHUMAN", displayName: "Person", email: email.human, isBot: false, isAppUser: false },
      { id: "U0INTGUEST", displayName: "Guest", email: email.guest, isBot: false, isAppUser: false },
    ]);
    expect(projected.find((user) => user.id === "U0INTGUEST")).toMatchObject({ isRestricted: true, deleted: false });

    // Only the two classified humans were considered, and both linked: a field-name drift between the
    // projection and the adapter would leave them unclassified and fail right here.
    expect(result).toEqual({ scanned: 2, mapped: 2, skipped: 0 });
    expect((await slackIdentities(seed.teamId)).map(({ external_id, member_id, handle }) => ({ external_id, member_id, handle }))).toEqual([
      { external_id: "U0INTGUEST", member_id: seed.memberId, handle: "Guest" },
      { external_id: "U0INTHUMAN", member_id: seed.memberId, handle: "Person" },
    ]);
    const map = await buildIdentityMap(db(), seed.teamId);
    for (const excludedId of ["U0INTBOT", "U0INTAPP", "U0INTUNKNOWN", "USLACKBOT"]) {
      expect(resolveByProviderId(map, "slack", excludedId), excludedId).toBeNull();
    }
    expect(Number(await generation(seed.teamId))).toBe(Number(before) + 2);
  });
});
