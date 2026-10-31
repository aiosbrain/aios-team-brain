import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import { getPool } from "@/lib/db/pg/pool";
import { buildIdentityMap, resolveByProviderId } from "@/lib/identity/resolve";
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
