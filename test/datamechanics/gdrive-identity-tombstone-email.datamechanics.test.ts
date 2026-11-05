import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import { getPool } from "@/lib/db/pg/pool";
import { withIdentityMutationBoundary } from "@/lib/identity/authority";
import { buildIdentityMap, providerIdentityState, resolveByProviderId } from "@/lib/identity/resolve";
import { removeMemberIdentity, setMemberIdentity } from "@/lib/identity/member-identities";
import { GoogleIdentityConflictError, publishGoogleDriveOAuthCredential } from "@/lib/integrations/gdrive-oauth";
import { db, seedTeam, type Seed } from "./helpers";

/**
 * AIO-1167 R47 — Google identity writes after R46 (real Postgres).
 *
 * F1 (AC-08/AC-09). Connecting or reconnecting a Google account is CREDENTIAL authority, not an intent
 * to undo an attribution decision. The verified subject and the verified email are separate identities,
 * each checked on its own: a deliberately unlinked one stays unlinked (no row, same revision, no repair,
 * no identity revision change) while the credential is still published; a never-reviewed one links; a
 * different existing owner is still a conflict; an explicit, revision-fenced Admin relink of a
 * tombstone stays available. A concurrent unlink serializes with publication and wins in the end.
 *
 * F8 (AC-08 shared namespace). `author-email:` is the one case-insensitive Drive namespace: a manual
 * link in mixed case is stored canonically, so connector evidence (always lowercased) resolves to it.
 * The same address in another spelling is never merged or overwritten. Opaque `subject:`/`permission:`
 * ids stay case-sensitive. Stale revisions and tombstone relinks keep their fences.
 */

const S = () => `subject:${randomUUID().slice(0, 8)}`;

async function adminTeam() {
  const seed = await seedTeam();
  await db().from("members").update({ role: "admin" }).eq("id", seed.memberId).eq("team_id", seed.teamId);
  return seed;
}

async function member(seed: Seed, name: string) {
  const email = `${name}-${randomUUID().slice(0, 6)}@example.com`;
  const { data } = await db().from("members").insert({
    team_id: seed.teamId, email, display_name: name, actor_handle: `${name}-${randomUUID().slice(0, 6)}`,
    role: "member", tier: "team", status: "active",
  }).select("id").single();
  return { id: (data as { id: string }).id, email };
}

function publish(seed: Seed, subject: string, email: string, name = `docs-${randomUUID().slice(0, 6)}`) {
  return publishGoogleDriveOAuthCredential({
    teamId: seed.teamId, memberId: seed.memberId, integrationName: name,
    clientId: "oauth-client", clientSecret: "client-secret", subject, email, emailVerified: true,
    refreshToken: `refresh-${randomUUID().slice(0, 6)}`, grantMode: "files",
    scopes: ["openid", "https://www.googleapis.com/auth/drive.file"],
  });
}

function gate() {
  let release!: () => void;
  let reached!: () => void;
  const open = new Promise<void>((resolve) => { release = resolve; });
  const at = new Promise<void>((resolve) => { reached = resolve; });
  return { open, at, release, reached };
}

type Settled<T> = Promise<{ value: T | null; error: unknown }>;
const settled = <T>(promise: Promise<T>): Settled<T> =>
  promise.then((value) => ({ value, error: null }), (error: unknown) => ({ value: null, error }));

/** Wait until exactly one backend is queued on an advisory lock (the loser, parked behind the winner). */
async function waitForOneAdvisoryWaiter(): Promise<void> {
  let waiting = 0;
  for (let tries = 0; tries < 320 && waiting !== 1; tries++) {
    const { rows } = await getPool().query<{ n: number }>(
      `select count(*)::int as n from pg_locks l join pg_database d on d.oid = l.database
        where l.locktype = 'advisory' and not l.granted and d.datname = current_database()`);
    waiting = rows[0].n;
    if (waiting !== 1) await new Promise((resolve) => setTimeout(resolve, 25));
  }
  expect(waiting, "expected the unlink to queue behind the publication").toBe(1);
}

/** The identity-caused state of a set of ids: rows, mapping states, repair obligations, team revision. */
async function identityState(teamId: string, ids: string[]) {
  const pool = getPool();
  return JSON.stringify({
    rows: (await pool.query(
      "select external_id, member_id from member_identities where team_id=$1 and provider='gdrive' and external_id=any($2) order by external_id",
      [teamId, ids])).rows,
    states: (await pool.query(
      "select external_id, state, revision from member_identity_mapping_state where team_id=$1 and provider='gdrive' and external_id=any($2) order by external_id",
      [teamId, ids])).rows,
    obligations: (await pool.query(
      "select external_id, mapping_revision from identity_repair_obligations where team_id=$1 and external_id=any($2) order by external_id, mapping_revision",
      [teamId, ids])).rows,
    authority: (await pool.query("select revision from team_identity_authority where team_id=$1", [teamId])).rows,
  });
}

async function credentialStored(teamId: string, name: string) {
  const { rows } = await getPool().query(
    "select secret_ciphertext is not null as stored from integrations where team_id=$1 and type='gdrive' and name=$2", [teamId, name]);
  return rows[0]?.stored === true;
}

