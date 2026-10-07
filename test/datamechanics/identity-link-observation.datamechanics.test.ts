import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getPool } from "@/lib/db/pg/pool";
import { listMemberIdentities } from "@/lib/identity/list";
import { removeMemberIdentity, setMemberIdentity } from "@/lib/identity/member-identities";
import { db, seedTeam, type Seed } from "./helpers";
import {
  RACE_TEST_TIMEOUT_MS,
  bothQueuedOnAuthority,
  closeRaceHarness,
  holdIdentityKey,
  holdTable,
  parkThenCompete,
  raceHarnessFatal,
} from "./identity-race-harness";

/**
 * THE ADMIN IDENTITY LINK ACTION keeps what a row DISPLAYED apart from the id being REQUESTED
 * (AIO-1167 X-02), against real PostgreSQL, through the real action and the real single writer.
 *
 * Spec. `setMemberIdentity`'s `expectedRevision` is a compare-and-set on the id it is asked to
 * write. The Admin row used to send the revision of the id it displayed with whatever id was typed,
 * so the writer compared one identity's revision with another's: a change to a different id, a
 * re-link after an unlink and a remap were refused for good — or, where the two revisions happened
 * to be equal, a remap went through with nobody having asked for one. Now:
 *
 *   1. the requested id is fenced by ITS OWN observed state — never linked, an unlinked tombstone,
 *      or already this member's — and the displayed identity is left exactly as it was;
 *   2. the displayed identity, when a different id is requested, must still be what the admin saw
 *      (stale ORIGINAL), and a confirmation must name the revision the admin was shown (stale
 *      TARGET) — otherwise nothing is written;
 *   3. an id another member holds is OFFERED as a remap and written only on explicit confirmation
 *      at the observed target revision — from a Change row for every provider, and from a blank
 *      row for Slack / Linear / Plane. The Google ADD protection is kept: a blank Google row naming
 *      an identity that is already linked is refused outright, with no offer and no write, while
 *      it may still claim a new identity or re-link an unlinked tombstone;
 *   4. the write, its audit actor, its epoch and its repair obligation are the shared writer's,
 *      once per mapping change — and a refusal or an offer causes none of them;
 *   5. the whole fenced decision runs inside the team's identity mutation boundary. The holder and
 *      the revision of the requested id are ONE observation — no remap commits between the two
 *      reads — and the displayed identity cannot be unlinked or remapped between its validation and
 *      the requested id's write. An offer releases the boundary; a confirmation enters a fresh one
 *      and is held to the revision the admin was shown.
 *
 * The races in (5) are driven deterministically: one side is parked on a PostgreSQL lock held by a
 * connection of the test's own, and the other is shown — from `pg_locks`, not from a clock — to be
 * waiting on the team authority the parked side holds, before the lock is released.
 *
 * The action and the writer are the REAL ones. Only the session lookup, the cache revalidation and
 * the post-response deferral — which need a live Next request — are stood in for; the deferred
 * work is counted, not run.
 */

const admin = vi.hoisted(() => ({ teamId: "", memberId: "" }));
const deferred = vi.hoisted(() => ({ callbacks: [] as Array<() => unknown> }));
const revalidated = vi.hoisted(() => ({ paths: [] as string[] }));

vi.mock("@/lib/auth/guard", () => ({
  requireTeamAdmin: async () => (admin.teamId ? { teamId: admin.teamId, memberId: admin.memberId } : null),
}));
vi.mock("next/cache", () => ({ revalidatePath: (path: string) => { revalidated.paths.push(path); } }));
vi.mock("next/server", async (original) => ({
  ...(await original<typeof import("next/server")>()),
  after: (callback: () => unknown) => { deferred.callbacks.push(callback); },
}));

const { linkMemberIdentity, linkMemberSlack, unlinkMemberIdentity } = await import("@/app/t/[team]/admin/members/actions");

const STALE = "identity mapping changed concurrently; refresh and retry";
const PROVIDERS = ["slack", "linear", "plane", "gdrive"] as const;
type Provider = (typeof PROVIDERS)[number];
type Observation = NonNullable<Parameters<typeof linkMemberIdentity>[5]>;

/** A blank "Link" row: it displays no identity, so it has observed none. */
const BLANK: Observation = { original: null };

const idFor = (provider: Provider, tag: string) =>
  provider === "gdrive" ? `permission:${tag}-${randomUUID().slice(0, 8)}` : `${tag}-${randomUUID().slice(0, 8)}`;

async function adminSeed(): Promise<Seed> {
  const seed = await seedTeam();
  await db().from("members").update({ role: "admin" }).eq("id", seed.memberId).eq("team_id", seed.teamId);
  admin.teamId = seed.teamId;
  admin.memberId = seed.memberId;
  return seed;
}

async function member(seed: Seed, name: string, over: Record<string, unknown> = {}): Promise<string> {
  const { data, error } = await db().from("members").insert({
    team_id: seed.teamId, email: `${name.toLowerCase()}-${randomUUID().slice(0, 8)}@roster.example`,
    display_name: name, actor_handle: `${name.toLowerCase()}-${randomUUID().slice(0, 8)}`,
    role: "member", tier: "team", status: "active", is_connector: false, ...over,
  }).select("id").single();
  if (error || !data) throw new Error(`member fixture failed: ${error?.message}`);
  return (data as { id: string }).id;
}

interface Mapping { holder: string | null; revision: number; state: string | null }

/** The stored truth for one provider id: who holds it, its mapping revision (0 = never had one). */
async function mapping(seed: Seed, provider: Provider, externalId: string): Promise<Mapping> {
  const { rows } = await getPool().query<Mapping>(
    `select (select member_id from member_identities
              where team_id=$1 and provider=$2 and external_id=$3) as holder,
            coalesce((select revision::int from member_identity_mapping_state
                       where team_id=$1 and provider=$2 and external_id=$3), 0) as revision,
            (select state from member_identity_mapping_state
              where team_id=$1 and provider=$2 and external_id=$3) as state`,
    [seed.teamId, provider, externalId]);
  return rows[0];
}

