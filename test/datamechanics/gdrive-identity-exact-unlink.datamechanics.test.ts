import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * AIO-1167 final review A5 — a recognized legacy Google `author-email:` spelling is unlinked by its EXACT
 * persisted bytes, through the real holder/revision-fenced Admin action and shared writer (real
 * Postgres). Outer ASCII/Unicode whitespace, whitespace after the prefix, mixed case and a non-ASCII
 * address are removed as themselves: only that row goes, the tombstone/audit/revision belong to that
 * exact key, and every other spelling and history stays byte-for-byte. A canonical-equivalent request
 * never removes a different stored spelling; stale/missing observations, the wrong holder, another team
 * and a non-admin are refused without effects. New-link validation, Slack and opaque Google ids keep
 * their semantics. Only the session guard and Next's request-scoped hooks are stubbed.
 */

const guard = vi.hoisted(() => ({ session: null as null | { teamId: string; memberId: string } }));
vi.mock("@/lib/auth/guard", () => ({ requireTeamAdmin: vi.fn(async () => guard.session) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: vi.fn(),
}));

import { getPool } from "@/lib/db/pg/pool";
import { linkMemberIdentity, unlinkMemberIdentity } from "@/app/t/[team]/admin/members/actions";
import { removeMemberIdentity, setMemberIdentity } from "@/lib/identity/member-identities";
import { buildIdentityMap, resolveByProviderId } from "@/lib/identity/resolve";
import { db, seedTeam, type Seed } from "./helpers";

async function member(seed: Seed, name: string, email: string) {
  const { data } = await db().from("members").insert({
    team_id: seed.teamId, email, display_name: name, actor_handle: `${name}-${randomUUID().slice(0, 6)}`,
    role: "member", tier: "team", status: "active",
  }).select("id").single();
  return (data as { id: string }).id;
}

async function admin() {
  const seed = await seedTeam();
  await db().from("members").update({ role: "admin" }).eq("id", seed.memberId).eq("team_id", seed.teamId);
  guard.session = { teamId: seed.teamId, memberId: seed.memberId };
  return seed;
}

async function rawLink(teamId: string, memberId: string, provider: string, key: string) {
  await getPool().query(
    "insert into member_identities(team_id,member_id,provider,external_id,handle,email) values ($1,$2,$3,$4,'','')",
    [teamId, memberId, provider, key]);
}

async function rawState(teamId: string, key: string, state: "linked" | "unlinked", memberId: string | null) {
  await getPool().query(
    "insert into member_identity_mapping_state(team_id,provider,external_id,member_id,revision,state) values ($1,'gdrive',$2,$3,1,$4)",
    [teamId, key, memberId, state]);
}

async function rows(teamId: string) {
  return (await getPool().query(
    "select provider,external_id,member_id from member_identities where team_id=$1 order by provider,external_id", [teamId])).rows;
}

async function states(teamId: string) {
  return (await getPool().query(
    "select external_id,state,revision::int as revision from member_identity_mapping_state where team_id=$1 and provider='gdrive' order by external_id",
    [teamId])).rows as { external_id: string; state: string; revision: number }[];
}

async function removalAudits(teamId: string) {
  return (await getPool().query(
    "select meta from audit_log where team_id=$1 and action='identity.removed'", [teamId])).rows
    .map((row) => row.meta as { external_id: string; mapping_revision: number });
}

beforeEach(() => { guard.session = null; });

