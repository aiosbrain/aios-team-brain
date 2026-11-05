import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * AIO-1167 R86 F2 — an audience NARROWING advances the durable revocation barrier (real Postgres).
 *
 * Spec (Astra R86 adjudication F2). The sanctioned access writers that remove an audience edge —
 * `removeMemberFromGroup`, `revokeProjectFromGroup`, the repair `revokeUnsanctionedSystemEdge`, a
 * deliberate posture move (`writeInviteDefaultMembership` reconcile) and a singleton's stray-member
 * prune — advance `team_authorization_epochs` in the SAME transaction as the deletion, before success
 * is reported. So a protected answer or an active protected stream captured at the old epoch stops being
 * readable or publishable for every reader, whichever process serves it. Refusals and no-ops advance
 * nothing; an epoch-write failure rolls the deletion back; the barrier is conservative (it advances even
 * where an overlapping grant keeps the member's direct access); another team is untouched. Against a
 * concurrent protected output publication both commit orders are safe: the publication waits for, or is
 * waited on by, the barrier — and is then either refused or unreadable.
 */

const epochHook = vi.hoisted(() => ({
  fail: false,
  hold: null as null | { entered: () => void; release: Promise<void> },
}));
vi.mock("@/lib/access/authorization-epoch", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/access/authorization-epoch")>();
  return {
    ...real,
    advanceAuthorizationEpoch: async (teamId: string) => {
      if (epochHook.fail) throw new Error("authorization epoch write failed");
      const epoch = await real.advanceAuthorizationEpoch(teamId);
      const hold = epochHook.hold;
      if (hold) {
        epochHook.hold = null;
        hold.entered(); // advanced, inside the narrowing's still-open transaction
        await hold.release;
      }
      return epoch;
    },
  };
});

import { revocationEpoch } from "@/lib/access/authorization-epoch";
import { visibleItemIds } from "@/lib/access/enforce";
import {
  addMemberToGroup, createGroup, grantProjectToGroup, removeMemberFromGroup, revokeProjectFromGroup,
  writeInviteDefaultMembership,
} from "@/lib/access/groups";
import { appendMessage, getConversation } from "@/lib/chat/store";
import { getPool } from "@/lib/db/pg/pool";
import { backfillTeamContext } from "@/lib/projects/context/backfill";
import { QueryContextAuthorizationChangedError } from "@/lib/query/context-authorization";
import { withOutputPublication } from "@/lib/query/output-provenance";
import { createRun, flushPartial } from "@/lib/query/turn-runs";
import { db, ingest, placeMemberByTier, seedTeam, type Seed } from "./helpers";

beforeEach(() => {
  epochHook.fail = false;
  epochHook.hold = null;
});

async function member(seed: Seed, role = "member"): Promise<string> {
  const { data } = await db().from("members").insert({
    team_id: seed.teamId, email: `${randomUUID()}@t.local`, display_name: "M",
    actor_handle: `m-${randomUUID().slice(0, 10)}`, role, tier: "team", status: "active",
  }).select("id").single();
  const id = data!.id as string;
  await placeMemberByTier(seed.teamId, id, "team");
  return id;
}

async function group(seed: Seed, admin: string): Promise<string> {
  const g = await createGroup(db(), seed.teamId, `g-${randomUUID().slice(0, 8)}`, "G", admin);
  expect(g.ok).toBe(true);
  return g.groupId!;
}

/** A restricted project holding one Drive-like item, granted to `groups`. */
async function restricted(seed: Seed, admin: string, groups: string[]) {
  const item = await ingest(seed, { path: `p-${randomUUID().slice(0, 8)}.md`, body: "zephyr ledger", access: "team", project: "src" });
  await backfillTeamContext(db(), seed.teamId);
  const { data: proj } = await db().from("projects")
    .insert({ team_id: seed.teamId, slug: `r-${randomUUID().slice(0, 8)}`, name: "R", kind: "initiative" })
    .select("id").single();
  const projectId = proj!.id as string;
  for (const g of groups) expect((await grantProjectToGroup(db(), seed.teamId, projectId, g, admin)).ok).toBe(true);
  const { data: unit } = await db().from("project_context_units").select("id").eq("source_item_id", item.id).single();
  await db().from("project_context_memberships").update({ valid_to: new Date().toISOString() })
    .eq("context_unit_id", unit!.id).is("valid_to", null);
  await db().from("project_context_memberships")
    .insert({ team_id: seed.teamId, project_id: projectId, context_unit_id: unit!.id, method: "manual" });
  return { itemId: item.id, projectId };
}

async function world() {
  const seed = await seedTeam();
  await backfillTeamContext(db(), seed.teamId);
  const admin = await member(seed, "admin");
  const viewer = await member(seed);
  const g1 = await group(seed, admin);
  await addMemberToGroup(db(), seed.teamId, g1, viewer, admin);
  const { itemId, projectId } = await restricted(seed, admin, [g1]);
  return { seed, admin, viewer, g1, itemId, projectId };
}

