import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getPool } from "@/lib/db/pg/pool";
import { listMemberIdentities } from "@/lib/identity/list";
import { db, seedTeam, type Seed } from "./helpers";

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
 *   3. an id another member holds is OFFERED as a remap and written only on explicit confirmation,
 *      for every provider and from either kind of row;
 *   4. the write, its audit actor, its epoch and its repair obligation are the shared writer's,
 *      once per mapping change — and a refusal or an offer causes none of them.
 *
 * The action and the writer are the REAL ones. Only the session lookup, the cache revalidation and
 * the post-response deferral — which need a live Next request — are stood in for; the deferred
 * work is counted, not run.
 */

const admin = vi.hoisted(() => ({ teamId: "", memberId: "" }));
const deferred = vi.hoisted(() => ({ callbacks: [] as Array<() => unknown> }));

vi.mock("@/lib/auth/guard", () => ({
  requireTeamAdmin: async () => (admin.teamId ? { teamId: admin.teamId, memberId: admin.memberId } : null),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
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
  return { authority: rows[0].authority, epoch: rows[0].epoch, obligations: rows[0].obligations ?? [], deferred: deferred.callbacks.length };
}

const link = (seed: Seed, memberId: string, provider: Provider, externalId: string, observed: Observation) =>
  linkMemberIdentity(seed.teamSlug, memberId, provider, externalId, undefined, observed);

/** Unlink exactly as the row does: the displayed id, at its displayed revision. */
async function unlinkDisplayed(seed: Seed, memberId: string, provider: Provider, externalId: string): Promise<void> {
  const shown = await displayed(seed, memberId, provider, externalId);
  expect(await unlinkMemberIdentity(seed.teamSlug, provider, shown.externalId, shown.revision)).toEqual({ ok: true });
}

/**
 * Run two calls so that EACH has made its observation before EITHER may write: the team's identity
 * authority is held from a connection of its own until both writers are waiting on it.
 */
async function afterBothObserved<T>(seed: Seed, first: () => Promise<T>, second: () => Promise<T>): Promise<[T, T]> {
  const owner = new Client({ connectionString: process.env.DATABASE_URL });
  owner.on("error", () => undefined);
  await owner.connect();
  await owner.query("begin");
  await owner.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [`${seed.teamId}:identity-authority`]);
  const both = Promise.all([first(), second()]);
  both.catch(() => undefined);
  try {
    await expect.poll(async () => (await getPool().query<{ n: number }>(
      "select count(*)::int as n from pg_locks where locktype='advisory' and not granted")).rows[0].n,
    { timeout: 10_000 }).toBe(2);
  } finally {
    await owner.query("rollback").catch(() => undefined);
    await owner.end().catch(() => undefined);
  }
  return both;
}

beforeEach(() => {
  admin.teamId = "";
  admin.memberId = "";
  deferred.callbacks.length = 0;
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

  it("REMAP is OFFERED, never made — not even when the two revisions coincide — and is written only on confirmation", async () => {
    const seed = await adminSeed();
    const alice = await member(seed, "Alice");
    const bob = await member(seed, "Bob");
    const carol = await member(seed, "Carol");
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
    // From a row that displays an identity, and from a blank one.
    expect(await link(seed, alice, provider, target, { original: shown })).toEqual(offer);
    expect(await link(seed, await member(seed, "Carol"), provider, target, BLANK)).toEqual(offer);

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
    // Alice and Carol are both offered Bob's id at revision 1. Carol confirms first.
    expect((await link(seed, alice, provider, target, BLANK)).remap).toEqual({ externalId: target, revision: 1, linkedTo: "Bob" });
    expect(await link(seed, carol, provider, target, { original: null, remap: { revision: 1 } })).toEqual({ ok: true });
    const moved = await effects(seed, provider, target);

    // MOVED: still held by someone else, but not at the revision Alice was shown.
    expect(await link(seed, alice, provider, target, { original: null, remap: { revision: 1 } })).toEqual({ ok: false, error: STALE });
    expect(await mapping(seed, provider, target)).toEqual({ holder: carol, revision: 2, state: "linked" });

    // UNLINKED: Alice is offered it again at revision 2, and it is unlinked before she confirms.
    expect((await link(seed, alice, provider, target, BLANK)).remap).toEqual({ externalId: target, revision: 2, linkedTo: "Carol" });
    expect(await effects(seed, provider, target)).toEqual(moved);
    await unlinkDisplayed(seed, carol, provider, target);
    const unlinked = await effects(seed, provider, target);
    expect(await link(seed, alice, provider, target, { original: null, remap: { revision: 2 } })).toEqual({ ok: false, error: STALE });
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

    // The id is remapped to Bob. Alice's row still displays it at revision 1.
    expect(await link(seed, bob, provider, target, { original: null, remap: { revision: 1 } })).toEqual({ ok: true });
    expect(await link(seed, alice, provider, target, { original: shown })).toEqual({ ok: false, error: STALE });
    expect(await mapping(seed, provider, target)).toEqual({ holder: bob, revision: 2, state: "linked" });
  });

  it("CONCURRENT first claims and CONCURRENT confirmed remaps: each pair observes the same state, and the writer lets exactly one win", async () => {
    const seed = await adminSeed();
    const alice = await member(seed, "Alice");
    const bob = await member(seed, "Bob");
    const carol = await member(seed, "Carol");
    const claimed = idFor(provider, "claimed");

    // Both blank rows observe "never linked" (revision 0) before either writes.
    const claims = await afterBothObserved(seed,
      () => link(seed, alice, provider, claimed, BLANK),
      () => link(seed, bob, provider, claimed, BLANK));
    expect(claims.filter((result) => result.ok)).toEqual([{ ok: true }]);
    expect(claims.filter((result) => !result.ok)).toEqual([{ ok: false, error: STALE }]);
    const claimant = claims[0].ok ? alice : bob;
    expect(await mapping(seed, provider, claimed)).toEqual({ holder: claimant, revision: 1, state: "linked" });
    expect(await audits(seed, claimed)).toHaveLength(1);

    // Carol holds an id; Alice and Bob were both offered it at revision 1 and both confirm.
    const held = idFor(provider, "held");
    expect(await link(seed, carol, provider, held, BLANK)).toEqual({ ok: true });
    const remaps = await afterBothObserved(seed,
      () => link(seed, alice, provider, held, { original: null, remap: { revision: 1 } }),
      () => link(seed, bob, provider, held, { original: null, remap: { revision: 1 } }));
    expect(remaps.filter((result) => result.ok)).toEqual([{ ok: true }]);
    expect(remaps.filter((result) => !result.ok)).toEqual([{ ok: false, error: STALE }]);
    expect(await mapping(seed, provider, held)).toEqual({ holder: remaps[0].ok ? alice : bob, revision: 2, state: "linked" });
    expect((await audits(seed, held)).map((row) => row.mapping_revision)).toEqual([1, 2]);
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