describe("R47 F1 — OAuth publication honours deliberate unlink tombstones", () => {
  it("connect and reconnect publish the credential and leave both tombstoned identities unlinked", async () => {
    const seed = await adminTeam();
    const alice = await member(seed, "alice");
    const subject = S();
    const ids = [subject, `author-email:${alice.email}`];
    for (const id of ids) {
      await setMemberIdentity(db(), seed.teamId, alice.id, { provider: "gdrive", externalId: id });
      await removeMemberIdentity(db(), seed.teamId, { provider: "gdrive", externalId: id });
    }
    const before = await identityState(seed.teamId, ids);

    const name = `docs-${randomUUID().slice(0, 6)}`;
    await publish(seed, subject, alice.email, name); // Connect
    expect(await credentialStored(seed.teamId, name)).toBe(true);
    expect(await identityState(seed.teamId, ids)).toBe(before);

    await publish(seed, subject, alice.email, name); // Reconnect
    expect(await identityState(seed.teamId, ids)).toBe(before);
    expect(JSON.parse(before).states.map((s: { state: string }) => s.state)).toEqual(["unlinked", "unlinked"]);
  });

  it("each identity is checked on its own: a tombstoned subject stays unlinked while a never-reviewed email links", async () => {
    const seed = await adminTeam();
    const alice = await member(seed, "alice");
    const subject = S();
    await setMemberIdentity(db(), seed.teamId, alice.id, { provider: "gdrive", externalId: subject });
    await removeMemberIdentity(db(), seed.teamId, { provider: "gdrive", externalId: subject });

    await publish(seed, subject, alice.email);

    const map = await buildIdentityMap(db(), seed.teamId, { strict: true });
    expect(resolveByProviderId(map, "gdrive", subject)).toBeNull();
    expect(resolveByProviderId(map, "gdrive", `author-email:${alice.email}`)).toBe(alice.id);
  });

  it("a never-reviewed account links both identities; the same owner relinking is a no-op link", async () => {
    const seed = await adminTeam();
    const alice = await member(seed, "alice");
    const subject = S();
    const name = `docs-${randomUUID().slice(0, 6)}`;
    await publish(seed, subject, alice.email, name);
    await publish(seed, subject, alice.email, name);
    const map = await buildIdentityMap(db(), seed.teamId, { strict: true });
    expect(resolveByProviderId(map, "gdrive", subject)).toBe(alice.id);
    expect(resolveByProviderId(map, "gdrive", `author-email:${alice.email}`)).toBe(alice.id);
  });

  it("a different existing owner is still a conflict, never treated as unlinked", async () => {
    const seed = await adminTeam();
    const alice = await member(seed, "alice");
    const bob = await member(seed, "bob");
    const subject = S();
    await setMemberIdentity(db(), seed.teamId, bob.id, { provider: "gdrive", externalId: subject });
    const before = await identityState(seed.teamId, [subject]);
    await expect(publish(seed, subject, alice.email)).rejects.toBeInstanceOf(GoogleIdentityConflictError);
    expect(await identityState(seed.teamId, [subject])).toBe(before);
  });

  it("R50 F5: an inconsistent tombstone hiding a different owner is the visible conflict, and nothing is published", async () => {
    const seed = await adminTeam();
    const alice = await member(seed, "alice");
    const bob = await member(seed, "bob");
    const subject = S();
    const email = `author-email:${alice.email}`;
    await setMemberIdentity(db(), seed.teamId, bob.id, { provider: "gdrive", externalId: subject });
    // A legacy/raw shape normal writers never produce: Bob's row survives behind an `unlinked` state.
    await getPool().query(
      "update member_identity_mapping_state set state='unlinked' where team_id=$1 and provider='gdrive' and external_id=$2",
      [seed.teamId, subject]);
    const before = await identityState(seed.teamId, [subject, email]);
    const name = `docs-${randomUUID().slice(0, 6)}`;

    await expect(publish(seed, subject, alice.email, name)).rejects.toBeInstanceOf(GoogleIdentityConflictError);

    // Rolled back whole: no credential, no mapping (the never-reviewed email did not link either),
    // no revision, no repair obligation, no identity-authority change.
    expect(await credentialStored(seed.teamId, name)).toBe(false);
    expect(await identityState(seed.teamId, [subject, email])).toBe(before);
    const map = await buildIdentityMap(db(), seed.teamId, { strict: true });
    expect(resolveByProviderId(map, "gdrive", email)).toBeNull();
  });

  it("an explicit revision-fenced Admin relink restores a tombstone", async () => {
    const seed = await adminTeam();
    const alice = await member(seed, "alice");
    const subject = S();
    await setMemberIdentity(db(), seed.teamId, alice.id, { provider: "gdrive", externalId: subject });
    const unlinked = await removeMemberIdentity(db(), seed.teamId, { provider: "gdrive", externalId: subject });
    await publish(seed, subject, alice.email); // automatic: stays unlinked
    expect(resolveByProviderId(await buildIdentityMap(db(), seed.teamId, { strict: true }), "gdrive", subject)).toBeNull();

    const relinked = await setMemberIdentity(db(), seed.teamId, alice.id, { provider: "gdrive", externalId: subject },
      { force: true, expectedRevision: unlinked.mappingRevision });
    expect(relinked.created).toBe(true);
    expect(resolveByProviderId(await buildIdentityMap(db(), seed.teamId, { strict: true }), "gdrive", subject)).toBe(alice.id);
  });

  it("an unlink racing a publication serializes behind it and wins, in either order", async () => {
    const seed = await adminTeam();
    const alice = await member(seed, "alice");
    const subject = S();
    await setMemberIdentity(db(), seed.teamId, alice.id, { provider: "gdrive", externalId: subject });

    // Publication first: it holds the identity authority; the unlink queues behind it and lands last.
    const publishing = gate();
    const oauth = settled(publishGoogleDriveOAuthCredential({
      teamId: seed.teamId, memberId: seed.memberId, integrationName: `docs-${randomUUID().slice(0, 6)}`,
      clientId: "oauth-client", clientSecret: "client-secret", subject, email: alice.email, emailVerified: true,
      refreshToken: "refresh-race", grantMode: "files", scopes: ["openid", "https://www.googleapis.com/auth/drive.file"],
    }, { afterLocks: async () => { publishing.reached(); await publishing.open; } }));
    let unlinking: Settled<unknown> | undefined;
    try {
      await publishing.at;
      // Started from the TEST's context, not inside the hook — a call made inside the hook would join
      // the publication's own transaction and prove nothing about serialization.
      unlinking = settled(removeMemberIdentity(db(), seed.teamId, { provider: "gdrive", externalId: subject }));
      await waitForOneAdvisoryWaiter();
    } finally {
      publishing.release();
      await oauth;
      await unlinking;
    }
    expect((await oauth).error).toBeNull();
    expect((await unlinking!).error).toBeNull();
    const afterRace = JSON.parse(await identityState(seed.teamId, [subject]));
    expect(afterRace.rows).toEqual([]);
    expect(afterRace.states.map((s: { state: string }) => s.state)).toEqual(["unlinked"]);

    // Unlink first (now committed): a later reconnect respects it.
    const before = await identityState(seed.teamId, [subject]);
    await publish(seed, subject, alice.email);
    expect(await identityState(seed.teamId, [subject])).toBe(before);
  });
});

