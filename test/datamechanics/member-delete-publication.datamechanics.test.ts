import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

/**
 * AIO-1167 R92 #2 — member deactivation/deletion never deadlocks a protected answer publication
 * (real Postgres, real `deleteMember`, real `withOutputPublication` + `appendMessage`; deterministic
 * barriers and lock evidence, no sleeps, no retry-as-success).
 *
 * A protected answer holds the authorization epoch `for share` and then needs a foreign-key KEY SHARE on
 * its member's row. A soft deactivation now holds that member `for no key update` (compatible with the key
 * share) while its trigger waits for the epoch; a hard delete takes the identity-authority row and the
 * epoch exclusively BEFORE its member `for update`, so it waits on a publication without holding any
 * member lock. Either way both orders complete: publication first → both commit, the answer keeps its
 * original epoch and is suppressed; deactivation first → the old-epoch publication is refused and leaves
 * no answer. Controls: absent member, last-admin refusal, epoch advancement and audit.
 */

import { revocationEpoch } from "@/lib/access/authorization-epoch";
import { deleteMember } from "@/lib/admin/members";
import { appendMessage, getConversation } from "@/lib/chat/store";
import { getPool, runSql, withTransaction } from "@/lib/db/pg/pool";
import { QueryContextAuthorizationChangedError } from "@/lib/query/context-authorization";
import { withOutputPublication } from "@/lib/query/output-provenance";
import { db, placeMemberByTier, seedTeam } from "./helpers";

const TIMEOUT = 60_000;