/** What the Admin row for this identity DISPLAYS — read by the page's own reader. */
async function displayed(seed: Seed, memberId: string, provider: Provider, externalId: string) {
  const shown = (await listMemberIdentities(db(), seed.teamId)).get(memberId)?.providers
    .find((identity) => identity.provider === provider && identity.externalId === externalId);
  if (!shown) throw new Error(`the page would not display ${provider} ${externalId} for this member`);
  return { externalId: shown.externalId, revision: shown.revision };
}

interface IdentityAudit { action: string; actor_kind: string; member_id: string | null; target_id: string | null; mapping_revision: number }

async function audits(seed: Seed, externalId: string): Promise<IdentityAudit[]> {
  const { rows } = await getPool().query<IdentityAudit>(
    `select action, actor_kind, member_id, target_id, (meta->>'mapping_revision')::int as mapping_revision
       from audit_log
      where team_id=$1 and action in ('identity.set','identity.removed') and meta->>'external_id'=$2
      order by id`, [seed.teamId, externalId]);
  return rows;
}

/** Everything a mapping change moves outside the two identity tables. */
async function effects(seed: Seed, provider: Provider, externalId: string) {
  const { rows } = await getPool().query<{ authority: number; epoch: number; obligations: number[] | null }>(
    `select coalesce((select revision::int from team_identity_authority where team_id=$1), 0) as authority,
            coalesce((select epoch::int from team_authorization_epochs where team_id=$1), 1) as epoch,
            (select array_agg(mapping_revision::int order by mapping_revision)
               from identity_repair_obligations
              where team_id=$1 and provider=$2 and external_id=$3 and status='pending') as obligations`,
    [seed.teamId, provider, externalId]);
  return {
    authority: rows[0].authority, epoch: rows[0].epoch, obligations: rows[0].obligations ?? [],
    deferred: deferred.callbacks.length, revalidated: revalidated.paths.length,
  };
}

const link = (seed: Seed, memberId: string, provider: Provider, externalId: string, observed: Observation) =>
  linkMemberIdentity(seed.teamSlug, memberId, provider, externalId, undefined, observed);

/** Give a member an identity of their own and return what its row then displays — the "Change" row. */
async function ownRow(seed: Seed, memberId: string, provider: Provider) {
  const own = idFor(provider, "own");
  expect(await link(seed, memberId, provider, own, BLANK)).toEqual({ ok: true });
  return displayed(seed, memberId, provider, own);
}

type UnlinkObservation = Parameters<typeof unlinkMemberIdentity>[3];

const unlink = (seed: Seed, provider: Provider, externalId: string, observed: UnlinkObservation) =>
  unlinkMemberIdentity(seed.teamSlug, provider, externalId, observed);

/** Unlink exactly as the row does: the displayed id, bound to the row's member and its displayed revision. */
async function unlinkDisplayed(seed: Seed, memberId: string, provider: Provider, externalId: string): Promise<void> {
  const shown = await displayed(seed, memberId, provider, externalId);
  expect(await unlink(seed, provider, shown.externalId, { memberId, revision: shown.revision })).toEqual({ ok: true });
}

/** The team's identity audit rows in commit order: which id, and what was done to it. */
async function auditOrder(seed: Seed): Promise<[string, string][]> {
  const { rows } = await getPool().query<{ external_id: string; action: string }>(
    `select meta->>'external_id' as external_id, action from audit_log
      where team_id=$1 and action in ('identity.set','identity.removed') order by id`, [seed.teamId]);
  return rows.map((row) => [row.external_id, row.action]);
}

beforeEach(() => {
  // A race whose cleanup could not be proven may have left sessions holding locks. Nothing else in
  // this file may run as if it had been cleaned up.
  const fatal = raceHarnessFatal();
  if (fatal) throw new Error(fatal);
  admin.teamId = "";
  admin.memberId = "";
  deferred.callbacks.length = 0;
  revalidated.paths.length = 0;
});

afterAll(async () => {
  await closeRaceHarness();
});

