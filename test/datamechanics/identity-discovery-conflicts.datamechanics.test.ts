import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import { getPool } from "@/lib/db/pg/pool";
import type { DbClient } from "@/lib/db/types";
import { listIdentityDiscoveryConflicts, type IdentityConflictPage } from "@/lib/identity/discovery-conflicts";
import { discoverMemberIdentity, removeMemberIdentity, setMemberIdentity } from "@/lib/identity/member-identities";
import { db, placeMemberByTier, seedTeam, type Seed } from "./helpers";

/**
 * AIO-1167 R45 (AC-08) — the Admin diagnostic for refused automatic identity links, on real Postgres.
 *
 * Spec (Astra adjudication). A refused automatic link — a connector observed an account whose
 * confirmed email names member A while an UNREVIEWED legacy mapping gives it to B — is visible to a
 * team Admin: when it was last observed, which account, the candidate, who held it then, and the
 * mapping as it stands NOW. Repeats fold into one row; rows page newest first without duplicates. The
 * current state is re-read, so a later remap or unlink reads as resolved history. Only allowlisted
 * fields leave the projection. A read failure is `unavailable`, never an empty list. Only an active
 * admin of THAT team at team posture may read it. A reviewed mapping or an unlink tombstone is never
 * a conflict, whatever email is observed later — and nothing here changes a mapping.
 */

async function member(seed: Seed, name: string, over: Partial<{ role: string; status: string }> = {}) {
  const { data } = await db().from("members").insert({
    team_id: seed.teamId, email: `${name}-${randomUUID().slice(0, 6)}@example.com`, display_name: name,
    actor_handle: `${name}-${randomUUID().slice(0, 6)}`, role: over.role ?? "member", tier: "team",
    status: over.status ?? "active",
  }).select("id").single();
  return (data as { id: string }).id;
}

async function adminOf(seed: Seed): Promise<string> {
  await db().from("members").update({ role: "admin" }).eq("id", seed.memberId).eq("team_id", seed.teamId);
  await placeMemberByTier(seed.teamId, seed.memberId, "team");
  return seed.memberId;
}

/** A LEGACY mapping: a member_identities row with no mapping-state row (never reviewed). */
async function legacyMapping(seed: Seed, memberId: string, externalId: string) {
  await getPool().query(
    "insert into member_identities(team_id, member_id, provider, external_id, handle, email) values ($1,$2,'gdrive',$3,'','')",
    [seed.teamId, memberId, externalId]);
}

const refuse = (seed: Seed, candidate: string, externalId: string) =>
  discoverMemberIdentity(db(), seed.teamId, candidate, { provider: "gdrive", externalId, email: "observed@example.com" },
    { actor: { kind: "api_key", memberId: candidate } });

function ok(page: IdentityConflictPage) {
  expect(page.status).toBe("ok");
  if (page.status !== "ok") throw new Error("unreachable");
  return page;
}

async function conflictEvents(teamId: string) {
  return (await getPool().query(
    "select 1 from audit_log where team_id=$1 and action='identity.discovery_conflict'", [teamId])).rows.length;
}