/** A protected answer, published at the team's current epoch through the real publication gate. */
async function protectedAnswer(seed: Seed, memberId: string, text: string) {
  const owner = { teamId: seed.teamId, memberId };
  const { data } = await db().from("conversations")
    .insert({ team_id: seed.teamId, member_id: memberId, title: "t" }).select("id").single();
  const convo = (data as { id: string }).id;
  const provenance = { epoch: await revocationEpoch(db(), seed.teamId) };
  await withOutputPublication(seed.teamId, provenance, () =>
    appendMessage(db(), owner, convo, "assistant", text, {}, provenance));
  const readable = async () => (await getConversation(db(), owner, convo))!.messages.map((m) => m.content);
  return { owner, convo, provenance, readable };
}

const epochOf = async (teamId: string) => Number((await getPool().query<{ epoch: string }>(
  `select coalesce((select epoch from team_authorization_epochs where team_id=$1), 1)::text as epoch`, [teamId])).rows[0].epoch);
const membership = async (seed: Seed, groupId: string, memberId: string) => (await getPool().query(
  `select 1 from group_members where team_id=$1 and group_id=$2 and member_id=$3`, [seed.teamId, groupId, memberId])).rows.length;
const edge = async (seed: Seed, projectId: string, groupId: string) => (await getPool().query(
  `select 1 from project_groups where team_id=$1 and project_id=$2 and group_id=$3`, [seed.teamId, projectId, groupId])).rows.length;
const audits = async (seed: Seed, action: string) => (await getPool().query(
  `select 1 from audit_log where team_id=$1 and action=$2`, [seed.teamId, action])).rows.length;