describe("R47 F8 — the author-email namespace is canonical; opaque ids are not", () => {
  it("a mixed-case manual email link is stored canonically and resolves connector evidence", async () => {
    const seed = await adminTeam();
    const alice = await member(seed, "alice");
    const written = await setMemberIdentity(db(), seed.teamId, alice.id,
      { provider: "gdrive", externalId: "author-email:  Alice.Doe@Example.COM " }, { force: true });
    expect(written.created).toBe(true);
    const { rows } = await getPool().query(
      "select external_id from member_identities where team_id=$1 and provider='gdrive'", [seed.teamId]);
    expect(rows).toEqual([{ external_id: "author-email:alice.doe@example.com" }]);
    // The connector always emits the lowercased form: it now resolves, and repair is owed under it.
    const map = await buildIdentityMap(db(), seed.teamId, { strict: true });
    expect(resolveByProviderId(map, "gdrive", "author-email:alice.doe@example.com")).toBe(alice.id);
    const { rows: owed } = await getPool().query(
      "select external_id from identity_repair_obligations where team_id=$1", [seed.teamId]);
    expect(owed).toEqual([{ external_id: "author-email:alice.doe@example.com" }]);
  });

  it("the same address in another spelling is refused, never merged or overwritten", async () => {
    const seed = await adminTeam();
    const alice = await member(seed, "alice");
    const bob = await member(seed, "bob");
    // A legacy, differently spelled row for bob.
    await getPool().query(
      "insert into member_identities(team_id, member_id, provider, external_id, handle, email) values ($1,$2,'gdrive','author-email:Bob@Example.com','','')",
      [seed.teamId, bob.id]);
    await expect(setMemberIdentity(db(), seed.teamId, alice.id,
      { provider: "gdrive", externalId: "author-email:bob@example.com" }, { force: true })).rejects.toThrow(/differently spelled/);
    const { rows } = await getPool().query(
      "select external_id, member_id from member_identities where team_id=$1 and provider='gdrive'", [seed.teamId]);
    expect(rows).toEqual([{ external_id: "author-email:Bob@Example.com", member_id: bob.id }]);
    // The explicit correction: unlink the stored spelling exactly, then link the canonical one.
    await removeMemberIdentity(db(), seed.teamId, { provider: "gdrive", externalId: "author-email:Bob@Example.com" });
    expect((await setMemberIdentity(db(), seed.teamId, alice.id,
      { provider: "gdrive", externalId: "author-email:bob@example.com" }, { force: true })).created).toBe(true);
  });

  it("opaque ids differing only by case stay distinct", async () => {
    const seed = await adminTeam();
    const alice = await member(seed, "alice");
    const bob = await member(seed, "bob");
    await setMemberIdentity(db(), seed.teamId, alice.id, { provider: "gdrive", externalId: "permission:AbC123" });
    await setMemberIdentity(db(), seed.teamId, bob.id, { provider: "gdrive", externalId: "permission:abc123" });
    const map = await buildIdentityMap(db(), seed.teamId, { strict: true });
    expect(resolveByProviderId(map, "gdrive", "permission:AbC123")).toBe(alice.id);
    expect(resolveByProviderId(map, "gdrive", "permission:abc123")).toBe(bob.id);
  });

  it("a stale revision is refused, and a canonical tombstone relinks only under its revision", async () => {
    const seed = await adminTeam();
    const alice = await member(seed, "alice");
    const linked = await setMemberIdentity(db(), seed.teamId, alice.id, { provider: "gdrive", externalId: "author-email:a@example.com" });
    const removed = await removeMemberIdentity(db(), seed.teamId, { provider: "gdrive", externalId: "author-email:a@example.com" });
    await expect(setMemberIdentity(db(), seed.teamId, alice.id, { provider: "gdrive", externalId: "author-email:A@EXAMPLE.com" },
      { force: true, expectedRevision: linked.mappingRevision })).rejects.toThrow(/changed concurrently/);
    const relinked = await setMemberIdentity(db(), seed.teamId, alice.id, { provider: "gdrive", externalId: "author-email:A@EXAMPLE.com" },
      { force: true, expectedRevision: removed.mappingRevision });
    expect(relinked.created).toBe(true);
    expect(resolveByProviderId(await buildIdentityMap(db(), seed.teamId, { strict: true }), "gdrive", "author-email:a@example.com")).toBe(alice.id);
  });
});

/**
 * AIO-1167 PR743 — Google `author-email:` equivalence across LEGACY spellings (Astra PR714/PR743
 * decision). Legacy rows written before canonicalization keep their stored spelling and their own
 * mapping-state history. An automatic publication decides the canonical key across the whole
 * equivalence class: a different live owner is the visible conflict first; the canonical key's own
 * state governs alone; otherwise zero legacy tombstones → the ordinary path, exactly one legacy state
 * that is a tombstone → it stands, several legacy states → nothing is written (fail closed). Refusals
 * change no row, revision, repair obligation, authority revision, epoch or identity audit. An explicit
 * Admin relink is fenced on ONE exact key (`expectedRevisionKey`), resolves the history by writing the
 * canonical key's own state, and lets a later reconnect proceed. Opaque ids never fold case.
 */
