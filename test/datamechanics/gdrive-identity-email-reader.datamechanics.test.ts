import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import { getPool, withTransaction } from "@/lib/db/pg/pool";
import { db, driveFixture, seedTeam, type Seed } from "./helpers";
import {
  advanceIdentityMappingState, removeMemberIdentity, setMemberIdentity,
} from "@/lib/identity/member-identities";
import { buildIdentityMap, providerIdentityState, resolveByProviderId } from "@/lib/identity/resolve";
import { parseAuthorRefs, resolveAuthors } from "@/lib/attribution/resolve-authors";
import { googleDriveContributionEvidence } from "@/lib/dashboard/gdrive-contributions";
import { drainIdentityRepairs, runIdentityRepairObligation } from "@/lib/ingest/identity-repair";
import { reattributeItems } from "@/lib/ingest/reattribute";

/**
 * AIO-1167 PR743 — Google `author-email:` authority is the SAME in readers as in the writer (combined
 * final review §2; PR714 Google-reader extension decision). Real Postgres, through the actual callers:
 * author resolution, contribution persistence/evidence, the per-key repair drain, historical
 * reattribution and the Timeline projection.
 *
 *  * A legacy unlink under another spelling blocks canonical connector evidence AND its roster-email
 *    fallback; an explicit, fenced canonical relink restores resolution while the old history stays.
 *  * Several equivalent histories (linked/linked, linked/unlinked) are ambiguous: no credit and no
 *    fallback — but, unlike a definite unlink, established item credit is not erased: neither by
 *    historical reattribution nor by draining a CURRENT per-key repair obligation (R51), where a remap
 *    still reassigns and a definite unlink still clears.
 *  * An email-key repair batch counts its whole scanned page, even with no matching candidate (R51 L2).
 *  * A standing legacy owner resolves canonical evidence; a repair obligation nominates equivalent
 *    evidence with whitespace, prefix case and non-ASCII case, even without the optional email.
 *  * Opaque ids, other providers (Slack/Linear lookalikes) and other teams are unaffected.
 */

async function member(seed: Seed, name: string, email: string): Promise<string> {
  const { data, error } = await db().from("members").insert({
    team_id: seed.teamId, email, display_name: name,
    actor_handle: `${name.toLowerCase()}-${randomUUID().slice(0, 8)}`,
    role: "member", tier: "team", status: "active", is_connector: false,
  }).select("id").single();
  if (error || !data) throw new Error(`member seed failed: ${error?.message}`);
  return (data as { id: string }).id;
}

/** A Drive document whose author and contribution evidence carry `externalId` (and `email`, if any). */
async function emailItem(seed: Seed, suffix: string, externalId: string, email?: string) {
  const evidence = { external_id: externalId, ...(email ? { email } : {}), role: "editor" };
  const result = await driveFixture(seed, {
    project: "drive-email-reader",
    path: `gdrive/${suffix}-${randomUUID()}.md`,
    body: `body ${suffix}`,
    frontmatter: {
      source: "gdrive", source_id: `doc-${suffix}-${randomUUID().slice(0, 6)}`,
      source_url: `https://docs.google.com/document/d/doc-${suffix}/edit`, title: `Drive ${suffix}`,
      authors: [{ provider: "gdrive", ...evidence }],
      contributions: [{ ...evidence, at: "2026-09-21T04:30:00-04:00" }],
    },
  }, { unclaimed: true, access: "team", attribution: { authorMemberId: null } });
  await db().from("items").update({ member_id: null }).eq("id", result.id);
  await db().from("item_versions").update({ member_id: null }).eq("item_id", result.id);
  return result.id;
}

async function rawLink(seed: Seed, memberId: string, provider: string, key: string) {
  await getPool().query(
    "insert into member_identities(team_id, member_id, provider, external_id, handle, email) values ($1,$2,$3,$4,'','')",
    [seed.teamId, memberId, provider, key]);
}

async function rawState(seed: Seed, provider: string, key: string, state: "linked" | "unlinked", memberId: string | null) {
  await getPool().query(
    "insert into member_identity_mapping_state(team_id,provider,external_id,member_id,revision,state,updated_at) values ($1,$2,$3,$4,1,$5,now())",
    [seed.teamId, provider, key, memberId, state]);
}

