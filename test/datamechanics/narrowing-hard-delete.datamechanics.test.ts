import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

/**
 * AIO-1167 R93 #1 — an audience narrowing and a hard member deletion share ONE team identity boundary
 * (real Postgres, the real access writers and `deleteMember`, deterministic barriers + blocker evidence).
 *
 * A hard delete takes identity boundary → identity row → epoch `for no key update` → member `for update`
 * (R92). A narrowing used to take member `for no key update` → edge → epoch with no boundary, so a
 * narrowing holding the member while a hard delete held the epoch was a 40P01 cycle. The shared narrowing
 * helper now takes the SAME advisory boundary first: whichever arrives second waits there, holding nothing
 * the other needs. Both orders finish durably; ordinary and builtin/posture narrowing share it; a no-op
 * narrowing advances nothing and an epoch failure still rolls the deletion back.
 */

const epochHook = vi.hoisted(() => ({
  fail: false,
  hold: null as null | { entered: (pid: number) => void; release: Promise<void> },
}));
vi.mock("@/lib/access/authorization-epoch", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/access/authorization-epoch")>();
  return {
    ...real,
    advanceAuthorizationEpoch: async (teamId: string) => {
      if (epochHook.fail) throw new Error("authorization epoch write failed");
      const hold = epochHook.hold;
      if (hold) {
        epochHook.hold = null;
        const { runSql } = await import("@/lib/db/pg/pool");
        hold.entered((await runSql<{ pid: number }>("select pg_backend_pid() as pid", [])).rows[0].pid);
        await hold.release; // the narrowing holds its member lock and deleted edge, before the epoch
      }
      return real.advanceAuthorizationEpoch(teamId);
    },
  };
});

import { createGroup, addMemberToGroup, removeMemberFromGroup, writeInviteDefaultMembership } from "@/lib/access/groups";
import { deleteMember } from "@/lib/admin/members";
import { getPool, runSql } from "@/lib/db/pg/pool";
import { db, placeMemberByTier, seedTeam } from "./helpers";