describe("PR743 — author-email tombstones are decided across equivalent legacy spellings", () => {
  const automatic = (seed: Seed, memberId: string, externalId: string) =>
    setMemberIdentity(db(), seed.teamId, memberId, { provider: "gdrive", externalId },
      { respectTombstone: true, actor: { kind: "member", memberId: seed.memberId } });

  /** A row as a pre-canonicalization writer stored it: exact spelling, no mapping state. */
  async function rawLink(seed: Seed, memberId: string, key: string) {
    await getPool().query(
      "insert into member_identities(team_id, member_id, provider, external_id, handle, email) values ($1,$2,'gdrive',$3,'','')",
      [seed.teamId, memberId, key]);
  }

  /** A legacy spelling deliberately unlinked by its exact stored spelling. Returns its own revision. */
  async function legacyTombstone(seed: Seed, memberId: string, key: string): Promise<number> {
    await rawLink(seed, memberId, key);
    const removed = await removeMemberIdentity(db(), seed.teamId, { provider: "gdrive", externalId: key });
    expect(removed).toMatchObject({ removed: true, mappingKey: key });
    return removed.mappingRevision!;
  }

  function spellings(address: string) {
    const [local, domain] = address.split("@");
    return {
      canonical: `author-email:${address}`,
      mixedAddress: `author-email:${local[0].toUpperCase()}${local.slice(1)}@${domain.toUpperCase()}`,
      upperPrefix: `AUTHOR-EMAIL:${address}`,
      mixedBoth: `Author-Email:${address.toUpperCase()}`,
    };
  }

  /** Every identity-caused effect, including the durable epoch and identity audits. */
  async function sideEffects(teamId: string, ids: string[]) {
    const pool = getPool();
    return JSON.stringify({
      identity: JSON.parse(await identityState(teamId, ids)),
      epoch: (await pool.query("select epoch from team_authorization_epochs where team_id=$1", [teamId])).rows,
      audits: (await pool.query(
        "select count(*)::int as n from audit_log where team_id=$1 and action like 'identity.%'", [teamId])).rows,
    });
  }

  /**
   * The email keys' own rows, mapping histories/revisions and repair obligations, WITHOUT the team-wide
   * authority revision. For publisher runs only: a publication also links its separate `subject:` key,
   * which legitimately advances the team revision; that transition is asserted on its own. Direct
   * refusals keep the full `sideEffects` comparison, team revision, epoch and audits included.
   */
  async function emailState(teamId: string, ids: string[]) {
    const { authority: _teamRevision, ...email } = JSON.parse(await identityState(teamId, ids));
    return JSON.stringify(email);
  }

  /** Raw historical mapping state, as an older writer or a pre-canonicalization era left it. */
  async function rawState(seed: Seed, key: string, state: "linked" | "unlinked", memberId: string | null) {
    await getPool().query(
      "insert into member_identity_mapping_state(team_id,provider,external_id,member_id,revision,state,updated_at) values ($1,'gdrive',$2,$3,1,$4,now())",
      [seed.teamId, key, memberId, state]);
  }

  /** Mapping states with numeric revisions (a bigint column may arrive as a string). */
  const statesOf = async (teamId: string, ids: string[]) =>
    (JSON.parse(await identityState(teamId, ids)).states as { external_id: string; state: string; revision: string | number }[])
      .map((s) => ({ external_id: s.external_id, state: s.state, revision: Number(s.revision) }));

  const emailOf = async (seed: Seed, key: string) =>
    resolveByProviderId(await buildIdentityMap(db(), seed.teamId, { strict: true }), "gdrive", key);

  it("zero equivalent tombstones: the ordinary link, and a merely similar address is not equivalent", async () => {
    const seed = await adminTeam();
    const alice = await member(seed, "alice");
    const k = spellings(alice.email);
    // This key CONTAINS the address but is a different address: the canonical comparison rejects it,
    // so it does not block or confuse the decision.
    await legacyTombstone(seed, alice.id, `author-email:x${alice.email}`);
    const name = `docs-${randomUUID().slice(0, 6)}`;
    await publish(seed, S(), alice.email, name);
    expect(await credentialStored(seed.teamId, name)).toBe(true);
    expect(await emailOf(seed, k.canonical)).toBe(alice.id);
  });

  it.each(["mixedAddress", "upperPrefix", "mixedBoth"] as const)(
    "one legacy tombstone (%s) stands: no identity write, no side effects, idempotent",
    async (variant) => {
      const seed = await adminTeam();
      const alice = await member(seed, "alice");
      const k = spellings(alice.email);
      const legacyRevision = await legacyTombstone(seed, alice.id, k[variant]);
      const ids = [k.canonical, k[variant]];
      const before = await sideEffects(seed.teamId, ids);

      const refused = await automatic(seed, alice.id, k.canonical);
      expect(refused).toMatchObject({
        tombstoned: true, created: false, updated: false, conflict: false,
        mappingKey: k[variant], mappingRevision: legacyRevision,
      });
      expect(await automatic(seed, alice.id, k.canonical)).toMatchObject({ tombstoned: true }); // repeated
      expect(await sideEffects(seed.teamId, ids)).toBe(before);

      // Through the publisher: the credential is published, the email stays unlinked. The publication
      // links its never-reviewed subject — its own transition, asserted separately.
      const name = `docs-${randomUUID().slice(0, 6)}`;
      const subject = S();
      const emailBefore = await emailState(seed.teamId, ids);
      await publish(seed, subject, alice.email, name); // Connect
      await publish(seed, subject, alice.email, name); // Reconnect (same subject)
      expect(await credentialStored(seed.teamId, name)).toBe(true);
      expect(await emailState(seed.teamId, ids)).toBe(emailBefore);
      expect(await emailOf(seed, k.canonical)).toBeNull();
      expect(await emailOf(seed, subject)).toBe(alice.id);
    });

  it("several equivalent histories fail closed: no mapping is selected or published", async () => {
    const seed = await adminTeam();
    const alice = await member(seed, "alice");
    const k = spellings(alice.email);
    await legacyTombstone(seed, alice.id, k.mixedAddress);
    await legacyTombstone(seed, alice.id, k.upperPrefix);
    // A legacy linked STATE with no row (another historical record of the same person-key).
    await rawState(seed, k.mixedBoth, "linked", alice.id);
    const ids = [k.canonical, k.mixedAddress, k.upperPrefix, k.mixedBoth];
    const before = await sideEffects(seed.teamId, ids);

    const refused = await automatic(seed, alice.id, k.canonical);
    expect(refused).toMatchObject({ ambiguous: true, created: false, updated: false, conflict: false });
    expect(refused.tombstoned).toBeUndefined();
    expect(refused.mappingKey).toBeUndefined();
    expect(refused.mappingRevision).toBeUndefined();
    expect(await automatic(seed, alice.id, k.canonical)).toMatchObject({ ambiguous: true });
    expect(await sideEffects(seed.teamId, ids)).toBe(before);

    const name = `docs-${randomUUID().slice(0, 6)}`;
    const subject = S();
    const emailBefore = await emailState(seed.teamId, ids);
    await publish(seed, subject, alice.email, name);
    expect(await credentialStored(seed.teamId, name)).toBe(true);
    expect(await emailState(seed.teamId, ids)).toBe(emailBefore);
    expect(await emailOf(seed, k.canonical)).toBeNull();
    expect(await emailOf(seed, subject)).toBe(alice.id); // the subject's own, separate transition
  });

  it("several all-LINKED histories also fail closed; a fenced canonical relink resolves them and reconnect proceeds", async () => {
    const seed = await adminTeam();
    const alice = await member(seed, "alice");
    const k = spellings(alice.email);
    // Two legacy linked histories, no live row, no canonical state.
    await rawState(seed, k.mixedAddress, "linked", alice.id);
    await rawState(seed, k.upperPrefix, "linked", alice.id);
    const ids = [k.canonical, k.mixedAddress, k.upperPrefix];
    const legacyStates = await statesOf(seed.teamId, [k.mixedAddress, k.upperPrefix]);
    const before = await sideEffects(seed.teamId, ids);

    const refused = await automatic(seed, alice.id, k.canonical);
    expect(refused).toMatchObject({ ambiguous: true, created: false, updated: false, conflict: false });
    expect(refused.mappingKey).toBeUndefined();
    expect(await automatic(seed, alice.id, k.canonical)).toMatchObject({ ambiguous: true }); // repeated
    expect(await sideEffects(seed.teamId, ids)).toBe(before);

    // The publisher still publishes the credential and links nothing for the email.
    const name = `docs-${randomUUID().slice(0, 6)}`;
    const subject = S();
    const emailBefore = await emailState(seed.teamId, ids);
    await publish(seed, subject, alice.email, name);
    expect(await credentialStored(seed.teamId, name)).toBe(true);
    expect(await emailState(seed.teamId, ids)).toBe(emailBefore);
    expect(await emailOf(seed, k.canonical)).toBeNull();

    // An explicit relink fenced on exactly the canonical key (never-stated: revision 0) decides.
    const relinked = await setMemberIdentity(db(), seed.teamId, alice.id, { provider: "gdrive", externalId: k.canonical },
      { force: true, expectedRevision: 0, expectedRevisionKey: k.canonical });
    expect(relinked).toMatchObject({ created: true, mappingKey: k.canonical, mappingRevision: 1 });
    expect(await statesOf(seed.teamId, [k.mixedAddress, k.upperPrefix])).toEqual(legacyStates);

    // Reconnect (same subject) succeeds; neither legacy history is rewritten.
    await publish(seed, subject, alice.email, name);
    expect(await emailOf(seed, k.canonical)).toBe(alice.id);
    expect(await statesOf(seed.teamId, [k.mixedAddress, k.upperPrefix])).toEqual(legacyStates);
  });

  it("exactly one legacy history that is not a tombstone keeps the ordinary path", async () => {
    const seed = await adminTeam();
    const alice = await member(seed, "alice");
    const k = spellings(alice.email);
    await rawState(seed, k.mixedBoth, "linked", alice.id);
    expect(await automatic(seed, alice.id, k.canonical)).toMatchObject({ created: true, mappingKey: k.canonical });
    expect(await statesOf(seed.teamId, [k.mixedBoth]))
      .toEqual([{ external_id: k.mixedBoth, state: "linked", revision: 1 }]);
  });

  it("equivalence is JavaScript's alone: Unicode outer whitespace, mixed-case prefix, non-ASCII case fold", async () => {
    const seed = await adminTeam();
    const alice = await member(seed, "alice");
    const bob = await member(seed, "bob");
    const id = randomUUID().slice(0, 6);
    const canonical = `author-email:élodie-${id}@example.com`;
    // Ideographic space before, no-break space after (both stripped by JavaScript `trim`, neither an
    // ASCII space), a mixed-case prefix, padding after the colon, and a non-ASCII upper-case address.
    const legacy = `　Author-EMAIL:  ÉLODIE-${id.toUpperCase()}@EXAMPLE.COM `;
    // A merely similar, unaccented address is a DIFFERENT key and must not count.
    const unaccented = `author-email:elodie-${id}@example.com`;
    await rawState(seed, legacy, "unlinked", null);
    await rawState(seed, unaccented, "unlinked", null);
    const ids = [canonical, legacy, unaccented];
    const before = await sideEffects(seed.teamId, ids);

    expect(await automatic(seed, alice.id, canonical))
      .toMatchObject({ tombstoned: true, mappingKey: legacy, mappingRevision: 1 });
    expect(await sideEffects(seed.teamId, ids)).toBe(before);

    // The live-row side uses the same comparison: Bob's equivalent legacy row is Alice's conflict.
    const other = `author-email:zoë-${id}@example.com`;
    await rawLink(seed, bob.id, `　AUTHOR-EMAIL:ZOË-${id.toUpperCase()}@EXAMPLE.COM`);
    expect(await automatic(seed, alice.id, other)).toMatchObject({ conflict: true, created: false });
  });

  it("revision evidence is byte-exact: a padded canonical key with the matching revision is refused", async () => {
    const seed = await adminTeam();
    const alice = await member(seed, "alice");
    const k = spellings(alice.email);
    await setMemberIdentity(db(), seed.teamId, alice.id, { provider: "gdrive", externalId: k.canonical });
    const removed = await removeMemberIdentity(db(), seed.teamId, { provider: "gdrive", externalId: k.canonical });
    const before = await sideEffects(seed.teamId, [k.canonical]);
    for (const padded of [` ${k.canonical}`, `${k.canonical} `, `${k.canonical} `]) {
      await expect(setMemberIdentity(db(), seed.teamId, alice.id, { provider: "gdrive", externalId: k.canonical },
        { force: true, expectedRevision: removed.mappingRevision, expectedRevisionKey: padded })).rejects.toThrow(/changed concurrently/);
    }
    expect(await sideEffects(seed.teamId, [k.canonical])).toBe(before);
    expect(await statesOf(seed.teamId, [k.canonical]))
      .toEqual([{ external_id: k.canonical, state: "unlinked", revision: removed.mappingRevision }]);
  });

  it("a different live owner under an equivalent spelling is the visible conflict before any tombstone", async () => {
    const seed = await adminTeam();
    const alice = await member(seed, "alice");
    const bob = await member(seed, "bob");
    const k = spellings(alice.email);
    await legacyTombstone(seed, alice.id, k.mixedAddress);
    await rawLink(seed, bob.id, k.upperPrefix); // an inconsistent legacy row held by someone else
    const subject = S();
    const ids = [subject, k.canonical, k.mixedAddress, k.upperPrefix];
    const before = await sideEffects(seed.teamId, ids);

    const refused = await automatic(seed, alice.id, k.canonical);
    expect(refused).toMatchObject({ conflict: true, created: false, updated: false });
    expect(refused.tombstoned).toBeUndefined();
    expect(await sideEffects(seed.teamId, ids)).toBe(before);

    // The publication rolls back whole — the never-reviewed subject included — and publishes nothing.
    const name = `docs-${randomUUID().slice(0, 6)}`;
    await expect(publish(seed, subject, alice.email, name)).rejects.toBeInstanceOf(GoogleIdentityConflictError);
    expect(await credentialStored(seed.teamId, name)).toBe(false);
    expect(await sideEffects(seed.teamId, ids)).toBe(before);
  });

  it("a different live owner of the canonical key is still the conflict when a legacy tombstone exists", async () => {
    const seed = await adminTeam();
    const alice = await member(seed, "alice");
    const bob = await member(seed, "bob");
    const k = spellings(alice.email);
    await legacyTombstone(seed, alice.id, k.mixedBoth);
    await setMemberIdentity(db(), seed.teamId, bob.id, { provider: "gdrive", externalId: k.canonical }, { force: true });
    const before = await identityState(seed.teamId, [k.canonical, k.mixedBoth]);
    await expect(publish(seed, S(), alice.email)).rejects.toBeInstanceOf(GoogleIdentityConflictError);
    expect(await identityState(seed.teamId, [k.canonical, k.mixedBoth])).toBe(before);
  });

  it("unlink is exact-spelling: the canonical spelling removes nothing of a legacy row", async () => {
    const seed = await adminTeam();
    const alice = await member(seed, "alice");
    const k = spellings(alice.email);
    await rawLink(seed, alice.id, k.mixedAddress);
    expect(await removeMemberIdentity(db(), seed.teamId, { provider: "gdrive", externalId: k.canonical }))
      .toEqual({ removed: false });
    const afterCanonical = JSON.parse(await identityState(seed.teamId, [k.canonical, k.mixedAddress]));
    expect(afterCanonical.rows).toEqual([{ external_id: k.mixedAddress, member_id: alice.id }]);
    expect(afterCanonical.states).toEqual([]);

    const removed = await removeMemberIdentity(db(), seed.teamId, { provider: "gdrive", externalId: k.mixedAddress });
    expect(removed).toMatchObject({ removed: true, mappingKey: k.mixedAddress });
    const after = JSON.parse(await identityState(seed.teamId, [k.canonical, k.mixedAddress]));
    expect(after.rows).toEqual([]);
    expect(await statesOf(seed.teamId, [k.canonical, k.mixedAddress]))
      .toEqual([{ external_id: k.mixedAddress, state: "unlinked", revision: removed.mappingRevision }]);
  });

  it("an explicit relink fenced on the canonical key resolves the history, and a reconnect then proceeds", async () => {
    const seed = await adminTeam();
    const alice = await member(seed, "alice");
    const k = spellings(alice.email);
    const legacyA = await legacyTombstone(seed, alice.id, k.mixedAddress);
    await legacyTombstone(seed, alice.id, k.upperPrefix);
    expect(await automatic(seed, alice.id, k.canonical)).toMatchObject({ ambiguous: true });

    // A revision observed for a LEGACY key is never the canonical key's fence.
    await expect(setMemberIdentity(db(), seed.teamId, alice.id, { provider: "gdrive", externalId: k.canonical },
      { force: true, expectedRevision: legacyA, expectedRevisionKey: k.mixedAddress })).rejects.toThrow(/changed concurrently/);
    await expect(setMemberIdentity(db(), seed.teamId, alice.id, { provider: "gdrive", externalId: k.canonical },
      { force: true, expectedRevision: legacyA, expectedRevisionKey: k.canonical })).rejects.toThrow(/changed concurrently/);
    await expect(setMemberIdentity(db(), seed.teamId, alice.id, { provider: "gdrive", externalId: k.canonical },
      { force: true, expectedRevisionKey: k.canonical })).rejects.toThrow(/requires expectedRevision/);

    // The canonical key has never had a state: its fence is 0, on exactly that key.
    const legacyStates = JSON.parse(await identityState(seed.teamId, [k.mixedAddress, k.upperPrefix])).states;
    const relinked = await setMemberIdentity(db(), seed.teamId, alice.id, { provider: "gdrive", externalId: k.canonical },
      { force: true, expectedRevision: 0, expectedRevisionKey: k.canonical });
    expect(relinked).toMatchObject({ created: true, mappingKey: k.canonical, mappingRevision: 1 });
    // The legacy histories are kept, unmerged.
    expect(JSON.parse(await identityState(seed.teamId, [k.mixedAddress, k.upperPrefix])).states).toEqual(legacyStates);
    expect(await emailOf(seed, k.canonical)).toBe(alice.id);

    // Stale evidence: the canonical key moved since revision 0 was observed.
    await expect(setMemberIdentity(db(), seed.teamId, alice.id, { provider: "gdrive", externalId: k.canonical },
      { force: true, expectedRevision: 0, expectedRevisionKey: k.canonical })).rejects.toThrow(/changed concurrently/);

    // Reconnect: the canonical decision governs; the link stands and the credential is published.
    const name = `docs-${randomUUID().slice(0, 6)}`;
    await publish(seed, S(), alice.email, name);
    expect(await credentialStored(seed.teamId, name)).toBe(true);
    expect(await emailOf(seed, k.canonical)).toBe(alice.id);
    expect(await automatic(seed, alice.id, k.canonical)).toMatchObject({ updated: true, mappingKey: k.canonical });
  });

  it("equal revision numbers on different spellings are not interchangeable", async () => {
    const seed = await adminTeam();
    const alice = await member(seed, "alice");
    const k = spellings(alice.email);
    await setMemberIdentity(db(), seed.teamId, alice.id, { provider: "gdrive", externalId: k.canonical });
    const canonical = await removeMemberIdentity(db(), seed.teamId, { provider: "gdrive", externalId: k.canonical });
    await legacyTombstone(seed, alice.id, k.mixedAddress);
    const legacy = await legacyTombstone(seed, alice.id, k.mixedAddress);
    expect(canonical.mappingRevision).toBe(2);
    expect(legacy).toBe(2);

    // Automatic: the canonical key's own tombstone governs, under its own key.
    expect(await automatic(seed, alice.id, k.canonical))
      .toMatchObject({ tombstoned: true, mappingKey: k.canonical, mappingRevision: 2 });

    await expect(setMemberIdentity(db(), seed.teamId, alice.id, { provider: "gdrive", externalId: k.canonical },
      { force: true, expectedRevision: 2, expectedRevisionKey: k.mixedAddress })).rejects.toThrow(/changed concurrently/);
    const relinked = await setMemberIdentity(db(), seed.teamId, alice.id, { provider: "gdrive", externalId: k.canonical },
      { force: true, expectedRevision: 2, expectedRevisionKey: k.canonical });
    expect(relinked).toMatchObject({ created: true, mappingKey: k.canonical, mappingRevision: 3 });
    expect(await statesOf(seed.teamId, [k.mixedAddress]))
      .toEqual([{ external_id: k.mixedAddress, state: "unlinked", revision: 2 }]);
  });

  it("publication-first overlap: an unlink of an equivalent spelling queued behind a publication never yields a canonical link, nor does a later reconnect", async () => {
    const seed = await adminTeam();
    const alice = await member(seed, "alice");
    const k = spellings(alice.email);
    await legacyTombstone(seed, alice.id, k.upperPrefix);
    await rawLink(seed, alice.id, k.mixedAddress); // alice's live legacy row
    const emailIds = [k.canonical, k.upperPrefix, k.mixedAddress];
    const subject = S();

    // Publication first: it holds the identity authority; the unlink queues behind it and lands last.
    const publishing = gate();
    const name = `docs-${randomUUID().slice(0, 6)}`;
    const oauth = settled(publishGoogleDriveOAuthCredential({
      teamId: seed.teamId, memberId: seed.memberId, integrationName: name,
      clientId: "oauth-client", clientSecret: "client-secret", subject, email: alice.email, emailVerified: true,
      refreshToken: "refresh-race", grantMode: "files", scopes: ["openid", "https://www.googleapis.com/auth/drive.file"],
    }, { afterLocks: async () => { publishing.reached(); await publishing.open; } }));
    let unlinking: Settled<unknown> | undefined;
    try {
      await publishing.at;
      unlinking = settled(removeMemberIdentity(db(), seed.teamId, { provider: "gdrive", externalId: k.mixedAddress }));
      await waitForOneAdvisoryWaiter();
    } finally {
      publishing.release();
      await oauth;
      await unlinking;
    }
    expect((await oauth).error).toBeNull(); // one legacy tombstone stood: no email write
    expect((await unlinking!).error).toBeNull();
    expect(await credentialStored(seed.teamId, name)).toBe(true);
    const afterRace = JSON.parse(await identityState(seed.teamId, emailIds));
    expect(afterRace.rows).toEqual([]);
    expect(afterRace.states.map((s: { external_id: string; state: string }) => [s.external_id, s.state]).sort())
      .toEqual([[k.mixedAddress, "unlinked"], [k.upperPrefix, "unlinked"]].sort());

    // Sequential, after the unlink committed (NOT an overlap — see the next case): two legacy histories,
    // so a reconnect with the same subject links nothing for the email.
    const before = await emailState(seed.teamId, emailIds);
    await publish(seed, subject, alice.email, name);
    expect(await emailState(seed.teamId, emailIds)).toBe(before);
    expect(await emailOf(seed, k.canonical)).toBeNull();
  });

  it("unlink-first overlap: a publication queued behind a held unlink boundary never yields a canonical link", async () => {
    const seed = await adminTeam();
    const alice = await member(seed, "alice");
    const k = spellings(alice.email);
    await legacyTombstone(seed, alice.id, k.upperPrefix);
    await rawLink(seed, alice.id, k.mixedAddress); // alice's live legacy row
    const emailIds = [k.canonical, k.upperPrefix, k.mixedAddress];
    const subject = S();
    const name = `docs-${randomUUID().slice(0, 6)}`;

    // The unlink holds the team's identity mutation boundary (the writer joins that transaction) and
    // parks before committing; no production hook is involved.
    const holding = gate();
    const unlinking = settled(withIdentityMutationBoundary(seed.teamId, async () => {
      const removed = await removeMemberIdentity(db(), seed.teamId, { provider: "gdrive", externalId: k.mixedAddress });
      holding.reached();
      await holding.open;
      return removed;
    }));
    let oauth: Settled<unknown> | undefined;
    try {
      await holding.at;
      // Started from the TEST's context, outside the held boundary's async context, so it opens its own
      // transaction and queues on the team authority instead of joining the unlink's transaction.
      oauth = settled(publish(seed, subject, alice.email, name));
      await waitForOneAdvisoryWaiter();
    } finally {
      holding.release();
      await unlinking;
      await oauth;
    }
    expect((await unlinking).error).toBeNull();
    expect((await unlinking).value).toMatchObject({ removed: true, mappingKey: k.mixedAddress });
    // The publication saw the committed unlink: two legacy histories, no canonical decision → no email link.
    expect((await oauth!).error).toBeNull();
    expect(await credentialStored(seed.teamId, name)).toBe(true);
    const after = JSON.parse(await identityState(seed.teamId, emailIds));
    expect(after.rows).toEqual([]);
    expect(after.states.map((s: { external_id: string; state: string }) => [s.external_id, s.state]).sort())
      .toEqual([[k.mixedAddress, "unlinked"], [k.upperPrefix, "unlinked"]].sort());
    expect(await emailOf(seed, k.canonical)).toBeNull();
    expect(await emailOf(seed, subject)).toBe(alice.id);
  });

  it("opaque ids stay case-sensitive: a tombstone on one spelling never blocks another", async () => {
    const seed = await adminTeam();
    const alice = await member(seed, "alice");
    await setMemberIdentity(db(), seed.teamId, alice.id, { provider: "gdrive", externalId: "permission:AbC123" });
    await removeMemberIdentity(db(), seed.teamId, { provider: "gdrive", externalId: "permission:AbC123" });
    expect(await automatic(seed, alice.id, "permission:abc123")).toMatchObject({ created: true, mappingKey: "permission:abc123" });

    // Letters guaranteed, so the upper-case spelling is always a different opaque id.
    const subject = `subject:abc${randomUUID().slice(0, 8)}`;
    const upper = `subject:${subject.slice("subject:".length).toUpperCase()}`;
    await setMemberIdentity(db(), seed.teamId, alice.id, { provider: "gdrive", externalId: upper });
    await removeMemberIdentity(db(), seed.teamId, { provider: "gdrive", externalId: upper });
    await publish(seed, subject, alice.email);
    const map = await buildIdentityMap(db(), seed.teamId, { strict: true });
    expect(resolveByProviderId(map, "gdrive", subject)).toBe(alice.id);
    expect(resolveByProviderId(map, "gdrive", upper)).toBeNull();
  });

  // --------------------------------------------------------------------------------------------- //
  // Combined final review §2: the same member's STANDING legacy spelling is preserved, not refused
  // --------------------------------------------------------------------------------------------- //

  it.each([
    { name: "no mapping state", linkedState: false },
    { name: "one linked legacy state", linkedState: true },
  ])("a same-member legacy live spelling ($name) is preserved: credential publishes, history byte-exact", async ({ linkedState }) => {
    const seed = await adminTeam();
    const alice = await member(seed, "alice");
    const k = spellings(alice.email);
    // Mixed case and outer whitespace, exactly as a pre-canonicalization writer stored it.
    const legacy = `  ${k.mixedBoth}  `;
    await rawLink(seed, alice.id, legacy);
    if (linkedState) await rawState(seed, legacy, "linked", alice.id);
    const ids = [k.canonical, legacy];
    const before = await sideEffects(seed.teamId, ids);

    const preserved = await automatic(seed, alice.id, k.canonical);
    expect(preserved).toMatchObject({
      preserved: true, preservedKeys: [legacy], created: false, updated: false, conflict: false,
    });
    expect(preserved.tombstoned).toBeUndefined();
    expect(preserved.ambiguous).toBeUndefined();
    expect(preserved.mappingRevision).toBeUndefined(); // no unobserved revision is claimed
    expect(await automatic(seed, alice.id, k.canonical)).toMatchObject({ preserved: true }); // repeated
    expect(await sideEffects(seed.teamId, ids)).toBe(before); // rows, histories, repair, revision, epoch, audit

    // Through the publisher: no generic failure, the credential is stored, the outcome is typed.
    const name = `docs-${randomUUID().slice(0, 6)}`;
    const subject = S();
    const emailBefore = await emailState(seed.teamId, ids);
    const published = await publish(seed, subject, alice.email, name);
    expect(published.identity).toEqual({ subject: "linked", email: "preserved" });
    expect(await credentialStored(seed.teamId, name)).toBe(true);
    expect(await emailState(seed.teamId, ids)).toBe(emailBefore); // the legacy row's bytes are unchanged
    // The standing owner resolves canonical connector evidence.
    expect(await emailOf(seed, k.canonical)).toBe(alice.id);

    // Explicit Admin linking keeps its unlink-first refusal for a differently spelled live mapping.
    await expect(setMemberIdentity(db(), seed.teamId, alice.id, { provider: "gdrive", externalId: k.canonical },
      { force: true, expectedRevision: 0, expectedRevisionKey: k.canonical })).rejects.toThrow(/differently spelled/);
    expect(await emailState(seed.teamId, ids)).toBe(emailBefore);
  });

  it("a same-member live legacy spelling beside a legacy tombstone or several histories is held, not preserved", async () => {
    const seed = await adminTeam();
    const alice = await member(seed, "alice");
    const k = spellings(alice.email);
    await rawLink(seed, alice.id, k.mixedAddress);
    await rawState(seed, k.upperPrefix, "unlinked", null);
    expect(await automatic(seed, alice.id, k.canonical)).toMatchObject({ tombstoned: true, mappingKey: k.upperPrefix });
    await rawState(seed, k.mixedBoth, "linked", alice.id);
    const refused = await automatic(seed, alice.id, k.canonical);
    expect(refused).toMatchObject({ ambiguous: true });
    expect(refused.preserved).toBeUndefined();
    const published = await publish(seed, S(), alice.email);
    expect(published.identity.email).toBe("ambiguous");
    expect(await emailOf(seed, k.canonical)).toBeNull(); // the reader holds it too
  });

  it("history decisions do not depend on row order", async () => {
    // The same equivalent histories, stored in opposite orders in two teams, decide identically.
    for (const order of [[0, 1], [1, 0]]) {
      const seed = await adminTeam();
      const alice = await member(seed, "alice");
      const k = spellings(alice.email);
      const histories: [string, "linked" | "unlinked"][] = [[k.upperPrefix, "unlinked"], [k.mixedBoth, "linked"]];
      for (const index of order) await rawState(seed, histories[index][0], histories[index][1], alice.id);
      expect(await automatic(seed, alice.id, k.canonical)).toMatchObject({ ambiguous: true });
      const map = await buildIdentityMap(db(), seed.teamId, { strict: true });
      expect(providerIdentityState(map, "gdrive", k.canonical)).toBe("ambiguous");
      expect(providerIdentityState(map, "gdrive", ` ${k.mixedAddress} `)).toBe("ambiguous");
    }
  });
});