async function waitsOnLock(pattern: string): Promise<boolean> {
  for (let tries = 0; tries < 400; tries++) {
    const { rows } = await getPool().query<{ n: number }>(
      `select count(*)::int as n from pg_stat_activity
        where datname=current_database() and wait_event_type='Lock' and query ilike $1`, [pattern]);
    if (rows[0].n > 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

describe("every sanctioned narrowing advances the barrier with the deletion", () => {
  it("member removal and project revoke: the protected answer and the active stream stop; another team is untouched", async () => {
    const w = await world();
    const other = await world();
    const answer = await protectedAnswer(w.seed, w.viewer, "kestrel protected answer");
    const otherAnswer = await protectedAnswer(other.seed, other.viewer, "ibis protected answer");
    const run = (await createRun(db(), answer.owner, answer.convo, "q", answer.provenance))!.id;
    expect(await answer.readable()).toEqual(["kestrel protected answer"]);
    const before = await epochOf(w.seed.teamId);

    expect(await removeMemberFromGroup(db(), w.seed.teamId, w.g1, w.viewer, w.admin)).toEqual({ ok: true });
    expect(await epochOf(w.seed.teamId), "an independent reader sees the advanced barrier").toBe(before + 1);
    expect(await answer.readable()).toEqual([]);
    await expect(flushPartial(db(), run, "more", { teamId: w.seed.teamId, provenance: answer.provenance }))
      .rejects.toBeInstanceOf(QueryContextAuthorizationChangedError);
    expect(await otherAnswer.readable(), "another team's barrier and answer are untouched").toEqual(["ibis protected answer"]);

    // The project revoke advances it again.
    const again = await protectedAnswer(w.seed, w.admin, "osprey protected answer");
    expect(await revokeProjectFromGroup(db(), w.seed.teamId, w.projectId, w.g1, { kind: "member", memberId: w.admin }))
      .toEqual({ ok: true, revoked: true });
    expect(await epochOf(w.seed.teamId)).toBe(before + 2);
    expect(await again.readable()).toEqual([]);
  });

  it("a deliberate posture move (team → external) is a narrowing too", async () => {
    const w = await world();
    const before = await epochOf(w.seed.teamId);
    expect(await writeInviteDefaultMembership(db(), w.seed.teamId, w.viewer, "external", { reconcile: true })).toEqual({ ok: true });
    expect(await epochOf(w.seed.teamId)).toBe(before + 1);
  });

  it("overlapping grants: the conservative barrier advances while direct access remains", async () => {
    const w = await world();
    const g2 = await group(w.seed, w.admin);
    await addMemberToGroup(db(), w.seed.teamId, g2, w.viewer, w.admin);
    expect((await grantProjectToGroup(db(), w.seed.teamId, w.projectId, g2, w.admin)).ok).toBe(true);
    const before = await epochOf(w.seed.teamId);

    expect((await removeMemberFromGroup(db(), w.seed.teamId, w.g1, w.viewer, w.admin)).ok).toBe(true);
    expect(await epochOf(w.seed.teamId)).toBe(before + 1);
    const visible = await visibleItemIds(db(), { teamId: w.seed.teamId, memberId: w.viewer });
    expect(visible.ids.has(w.itemId), "still granted through the second group").toBe(true);
  });

  it("refusals and no-ops advance nothing", async () => {
    const w = await world();
    const stranger = await member(w.seed); // (creating a member is itself a roster change: baseline after)
    const g2 = await group(w.seed, w.admin);
    const before = await epochOf(w.seed.teamId);
    expect((await removeMemberFromGroup(db(), w.seed.teamId, randomUUID(), w.viewer, w.admin)).ok).toBe(false);
    expect((await removeMemberFromGroup(db(), w.seed.teamId, w.g1, stranger, w.admin)).ok).toBe(true); // not a member: no-op
    expect(await revokeProjectFromGroup(db(), w.seed.teamId, w.projectId, g2, { kind: "member", memberId: w.admin }))
      .toEqual({ ok: true, revoked: false });
    expect(await epochOf(w.seed.teamId)).toBe(before);
  });

  it("an epoch-write failure rolls the deletion back and reports failure — no audit, no epoch", async () => {
    const w = await world();
    const before = await epochOf(w.seed.teamId);
    const removedAudits = await audits(w.seed, "access.member_removed");
    epochHook.fail = true;

    expect((await removeMemberFromGroup(db(), w.seed.teamId, w.g1, w.viewer, w.admin)).ok).toBe(false);
    expect(await membership(w.seed, w.g1, w.viewer), "the removal rolled back").toBe(1);
    expect((await revokeProjectFromGroup(db(), w.seed.teamId, w.projectId, w.g1, { kind: "member", memberId: w.admin })).ok).toBe(false);
    expect(await edge(w.seed, w.projectId, w.g1), "the revoke rolled back").toBe(1);
    expect(await epochOf(w.seed.teamId)).toBe(before);
    expect(await audits(w.seed, "access.member_removed")).toBe(removedAudits);
    expect(await audits(w.seed, "access.project_revoked")).toBe(0);
  });
});

describe("a narrowing against a concurrent protected output publication, both commit orders", () => {
  it("publication first: the narrowing waits for it, then the published answer is unreadable", async () => {
    const w = await world();
    const owner = { teamId: w.seed.teamId, memberId: w.viewer };
    const { data } = await db().from("conversations").insert({ team_id: w.seed.teamId, member_id: w.viewer, title: "t" }).select("id").single();
    const convo = (data as { id: string }).id;
    const provenance = { epoch: await revocationEpoch(db(), w.seed.teamId) };
    let publishing!: () => void;
    const holding = new Promise<void>((resolve) => { publishing = resolve; });
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => { finish = resolve; });

    const publication = withOutputPublication(w.seed.teamId, provenance, async () => {
      publishing(); // the epoch share lock is held
      await finished;
      return appendMessage(db(), owner, convo, "assistant", "heron protected answer", {}, provenance);
    });
    await holding;
    const narrowing = removeMemberFromGroup(db(), w.seed.teamId, w.g1, w.viewer, w.admin);
    expect(await waitsOnLock("%team_authorization_epochs%do update%"), "the barrier waited on the publication").toBe(true);
    finish();
    await publication;
    expect((await narrowing).ok).toBe(true);
    expect((await getConversation(db(), owner, convo))!.messages).toEqual([]);
  });

  it("narrowing first: the publication waits for the barrier, then is refused and writes nothing", async () => {
    const w = await world();
    const owner = { teamId: w.seed.teamId, memberId: w.viewer };
    const { data } = await db().from("conversations").insert({ team_id: w.seed.teamId, member_id: w.viewer, title: "t" }).select("id").single();
    const convo = (data as { id: string }).id;
    const provenance = { epoch: await revocationEpoch(db(), w.seed.teamId) };
    let entered!: () => void;
    const advanced = new Promise<void>((resolve) => { entered = resolve; });
    let open!: () => void;
    epochHook.hold = { entered: () => entered(), release: new Promise<void>((resolve) => { open = resolve; }) };

    const narrowing = removeMemberFromGroup(db(), w.seed.teamId, w.g1, w.viewer, w.admin);
    await advanced; // the barrier is advanced inside the still-open narrowing transaction
    const publication = withOutputPublication(w.seed.teamId, provenance, () =>
      appendMessage(db(), owner, convo, "assistant", "plover protected answer", {}, provenance));
    expect(await waitsOnLock("%team_authorization_epochs%"), "the publication waited on the barrier").toBe(true);
    open();
    expect((await narrowing).ok).toBe(true);
    await expect(publication).rejects.toBeInstanceOf(QueryContextAuthorizationChangedError);
    const { rows } = await getPool().query(`select 1 from chat_messages where conversation_id=$1`, [convo]);
    expect(rows).toEqual([]);
  });
});