function barrier() {
  let fire!: () => void;
  const wait = new Promise<void>((resolve) => { fire = resolve; });
  return { wait, fire };
}
async function eventually(check: () => Promise<boolean>): Promise<boolean> {
  for (let tries = 0; tries < 400; tries++) {
    if (await check()) return true;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  return false;
}
const blockedOn = (pid: number) => eventually(async () => (await getPool().query<{ n: number }>(
  `select count(*)::int as n from pg_stat_activity where $1 = any(pg_blocking_pids(pid))`, [pid])).rows[0].n > 0);
const waitsIn = (pattern: string) => eventually(async () => (await getPool().query<{ n: number }>(
  `select count(*)::int as n from pg_stat_activity
    where datname=current_database() and wait_event_type='Lock' and query ilike $1`, [pattern])).rows[0].n > 0);
/** Is any conflicting member lock (one that blocks a FK key share) held on the row? */
async function keyShareBlocked(memberId: string): Promise<boolean> {
  const probe = await getPool().connect();
  try {
    await probe.query("begin");
    await probe.query(`select id from members where id=$1 for key share nowait`, [memberId]);
    return false;
  } catch (error) {
    if ((error as { code?: string }).code === "55P03") return true;
    throw error;
  } finally {
    await probe.query("rollback");
    probe.release();
  }
}
const epochOf = async (teamId: string) => Number((await getPool().query<{ e: string }>(
  `select coalesce((select epoch from team_authorization_epochs where team_id=$1), 1)::text as e`, [teamId])).rows[0].e);

/** A team with a second admin (so the last-admin guard passes) and a target member with a conversation. */
async function world(role: "member" | "admin" = "member") {
  const seed = await seedTeam();
  await db().from("members").update({ role: "admin" }).eq("id", seed.memberId).eq("team_id", seed.teamId);
  const email = `target-${randomUUID().slice(0, 8)}@example.com`;
  const { data } = await db().from("members").insert({
    team_id: seed.teamId, email, display_name: "Target", actor_handle: `t-${randomUUID().slice(0, 8)}`,
    role, tier: "team", status: "active",
  }).select("id").single();
  const memberId = (data as { id: string }).id;
  await placeMemberByTier(seed.teamId, memberId, "team");
  const { rows } = await getPool().query<{ id: string }>(
    `insert into conversations(team_id, member_id, title) values ($1,$2,'t') returning id`, [seed.teamId, memberId]);
  return { seed, email, memberId, convo: rows[0].id };
}
type W = Awaited<ReturnType<typeof world>>;

/** A protected answer for the target's conversation, paused right after it share-locked the epoch. */
async function heldAnswer(w: W) {
  const owner = { teamId: w.seed.teamId, memberId: w.memberId };
  const provenance = { epoch: await revocationEpoch(db(), w.seed.teamId) };
  const holding = barrier();
  const release = barrier();
  let pid = 0;
  const done = withOutputPublication(w.seed.teamId, provenance, async () => {
    pid = (await runSql<{ pid: number }>("select pg_backend_pid() as pid", [])).rows[0].pid;
    holding.fire();
    await release.wait;
    return appendMessage(db(), owner, w.convo, "assistant", "sablewing protected answer", {}, provenance);
  });
  done.catch(() => undefined);
  await Promise.race([holding.wait, done.then(() => { throw new Error("answer finished before holding the epoch"); })]);
  return { done, release: release.fire, pid: () => pid, provenance };
}

/** Run `body`; on every path release the barriers and join every started operation. */
async function settled<T>(releases: (() => void)[], started: Promise<unknown>[], body: () => Promise<T>): Promise<T> {
  try {
    return await body();
  } finally {
    for (const release of releases) release();
    await Promise.allSettled(started);
  }
}

const messages = async (convo: string) => (await getPool().query<{ e: string }>(
  `select context_authorization_epoch::text as e from chat_messages where conversation_id=$1`, [convo])).rows;

/**
 * Deletion FIRST: the deletion runs in an outer transaction paused before commit; an old-epoch protected
 * publication is started against it and must wait, then be refused with no answer row. Every started
 * operation is in ONE mutable registry, pushed the moment it is created, so cleanup joins exactly what
 * started; `inject` throws inside the schedule (before the publication starts, or right after it is
 * blocked) to prove cleanup releases the blocker, settles every started operation before the failure is
 * reported, and lets no transaction escape.
 */
async function deletionFirst(w: W, hard: boolean, inject?: "before-publication" | "after-publication"): Promise<void> {
  const provenance = { epoch: await revocationEpoch(db(), w.seed.teamId) };
  const inside = barrier();
  const commit = barrier();
  const operations: Promise<unknown>[] = [];
  const state = { deletionSettled: false, publicationStarted: false, publicationSettled: false };
  const deletion = withTransaction(async () => {
    const result = await deleteMember(db(), w.seed.teamId, w.email, hard ? { hard: true } : {});
    inside.fire();
    await commit.wait;
    return result;
  });
  operations.push(deletion);
  void deletion.then(() => { state.deletionSettled = true; }, () => { state.deletionSettled = true; });
  let publication: Promise<unknown> | null = null;
  try {
    await settled([commit.fire], operations, async () => {
      await inside.wait;
      if (inject === "before-publication") throw new Error("r93-injected-before-publication");
      publication = withOutputPublication(w.seed.teamId, provenance, () =>
        appendMessage(db(), { teamId: w.seed.teamId, memberId: w.memberId }, w.convo, "assistant", "late answer", {}, provenance));
      operations.push(publication); // registered BEFORE the next await
      state.publicationStarted = true;
      void publication.then(() => { state.publicationSettled = true; }, () => { state.publicationSettled = true; });
      expect(await waitsIn("%team_authorization_epochs%"), "the publication waits on the deletion's epoch lock").toBe(true);
      if (inject === "after-publication") throw new Error("r93-injected-after-publication");
      commit.fire();
      await expect(deletion).resolves.toMatchObject({ deleted: true, mode: hard ? "hard" : "soft" });
      await expect(publication).rejects.toBeInstanceOf(QueryContextAuthorizationChangedError);
    });
  } finally {
    // Cleanup released the blocker and joined EVERY operation that started — before returning.
    expect(state.deletionSettled, "the blocking deletion was released and settled").toBe(true);
    if (state.publicationStarted) expect(state.publicationSettled, "the blocked publication settled first").toBe(true);
    const { rows } = await getPool().query<{ n: number }>(
      `select count(*)::int as n from pg_stat_activity where datname=current_database() and state like 'idle in transaction%'`);
    expect(rows[0].n, "no transaction escaped").toBe(0);
  }
  expect(await messages(w.convo)).toEqual([]);
}

describe("R92 #2: member deletion vs a protected answer publication, both orders", () => {
  it("soft, publication first: the deactivation waits on the epoch WITHOUT blocking the key share; both commit", { timeout: TIMEOUT }, async () => {
    const w = await world();
    const before = await epochOf(w.seed.teamId);
    const answer = await heldAnswer(w);
    const deactivation = deleteMember(db(), w.seed.teamId, w.email);
    deactivation.catch(() => undefined);
    await settled([answer.release], [answer.done, deactivation], async () => {
      expect(await blockedOn(answer.pid()), "the deactivation waits on the answer's epoch share").toBe(true);
      expect(await keyShareBlocked(w.memberId), "it holds no lock that blocks the answer's key share").toBe(false);
      answer.release();
      await expect(answer.done).resolves.toBeTruthy();
      await expect(deactivation).resolves.toMatchObject({ deleted: true, mode: "soft", id: w.memberId });
    });
    expect(await messages(w.convo)).toEqual([{ e: String(answer.provenance.epoch) }]);
    expect(await epochOf(w.seed.teamId), "the trigger advanced the epoch").toBeGreaterThan(before);
    const { rows } = await getPool().query<{ status: string }>(`select status from members where id=$1`, [w.memberId]);
    expect(rows[0].status).toBe("disabled");
    const thread = await getConversation(db(), { teamId: w.seed.teamId, memberId: w.memberId }, w.convo);
    expect(thread?.messages ?? [], "the old-epoch answer is suppressed").toEqual([]);
  });

  it("soft, deactivation first: the old-epoch publication waits, then is refused and leaves no answer", { timeout: TIMEOUT }, async () => {
    await deletionFirst(await world(), false);
  });

  it("hard, publication first: the delete waits on the epoch BEFORE any member lock; both commit", { timeout: TIMEOUT }, async () => {
    const w = await world();
    const answer = await heldAnswer(w);
    const deletion = deleteMember(db(), w.seed.teamId, w.email, { hard: true });
    deletion.catch(() => undefined);
    await settled([answer.release], [answer.done, deletion], async () => {
      expect(await blockedOn(answer.pid()), "the hard delete waits on the answer's epoch share").toBe(true);
      expect(await waitsIn("%team_authorization_epochs where team_id=$1 for no key update%"),
        "waiting at its exclusive epoch lock").toBe(true);
      expect(await keyShareBlocked(w.memberId), "holding no member lock while it waits").toBe(false);
      answer.release();
      await expect(answer.done).resolves.toBeTruthy();
      await expect(deletion).resolves.toMatchObject({ deleted: true, mode: "hard", id: w.memberId });
    });
    const { rows } = await getPool().query(`select 1 from members where id=$1`, [w.memberId]);
    expect(rows).toEqual([]);
  });

  it("hard, delete first: the old-epoch publication waits, then is refused and leaves no answer", { timeout: TIMEOUT }, async () => {
    await deletionFirst(await world(), true);
  });

  it.each([
    [false, "after-publication"], [true, "after-publication"], [false, "before-publication"], [true, "before-publication"],
  ] as const)("cleanup (hard=%s, failure %s): the blocker is released and EVERY started operation settles before the failure is reported", { timeout: TIMEOUT }, async (hard, inject) => {
    const w = await world();
    const probe = await deletionFirst(w, hard, inject).then(() => null, (error: unknown) => error);
    expect(String(probe)).toContain(`r93-injected-${inject}`); // the ORIGINAL failure is what is reported
  });

  it("controls: absent member, last-admin refusal, epoch advancement and audit outcomes", { timeout: TIMEOUT }, async () => {
    const w = await world();
    expect(await deleteMember(db(), w.seed.teamId, "nobody@example.com")).toEqual({ deleted: false, reason: "absent" });
    expect(await deleteMember(db(), w.seed.teamId, "nobody@example.com", { hard: true })).toEqual({ deleted: false, reason: "absent" });
    const { rows: me } = await getPool().query<{ email: string }>(`select email from members where id=$1`, [w.seed.memberId]);
    // The seed admin is the only admin: refused, soft and hard.
    expect(await deleteMember(db(), w.seed.teamId, me[0].email)).toEqual({ deleted: false, reason: "last-admin" });
    expect(await deleteMember(db(), w.seed.teamId, me[0].email, { hard: true })).toEqual({ deleted: false, reason: "last-admin" });
    const before = await epochOf(w.seed.teamId);
    expect(await deleteMember(db(), w.seed.teamId, w.email)).toMatchObject({ deleted: true, mode: "soft" });
    expect(await epochOf(w.seed.teamId)).toBeGreaterThan(before);
    const audits = (await getPool().query<{ action: string }>(
      `select action from audit_log where team_id=$1 and target_id=$2 order by created_at`, [w.seed.teamId, w.memberId])).rows;
    expect(audits.map((a) => a.action)).toEqual(["member.disabled"]);
  });
});