describe.each(PROVIDERS)("AIO-1167 X-02 — %s: the Admin link keeps the displayed identity apart from the requested id (real Postgres)", (provider) => {
  it("FIRST LINK from a blank row: a never-linked id is claimed at revision 1, by the admin, with one deferred repair", async () => {
    const seed = await adminSeed();
    const alice = await member(seed, "Alice");
    const target = idFor(provider, "first");
    const before = await effects(seed, provider, target);

    expect(await link(seed, alice, provider, target, BLANK)).toEqual({ ok: true });

    expect(await mapping(seed, provider, target)).toEqual({ holder: alice, revision: 1, state: "linked" });
    expect(await audits(seed, target)).toEqual([
      { action: "identity.set", actor_kind: "member", member_id: seed.memberId, target_id: alice, mapping_revision: 1 },
    ]);
    const after = await effects(seed, provider, target);
    expect(after.authority).toBeGreaterThan(before.authority);
    expect(after.deferred).toBe(before.deferred + 1);
    // The Drive-only effects are the writer's: a durable obligation at the new revision, and the epoch.
    expect(after.obligations).toEqual(provider === "gdrive" ? [1] : []);
    if (provider === "gdrive") expect(after.epoch).toBeGreaterThan(before.epoch);
  });

  it("CHANGE to a different id: fenced by the REQUESTED id's own state, and the displayed identity is left as it was", async () => {
    const seed = await adminSeed();
    const alice = await member(seed, "Alice");
    const original = idFor(provider, "original");
    const next = idFor(provider, "next");
    // The displayed id stands at revision 3 (link, unlink, link) — a number no state of the
    // requested id has, so a payload that reused it could only be refused.
    expect(await link(seed, alice, provider, original, BLANK)).toEqual({ ok: true });
    await unlinkDisplayed(seed, alice, provider, original);
    expect(await link(seed, alice, provider, original, BLANK)).toEqual({ ok: true });
    const shown = await displayed(seed, alice, provider, original);
    expect(shown).toEqual({ externalId: original, revision: 3 });

    expect(await link(seed, alice, provider, next, { original: shown })).toEqual({ ok: true });

    expect(await mapping(seed, provider, next)).toEqual({ holder: alice, revision: 1, state: "linked" });
    expect(await mapping(seed, provider, original)).toEqual({ holder: alice, revision: 3, state: "linked" });
  });

  it("RE-LINK after an unlink: the tombstone's own revision is the observation, from a blank row", async () => {
    const seed = await adminSeed();
    const alice = await member(seed, "Alice");
    const bob = await member(seed, "Bob");
    const target = idFor(provider, "relink");
    expect(await link(seed, alice, provider, target, BLANK)).toEqual({ ok: true });
    await unlinkDisplayed(seed, alice, provider, target);
    expect(await mapping(seed, provider, target)).toEqual({ holder: null, revision: 2, state: "unlinked" });

    // Nobody holds a tombstone, so linking it — to its last holder or to anyone else — is not a
    // remap and needs no confirmation.
    expect(await link(seed, bob, provider, target, BLANK)).toEqual({ ok: true });

    expect(await mapping(seed, provider, target)).toEqual({ holder: bob, revision: 3, state: "linked" });
    expect((await audits(seed, target)).map((row) => [row.action, row.target_id, row.mapping_revision])).toEqual([
      ["identity.set", alice, 1], ["identity.removed", alice, 2], ["identity.set", bob, 3],
    ]);
  });

  it("CHANGE REMAP: from a row displaying the member's own identity, an id another member holds is OFFERED, never made — not even when the two revisions coincide — and is written only on confirmation", async () => {
    const seed = await adminSeed();
    const alice = await member(seed, "Alice");
    const bob = await member(seed, "Bob");
    const original = idFor(provider, "original");
    const target = idFor(provider, "held");
    expect(await link(seed, alice, provider, original, BLANK)).toEqual({ ok: true });
    expect(await link(seed, bob, provider, target, BLANK)).toEqual({ ok: true });
    // THE COINCIDENCE: Alice's displayed id and Bob's id both stand at revision 1. Sending the
    // displayed revision with the requested id used to satisfy the writer and remap Bob's id.
    const shown = await displayed(seed, alice, provider, original);
    expect(shown.revision).toBe((await mapping(seed, provider, target)).revision);
    const before = await effects(seed, provider, target);

    const offer = { ok: false, error: `this ${provider} identity is linked to Bob; confirm to remap it`,
      remap: { externalId: target, revision: 1, linkedTo: "Bob" } };
    // Asked twice: an offer is a read, and repeating it changes nothing.
    expect(await link(seed, alice, provider, target, { original: shown })).toEqual(offer);
    expect(await link(seed, alice, provider, target, { original: shown })).toEqual(offer);

    // An offer writes nothing and starts nothing.
    expect(await mapping(seed, provider, target)).toEqual({ holder: bob, revision: 1, state: "linked" });
    expect(await audits(seed, target)).toHaveLength(1);
    expect(await effects(seed, provider, target)).toEqual(before);

    // The confirmation names the revision the admin was shown for the REQUESTED id.
    expect(await link(seed, alice, provider, target, { original: shown, remap: { revision: 1 } })).toEqual({ ok: true });

    expect(await mapping(seed, provider, target)).toEqual({ holder: alice, revision: 2, state: "linked" });
    expect(await mapping(seed, provider, original)).toEqual({ holder: alice, revision: 1, state: "linked" });
    expect((await audits(seed, target))[1]).toEqual(
      { action: "identity.set", actor_kind: "member", member_id: seed.memberId, target_id: alice, mapping_revision: 2 });
    const after = await effects(seed, provider, target);
    expect(after.deferred).toBe(before.deferred + 1);
    expect(after.obligations).toEqual(provider === "gdrive" ? [1, 2] : []);
    if (provider === "gdrive") expect(after.epoch).toBeGreaterThan(before.epoch);
  });

  it("STALE TARGET: a confirmation of an id that moved, or was unlinked, after the offer writes nothing", async () => {
    const seed = await adminSeed();
    const alice = await member(seed, "Alice");
    const bob = await member(seed, "Bob");
    const carol = await member(seed, "Carol");
    const target = idFor(provider, "moving");
    expect(await link(seed, bob, provider, target, BLANK)).toEqual({ ok: true });
    // Alice and Carol each act from a row displaying an identity of their own.
    const aliceRow = await ownRow(seed, alice, provider);
    const carolRow = await ownRow(seed, carol, provider);
    // Both are offered Bob's id at revision 1. Carol confirms first.
    expect((await link(seed, alice, provider, target, { original: aliceRow })).remap).toEqual({ externalId: target, revision: 1, linkedTo: "Bob" });
    expect(await link(seed, carol, provider, target, { original: carolRow, remap: { revision: 1 } })).toEqual({ ok: true });
    const moved = await effects(seed, provider, target);

    // MOVED: still held by someone else, but not at the revision Alice was shown.
    expect(await link(seed, alice, provider, target, { original: aliceRow, remap: { revision: 1 } })).toEqual({ ok: false, error: STALE });
    expect(await mapping(seed, provider, target)).toEqual({ holder: carol, revision: 2, state: "linked" });

    // UNLINKED: Alice is offered it again at revision 2, and it is unlinked before she confirms.
    expect((await link(seed, alice, provider, target, { original: aliceRow })).remap).toEqual({ externalId: target, revision: 2, linkedTo: "Carol" });
    expect(await effects(seed, provider, target)).toEqual(moved);
    await unlinkDisplayed(seed, carol, provider, target);
    const unlinked = await effects(seed, provider, target);
    expect(await link(seed, alice, provider, target, { original: aliceRow, remap: { revision: 2 } })).toEqual({ ok: false, error: STALE });
    expect(await mapping(seed, provider, target)).toEqual({ holder: null, revision: 3, state: "unlinked" });
    expect(await effects(seed, provider, target)).toEqual(unlinked);
    expect((await audits(seed, target)).map((row) => row.mapping_revision)).toEqual([1, 2, 3]);
  });

  it("STALE ORIGINAL: a change from a row whose displayed identity has since changed is refused, and the requested id is never created", async () => {
    const seed = await adminSeed();
    const alice = await member(seed, "Alice");
    const original = idFor(provider, "original");
    const next = idFor(provider, "next");
    expect(await link(seed, alice, provider, original, BLANK)).toEqual({ ok: true });
    const shown = await displayed(seed, alice, provider, original);

    // Another admin unlinks the displayed identity; this row still shows it.
    await unlinkDisplayed(seed, alice, provider, original);
    const before = await effects(seed, provider, next);
    expect(await link(seed, alice, provider, next, { original: shown })).toEqual({ ok: false, error: STALE });
    // …and links it again: the same holder, but not the identity state this row observed.
    expect(await link(seed, alice, provider, original, BLANK)).toEqual({ ok: true });
    const relinked = await effects(seed, provider, next);
    expect(await link(seed, alice, provider, next, { original: shown })).toEqual({ ok: false, error: STALE });

    expect(await mapping(seed, provider, next)).toEqual({ holder: null, revision: 0, state: null });
    expect(await audits(seed, next)).toEqual([]);
    expect(relinked.authority).toBeGreaterThan(before.authority);
    expect(await effects(seed, provider, next)).toEqual(relinked);

    // A refreshed row — the identity as it is now — makes the same change.
    expect(await link(seed, alice, provider, next, { original: await displayed(seed, alice, provider, original) })).toEqual({ ok: true });
    expect(await mapping(seed, provider, next)).toEqual({ holder: alice, revision: 1, state: "linked" });
  });

  it("the requested id IS the displayed one: its displayed revision is the compare-and-set, and a stale one is refused", async () => {
    const seed = await adminSeed();
    const alice = await member(seed, "Alice");
    const bob = await member(seed, "Bob");
    const target = idFor(provider, "same");
    expect(await link(seed, alice, provider, target, BLANK)).toEqual({ ok: true });
    const shown = await displayed(seed, alice, provider, target);

    expect(await link(seed, alice, provider, target, { original: shown })).toEqual({ ok: true });
    expect(await mapping(seed, provider, target)).toEqual({ holder: alice, revision: 1, state: "linked" });

    // The id is remapped to Bob, by a confirmed Change from Bob's own row. Alice's row still
    // displays it at revision 1.
    expect(await link(seed, bob, provider, target, { original: await ownRow(seed, bob, provider), remap: { revision: 1 } })).toEqual({ ok: true });
    expect(await link(seed, alice, provider, target, { original: shown })).toEqual({ ok: false, error: STALE });
    expect(await mapping(seed, provider, target)).toEqual({ holder: bob, revision: 2, state: "linked" });
  });

  it("CONCURRENT first claims and CONCURRENT confirmed remaps: the two are serialized, exactly one writes, and the other is answered from what the first committed — never refreshed into a second write", async () => {
    const seed = await adminSeed();
    const alice = await member(seed, "Alice");
    const bob = await member(seed, "Bob");
    const carol = await member(seed, "Carol");
    const claimed = idFor(provider, "claimed");

    // Two blank rows claim one never-linked id together. One writes it. The other, observing
    // under the same authority, sees an id that is now held: it is offered the remap — or, from a
    // blank Google row, refused outright — and writes nothing.
    const claims = await bothQueuedOnAuthority(seed,
      () => link(seed, alice, provider, claimed, BLANK),
      () => link(seed, bob, provider, claimed, BLANK));
    expect(claims.filter((result) => result.ok)).toEqual([{ ok: true }]);
    const claimant = claims[0].ok ? alice : bob;
    const claimantName = claims[0].ok ? "Alice" : "Bob";
    expect(claims.filter((result) => !result.ok)).toEqual([provider === "gdrive"
      ? { ok: false, error: "this Google identity is already linked; refresh and use Change" }
      : { ok: false, error: `this ${provider} identity is linked to ${claimantName}; confirm to remap it`,
        remap: { externalId: claimed, revision: 1, linkedTo: claimantName } }]);
    expect(await mapping(seed, provider, claimed)).toEqual({ holder: claimant, revision: 1, state: "linked" });
    expect(await audits(seed, claimed)).toHaveLength(1);

    // Carol holds an id; Alice and Bob, each from a row of their own, were both offered it at
    // revision 1 and both confirm.
    const held = idFor(provider, "held");
    expect(await link(seed, carol, provider, held, BLANK)).toEqual({ ok: true });
    const aliceRow = await ownRow(seed, alice, provider);
    const bobRow = await ownRow(seed, bob, provider);
    // TARGET CAS: each confirmation hands the writer the revision its admin was SHOWN (1). The
    // second finds the id at revision 2 and is refused by the writer's compare-and-set.
    const remaps = await bothQueuedOnAuthority(seed,
      () => link(seed, alice, provider, held, { original: aliceRow, remap: { revision: 1 } }),
      () => link(seed, bob, provider, held, { original: bobRow, remap: { revision: 1 } }));
    expect(remaps.filter((result) => result.ok)).toEqual([{ ok: true }]);
    expect(remaps.filter((result) => !result.ok)).toEqual([{ ok: false, error: STALE }]);
    expect(await mapping(seed, provider, held)).toEqual({ holder: remaps[0].ok ? alice : bob, revision: 2, state: "linked" });
    expect((await audits(seed, held)).map((row) => row.mapping_revision)).toEqual([1, 2]);
  }, RACE_TEST_TIMEOUT_MS);
});