describe("A5 — exact padded legacy Google email unlink through the Admin action (real Postgres)", () => {
  it.each([
    { name: "outer ASCII whitespace", spell: (a: string) => `  AUTHOR-EMAIL:${a}  ` },
    { name: "outer Unicode whitespace", spell: (a: string) => `　author-email:${a} ` },
    { name: "whitespace after the prefix", spell: (a: string) => `author-email:  ${a}` },
    { name: "mixed-case prefix and address", spell: (a: string) => `Author-Email:${a.toUpperCase()}` },
  ])("$name: only the exact row is removed, its own tombstone and audit; other spellings intact", async ({ spell }) => {
    const seed = await admin();
    const address = `alice-${randomUUID().slice(0, 6)}@example.com`;
    const alice = await member(seed, "alice", address);
    const legacy = spell(address);
    const other = `AUTHOR-EMAIL: ${address.toUpperCase()}`;
    await rawLink(seed.teamId, alice, "gdrive", legacy);
    await rawState(seed.teamId, other, "linked", alice); // an equivalent, independent history
    const otherBefore = (await states(seed.teamId)).filter((s) => s.external_id === other);

    // The canonical writer refuses while the legacy spelling is live: unlink-first.
    const canonical = `author-email:${address}`;
    await expect(setMemberIdentity(db(), seed.teamId, alice, { provider: "gdrive", externalId: canonical },
      { force: true, expectedRevision: 0, expectedRevisionKey: canonical })).rejects.toThrow(/differently spelled/);

    const result = await unlinkMemberIdentity(seed.teamSlug, "gdrive", legacy, { memberId: alice, revision: 0 });
    expect(result).toEqual({ ok: true });
    expect(await rows(seed.teamId)).toEqual([]);
    const after = await states(seed.teamId);
    expect(after.filter((s) => s.external_id === legacy)).toEqual([{ external_id: legacy, state: "unlinked", revision: 1 }]);
    expect(after.filter((s) => s.external_id === other)).toEqual(otherBefore); // byte-for-byte intact
    expect(after.some((s) => s.external_id === canonical)).toBe(false); // no merged/transferred history
    const audits = await removalAudits(seed.teamId);
    expect(audits.map((meta) => [meta.external_id, Number(meta.mapping_revision)])).toEqual([[legacy, 1]]);

    // An explicit canonical link now succeeds and resolves canonical connector evidence.
    const linked = await linkMemberIdentity(seed.teamSlug, alice, "gdrive", canonical, undefined, { original: null });
    expect(linked).toEqual({ ok: true });
    const map = await buildIdentityMap(db(), seed.teamId, { strict: true });
    expect(resolveByProviderId(map, "gdrive", canonical)).toBe(alice);
  });

  it("a non-ASCII legacy address is removed by its exact bytes", async () => {
    const seed = await admin();
    const id = randomUUID().slice(0, 6);
    const alice = await member(seed, "elodie", `elodie-${id}@example.org`);
    const legacy = ` AUTHOR-EMAIL:ÉLODIE-${id.toUpperCase()}@EXAMPLE.COM`;
    await rawLink(seed.teamId, alice, "gdrive", legacy);
    expect(await unlinkMemberIdentity(seed.teamSlug, "gdrive", legacy, { memberId: alice, revision: 0 }))
      .toEqual({ ok: true });
    expect(await rows(seed.teamId)).toEqual([]);
    expect((await states(seed.teamId)).map((s) => s.external_id)).toEqual([legacy]);
  });

  it("a canonical-equivalent, stale, wrong-holder, cross-team or non-admin unlink removes nothing", async () => {
    const seed = await admin();
    const address = `bea-${randomUUID().slice(0, 6)}@example.com`;
    const bea = await member(seed, "bea", address);
    const bob = await member(seed, "bob", `bob-${randomUUID().slice(0, 6)}@example.com`);
    const legacy = `  author-email: ${address.toUpperCase()} `;
    await rawLink(seed.teamId, bea, "gdrive", legacy);
    const intact = JSON.stringify({ rows: await rows(seed.teamId), states: await states(seed.teamId) });
    const unchanged = async () => expect(JSON.stringify({ rows: await rows(seed.teamId), states: await states(seed.teamId) })).toBe(intact);

    // The canonical spelling names a different (absent) row: refused as stale, nothing removed.
    expect((await unlinkMemberIdentity(seed.teamSlug, "gdrive", `author-email:${address}`, { memberId: bea, revision: 0 })).ok).toBe(false);
    await unchanged();
    // A trimmed rendering of the padded key is ALSO a different row.
    expect((await unlinkMemberIdentity(seed.teamSlug, "gdrive", legacy.trim(), { memberId: bea, revision: 0 })).ok).toBe(false);
    await unchanged();
    // Stale revision, wrong displayed holder, missing observation.
    expect((await unlinkMemberIdentity(seed.teamSlug, "gdrive", legacy, { memberId: bea, revision: 3 })).ok).toBe(false);
    expect((await unlinkMemberIdentity(seed.teamSlug, "gdrive", legacy, { memberId: bob, revision: 0 })).ok).toBe(false);
    expect((await unlinkMemberIdentity(seed.teamSlug, "gdrive", legacy,
      undefined as unknown as { memberId: string; revision: number })).ok).toBe(false);
    await unchanged();
    // Another team's admin session observes its own team: nothing here moves.
    const other = await seedTeam();
    guard.session = { teamId: other.teamId, memberId: other.memberId };
    expect((await unlinkMemberIdentity(other.teamSlug, "gdrive", legacy, { memberId: bea, revision: 0 })).ok).toBe(false);
    await unchanged();
    // Not an admin.
    guard.session = null;
    expect(await unlinkMemberIdentity(seed.teamSlug, "gdrive", legacy, { memberId: bea, revision: 0 }))
      .toEqual({ ok: false, error: "admins only" });
    await unchanged();
  });

  it("validation and other providers keep their semantics", async () => {
    const seed = await admin();
    const alice = await member(seed, "alice", `alice-${randomUUID().slice(0, 6)}@example.com`);
    // An absent padded Google email key: a no-op that writes no history.
    expect(await removeMemberIdentity(db(), seed.teamId, { provider: "gdrive", externalId: " author-email: nobody@x.example " }))
      .toEqual({ removed: false });
    expect(await states(seed.teamId)).toEqual([]);
    // Opaque Google ids keep strict validation; new invalid links stay rejected.
    await expect(removeMemberIdentity(db(), seed.teamId, { provider: "gdrive", externalId: "subject: padded" }))
      .rejects.toThrow(/verified subject/);
    await expect(setMemberIdentity(db(), seed.teamId, alice, { provider: "gdrive", externalId: "account:x" }))
      .rejects.toThrow(/verified subject/);
    // Slack keeps its trimming: a padded request removes the stored id.
    const slackId = `U${randomUUID().slice(0, 6).toUpperCase()}`;
    await rawLink(seed.teamId, alice, "slack", slackId);
    expect((await removeMemberIdentity(db(), seed.teamId, { provider: "slack", externalId: `  ${slackId} ` })).removed).toBe(true);
    // Opaque Google ids keep exact case: a different-case permission id is a different row.
    await rawLink(seed.teamId, alice, "gdrive", "permission:AbC");
    expect((await removeMemberIdentity(db(), seed.teamId, { provider: "gdrive", externalId: "permission:abc" })).removed).toBe(false);
    expect((await rows(seed.teamId)).map((row) => row.external_id)).toEqual(["permission:AbC"]);
  });
});