const TIMEOUT = 60_000;

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
async function eventually(check: () => Promise<boolean>): Promise<boolean> {
  for (let tries = 0; tries < 400; tries++) {
    if (await check()) return true;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  return false;
}
/** Some backend is waiting at the team identity ADVISORY boundary, blocked by `holder`. */
const waitsAtBoundary = (holder: number) => eventually(async () => (await getPool().query<{ n: number }>(
  `select count(*)::int as n from pg_stat_activity
    where wait_event_type='Lock' and query ilike '%pg_advisory_xact_lock(hashtextextended%'
      and $1 = any(pg_blocking_pids(pid))`, [holder])).rows[0].n > 0);
/** Is the row lockable right now (`nowait`)? */
async function lockable(sql: string, params: unknown[]): Promise<boolean> {
  const probe = await getPool().connect();
  try {
    await probe.query("begin");
    await probe.query(`${sql} nowait`, params);
    return true;
  } catch (error) {
    if ((error as { code?: string }).code === "55P03") return false;
    throw error;
  } finally {
    await probe.query("rollback");
    probe.release();
  }
}
const epochOf = async (teamId: string) => Number((await getPool().query<{ e: string }>(
  `select coalesce((select epoch from team_authorization_epochs where team_id=$1), 1)::text as e`, [teamId])).rows[0].e);

async function world() {
  const seed = await seedTeam();
  await db().from("members").update({ role: "admin" }).eq("id", seed.memberId).eq("team_id", seed.teamId);
  const email = `t-${randomUUID().slice(0, 8)}@example.com`;
  const { data } = await db().from("members").insert({
    team_id: seed.teamId, email, display_name: "Target", actor_handle: `t-${randomUUID().slice(0, 8)}`,
    role: "member", tier: "team", status: "active",
  }).select("id").single();
  const memberId = (data as { id: string }).id;
  await placeMemberByTier(seed.teamId, memberId, "team");
  const group = await createGroup(db(), seed.teamId, `g-${randomUUID().slice(0, 8)}`, "G", seed.memberId);
  expect((await addMemberToGroup(db(), seed.teamId, group.groupId!, memberId, seed.memberId)).ok).toBe(true);
  const memberExists = async () => (await getPool().query(`select 1 from members where id=$1`, [memberId])).rows.length > 0;
  const inGroup = async () => (await getPool().query(
    `select 1 from group_members where group_id=$1 and member_id=$2`, [group.groupId, memberId])).rows.length > 0;
  return { seed, email, memberId, groupId: group.groupId!, memberExists, inGroup };
}

/** Run `body`; on every path release the barriers and join every started operation. */
async function joined<T>(releases: (() => void)[], operations: Promise<unknown>[], body: () => Promise<T>): Promise<T> {
  try {
    return await body();
  } finally {
    for (const release of releases) release();
    await Promise.allSettled(operations);
  }
}

describe("R93: narrowing and hard deletion meet at the identity boundary, both orders", () => {
  it.each([
    ["ordinary group removal", "group"],
    ["builtin posture move (team → external)", "posture"],
  ] as const)("removal first (%s): the hard delete waits at the boundary holding no epoch; both finish", { timeout: TIMEOUT }, async (_name, kind) => {
    const w = await world();
    const before = await epochOf(w.seed.teamId);
    const entered = deferred<number>();
    const release = deferred();
    epochHook.hold = { entered: entered.resolve, release: release.promise };
    const operations: Promise<unknown>[] = [];
    const narrowing = kind === "group"
      ? removeMemberFromGroup(db(), w.seed.teamId, w.groupId, w.memberId, w.seed.memberId)
      : writeInviteDefaultMembership(db(), w.seed.teamId, w.memberId, "external", { reconcile: true });
    operations.push(narrowing);
    await joined([release.resolve], operations, async () => {
      const narrowingPid = await entered.promise; // member locked + edge deleted, epoch not yet taken
      const deletion = deleteMember(db(), w.seed.teamId, w.email, { hard: true });
      operations.push(deletion);
      expect(await waitsAtBoundary(narrowingPid), "the hard delete waits at the identity boundary").toBe(true);
      expect(await lockable(`select epoch from team_authorization_epochs where team_id=$1 for no key update`, [w.seed.teamId]),
        "it holds no epoch lock while it waits").toBe(true);
      release.resolve();
      await expect(narrowing).resolves.toEqual({ ok: true });
      await expect(deletion).resolves.toMatchObject({ deleted: true, mode: "hard", id: w.memberId });
    });
    expect(await w.memberExists()).toBe(false);
    expect(await epochOf(w.seed.teamId), "both the narrowing and the deletion advanced the barrier").toBeGreaterThan(before + 1);
  });

  it("delete first: the narrowing waits at the boundary before any member/edge lock; then the absent-edge no-op", { timeout: TIMEOUT }, async () => {
    const w = await world();
    const atEpoch = deferred<number>();
    const release = deferred();
    const operations: Promise<unknown>[] = [];
    const deletion = deleteMember(db(), w.seed.teamId, w.email, {
      hard: true,
      concurrencyHooks: {
        afterEpochLock: async () => {
          atEpoch.resolve((await runSql<{ pid: number }>("select pg_backend_pid() as pid", [])).rows[0].pid);
          await release.promise; // identity row + epoch held; no member row yet
        },
      },
    });
    operations.push(deletion);
    let epochAfterDelete = 0;
    await joined([release.resolve], operations, async () => {
      const deletePid = await atEpoch.promise;
      const narrowing = removeMemberFromGroup(db(), w.seed.teamId, w.groupId, w.memberId, w.seed.memberId);
      operations.push(narrowing);
      expect(await waitsAtBoundary(deletePid), "the narrowing waits at the identity boundary").toBe(true);
      expect(await lockable(`select id from members where id=$1 for no key update`, [w.memberId]),
        "the narrowing holds no member lock while it waits").toBe(true);
      expect(await w.inGroup(), "nor has it touched the edge").toBe(true);
      release.resolve();
      await expect(deletion).resolves.toMatchObject({ deleted: true, mode: "hard" });
      epochAfterDelete = await epochOf(w.seed.teamId);
      // The edge went with the member (cascade): the narrowing is the existing absent-edge outcome.
      await expect(narrowing).resolves.toEqual({ ok: true });
    });
    expect(await w.memberExists()).toBe(false);
    expect(await epochOf(w.seed.teamId), "an absent edge narrows nothing: no further advance").toBe(epochAfterDelete);
  });

  it("controls: a no-op narrowing advances nothing; an epoch failure rolls the removal back", { timeout: TIMEOUT }, async () => {
    const w = await world();
    const stranger = await createGroup(db(), w.seed.teamId, `s-${randomUUID().slice(0, 8)}`, "S", w.seed.memberId);
    const before = await epochOf(w.seed.teamId);
    expect(await removeMemberFromGroup(db(), w.seed.teamId, stranger.groupId!, w.memberId, w.seed.memberId)).toEqual({ ok: true });
    expect(await epochOf(w.seed.teamId)).toBe(before);
    epochHook.fail = true;
    try {
      expect((await removeMemberFromGroup(db(), w.seed.teamId, w.groupId, w.memberId, w.seed.memberId)).ok).toBe(false);
    } finally {
      epochHook.fail = false;
    }
    expect(await w.inGroup(), "rolled back").toBe(true);
    expect(await epochOf(w.seed.teamId)).toBe(before);
  });
});