describe.each(PROVIDERS)("AIO-1167 X-02 — %s: the fenced decision is ONE boundary — deterministic races against the real writer (real Postgres)", (provider) => {
  /** Alice acts from a Change row displaying her own identity; Bob holds the id she asks for. */
  async function heldTarget() {
    const seed = await adminSeed();
    const alice = await member(seed, "Alice");
    const bob = await member(seed, "Bob");
    const carol = await member(seed, "Carol");
    const target = idFor(provider, "held");
    expect(await link(seed, bob, provider, target, BLANK)).toEqual({ ok: true });
    const aliceRow = await ownRow(seed, alice, provider);
    return { seed, alice, bob, carol, target, aliceRow };
  }
  const offerOf = (target: string, revision: number, linkedTo: string) => ({
    ok: false, error: `this ${provider} identity is linked to ${linkedTo}; confirm to remap it`,
    remap: { externalId: target, revision, linkedTo },
  });

  it("(1) OFFER OBSERVATION: a competing remap of the requested id cannot commit inside the action's observation — it waits for the action, and the offer names one holder at that holder's revision", async () => {
    const { seed, alice, carol, target, aliceRow } = await heldTarget();
    // WHERE THE ACTION PARKS, exactly. The barrier holds the mapping-state table, so the action
    // stops at its first read of that table, already inside the boundary.
    //   - Slack / Linear / Plane ask from a BLANK row: nothing is displayed, so the first thing
    //     read is the REQUESTED id. Its holder (Bob) has been read from `member_identities`; the
    //     action is waiting to read that id's revision — parked between the two reads of the
    //     requested id, the very gap a remap used to commit in.
    //   - Google asks from a CHANGE row, because a blank Google row naming a linked identity is
    //     refused, never offered. There the first mapping-state read is the DISPLAYED identity's,
    //     so the action parks before it has read the requested id at all. That schedule proves
    //     the remap waits for the whole fenced decision; it does not sit between the two reads.
    // In both, the real writer then asks to remap the requested id Bob → Carol.
    const observed: Observation = provider === "gdrive" ? { original: aliceRow } : BLANK;
    const { first: offer, second: remapped } = await parkThenCompete({
      seed,
      barrier: await holdTable("member_identity_mapping_state"),
      parksOn: "relation",
      first: () => link(seed, alice, provider, target, observed),
      second: () => setMemberIdentity(db(), seed.teamId, carol, { provider, externalId: target }, { force: true, expectedRevision: 1 }),
    });

    // The remap was shown waiting on the team authority behind the action. So the offer is Bob at
    // Bob's revision — never Bob at Carol's, which a remap committing between the reads produced.
    expect(offer).toEqual(offerOf(target, 1, "Bob"));
    // The remap was only made to wait: it then committed, against the state the action left alone.
    expect(remapped).toMatchObject({ memberId: carol, updated: true, conflict: false, mappingRevision: 2 });
    expect(await mapping(seed, provider, target)).toEqual({ holder: carol, revision: 2, state: "linked" });

    // Alice's offer was for Bob's link at revision 1. Confirming it is NOT refreshed to Carol's.
    const moved = await effects(seed, provider, target);
    expect(await link(seed, alice, provider, target, { ...observed, remap: { revision: 1 } })).toEqual({ ok: false, error: STALE });
    expect(await mapping(seed, provider, target)).toEqual({ holder: carol, revision: 2, state: "linked" });
    expect(await effects(seed, provider, target)).toEqual(moved);
  }, RACE_TEST_TIMEOUT_MS);

  it("(2) a competing remap that COMMITS FIRST is what the action then shows: the new holder at the new revision, and that exact revision is what a confirmation remaps", async () => {
    const { seed, alice, carol, target, aliceRow } = await heldTarget();

    // The real writer is parked mid-remap — at its own locked read of the mapping state, holding
    // the team authority, its remap not yet written. The action (from a Change row, for every
    // provider) is shown waiting on that authority: it is in flight and has read nothing.
    const { first: remapped, second: offer } = await parkThenCompete({
      seed,
      barrier: await holdTable("member_identity_mapping_state"),
      parksOn: "relation",
      first: () => setMemberIdentity(db(), seed.teamId, carol, { provider, externalId: target }, { force: true, expectedRevision: 1 }),
      second: () => link(seed, alice, provider, target, { original: aliceRow }),
    });

    expect(remapped).toMatchObject({ memberId: carol, updated: true, mappingRevision: 2 });
    expect(offer).toEqual(offerOf(target, 2, "Carol"));
    expect(await mapping(seed, provider, target)).toEqual({ holder: carol, revision: 2, state: "linked" });

    expect(await link(seed, alice, provider, target, { original: aliceRow, remap: { revision: 2 } })).toEqual({ ok: true });
    expect(await mapping(seed, provider, target)).toEqual({ holder: alice, revision: 3, state: "linked" });
  }, RACE_TEST_TIMEOUT_MS);

  it("(3) the DISPLAYED identity cannot be remapped or unlinked between its validation and the requested id's write: the competing mutation waits for the action and commits after it", async () => {
    const seed = await adminSeed();
    const alice = await member(seed, "Alice");
    const bob = await member(seed, "Bob");

    // (a) THE DISCRIMINATING SCHEDULE. The barrier holds `member_identities`, so the action parks
    // at its very first read — of the displayed identity — having validated nothing, but already
    // holding the team authority. A real remap of the displayed id (Alice → Bob) arrives and is
    // shown waiting on that authority. An action that validated the displayed identity before
    // entering the boundary would hold no authority here: the remap would not wait behind it, and
    // this evidence could not be produced.
    const shownA = await ownRow(seed, alice, provider);
    const nextA = idFor(provider, "next");
    const remap = await parkThenCompete({
      seed,
      barrier: await holdTable("member_identities"),
      parksOn: "relation",
      first: () => link(seed, alice, provider, nextA, { original: shownA }),
      second: () => setMemberIdentity(db(), seed.teamId, bob, { provider, externalId: shownA.externalId }, { force: true, expectedRevision: shownA.revision }),
    });
    // Released, the action validated the identity as displayed and wrote the requested id; only
    // then did the remap of the displayed identity commit — the audit order below is that order.
    expect(remap.first).toEqual({ ok: true });
    expect(remap.second).toMatchObject({ memberId: bob, updated: true, mappingRevision: shownA.revision + 1 });
    expect(await mapping(seed, provider, nextA)).toEqual({ holder: alice, revision: 1, state: "linked" });
    expect(await mapping(seed, provider, shownA.externalId)).toEqual({ holder: bob, revision: shownA.revision + 1, state: "linked" });
    expect((await auditOrder(seed)).slice(-2)).toEqual([[nextA, "identity.set"], [shownA.externalId, "identity.set"]]);

    // (b) THE WINDOW ITSELF, pinned — not a second proof of the fix. The barrier holds the
    // requested id's own key, which only the writer takes: so the action parks INSIDE the writer,
    // with the displayed identity already validated, the requested id already observed and
    // nothing yet written. A real unlink of the displayed identity arrives and waits. This shows
    // that an unlink arriving in exactly that window commits after the requested id's write. It
    // does NOT by itself distinguish an action that validates outside the boundary: the writer
    // holds the team authority by this point either way. (a) is the schedule that does.
    const shownB = await ownRow(seed, alice, provider);
    const nextB = idFor(provider, "next");
    const unlink = await parkThenCompete({
      seed,
      barrier: await holdIdentityKey(seed.teamId, provider, nextB),
      parksOn: "advisory",
      first: () => link(seed, alice, provider, nextB, { original: shownB }),
      second: () => removeMemberIdentity(db(), seed.teamId, { provider, externalId: shownB.externalId }, { expectedRevision: shownB.revision }),
    });
    expect(unlink.first).toEqual({ ok: true });
    expect(unlink.second).toEqual({ removed: true, mappingRevision: shownB.revision + 1 });
    expect(await mapping(seed, provider, nextB)).toEqual({ holder: alice, revision: 1, state: "linked" });
    expect(await mapping(seed, provider, shownB.externalId)).toEqual({ holder: null, revision: shownB.revision + 1, state: "unlinked" });
    expect((await auditOrder(seed)).slice(-2)).toEqual([[nextB, "identity.set"], [shownB.externalId, "identity.removed"]]);
  }, RACE_TEST_TIMEOUT_MS);

  it("(4) a displayed identity mutated FIRST — committed before the action starts, or while it waits — makes the action stale: no requested id, no audit row, no effect", async () => {
    const seed = await adminSeed();
    const alice = await member(seed, "Alice");
    const bob = await member(seed, "Bob");

    // (a) Committed before the action starts: the displayed id is remapped to Bob.
    const shownA = await ownRow(seed, alice, provider);
    const nextA = idFor(provider, "next");
    await setMemberIdentity(db(), seed.teamId, bob, { provider, externalId: shownA.externalId }, { force: true, expectedRevision: shownA.revision });
    const beforeA = await effects(seed, provider, nextA);
    expect(await link(seed, alice, provider, nextA, { original: shownA })).toEqual({ ok: false, error: STALE });
    expect(await mapping(seed, provider, nextA)).toEqual({ holder: null, revision: 0, state: null });
    expect(await audits(seed, nextA)).toEqual([]);
    expect(await effects(seed, provider, nextA)).toEqual(beforeA);

    // (b) Committed while the action waits. A real unlink of the displayed id is parked at its own
    // locked read of the mapping state — holding the team authority, its unlink not yet written.
    // The action is shown waiting on that authority: in flight, having validated nothing. Released,
    // the unlink commits first and the action then validates against what it committed.
    const shownB = await ownRow(seed, alice, provider);
    const nextB = idFor(provider, "next");
    const beforeB = await effects(seed, provider, nextB);
    const { first: unlinked, second: change } = await parkThenCompete({
      seed,
      barrier: await holdTable("member_identity_mapping_state"),
      parksOn: "relation",
      first: () => removeMemberIdentity(db(), seed.teamId, { provider, externalId: shownB.externalId }, { expectedRevision: shownB.revision }),
      second: () => link(seed, alice, provider, nextB, { original: shownB }),
    });
    expect(unlinked).toEqual({ removed: true, mappingRevision: shownB.revision + 1 });
    expect(change).toEqual({ ok: false, error: STALE });
    expect(await mapping(seed, provider, nextB)).toEqual({ holder: null, revision: 0, state: null });
    expect(await audits(seed, nextB)).toEqual([]);
    // The unlink's own row change is the only one the team authority counted, and the action
    // deferred nothing.
    const afterB = await effects(seed, provider, nextB);
    expect(afterB.authority).toBe(beforeB.authority + 1);
    expect(afterB.obligations).toEqual([]);
    expect(afterB.deferred).toBe(beforeB.deferred);
  }, RACE_TEST_TIMEOUT_MS);
});