async function itemCredit(itemId: string) {
  const item = (await db().from("items").select("member_id,frontmatter").eq("id", itemId).single()).data as {
    member_id: string | null; frontmatter: Record<string, unknown>;
  };
  const versions = ((await db().from("item_versions").select("member_id").eq("item_id", itemId)).data ?? []) as {
    member_id: string | null;
  }[];
  const evidence = ((await db().from("gdrive_contribution_evidence").select("member_id,diagnostic")
    .eq("item_id", itemId)).data ?? []) as { member_id: string | null; diagnostic: string | null }[];
  return { item: item.member_id, frontmatter: item.frontmatter, versions: versions.map((v) => v.member_id), evidence };
}

/** Every reader a Google document's credit passes through, at the current mapping state. */
async function readers(seed: Seed, itemId: string) {
  const map = await identityMap(seed);
  const { frontmatter } = await itemCredit(itemId);
  return {
    author: resolveAuthors(map, parseAuthorRefs(frontmatter), new Set()).memberId,
    projection: googleDriveContributionEvidence(frontmatter, itemId, map).map((row) => row.memberId),
  };
}

/** The attribution writers' map (strict, deactivated members' established mappings included). */
function identityMap(seed: Seed) {
  return buildIdentityMap(db(), seed.teamId, { strict: true, includeDeactivated: true });
}

