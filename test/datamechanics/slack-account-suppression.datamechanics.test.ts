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