describe.each(["slack", "linear", "plane"] as const)("AIO-1167 X-02 — %s: a BLANK row naming an id another member holds (real Postgres)", (provider) => {
  it("is offered the remap, writes nothing until it is confirmed, and is refused if the id moved after the offer", async () => {
    const seed = await adminSeed();
    const alice = await member(seed, "Alice");
    const bob = await member(seed, "Bob");
    const carol = await member(seed, "Carol");
    const target = idFor(provider, "held");
    expect(await link(seed, bob, provider, target, BLANK)).toEqual({ ok: true });
    const before = await effects(seed, provider, target);

    const offer = { ok: false, error: `this ${provider} identity is linked to Bob; confirm to remap it`,
      remap: { externalId: target, revision: 1, linkedTo: "Bob" } };
    expect(await link(seed, alice, provider, target, BLANK)).toEqual(offer);
    expect(await link(seed, carol, provider, target, BLANK)).toEqual(offer);
    expect(await mapping(seed, provider, target)).toEqual({ holder: bob, revision: 1, state: "linked" });
    expect(await audits(seed, target)).toHaveLength(1);
    expect(await effects(seed, provider, target)).toEqual(before);

    expect(await link(seed, alice, provider, target, { original: null, remap: { revision: 1 } })).toEqual({ ok: true });
    expect(await mapping(seed, provider, target)).toEqual({ holder: alice, revision: 2, state: "linked" });
    // Carol confirms the offer she was shown — at revision 1, which the id no longer has.
    expect(await link(seed, carol, provider, target, { original: null, remap: { revision: 1 } })).toEqual({ ok: false, error: STALE });
    expect(await mapping(seed, provider, target)).toEqual({ holder: alice, revision: 2, state: "linked" });
    expect((await audits(seed, target)).map((row) => [row.target_id, row.mapping_revision])).toEqual([[bob, 1], [alice, 2]]);
  });
});