describe("PR743 — Google email authority through the real readers", () => {
  it("a legacy unlink blocks canonical evidence and roster-email fallback until a fenced canonical relink", async () => {
    const seed = await seedTeam();
    const address = `alice-${randomUUID().slice(0, 6)}@example.com`;
    const alice = await member(seed, "Alice", address);
    const canonical = `author-email:${address}`;
    const legacy = `AUTHOR-EMAIL:${address.toUpperCase()}`;
    const itemId = await emailItem(seed, "unlink", canonical, address);

    // Never reviewed: the roster email is a legitimate exact fallback (the exposure under test).
    await reattributeItems(db(), seed.teamId, { batchSize: 50 });
    expect((await itemCredit(itemId)).item).toBe(alice);
    expect(await readers(seed, itemId)).toEqual({ author: alice, projection: [alice] });

    // A legacy spelling is deliberately unlinked; the connector keeps emitting the canonical key + email.
    await rawLink(seed, alice, "gdrive", legacy);
    const removed = await removeMemberIdentity(db(), seed.teamId, { provider: "gdrive", externalId: legacy });
    expect(removed).toMatchObject({ removed: true, mappingKey: legacy });
    // The per-key repair of the LEGACY obligation nominates the canonical evidence and clears credit.
    await drainIdentityRepairs(db(), { maxObligations: 10, batchSize: 10 });
    let credit = await itemCredit(itemId);
    expect(credit.item).toBeNull();
    expect(credit.versions.length).toBeGreaterThan(0);
    expect(credit.versions.every((v) => v === null)).toBe(true);
    expect(credit.evidence.length).toBeGreaterThan(0);
    expect(credit.evidence.every((row) => row.member_id === null)).toBe(true);
    expect(await readers(seed, itemId)).toEqual({ author: null, projection: [] });

    // Historical reattribution honours the same authority: credit put back by hand is cleared again.
    await db().from("items").update({ member_id: alice }).eq("id", itemId);
    await reattributeItems(db(), seed.teamId, { batchSize: 50 });
    expect((await itemCredit(itemId)).item).toBeNull();

    // An explicit canonical relink, fenced on exactly the canonical key, restores resolution; the
    // legacy history is retained untouched.
    await setMemberIdentity(db(), seed.teamId, alice, { provider: "gdrive", externalId: canonical },
      { force: true, expectedRevision: 0, expectedRevisionKey: canonical });
    await drainIdentityRepairs(db(), { maxObligations: 10, batchSize: 10 });
    credit = await itemCredit(itemId);
    expect(credit.item).toBe(alice);
    expect(credit.evidence.every((row) => row.member_id === alice)).toBe(true);
    expect(await readers(seed, itemId)).toEqual({ author: alice, projection: [alice] });
    const { rows: history } = await getPool().query(
      "select state, revision from member_identity_mapping_state where team_id=$1 and provider='gdrive' and external_id=$2",
      [seed.teamId, legacy]);
    expect(history.map((row) => [row.state, Number(row.revision)])).toEqual([["unlinked", removed.mappingRevision]]);
  });

  it.each([
    { name: "linked/linked", states: ["linked", "linked"] as const },
    { name: "linked/unlinked", states: ["linked", "unlinked"] as const },
  ])("several equivalent histories ($name) are ambiguous: no credit or fallback, but not an unlink", async ({ states }) => {
    const seed = await seedTeam();
    const address = `bea-${randomUUID().slice(0, 6)}@example.com`;
    const bea = await member(seed, "Bea", address);
    const canonical = `author-email:${address}`;
    const itemId = await emailItem(seed, "ambiguous", canonical, address);
    await rawState(seed, "gdrive", `Author-Email:${address.toUpperCase()}`, states[0], bea);
    await rawState(seed, "gdrive", `author-email: ${address} `, states[1], bea);

    const map = await identityMap(seed);
    expect(providerIdentityState(map, "gdrive", canonical)).toBe("ambiguous");
    expect(await readers(seed, itemId)).toEqual({ author: null, projection: [] });

    // Established credit is not erased by an ambiguity (only a definite unlink does that), but the
    // recomputed contribution evidence is unresolved.
    await db().from("items").update({ member_id: bea }).eq("id", itemId);
    await reattributeItems(db(), seed.teamId, { batchSize: 50 });
    const credit = await itemCredit(itemId);
    expect(credit.item).toBe(bea);
    expect(credit.evidence.length).toBeGreaterThan(0);
    expect(credit.evidence.every((row) => row.member_id === null && row.diagnostic === "unresolved_identity")).toBe(true);
  });

  it("canonical state governs older histories in readers: canonical unlinked over legacy linked blocks", async () => {
    const seed = await seedTeam();
    const address = `cy-${randomUUID().slice(0, 6)}@example.com`;
    const cy = await member(seed, "Cy", address);
    const canonical = `author-email:${address}`;
    await setMemberIdentity(db(), seed.teamId, cy, { provider: "gdrive", externalId: canonical });
    await removeMemberIdentity(db(), seed.teamId, { provider: "gdrive", externalId: canonical });
    await rawState(seed, "gdrive", `AUTHOR-EMAIL:${address}`, "linked", cy);
    const itemId = await emailItem(seed, "canonical-unlinked", canonical, address);
    const map = await identityMap(seed);
    expect(providerIdentityState(map, "gdrive", canonical)).toBe("unlinked");
    expect(await readers(seed, itemId)).toEqual({ author: null, projection: [] });
  });

  it("a standing legacy owner resolves canonical evidence; repair nominates equivalent keys without an email", async () => {
    const seed = await seedTeam();
    const dee = await member(seed, "Dee", `dee-${randomUUID().slice(0, 6)}@example.com`);
    const id = randomUUID().slice(0, 6);
    // A legacy live row (mixed case, padded) with no history resolves the canonical connector key.
    await rawLink(seed, dee, "gdrive", `  Author-Email: DEE-${id.toUpperCase()}@EXAMPLE.COM `);
    const map = await buildIdentityMap(db(), seed.teamId, { strict: true, includeDeactivated: true });
    expect(resolveByProviderId(map, "gdrive", `author-email:dee-${id}@example.com`)).toBe(dee);

    // Evidence spelled with prefix/address whitespace, upper case and a NON-ASCII address, and no
    // optional email: the canonical obligation's drain still nominates and repairs it.
    const elodie = await member(seed, "Elodie", `elodie-${id}@example.org`);
    const canonical = `author-email:élodie-${id}@example.com`;
    const itemId = await emailItem(seed, "unicode", `  AUTHOR-EMAIL:  ÉLODIE-${id.toUpperCase()}@EXAMPLE.COM `);
    expect((await itemCredit(itemId)).item).toBeNull();
    await setMemberIdentity(db(), seed.teamId, elodie, { provider: "gdrive", externalId: canonical });
    await drainIdentityRepairs(db(), { maxObligations: 10, batchSize: 10 });
    const credit = await itemCredit(itemId);
    expect(credit.item).toBe(elodie);
    expect(credit.evidence.length).toBeGreaterThan(0);
    expect(credit.evidence.every((row) => row.member_id === elodie)).toBe(true);
    // Repeating the drain is idempotent.
    await drainIdentityRepairs(db(), { maxObligations: 10, batchSize: 10 });
    expect((await itemCredit(itemId)).item).toBe(elodie);
  });

  it("opaque ids, other providers and other teams are untouched by Google email equivalence", async () => {
    const seed = await seedTeam();
    const address = `eve-${randomUUID().slice(0, 6)}@example.com`;
    const eve = await member(seed, "Eve", address);
    const zed = await member(seed, "Zed", `zed-${randomUUID().slice(0, 6)}@example.com`);
    // Slack/Linear lookalikes keep their own (lowercasing, exact-key) semantics and never hold Google.
    await rawLink(seed, zed, "slack", `AUTHOR-EMAIL:${address.toUpperCase()}`);
    await rawState(seed, "linear", `author-email:${address}`, "unlinked", null);
    await rawLink(seed, eve, "gdrive", "permission:AbC123");
    const map = await buildIdentityMap(db(), seed.teamId, { strict: true });
    expect(resolveByProviderId(map, "slack", `author-email:${address}`)).toBe(zed);
    expect(providerIdentityState(map, "linear", `author-email:${address}`)).toBe("unlinked");
    expect(providerIdentityState(map, "gdrive", `author-email:${address}`)).toBeNull();
    expect(resolveByProviderId(map, "gdrive", "permission:AbC123")).toBe(eve);
    expect(resolveByProviderId(map, "gdrive", "permission:abc123")).toBeNull();
    const itemId = await emailItem(seed, "controls", `author-email:${address}`, address);
    expect(await readers(seed, itemId)).toEqual({ author: eve, projection: [eve] }); // roster fallback intact

    // Another team's legacy unlink of the same address decides nothing here.
    const other = await seedTeam();
    const otherEve = await member(other, "Eve", address);
    await rawLink(other, otherEve, "gdrive", `AUTHOR-EMAIL:${address}`);
    await removeMemberIdentity(db(), other.teamId, { provider: "gdrive", externalId: `AUTHOR-EMAIL:${address}` });
    expect(await readers(seed, itemId)).toEqual({ author: eve, projection: [eve] });
  });

  it.each([
    {
      name: "linked/linked",
      // A legacy linked history, then a second equivalent spelling linked through the mapping owner
      // itself (as a legacy seed did): that revision carries a current per-key obligation.
      async ambiguate(seed: Seed, memberId: string, address: string) {
        await rawState(seed, "gdrive", `Author-Email:${address.toUpperCase()}`, "linked", memberId);
        const key = `author-email: ${address} `;
        await rawLink(seed, memberId, "gdrive", key);
        const revision = await withTransaction(() => advanceIdentityMappingState({
          teamId: seed.teamId, provider: "gdrive", externalId: key, memberId, state: "linked",
        }));
        return { key, revision };
      },
    },
    {
      name: "linked/unlinked",
      // A legacy linked history, and an explicit exact unlink of a second, live spelling.
      async ambiguate(seed: Seed, memberId: string, address: string) {
        await rawState(seed, "gdrive", `Author-Email:${address.toUpperCase()}`, "linked", memberId);
        const key = `author-email: ${address} `;
        await rawLink(seed, memberId, "gdrive", key);
        const removed = await removeMemberIdentity(db(), seed.teamId, { provider: "gdrive", externalId: key });
        if (removed.mappingRevision === undefined) throw new Error("the unlink recorded no mapping revision");
        return { key, revision: removed.mappingRevision };
      },
    },
  ])("the per-key repair under an ambiguous history ($name) keeps established credit and grants none", async ({ ambiguate }) => {
    const seed = await seedTeam();
    const address = `fay-${randomUUID().slice(0, 6)}@example.com`;
    const fay = await member(seed, "Fay", address);
    const canonical = `author-email:${address}`;
    const established = await emailItem(seed, "established", canonical, address);
    const uncredited = await emailItem(seed, "uncredited", canonical, address);
    await establish(established, fay);

    const { key, revision } = await ambiguate(seed, fay, address);
    expect(providerIdentityState(await identityMap(seed), "gdrive", canonical)).toBe("ambiguous");
    expect(await obligationStatus(seed, key, revision)).toEqual(["pending"]);

    // The CURRENT obligation drains (it nominates both documents by the equivalence contract).
    await drainIdentityRepairs(db(), { maxObligations: 10, batchSize: 10 });
    expect(await obligationStatus(seed, key, revision)).toEqual(["complete"]);
    const kept = await itemCredit(established);
    expect(kept.item).toBe(fay);
    expect(kept.versions.length).toBeGreaterThan(0);
    expect(kept.versions.every((v) => v === fay)).toBe(true);
    // No NEW attribution: the uncredited document stays uncredited, and recomputed evidence is unresolved.
    const none = await itemCredit(uncredited);
    expect(none.item).toBeNull();
    expect(none.versions.every((v) => v === null)).toBe(true);
    for (const credit of [kept, none]) {
      expect(credit.evidence.length).toBeGreaterThan(0);
      expect(credit.evidence.every((row) => row.member_id === null)).toBe(true);
    }

    // Replay: a second drain changes nothing.
    await drainIdentityRepairs(db(), { maxObligations: 10, batchSize: 10 });
    expect((await itemCredit(established)).item).toBe(fay);
    expect((await itemCredit(uncredited)).item).toBeNull();
  });

  it("controls: through the per-key repair a remap reassigns established credit and a definite unlink clears it", async () => {
    const seed = await seedTeam();
    const address = `gus-${randomUUID().slice(0, 6)}@example.com`;
    const gus = await member(seed, "Gus", address);
    const hal = await member(seed, "Hal", `hal-${randomUUID().slice(0, 6)}@example.com`);
    const canonical = `author-email:${address}`;
    const itemId = await emailItem(seed, "definite", canonical, address);
    const credited = async () => {
      const credit = await itemCredit(itemId);
      expect(credit.versions.length).toBeGreaterThan(0);
      return { item: credit.item, versions: [...new Set(credit.versions)] };
    };

    await setMemberIdentity(db(), seed.teamId, gus, { provider: "gdrive", externalId: canonical });
    await drainIdentityRepairs(db(), { maxObligations: 10, batchSize: 10 });
    expect(await credited()).toEqual({ item: gus, versions: [gus] });

    await setMemberIdentity(db(), seed.teamId, hal, { provider: "gdrive", externalId: canonical }, { force: true });
    await drainIdentityRepairs(db(), { maxObligations: 10, batchSize: 10 });
    expect(await credited()).toEqual({ item: hal, versions: [hal] });

    await removeMemberIdentity(db(), seed.teamId, { provider: "gdrive", externalId: canonical });
    await drainIdentityRepairs(db(), { maxObligations: 10, batchSize: 10 });
    expect(await credited()).toEqual({ item: null, versions: [null] });
  });

  it("an email-key batch with no matching candidate still counts its whole scanned page (Fable R51 L2)", async () => {
    const seed = await seedTeam();
    const address = `ivy-${randomUUID().slice(0, 6)}@example.com`;
    const ivy = await member(seed, "Ivy", address);
    const others: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      others.push(await emailItem(seed, `other-${i}`, `author-email:other-${i}-${randomUUID().slice(0, 6)}@example.com`));
    }
    const page = [...others].sort(); // the drain's `order by i.id` (uuid order is lower-case hex order)
    const canonical = `author-email:${address}`;
    const linked = await setMemberIdentity(db(), seed.teamId, ivy, { provider: "gdrive", externalId: canonical });
    const revision = linked.mappingRevision;
    if (revision === undefined) throw new Error("the Drive link recorded no mapping revision");
    const { data } = await db().from("identity_repair_obligations")
      .select("team_id,provider,external_id,mapping_revision,cursor_item_id,items_scanned,items_updated,versions_updated,contributions_updated")
      .eq("team_id", seed.teamId).eq("provider", "gdrive").eq("external_id", canonical).eq("mapping_revision", revision)
      .single();
    const obligation = data as Parameters<typeof runIdentityRepairObligation>[1];

    // A full page of two Drive documents, none naming the address: it advanced, so it counts two.
    expect(await runIdentityRepairObligation(db(), obligation, { batchSize: 2 }))
      .toEqual({ status: "partial", scanned: 2 });
    expect(await progress(seed, canonical, revision))
      .toEqual({ status: "running", cursor: page[1], scanned: 2, updated: 0 });
    // The bounded cursor resumes past that page: the last document, a short page, completes.
    expect(await runIdentityRepairObligation(db(), obligation, { batchSize: 2 }))
      .toEqual({ status: "complete", scanned: 1 });
    expect(await progress(seed, canonical, revision))
      .toEqual({ status: "complete", cursor: page[2], scanned: 3, updated: 0 });
  });
});

/** Credit an earlier link established, on the item AND every version. */
async function establish(itemId: string, memberId: string) {
  await db().from("items").update({ member_id: memberId }).eq("id", itemId);
  await db().from("item_versions").update({ member_id: memberId }).eq("item_id", itemId);
}

async function obligationStatus(seed: Seed, externalId: string, revision: number): Promise<string[]> {
  const { rows } = await getPool().query<{ status: string }>(
    `select status from identity_repair_obligations
      where team_id=$1 and provider='gdrive' and external_id=$2 and mapping_revision=$3`,
    [seed.teamId, externalId, revision]);
  return rows.map((row) => row.status);
}

async function progress(seed: Seed, externalId: string, revision: number) {
  const { rows } = await getPool().query<{ status: string; cursor: string | null; scanned: number; updated: number }>(
    `select status, cursor_item_id::text as cursor, items_scanned::int as scanned, items_updated::int as updated
       from identity_repair_obligations
      where team_id=$1 and provider='gdrive' and external_id=$2 and mapping_revision=$3`,
    [seed.teamId, externalId, revision]);
  if (rows.length !== 1) throw new Error(`expected one obligation, found ${rows.length}`);
  return rows[0];
}