describe("refused automatic identity links — the Admin diagnostic (R45, real Postgres)", () => {
  it("shows a legacy conflict once with its repeats, allowlisted, and tracks remap then unlink as history", async () => {
    const seed = await seedTeam();
    const viewer = { teamId: seed.teamId, memberId: await adminOf(seed) };
    const alice = await member(seed, "alice");
    const bob = await member(seed, "bob");
    await legacyMapping(seed, bob, "permission:L");
    expect(await refuse(seed, alice, "permission:L")).toBe("conflict");
    expect(await refuse(seed, alice, "permission:L")).toBe("conflict"); // a repeat push

    const page = ok(await listIdentityDiscoveryConflicts(db(), viewer));
    expect(page.rows).toHaveLength(1);
    const [row] = page.rows;
    expect(row).toMatchObject({
      occurrences: 2, provider: "gdrive", externalId: "permission:L",
      candidate: { id: alice, displayName: "alice" }, heldThen: { id: bob, displayName: "bob" },
      current: { state: "unreviewed", holder: { id: bob, displayName: "bob" }, revision: 0 },
      standing: "still_conflicting",
    });
    // Allowlisted fields only: no raw audit metadata, actor, key, email or content.
    expect(Object.keys(row).sort()).toEqual(
      ["candidate", "current", "externalId", "heldThen", "observedAt", "occurrences", "provider", "standing"]);
    expect(JSON.stringify(page)).not.toMatch(/observed@example\.com|api_key|mapped_member_id|meta/);
    // Nothing about the mapping was changed by reading it.
    const holder = (await getPool().query(
      "select member_id from member_identities where team_id=$1 and external_id='permission:L'", [seed.teamId])).rows;
    expect(holder).toEqual([{ member_id: bob }]);

    // The Admin remaps it to the candidate with the existing control: the event is now history.
    await setMemberIdentity(db(), seed.teamId, alice, { provider: "gdrive", externalId: "permission:L" }, { force: true });
    const remapped = ok(await listIdentityDiscoveryConflicts(db(), viewer)).rows[0];
    expect(remapped.current.state).toBe("linked");
    expect(remapped.current.holder?.id).toBe(alice);
    expect(remapped.current.revision).toBeGreaterThan(0);
    expect(remapped.standing).toBe("now_candidate");
    expect(remapped.heldThen?.id).toBe(bob); // the historical fact is unchanged

    // …and unlinks it: still listed as history, current state unlinked.
    await removeMemberIdentity(db(), seed.teamId, { provider: "gdrive", externalId: "permission:L" });
    const unlinked = ok(await listIdentityDiscoveryConflicts(db(), viewer)).rows[0];
    expect(unlinked).toMatchObject({ current: { state: "unlinked", holder: null }, standing: "unlinked" });
  });

  it("pages newest first, without duplicates, to the end", async () => {
    const seed = await seedTeam();
    const viewer = { teamId: seed.teamId, memberId: await adminOf(seed) };
    const alice = await member(seed, "alice");
    const bob = await member(seed, "bob");
    for (const id of ["permission:P1", "permission:P2", "permission:P3"]) {
      await legacyMapping(seed, bob, id);
      expect(await refuse(seed, alice, id)).toBe("conflict");
    }
    const first = ok(await listIdentityDiscoveryConflicts(db(), viewer, { limit: 2 }));
    expect(first.rows.map((r) => r.externalId)).toEqual(["permission:P3", "permission:P2"]);
    expect(first.nextCursor).not.toBeNull();
    const second = ok(await listIdentityDiscoveryConflicts(db(), viewer, { limit: 2, cursor: first.nextCursor }));
    expect(second.rows.map((r) => r.externalId)).toEqual(["permission:P1"]);
    expect(second.nextCursor).toBeNull();
    // An unreadable cursor starts from the top rather than failing or skipping.
    expect(ok(await listIdentityDiscoveryConflicts(db(), viewer, { limit: 2, cursor: "garbage" })).rows).toHaveLength(2);
  });

  it("a read failure is UNAVAILABLE, never an empty list", async () => {
    const seed = await seedTeam();
    const viewer = { teamId: seed.teamId, memberId: await adminOf(seed) };
    const failing = { from: () => { throw new Error("database unavailable"); } } as unknown as DbClient;
    expect(await listIdentityDiscoveryConflicts(failing, viewer)).toEqual({ status: "unavailable" });
  });

  it("only an active admin of THAT team at team posture may read it; other teams see none of it", async () => {
    const seed = await seedTeam();
    await adminOf(seed);
    const alice = await member(seed, "alice");
    const bob = await member(seed, "bob");
    await legacyMapping(seed, bob, "permission:X");
    expect(await refuse(seed, alice, "permission:X")).toBe("conflict");

    const other = await seedTeam();
    const otherAdmin = await adminOf(other);
    // A different team's admin, asking for this team: refused. Asking for their own: none of ours.
    expect(await listIdentityDiscoveryConflicts(db(), { teamId: seed.teamId, memberId: otherAdmin })).toEqual({ status: "forbidden" });
    expect(ok(await listIdentityDiscoveryConflicts(db(), { teamId: other.teamId, memberId: otherAdmin })).rows).toEqual([]);

    const plain = await member(seed, "plain");
    await placeMemberByTier(seed.teamId, plain, "team");
    expect(await listIdentityDiscoveryConflicts(db(), { teamId: seed.teamId, memberId: plain })).toEqual({ status: "forbidden" });

    const inactive = await member(seed, "inactive-admin", { role: "admin", status: "invited" });
    await placeMemberByTier(seed.teamId, inactive, "team");
    expect(await listIdentityDiscoveryConflicts(db(), { teamId: seed.teamId, memberId: inactive })).toEqual({ status: "forbidden" });

    const externalAdmin = await member(seed, "external-admin", { role: "admin" });
    await placeMemberByTier(seed.teamId, externalAdmin, "external");
    expect(await listIdentityDiscoveryConflicts(db(), { teamId: seed.teamId, memberId: externalAdmin })).toEqual({ status: "forbidden" });
  });

  it("a reviewed mapping and an unlink tombstone are never conflicts, whatever email is observed later", async () => {
    const seed = await seedTeam();
    const viewer = { teamId: seed.teamId, memberId: await adminOf(seed) };
    const alice = await member(seed, "alice");
    const bob = await member(seed, "bob");
    await setMemberIdentity(db(), seed.teamId, bob, { provider: "gdrive", externalId: "permission:R" }); // reviewed → bob
    await setMemberIdentity(db(), seed.teamId, bob, { provider: "gdrive", externalId: "permission:T" });
    await removeMemberIdentity(db(), seed.teamId, { provider: "gdrive", externalId: "permission:T" }); // tombstone

    expect(await refuse(seed, alice, "permission:R")).toBe("reviewed");
    expect(await refuse(seed, alice, "permission:T")).toBe("reviewed");
    expect(await conflictEvents(seed.teamId)).toBe(0);
    expect(ok(await listIdentityDiscoveryConflicts(db(), viewer)).rows).toEqual([]);
    // Both decisions stand, untouched.
    const rows = (await getPool().query(
      "select external_id, member_id from member_identities where team_id=$1 order by external_id", [seed.teamId])).rows;
    expect(rows).toEqual([{ external_id: "permission:R", member_id: bob }]);
    const states = (await getPool().query(
      "select external_id, state from member_identity_mapping_state where team_id=$1 order by external_id", [seed.teamId])).rows;
    expect(states).toEqual([{ external_id: "permission:R", state: "linked" }, { external_id: "permission:T", state: "unlinked" }]);
  });
});