describe("AIO-1167 X-02 — gdrive: the Google ADD protection is kept (real Postgres)", () => {
  const ALREADY_LINKED = { ok: false, error: "this Google identity is already linked; refresh and use Change" };

  it("a BLANK Google row naming a LINKED identity is refused outright — no offer, no confirmable remap, no write — whoever holds it", async () => {
    const seed = await adminSeed();
    const alice = await member(seed, "Alice");
    const bob = await member(seed, "Bob");
    const held = idFor("gdrive", "held");
    const own = idFor("gdrive", "own");
    expect(await link(seed, bob, "gdrive", held, BLANK)).toEqual({ ok: true });
    expect(await link(seed, alice, "gdrive", own, BLANK)).toEqual({ ok: true });
    const before = {
      held: await effects(seed, "gdrive", held), own: await effects(seed, "gdrive", own),
      heldAudits: await audits(seed, held), ownAudits: await audits(seed, own),
    };

    // Another member's identity: the plain Add, and an Add dressed as the confirmation of an offer
    // this row was never made — at the id's true revision, and at a wrong one.
    for (const observed of [BLANK, { original: null, remap: { revision: 1 } }, { original: null, remap: { revision: 0 } }]) {
      const refused = await link(seed, alice, "gdrive", held, observed);
      expect(refused, JSON.stringify(observed)).toEqual(ALREADY_LINKED);
      expect(refused, "no remap is offered from a blank Google row").not.toHaveProperty("remap");
    }
    // The member's own identity, added again from the blank row: the same refusal.
    for (const observed of [BLANK, { original: null, remap: { revision: 1 } }]) {
      const refused = await link(seed, alice, "gdrive", own, observed);
      expect(refused, JSON.stringify(observed)).toEqual(ALREADY_LINKED);
      expect(refused).not.toHaveProperty("remap");
    }

    // NO MUTATION: neither mapping, no audit row, no authority revision, epoch, obligation or
    // deferred repair moved.
    expect(await mapping(seed, "gdrive", held)).toEqual({ holder: bob, revision: 1, state: "linked" });
    expect(await mapping(seed, "gdrive", own)).toEqual({ holder: alice, revision: 1, state: "linked" });
    expect({
      held: await effects(seed, "gdrive", held), own: await effects(seed, "gdrive", own),
      heldAudits: await audits(seed, held), ownAudits: await audits(seed, own),
    }).toEqual(before);
  });

  it("the blank Google row still CLAIMS a never-linked identity and RE-LINKS an unlinked tombstone at the tombstone's revision", async () => {
    const seed = await adminSeed();
    const alice = await member(seed, "Alice");
    const bob = await member(seed, "Bob");
    const target = idFor("gdrive", "tombstone");
    expect(await link(seed, bob, "gdrive", target, BLANK)).toEqual({ ok: true });
    expect(await link(seed, alice, "gdrive", target, BLANK)).toEqual(ALREADY_LINKED);
    await unlinkDisplayed(seed, bob, "gdrive", target);
    expect(await mapping(seed, "gdrive", target)).toEqual({ holder: null, revision: 2, state: "unlinked" });

    // Nobody holds a tombstone: linking it is not a remap, and the protection does not apply.
    expect(await link(seed, alice, "gdrive", target, BLANK)).toEqual({ ok: true });
    expect(await mapping(seed, "gdrive", target)).toEqual({ holder: alice, revision: 3, state: "linked" });
    expect((await effects(seed, "gdrive", target)).obligations).toEqual([1, 2, 3]);
    // …and now that it is linked again, the blank row is refused again.
    expect(await link(seed, bob, "gdrive", target, BLANK)).toEqual(ALREADY_LINKED);
    expect(await mapping(seed, "gdrive", target)).toEqual({ holder: alice, revision: 3, state: "linked" });
  });

  it("CHANGE is the Google remap: the same held identity, requested from a row displaying the member's own, is offered and remapped on confirmation at the observed target revision", async () => {
    const seed = await adminSeed();
    const alice = await member(seed, "Alice");
    const bob = await member(seed, "Bob");
    const held = idFor("gdrive", "held");
    expect(await link(seed, bob, "gdrive", held, BLANK)).toEqual({ ok: true });
    const aliceRow = await ownRow(seed, alice, "gdrive");
    const before = await effects(seed, "gdrive", held);

    // Refused from the blank row…
    expect(await link(seed, alice, "gdrive", held, BLANK)).toEqual(ALREADY_LINKED);
    // …offered from the Change row, with nothing written by either.
    expect(await link(seed, alice, "gdrive", held, { original: aliceRow })).toEqual({
      ok: false, error: "this gdrive identity is linked to Bob; confirm to remap it",
      remap: { externalId: held, revision: 1, linkedTo: "Bob" },
    });
    expect(await mapping(seed, "gdrive", held)).toEqual({ holder: bob, revision: 1, state: "linked" });
    expect(await effects(seed, "gdrive", held)).toEqual(before);

    // A confirmation naming a revision the admin was not shown is refused by the writer…
    expect(await link(seed, alice, "gdrive", held, { original: aliceRow, remap: { revision: 2 } })).toEqual({ ok: false, error: STALE });
    expect(await mapping(seed, "gdrive", held)).toEqual({ holder: bob, revision: 1, state: "linked" });
    // …and the one naming the observed target revision remaps it, as the admin, with the writer's
    // Drive effects: a durable obligation at the new revision and an advanced epoch.
    expect(await link(seed, alice, "gdrive", held, { original: aliceRow, remap: { revision: 1 } })).toEqual({ ok: true });
    expect(await mapping(seed, "gdrive", held)).toEqual({ holder: alice, revision: 2, state: "linked" });
    expect((await audits(seed, held))[1]).toEqual(
      { action: "identity.set", actor_kind: "member", member_id: seed.memberId, target_id: alice, mapping_revision: 2 });
    const after = await effects(seed, "gdrive", held);
    expect(after.obligations).toEqual([1, 2]);
    expect(after.epoch).toBeGreaterThan(before.epoch);
    expect(after.deferred).toBe(before.deferred + 1);
    // Alice's own displayed identity is exactly as it was.
    expect(await mapping(seed, "gdrive", aliceRow.externalId)).toEqual({ holder: alice, revision: aliceRow.revision, state: "linked" });
  });
});

