import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { DbClient, PgBuilder } from "@/lib/db/types";
import { runSql } from "@/lib/db/pg/pool";
import { setMemberIdentity, removeMemberIdentity } from "@/lib/identity/member-identities";
import { syncSlackIdentities } from "@/lib/ingest/sources/slack-identity";
import { readSlackTeamGenerations } from "@/lib/ingest/slack-message-ledger";
import { transactionCapability } from "@/lib/projects/context/transaction";
import { db, seedTeam, transactionDecoratedDb, transactionSessionDecoratedDb } from "./helpers";

const migration = readFileSync(join(import.meta.dirname, "..", "..", "postgres", "migrations",
  "20260919200000_member_identity_suppressions.sql"), "utf8");

async function generation(teamId: string): Promise<string> {
  return transactionCapability(db()).transaction(async (s) =>
    (await readSlackTeamGenerations(s, teamId)).identityGeneration);
}

async function mapping(teamId: string, externalId: string): Promise<{ id: string; member_id: string } | null> {
  const { rows } = await runSql<{ id: string; member_id: string }>(
    `select id, member_id from member_identities
       where team_id = $1 and provider = 'slack' and external_id = $2`, [teamId, externalId]);
  return rows[0] ?? null;
}

async function suppressed(teamId: string, externalId: string): Promise<boolean> {
  const { rows } = await runSql(
    `select 1 from member_identity_suppressions
       where team_id = $1 and provider = 'slack' and external_id = $2`, [teamId, externalId]);
  return rows.length > 0;
}

async function rosterEmail(teamId: string, memberId: string): Promise<string> {
  const email = `slack-${randomUUID()}@test.local`;
  const { error } = await db().from("member_emails").insert({ team_id: teamId, member_id: memberId, email });
  if (error) throw new Error(error.message);
  return email;
}

function suppressionFault(operation: "select" | "insert" | "delete"): DbClient {
  if (operation === "select") {
    return transactionSessionDecoratedDb(db(), (session) => ({ ...session,
      executeSql: async <T = Record<string, unknown>>(sql: string, params?: unknown[]) => {
        if (sql.includes("from member_identity_suppressions")) {
          throw new Error("suppression select unavailable");
        }
        return session.executeSql<T>(sql, params);
      },
    }));
  }
  return transactionDecoratedDb(db(), (bound) => ({
    from(table: string): PgBuilder {
      const builder = bound.from(table);
      if (table !== "member_identity_suppressions") return builder;
      return new Proxy(builder, {
        get(target, property, receiver) {
          if (property === operation) return () => { throw new Error(`suppression ${operation} unavailable`); };
          return Reflect.get(target, property, receiver);
        },
      });
    },
    rpc: bound.rpc.bind(bound),
  }));
}