describe("AIO-1167 X-02 — what the action does not decide (real Postgres)", () => {
  it("MEMBER CHECKS stay the writer's: a deactivated or foreign target is refused by name and nothing is written", async () => {
    const seed = await adminSeed();
    const gone = await member(seed, "Gone", { status: "disabled" });
    const foreign = (await seedTeam()).memberId;
    const robot = await member(seed, "Robot", { is_connector: true });
    const target = idFor("slack", "checked");
    const google = idFor("gdrive", "checked");

    expect(await link(seed, gone, "slack", target, BLANK)).toEqual({ ok: false, error: "identity target is deactivated" });
    expect(await link(seed, foreign, "slack", target, BLANK)).toEqual({ ok: false, error: "identity target is not a member of this team" });
    expect(await link(seed, robot, "gdrive", google, BLANK))
      .toEqual({ ok: false, error: "Google Drive identities cannot be credited to connector service accounts" });
    expect(await link(seed, robot, "gdrive", "account:not-a-verified-key", BLANK))
      .toEqual({ ok: false, error: "Google Drive identity must use a verified subject:, permission:, or author-email: key" });

    expect(await mapping(seed, "slack", target)).toEqual({ holder: null, revision: 0, state: null });
    expect(await mapping(seed, "gdrive", google)).toEqual({ holder: null, revision: 0, state: null });
    expect(deferred.callbacks).toHaveLength(0);
  });

  it("an observation the action cannot read is REFUSED, never downgraded to an unfenced write", async () => {
    const seed = await adminSeed();
    const alice = await member(seed, "Alice");
    const bob = await member(seed, "Bob");
    const target = idFor("slack", "held");
    expect(await link(seed, bob, "slack", target, BLANK)).toEqual({ ok: true });
    deferred.callbacks.length = 0;

    // The shape an older client sent (a bare revision), and other malformed observations.
    for (const observed of [1, 0, null, "1", {}, { original: undefined }, { original: { externalId: target } },
      { original: { externalId: "", revision: 1 } }, { original: null, remap: { revision: -1 } },
      { original: { externalId: target, revision: 1.5 } }]) {
      expect(await linkMemberIdentity(seed.teamSlug, alice, "slack", target, undefined, observed as unknown as Observation),
        JSON.stringify(observed)).toEqual({ ok: false, error: STALE });
    }
    expect(await mapping(seed, "slack", target)).toEqual({ holder: bob, revision: 1, state: "linked" });
    expect(deferred.callbacks).toHaveLength(0);
  });

  it("WITHOUT an observation the programmatic callers are unchanged: an unfenced admin write that forces over a prior mapping", async () => {
    const seed = await adminSeed();
    const alice = await member(seed, "Alice");
    const bob = await member(seed, "Bob");
    const target = idFor("slack", "legacy");
    expect(await linkMemberSlack(seed.teamSlug, bob, target, "bob-handle")).toEqual({ ok: true });
    expect(await linkMemberIdentity(seed.teamSlug, alice, "slack", target)).toEqual({ ok: true });
    expect(await mapping(seed, "slack", target)).toEqual({ holder: alice, revision: 2, state: "linked" });
    expect((await audits(seed, target)).map((row) => [row.actor_kind, row.member_id, row.target_id])).toEqual([
      ["member", seed.memberId, bob], ["member", seed.memberId, alice],
    ]);
  });

  it("a caller that is not an admin of the team reaches neither the observation nor the writer", async () => {
    const seed = await adminSeed();
    const alice = await member(seed, "Alice");
    const target = idFor("slack", "denied");
    admin.teamId = "";
    expect(await link(seed, alice, "slack", target, BLANK)).toEqual({ ok: false, error: "admins only" });
    expect(await mapping(seed, "slack", target)).toEqual({ holder: null, revision: 0, state: null });
  });
});