function holdAfterTeamLock() {
  let entered!: () => void;
  let release!: () => void;
  const locked = new Promise<void>((resolve) => { entered = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  const client = transactionSessionDecoratedDb(db(), (session) => ({ ...session,
    executeSql: async <T = Record<string, unknown>>(sql: string, params?: unknown[]) => {
      const result = await session.executeSql<T>(sql, params);
      if (sql.includes("pg_advisory_xact_lock(7341014")) {
        entered();
        await held;
      }
      return result;
    },
  }));
  return { client, locked, release };
}

describe("Slack account suppression (real Postgres)", () => {
  it("unlinks, refuses automatic email sync, and clears suppression on authorized relink", async () => {
    const { teamId, memberId } = await seedTeam();
    const email = await rosterEmail(teamId, memberId);
    await setMemberIdentity(db(), teamId, memberId, { provider: "slack", externalId: "UCONSENT" });
    expect(await generation(teamId)).toBe("1");

    expect(await removeMemberIdentity(db(), teamId, { provider: "slack", externalId: "UCONSENT" }))
      .toEqual({ removed: true });
    expect(await mapping(teamId, "UCONSENT")).toBeNull();
    expect(await suppressed(teamId, "UCONSENT")).toBe(true);
    expect(await generation(teamId)).toBe("2");
    expect(await syncSlackIdentities(db(), teamId, [{ id: "UCONSENT", displayName: "Again", email }]))
      .toMatchObject({ scanned: 1, mapped: 0, skipped: 1 });
    expect(await mapping(teamId, "UCONSENT")).toBeNull();
    expect(await generation(teamId)).toBe("2");

    const relink = await setMemberIdentity(db(), teamId, memberId,
      { provider: "slack", externalId: "UCONSENT" }, { explicit: true, actor: { kind: "member", memberId } });
    expect(relink.created).toBe(true);
    expect(await mapping(teamId, "UCONSENT")).toMatchObject({ member_id: memberId });
    expect(await suppressed(teamId, "UCONSENT")).toBe(false);
    expect(await generation(teamId)).toBe("3");
    await syncSlackIdentities(db(), teamId, [{ id: "UCONSENT", displayName: "Again", email }]);
    expect(await generation(teamId)).toBe("3");
  });

  it("preserves collision and repeated-unlink no-op behavior, including an absent-key fence", async () => {
    const { teamId, memberId } = await seedTeam();
    const otherEmail = `other-${randomUUID()}@test.local`;
    const other = (await db().from("members").insert({ team_id: teamId, email: otherEmail,
      display_name: "Other", actor_handle: `other-${randomUUID().slice(0, 8)}`,
      role: "member", tier: "team", status: "active" }).select("id").single()).data.id as string;
    await setMemberIdentity(db(), teamId, memberId, { provider: "slack", externalId: "UCONFLICT" });
    expect((await setMemberIdentity(db(), teamId, other,
      { provider: "slack", externalId: "UCONFLICT" }, { explicit: true })).conflict).toBe(true);
    expect(await mapping(teamId, "UCONFLICT")).toMatchObject({ member_id: memberId });
    expect(await generation(teamId)).toBe("1");

    expect(await removeMemberIdentity(db(), teamId, { provider: "slack", externalId: "UABSENT" }))
      .toEqual({ removed: false });
    expect(await suppressed(teamId, "UABSENT")).toBe(true);
    expect(await generation(teamId)).toBe("2");
    expect(await removeMemberIdentity(db(), teamId, { provider: "slack", externalId: "UABSENT" }))
      .toEqual({ removed: false });
    expect(await generation(teamId)).toBe("2");
    expect((await setMemberIdentity(db(), teamId, memberId,
      { provider: "slack", externalId: "UABSENT" })).conflict).toBe(true);
    expect(await generation(teamId)).toBe("2");

    await setMemberIdentity(db(), teamId, memberId, { provider: "linear", externalId: "UABSENT" });
    await removeMemberIdentity(db(), teamId, { provider: "linear", externalId: "UABSENT" });
    expect(await generation(teamId)).toBe("2");
    expect(await suppressed(teamId, "UABSENT")).toBe(true);
  });

  it("rolls mapping and generation back on suppression failures and fails closed on an unreadable fence", async () => {
    const { teamId, memberId } = await seedTeam();
    await setMemberIdentity(db(), teamId, memberId, { provider: "slack", externalId: "UFAIL" });
    await expect(removeMemberIdentity(suppressionFault("insert"), teamId,
      { provider: "slack", externalId: "UFAIL" })).rejects.toThrow("suppression insert unavailable");
    expect(await mapping(teamId, "UFAIL")).toMatchObject({ member_id: memberId });
    expect(await suppressed(teamId, "UFAIL")).toBe(false);
    expect(await generation(teamId)).toBe("1");

    await removeMemberIdentity(db(), teamId, { provider: "slack", externalId: "UFAIL" });
    await expect(setMemberIdentity(suppressionFault("select"), teamId, memberId,
      { provider: "slack", externalId: "UFAIL" })).rejects.toThrow("suppression select unavailable");
    await expect(setMemberIdentity(suppressionFault("delete"), teamId, memberId,
      { provider: "slack", externalId: "UFAIL" }, { explicit: true }))
      .rejects.toThrow("suppression delete unavailable");
    expect(await mapping(teamId, "UFAIL")).toBeNull();
    expect(await suppressed(teamId, "UFAIL")).toBe(true);
    expect(await generation(teamId)).toBe("2");
  });

  it("serializes sync before unlink and unlink before sync through the shared identity lock", async () => {
    const { teamId, memberId } = await seedTeam();
    const email = await rosterEmail(teamId, memberId);
    const user = [{ id: "UORDER", displayName: "Ordered", email }];

    const first = holdAfterTeamLock();
    const sync = syncSlackIdentities(first.client, teamId, user);
    await first.locked;
    const unlink = removeMemberIdentity(db(), teamId, { provider: "slack", externalId: "UORDER" });
    first.release();
    expect(await sync).toMatchObject({ mapped: 1 });
    expect(await unlink).toEqual({ removed: true });
    expect(await mapping(teamId, "UORDER")).toBeNull();
    expect(await suppressed(teamId, "UORDER")).toBe(true);

    await setMemberIdentity(db(), teamId, memberId,
      { provider: "slack", externalId: "UORDER" }, { explicit: true });
    const second = holdAfterTeamLock();
    const heldUnlink = removeMemberIdentity(second.client, teamId,
      { provider: "slack", externalId: "UORDER" });
    await second.locked;
    const laterSync = syncSlackIdentities(db(), teamId, user);
    second.release();
    expect(await heldUnlink).toEqual({ removed: true });
    expect(await laterSync).toMatchObject({ mapped: 0, skipped: 1 });
    expect(await mapping(teamId, "UORDER")).toBeNull();
    expect(await suppressed(teamId, "UORDER")).toBe(true);
  });

  it("keeps raw and qualified IDs from becoming duplicate live rows; suppression survives migration replay", async () => {
    const { teamId, memberId } = await seedTeam();
    await setMemberIdentity(db(), teamId, memberId, { provider: "slack", externalId: "UOLD" });
    expect((await setMemberIdentity(db(), teamId, memberId,
      { provider: "slack", externalId: "TSPACE:UOLD" }, { explicit: true })).conflict).toBe(true);
    expect(await mapping(teamId, "TSPACE:UOLD")).toBeNull();
    await removeMemberIdentity(db(), teamId, { provider: "slack", externalId: "UOLD" });
    expect((await setMemberIdentity(db(), teamId, memberId,
      { provider: "slack", externalId: "TSPACE:UOLD" })).conflict).toBe(true);
    await setMemberIdentity(db(), teamId, memberId,
      { provider: "slack", externalId: "TSPACE:UOLD" }, { explicit: true });
    const qualified = await mapping(teamId, "TSPACE:UOLD");
    expect(qualified?.id).toBeTruthy();
    await expect(removeMemberIdentity(db(), teamId,
      { provider: "slack", externalId: "UOLD" })).rejects.toThrow("unlink that exact key");
    expect(await syncSlackIdentities(db(), teamId, [{ id: "TSPACE:UOLD", displayName: "Linked",
      email: await rosterEmail(teamId, memberId) }])).toMatchObject({ mapped: 1, skipped: 0 });
    expect((await setMemberIdentity(db(), teamId, memberId,
      { provider: "slack", externalId: "UOLD" }, { explicit: true })).conflict).toBe(true);
    expect(await suppressed(teamId, "UOLD")).toBe(true);

    await runSql(migration);
    await runSql(migration);
    expect(await mapping(teamId, "UOLD")).toBeNull();
    expect(await mapping(teamId, "TSPACE:UOLD")).toEqual(qualified);
    expect(await suppressed(teamId, "UOLD")).toBe(true);
  });

  it.each([
    { key: "uabc", providerKey: "UABC" },
    { key: "tspace:uabc", providerKey: "TSPACE:UABC" },
  ])("keeps a lowercase $key unlink fenced against uppercase auto-sync", async ({ key, providerKey }) => {
    const { teamId, memberId } = await seedTeam();
    const email = await rosterEmail(teamId, memberId);
    await setMemberIdentity(db(), teamId, memberId,
      { provider: "slack", externalId: key }, { explicit: true });
    expect(await removeMemberIdentity(db(), teamId,
      { provider: "slack", externalId: providerKey })).toEqual({ removed: true });
    expect(await mapping(teamId, key)).toBeNull();
    expect(await suppressed(teamId, key)).toBe(true);
    expect(await syncSlackIdentities(db(), teamId,
      [{ id: providerKey, displayName: "Again", email }]))
      .toMatchObject({ mapped: 0, skipped: 1 });
    expect(await mapping(teamId, providerKey)).toBeNull();
    expect(await generation(teamId)).toBe("2");

    const relink = await setMemberIdentity(db(), teamId, memberId,
      { provider: "slack", externalId: providerKey }, { explicit: true });
    expect(relink.created).toBe(true);
    expect(await suppressed(teamId, key)).toBe(false);
    expect(await mapping(teamId, providerKey)).toMatchObject({ member_id: memberId });
    expect(await generation(teamId)).toBe("3");
    expect(await syncSlackIdentities(db(), teamId,
      [{ id: providerKey, displayName: "Again", email }]))
      .toMatchObject({ mapped: 1, skipped: 0 });
    expect(await generation(teamId)).toBe("3");
  });

  it("folds live raw and qualified keys without merging different workspaces", async () => {
    const { teamId, memberId } = await seedTeam();
    const raw = await setMemberIdentity(db(), teamId, memberId,
      { provider: "slack", externalId: "uabc" }, { explicit: true });
    expect(raw.created).toBe(true);
    expect((await setMemberIdentity(db(), teamId, memberId,
      { provider: "slack", externalId: "UABC" }, { explicit: true })).updated).toBe(true);
    expect((await setMemberIdentity(db(), teamId, memberId,
      { provider: "slack", externalId: "TSPACE:UABC" }, { explicit: true })).conflict).toBe(true);
    expect(await mapping(teamId, "UABC")).toBeNull();
    expect(await mapping(teamId, "TSPACE:UABC")).toBeNull();

    await removeMemberIdentity(db(), teamId, { provider: "slack", externalId: "uabc" });
    await setMemberIdentity(db(), teamId, memberId,
      { provider: "slack", externalId: "tspace:uabc" }, { explicit: true });
    expect((await setMemberIdentity(db(), teamId, memberId,
      { provider: "slack", externalId: "TSPACE:UABC" }, { explicit: true })).updated).toBe(true);
    expect((await setMemberIdentity(db(), teamId, memberId,
      { provider: "slack", externalId: "UABC" }, { explicit: true })).conflict).toBe(true);
    await expect(removeMemberIdentity(db(), teamId,
      { provider: "slack", externalId: "UABC" })).rejects.toThrow("unlink that exact key");
    expect((await setMemberIdentity(db(), teamId, memberId,
      { provider: "slack", externalId: "TOTHER:UABC" }, { explicit: true })).created).toBe(true);
    const { rows } = await runSql<{ external_id: string }>(
      `select external_id from member_identities where team_id = $1 and provider = 'slack'`, [teamId]);
    expect(rows.map((row) => row.external_id).sort()).toEqual(["TOTHER:UABC", "tspace:uabc"]);
  });
});

/**
 * AIO-1170 pre-activation correction PA-5 — legacy CASE VARIANTS of one Slack account.
 *
 * The unique key is case-sensitive and the writer once matched exactly, so a team can hold `U0ABC`
 * and `u0abc` as two live rows. Today's writer folds case and will not create that state, which is
 * why these fixtures insert the rows directly: it is the only way to stand where such a team stands.
 * From there unlinking either row threw and linking returned a conflict — no way out except SQL.
 */
async function legacyVariant(
  teamId: string, memberId: string, externalId: string, handle = ""
): Promise<{ id: string; member_id: string }> {
  const { rows } = await runSql<{ id: string; member_id: string }>(
    `insert into member_identities (team_id, member_id, provider, external_id, handle)
          values ($1, $2, 'slack', $3, $4) returning id, member_id`,
    [teamId, memberId, externalId, handle]);
  return rows[0];
}

/** Every live Slack spelling the team holds, in byte order (`U0ABC` before `u0abc`). */
async function liveSpellings(teamId: string): Promise<string[]> {
  const { rows } = await runSql<{ external_id: string }>(
    `select external_id from member_identities
       where team_id = $1 and provider = 'slack' order by external_id collate "C"`, [teamId]);
  return rows.map((row) => row.external_id);
}

/** Every Slack unlink fence the team holds, whatever its spelling. */
async function fences(teamId: string): Promise<string[]> {
  const { rows } = await runSql<{ external_id: string }>(
    `select external_id from member_identity_suppressions
       where team_id = $1 and provider = 'slack' order by external_id collate "C"`, [teamId]);
  return rows.map((row) => row.external_id);
}

async function otherMember(teamId: string): Promise<string> {
  return (await db().from("members").insert({ team_id: teamId, email: `other-${randomUUID()}@test.local`,
    display_name: "Other", actor_handle: `other-${randomUUID().slice(0, 8)}`,
    role: "member", tier: "team", status: "active" }).select("id").single()).data.id as string;
}

describe("Slack case-variant unlink (PA-5, real Postgres)", () => {
  it.each([
    { remove: "u0abc", keep: "U0ABC" },
    { remove: "U0ABC", keep: "u0abc" },
  ])("removes only the row spelled $remove and bumps the identity generation once (AC-PA-15)", async ({ remove, keep }) => {
    const { teamId, memberId } = await seedTeam();
    // Two DIFFERENT members, so "the right row went" is visible as whose mapping survived.
    const rows: Record<string, { id: string; member_id: string }> = {
      U0ABC: await legacyVariant(teamId, memberId, "U0ABC"),
      u0abc: await legacyVariant(teamId, await otherMember(teamId), "u0abc"),
    };
    const before = await generation(teamId);

    expect(await removeMemberIdentity(db(), teamId, { provider: "slack", externalId: remove }))
      .toEqual({ removed: true });

    expect(await liveSpellings(teamId)).toEqual([keep]);
    // The survivor is the SAME row, still mapped to the member it was mapped to.
    expect(await mapping(teamId, keep)).toEqual(rows[keep]);
    expect(Number(await generation(teamId))).toBe(Number(before) + 1);
  });

  // NEGATIVE CONTROL, and a behavior kept on purpose: the exact-spelling rule is what makes the
  // removal above safe, so a spelling that names NEITHER row must not be resolved by guessing.
  it("still refuses a spelling that matches no row exactly, and changes nothing (AC-PA-16)", async () => {
    const { teamId, memberId } = await seedTeam();
    await legacyVariant(teamId, memberId, "U0ABC");
    await legacyVariant(teamId, memberId, "u0abc");
    const before = await generation(teamId);

    await expect(removeMemberIdentity(db(), teamId, { provider: "slack", externalId: "U0abc" }))
      .rejects.toThrow("multiple live case variants");

    expect(await liveSpellings(teamId)).toEqual(["U0ABC", "u0abc"]);
    expect(await fences(teamId)).toEqual([]);
    expect(await generation(teamId)).toBe(before);
  });

  it("writes the fence when the LAST variant goes, and auto-sync recreates neither spelling (AC-PA-17a)", async () => {
    const { teamId, memberId } = await seedTeam();
    const email = await rosterEmail(teamId, memberId);
    await legacyVariant(teamId, memberId, "U0ABC");
    await legacyVariant(teamId, memberId, "u0abc");
    const before = await generation(teamId);

    expect(await removeMemberIdentity(db(), teamId, { provider: "slack", externalId: "u0abc" }))
      .toEqual({ removed: true });
    expect(await removeMemberIdentity(db(), teamId, { provider: "slack", externalId: "U0ABC" }))
      .toEqual({ removed: true });

    expect(await liveSpellings(teamId)).toEqual([]);
    // ONE fence for the account, written by the removal that left nothing live.
    expect(await fences(teamId)).toEqual(["U0ABC"]);
    expect(Number(await generation(teamId))).toBe(Number(before) + 2);

    // The unlink now holds against BOTH spellings: neither comes back on its own.
    expect(await syncSlackIdentities(db(), teamId, [
      { id: "U0ABC", displayName: "Again", email },
      { id: "u0abc", displayName: "Again", email },
    ])).toMatchObject({ scanned: 2, mapped: 0, skipped: 2 });
    expect(await liveSpellings(teamId)).toEqual([]);
    expect(Number(await generation(teamId))).toBe(Number(before) + 2);
  });

  it("writes NO fence while a variant is still live, so the survivor's refresh is not a conflict (AC-PA-17b)", async () => {
    const { teamId, memberId } = await seedTeam();
    const email = await rosterEmail(teamId, memberId);
    const survivor = await legacyVariant(teamId, memberId, "U0ABC", "Stale");
    await legacyVariant(teamId, memberId, "u0abc");

    expect(await removeMemberIdentity(db(), teamId, { provider: "slack", externalId: "u0abc" }))
      .toEqual({ removed: true });
    expect(await fences(teamId)).toEqual([]);
    const afterUnlink = await generation(teamId);

    // The survivor is an ordinary live mapping again: auto-sync refreshes its metadata in place.
    expect(await syncSlackIdentities(db(), teamId, [{ id: "U0ABC", displayName: "Fresh", email }]))
      .toMatchObject({ scanned: 1, mapped: 1, skipped: 0 });
    expect(await mapping(teamId, "U0ABC")).toEqual(survivor);
    const { rows } = await runSql<{ handle: string }>(
      `select handle from member_identities where id = $1`, [survivor.id]);
    expect(rows[0]?.handle).toBe("Fresh");
    // A metadata refresh is not an identity change.
    expect(await generation(teamId)).toBe(afterUnlink);
  });

  // THE CONTROL for the test above: the same surviving row with a fence beside it. This is the
  // state a fence written during that unlink would leave, and it is why none may be: the suppression
  // check runs before the existing-row branch, so the survivor's own refresh is refused every time.
  it("would refuse the survivor's refresh forever if a fence sat beside it (AC-PA-17b control)", async () => {
    const { teamId, memberId } = await seedTeam();
    const email = await rosterEmail(teamId, memberId);
    const survivor = await legacyVariant(teamId, memberId, "U0ABC", "Stale");
    await runSql(
      `insert into member_identity_suppressions (team_id, provider, external_id) values ($1, 'slack', 'u0abc')`,
      [teamId]);

    expect(await syncSlackIdentities(db(), teamId, [{ id: "U0ABC", displayName: "Fresh", email }]))
      .toMatchObject({ scanned: 1, mapped: 0, skipped: 1 });
    const { rows } = await runSql<{ handle: string }>(
      `select handle from member_identities where id = $1`, [survivor.id]);
    expect(rows[0]?.handle).toBe("Stale");
  });

  it("leaves linking unchanged: refused while variants are live, possible once the extra one is unlinked", async () => {
    const { teamId, memberId } = await seedTeam();
    const survivor = await legacyVariant(teamId, memberId, "U0ABC");
    await legacyVariant(teamId, memberId, "u0abc");
    const before = await generation(teamId);

    // `setMemberIdentity` does not pick a variant, even for an explicit admin link.
    const refused = await setMemberIdentity(db(), teamId, memberId,
      { provider: "slack", externalId: "U0ABC", handle: "Named" }, { explicit: true });
    expect(refused).toMatchObject({ conflict: true, created: false, updated: false });
    expect(refused.note).toContain("multiple live case variants");
    expect(await liveSpellings(teamId)).toEqual(["U0ABC", "u0abc"]);
    expect(await generation(teamId)).toBe(before);

    // The way out is the unlink, by exact spelling — after which the same link is an ordinary one.
    await removeMemberIdentity(db(), teamId, { provider: "slack", externalId: "u0abc" });
    const linked = await setMemberIdentity(db(), teamId, memberId,
      { provider: "slack", externalId: "U0ABC", handle: "Named" }, { explicit: true });
    expect(linked).toMatchObject({ conflict: false, updated: true });
    expect(await mapping(teamId, "U0ABC")).toEqual(survivor);
    expect(await liveSpellings(teamId)).toEqual(["U0ABC"]);
  });
});
