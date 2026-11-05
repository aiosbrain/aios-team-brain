import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import { parseAuthorRefs, resolveAuthors } from "@/lib/attribution/resolve-authors";
import { googleDriveContributionEvidence } from "@/lib/dashboard/gdrive-contributions";
import { getPool } from "@/lib/db/pg/pool";
import { listIdentityDiscoveryConflicts } from "@/lib/identity/discovery-conflicts";
import { setMemberIdentity } from "@/lib/identity/member-identities";
import { buildIdentityMap, googleEmailBridge } from "@/lib/identity/resolve";
import { latestStoredGdriveObservations } from "@/lib/ingest/gdrive-ledger";
import { discoverGdriveContributorIdentities } from "@/lib/integrations/gdrive-identity-discovery";
import {
  convergeIdentityAttribution, db, fencedDriveWriter, placeMemberByTier, seedTeam,
  type FencedDriveWriter, type Seed,
} from "./helpers";

/**
 * AIO-1167 R53 — a deliberately linked `author-email:E` is consulted before E bridges to anyone (real
 * Postgres, through discovery, the fenced Drive commit, the stored evidence, the Timeline read and
 * Google author attribution).
 *
 * The reproduced defect: `author-email:E` is linked to A while E is B's roster email or alias. A
 * permission id P then arrives carrying E, at the same role and instant as A's author-email
 * observation. Discovery used to link P → B on the strength of E alone, the ledger folded A's
 * observation into P, and the Timeline credit moved to B silently.
 *
 * Spec (Astra adjudication). The email cannot say whose P is: no P → B (or P → A) link, no stored
 * evidence or Timeline credit for B, A's mapping unchanged, and the refusal visible on the existing
 * Admin discovery-conflict diagnostic — in either observation order and on replay, for a primary email
 * and an alias, for a manual link and a legacy link (both with an empty email column: the manual writer
 * stores none). Agreeing owners, an ordinary confirmed email and a legacy link alone keep linking; an
 * exact permission mapping keeps its authority; a deactivated linked owner still blocks.
 */

const AT = "2026-10-20T10:00:00.000Z";

interface World {
  seed: Seed;
  writer: FencedDriveWriter;
  address: string;
  a: string;
  b: string;
  sourceId: string;
}

async function member(seed: Seed, name: string, email: string): Promise<string> {
  const { data, error } = await db().from("members").insert({
    team_id: seed.teamId, email, display_name: name, actor_handle: `${name.toLowerCase()}-${randomUUID().slice(0, 8)}`,
    role: "member", tier: "team", status: "active",
  }).select("id").single();
  if (error || !data) throw new Error(`member seed failed: ${error?.message}`);
  return (data as { id: string }).id;
}

/**
 * `owner` gives the shared address E to B — as a primary email, as an alias, or to A herself (the
 * agreeing control) or nobody; `link` links `author-email:E` to A — the new manual writer, a legacy
 * row with an empty email column (and its decided state, as every upgraded link has), not at all, or
 * (`split`, R54) as two raw legacy spellings of E mapped to A and to a third member, with no decided
 * state and no stored email — rows the raw DB uniqueness allows and the map reads as ambiguous; or
 * (`linked-split`, R55) the canonical raw row mapped to A beside a legacy spelling mapped to a third
 * member, which the ACTUAL manual writer then re-links for A — a decided `linked` state over a split.
 */
async function world(
  owner: "primary" | "alias" | "a" | "nobody", link: "manual" | "legacy" | "none" | "split" | "linked-split",
): Promise<World> {
  const seed = await seedTeam();
  const writer = await fencedDriveWriter(seed);
  await placeMemberByTier(seed.teamId, seed.memberId, "team");
  const tag = randomUUID().slice(0, 6);
  const address = `shared-${tag}@example.com`;
  const a = await member(seed, "Ann", owner === "a" ? address : `ann-${tag}@example.com`);
  const b = await member(seed, "Ben", owner === "primary" ? address : `ben-${tag}@example.com`);
  if (owner === "alias") {
    await getPool().query("insert into member_emails(team_id,member_id,email) values ($1,$2,$3)", [seed.teamId, b, address]);
  }
  const key = `author-email:${address}`;
  if (link === "manual") {
    await setMemberIdentity(db(), seed.teamId, a, { provider: "gdrive", externalId: key });
  } else if (link === "split") {
    const c = await member(seed, "Cal", `cal-${tag}@example.com`);
    for (const [memberId, spelling] of [[a, `author-email:${address.toUpperCase()}`], [c, key]] as const) {
      await getPool().query(
        "insert into member_identities(team_id,member_id,provider,external_id,handle,email) values ($1,$2,'gdrive',$3,'','')",
        [seed.teamId, memberId, spelling]);
    }
  } else if (link === "linked-split") {
    const c = await member(seed, "Cal", `cal-${tag}@example.com`);
    for (const [memberId, spelling] of [[a, key], [c, `author-email:${address.toUpperCase()}`]] as const) {
      await getPool().query(
        "insert into member_identities(team_id,member_id,provider,external_id,handle,email) values ($1,$2,'gdrive',$3,'','')",
        [seed.teamId, memberId, spelling]);
    }
    await setMemberIdentity(db(), seed.teamId, a, { provider: "gdrive", externalId: key });
  } else if (link === "legacy") {
    await getPool().query(
      "insert into member_identities(team_id,member_id,provider,external_id,handle,email) values ($1,$2,'gdrive',$3,'','')",
      [seed.teamId, a, key]);
    await getPool().query(
      "insert into member_identity_mapping_state(team_id,provider,external_id,member_id,revision,state) values ($1,'gdrive',$2,$3,1,'linked')",
      [seed.teamId, key, a]);
  }
  await convergeIdentityAttribution(seed);
  return { seed, writer, address, a, b, sourceId: `doc-${tag}` };
}

const observation = (w: World, externalId: string, at = AT) => ({
  provider: "gdrive", external_id: externalId, email: w.address, role: "editor", at,
});

/** What the route does with one Drive push: discovery at the fenced boundary, then the fenced commit. */
async function push(w: World, obs: Record<string, unknown>) {
  const frontmatter = {
    source_id: w.sourceId, title: "Shared doc", source_url: `https://docs.google.com/document/d/${w.sourceId}/edit`,
    authors: [{ provider: obs.provider, external_id: obs.external_id, email: obs.email, role: obs.role }],
    contributions: [obs],
  };
  const discovery = await discoverGdriveContributorIdentities(db(), w.writer.auth, w.writer.execution, {
    ...frontmatter, source: "gdrive", connection_id: w.writer.integrationId,
  });
  const pushed = await w.writer.push({
    path: `gdrive/${w.sourceId}.md`, body: `Shared doc ${String(obs.external_id)} ${randomUUID()}`,
    project: "drive-bridge", frontmatter,
  });
  return { discovery, itemId: pushed.id };
}

async function permissionHolders(w: World): Promise<string[]> {
  return (await getPool().query<{ member_id: string }>(
    "select member_id from member_identities where team_id=$1 and provider='gdrive' and external_id='permission:P'",
    [w.seed.teamId])).rows.map((row) => row.member_id);
}

async function authorEmailMapping(w: World) {
  const pool = getPool();
  return JSON.stringify({
    identity: (await pool.query(
      "select member_id from member_identities where team_id=$1 and provider='gdrive' and external_id=$2",
      [w.seed.teamId, `author-email:${w.address}`])).rows,
    state: (await pool.query(
      "select member_id,state,revision from member_identity_mapping_state where team_id=$1 and provider='gdrive' and external_id=$2",
      [w.seed.teamId, `author-email:${w.address}`])).rows,
  });
}

/** Stored evidence, and the Timeline's read of it (`latestStoredGdriveObservations` → the renderer). */
async function credit(w: World, itemId: string) {
  const { rows } = await getPool().query<{
    item_id: string; evidence_key: string; external_id: string | null; email: string | null; role: string;
    source_at: string; updated_at: string; member_id: string | null; diagnostic: string | null;
  }>(
    `select item_id,evidence_key,external_id,email::text,role,source_at::text,updated_at::text,member_id,diagnostic
       from gdrive_contribution_evidence where team_id=$1 and item_id=$2`,
    [w.seed.teamId, itemId]);
  const map = await buildIdentityMap(db(), w.seed.teamId, { strict: true, includeDeactivated: true });
  const timeline = latestStoredGdriveObservations(rows).flatMap((row) => googleDriveContributionEvidence({
    source: "gdrive", title: "Shared doc",
    contributions: [{ external_id: row.external_id, email: row.email, role: row.role, at: row.source_at }],
  }, row.item_id, map)).map((row) => row.memberId);
  const { data: item } = await db().from("items").select("frontmatter").eq("id", itemId).single();
  const frontmatter = (item as { frontmatter: Record<string, unknown> }).frontmatter;
  return {
    evidence: rows.map((row) => ({ external_id: row.external_id, member_id: row.member_id, diagnostic: row.diagnostic })),
    timeline,
    author: resolveAuthors(map, parseAuthorRefs(frontmatter), new Set()).memberId,
    projection: googleDriveContributionEvidence(frontmatter, itemId, map).map((row) => row.memberId),
  };
}

/** Every raw `author-email:` mapping row and mapping state of the team, exactly as stored. */
async function legacyMappings(w: World) {
  const pool = getPool();
  return JSON.stringify({
    identities: (await pool.query(
      `select external_id,member_id,email::text from member_identities
        where team_id=$1 and provider='gdrive' and lower(external_id) like 'author-email:%' order by external_id`,
      [w.seed.teamId])).rows,
    states: (await pool.query(
      `select external_id,state,revision from member_identity_mapping_state
        where team_id=$1 and provider='gdrive' and lower(external_id) like 'author-email:%' order by external_id`,
      [w.seed.teamId])).rows,
  });
}

async function conflictRows(w: World) {
  const page = await listIdentityDiscoveryConflicts(db(), { teamId: w.seed.teamId, memberId: w.seed.memberId });
  expect(page.status).toBe("ok");
  return page.status === "ok" ? page.rows.filter((row) => row.externalId === "permission:P") : [];
}

describe("R53 — a linked author-email owner conflicting with the roster/alias owner (real Postgres)", () => {
  it.each([
    ["primary email", "manual", "author-email first"],
    ["primary email", "legacy", "author-email first"],
    ["alias", "manual", "author-email first"],
    ["alias", "legacy", "author-email first"],
    ["primary email", "manual", "permission first"],
    ["primary email", "legacy", "permission first"],
    ["alias", "legacy", "permission first"],
  ] as const)("%s, %s link, %s: no P link, no B credit, A unchanged, visible conflict", async (owner, link, order) => {
    const w = await world(owner === "alias" ? "alias" : "primary", link);
    const mappingBefore = await authorEmailMapping(w);
    const viaAuthorEmail = observation(w, `author-email:${w.address}`);
    // The same edit, replayed with a permission id: the same instant, spelled differently.
    const viaPermission = observation(w, "permission:P", "2026-10-20T10:00:00Z");
    const steps = order === "author-email first" ? [viaAuthorEmail, viaPermission] : [viaPermission, viaAuthorEmail];

    const first = await push(w, steps[0]);
    if (order === "author-email first") {
      // Direct author-email evidence is the deliberately linked owner's.
      expect((await credit(w, first.itemId)).evidence).toEqual([
        { external_id: `author-email:${w.address}`, member_id: w.a, diagnostic: null },
      ]);
    }
    const second = await push(w, steps[1]);
    expect(second.itemId).toBe(first.itemId);
    const permissionDiscovery = order === "author-email first" ? second.discovery : first.discovery;
    expect(permissionDiscovery).toMatchObject({ linked: 0, conflict: 1 });

    // Replay the permission observation: still nothing linked, credited or moved.
    const replay = await push(w, viaPermission);
    expect(replay.discovery).toMatchObject({ linked: 0, conflict: 1 });

    expect(await permissionHolders(w)).toEqual([]);
    expect(await authorEmailMapping(w)).toBe(mappingBefore);
    const result = await credit(w, first.itemId);
    // One observation (the permission id absorbed the author-email one), credited to nobody, with the
    // actionable diagnostic — never B, and not silently A's through the permission id either.
    expect(result.evidence).toEqual([{ external_id: "permission:P", member_id: null, diagnostic: "google_email_conflict" }]);
    expect(result.timeline).toEqual([]);
    expect(result.projection).toEqual([]);
    expect(result.author).not.toBe(w.b);

    // Every consumer reads the same bridge decision for E.
    for (const opts of [{ strict: true }, { strict: true, includeDeactivated: true }]) {
      expect(googleEmailBridge(await buildIdentityMap(db(), w.seed.teamId, opts), w.address).outcome).toBe("conflict");
    }

    // Visible on the existing Admin diagnostic: P, the candidate B the email names, refused because A's
    // `author-email:` mapping holds the address.
    const conflicts = await conflictRows(w);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({
      occurrences: 2, candidate: { id: w.b }, heldThen: { id: w.a }, current: { state: "absent" },
    });
  }, 60_000);

  it("a deactivated linked owner still blocks the roster owner; A's own direct evidence stays A's", async () => {
    const w = await world("primary", "manual");
    await db().from("members").update({ status: "disabled" }).eq("id", w.a).eq("team_id", w.seed.teamId);
    await convergeIdentityAttribution(w.seed);
    const viaPermission = observation(w, "permission:P");
    const { discovery, itemId } = await push(w, viaPermission);
    expect(discovery).toMatchObject({ linked: 0, conflict: 1 });
    expect(await permissionHolders(w)).toEqual([]);
    const result = await credit(w, itemId);
    expect(result.evidence.every((row) => row.member_id === null)).toBe(true);
    expect(result.timeline).toEqual([]);
    const attribution = await buildIdentityMap(db(), w.seed.teamId, { strict: true, includeDeactivated: true });
    expect(resolveAuthors(attribution, parseAuthorRefs({
      source: "gdrive", authors: [observation(w, `author-email:${w.address}`)],
    }), new Set()).memberId).toBe(w.a);
  }, 60_000);

  it("an exact permission mapping keeps its authority over the conflicted email", async () => {
    const w = await world("primary", "legacy");
    await setMemberIdentity(db(), w.seed.teamId, w.b, { provider: "gdrive", externalId: "permission:P" });
    await convergeIdentityAttribution(w.seed);
    const { discovery, itemId } = await push(w, observation(w, "permission:P"));
    expect(discovery).toMatchObject({ linked: 0, conflict: 0, reviewed: 1 });
    expect(await permissionHolders(w)).toEqual([w.b]);
    const result = await credit(w, itemId);
    expect(result.evidence).toEqual([{ external_id: "permission:P", member_id: w.b, diagnostic: null }]);
    expect(result.timeline).toEqual([w.b]);
  }, 60_000);
});

/**
 * AIO-1167 R54 — legacy spellings of E mapped to DIFFERENT members are ambiguous author-email authority.
 * With no decided state, nothing but the map's ambiguity records it; the email must then be held, not
 * bridged to E's unique roster/alias owner B: no permission link, no fallback evidence, Timeline or
 * author credit for anyone, and both legacy mappings left exactly as they were — in either order and on
 * replay. Not a conflict (no single linked owner), so nothing is audited as one.
 */
describe("R54 — ambiguous legacy author-email spellings hold the email (real Postgres)", () => {
  it.each([
    ["primary email", "author-email first"],
    ["primary email", "permission first"],
    ["alias", "author-email first"],
    ["alias", "permission first"],
  ] as const)("%s owner, %s: no P link, no fallback credit, legacy mappings unchanged", async (owner, order) => {
    const w = await world(owner === "alias" ? "alias" : "primary", "split");
    const before = await legacyMappings(w);
    expect(before).toContain(`author-email:${w.address.toUpperCase()}`);
    for (const opts of [{ strict: true }, { strict: true, includeDeactivated: true }]) {
      expect(googleEmailBridge(await buildIdentityMap(db(), w.seed.teamId, opts), w.address)).toEqual({ outcome: "held" });
    }
    const viaAuthorEmail = observation(w, `author-email:${w.address}`);
    const viaPermission = observation(w, "permission:P", "2026-10-20T10:00:00Z");
    const steps = order === "author-email first" ? [viaAuthorEmail, viaPermission] : [viaPermission, viaAuthorEmail];

    const first = await push(w, steps[0]);
    // Neither spelling's owner nor the roster owner is credited, from the first push on.
    expect((await credit(w, first.itemId)).evidence.every((row) => row.member_id === null)).toBe(true);
    const second = await push(w, steps[1]);
    const replay = await push(w, viaPermission);
    for (const discovery of [order === "author-email first" ? second.discovery : first.discovery, replay.discovery]) {
      expect(discovery).toMatchObject({ linked: 0, conflict: 0, reviewed: 1 });
    }

    expect(await permissionHolders(w)).toEqual([]);
    expect(await legacyMappings(w)).toBe(before);
    const result = await credit(w, first.itemId);
    expect(result.evidence).toEqual([{ external_id: "permission:P", member_id: null, diagnostic: "unresolved_identity" }]);
    expect(result.timeline).toEqual([]);
    expect(result.projection).toEqual([]);
    expect(result.author).toBeNull();
    expect(await conflictRows(w)).toEqual([]);
  }, 60_000);

  it("an exact permission mapping keeps its authority over the held email", async () => {
    const w = await world("primary", "split");
    await setMemberIdentity(db(), w.seed.teamId, w.a, { provider: "gdrive", externalId: "permission:P" });
    await convergeIdentityAttribution(w.seed);
    const { discovery, itemId } = await push(w, observation(w, "permission:P"));
    expect(discovery).toMatchObject({ linked: 0, reviewed: 1 });
    expect(await permissionHolders(w)).toEqual([w.a]);
    const result = await credit(w, itemId);
    expect(result.evidence).toEqual([{ external_id: "permission:P", member_id: w.a, diagnostic: null }]);
    expect(result.timeline).toEqual([w.a]);
  }, 60_000);
});

/**
 * AIO-1167 R55 — a DECIDED `linked` state on the canonical key can coexist with live raw spellings of
 * the address mapped to different members (the manual writer re-links an existing canonical row and
 * leaves a legacy spelling it does not own untouched). The decision stands but names no owner the map
 * can resolve: an actionable conflict — the conflict diagnostic on the evidence and the existing Admin
 * discovery-conflict audit, beside the roster/alias owner — not R54's silent hold, and still no fallback
 * credit, no permission link, and no raw mapping merged, deleted or rewritten.
 */
describe("R55 — a decided link over split live spellings is an actionable conflict (real Postgres)", () => {
  it.each([
    ["primary email", "author-email first"],
    ["primary email", "permission first"],
    ["alias", "author-email first"],
    ["alias", "permission first"],
  ] as const)("%s owner, %s: conflict evidence and audit, no credit, no P link, raw mappings unchanged", async (owner, order) => {
    const w = await world(owner === "alias" ? "alias" : "primary", "linked-split");
    const before = await legacyMappings(w);
    // The actual manual writer decided the canonical key and kept both raw rows: two spellings, two owners.
    const stored = JSON.parse(before) as { identities: Array<{ external_id: string; member_id: string }>; states: Array<{ external_id: string; state: string }> };
    expect(stored.identities.map((row) => row.external_id).sort())
      .toEqual([`author-email:${w.address.toUpperCase()}`, `author-email:${w.address}`].sort());
    expect(new Set(stored.identities.map((row) => row.member_id)).size).toBe(2);
    expect(stored.states).toEqual([expect.objectContaining({ external_id: `author-email:${w.address}`, state: "linked" })]);
    for (const opts of [{ strict: true }, { strict: true, includeDeactivated: true }]) {
      expect(googleEmailBridge(await buildIdentityMap(db(), w.seed.teamId, opts), w.address))
        .toEqual({ outcome: "conflict", linkedMemberId: null, emailMemberId: w.b });
    }
    const viaAuthorEmail = observation(w, `author-email:${w.address}`);
    const viaPermission = observation(w, "permission:P", "2026-10-20T10:00:00Z");
    const steps = order === "author-email first" ? [viaAuthorEmail, viaPermission] : [viaPermission, viaAuthorEmail];

    const first = await push(w, steps[0]);
    // The direct author-email observation resolves to no spelling's owner — none is invented.
    expect((await credit(w, first.itemId)).evidence.every((row) => row.member_id === null)).toBe(true);
    const second = await push(w, steps[1]);
    const replay = await push(w, viaPermission);
    for (const discovery of [order === "author-email first" ? second.discovery : first.discovery, replay.discovery]) {
      expect(discovery).toMatchObject({ linked: 0, conflict: 1 });
    }

    expect(await permissionHolders(w)).toEqual([]);
    expect(await legacyMappings(w)).toBe(before);
    const result = await credit(w, first.itemId);
    expect(result.evidence).toEqual([{ external_id: "permission:P", member_id: null, diagnostic: "google_email_conflict" }]);
    expect(result.timeline).toEqual([]);
    expect(result.projection).toEqual([]);
    expect(result.author).toBeNull();
    const conflicts = await conflictRows(w);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({
      occurrences: 2, candidate: { id: w.b }, heldThen: null, current: { state: "absent" },
    });
  }, 60_000);
});

describe("R53 — positive controls keep linking (real Postgres)", () => {
  it.each([
    ["agreeing owners (A's own address, manual link)", "a", "manual", "a"],
    ["an ordinary confirmed email, no Google authority", "primary", "none", "b"],
    ["a legacy link alone, its email column empty", "nobody", "legacy", "a"],
  ] as const)("%s: P links to that member and is credited", async (_case, owner, link, expected) => {
    const w = await world(owner, link);
    const memberId = expected === "a" ? w.a : w.b;
    expect(googleEmailBridge(await buildIdentityMap(db(), w.seed.teamId, { strict: true }), w.address))
      .toEqual({ outcome: "member", memberId });
    const { discovery, itemId } = await push(w, observation(w, "permission:P"));
    expect(discovery).toMatchObject({ linked: 1, conflict: 0 });
    expect(await permissionHolders(w)).toEqual([memberId]);
    await convergeIdentityAttribution(w.seed);
    const result = await credit(w, itemId);
    expect(result.evidence.map((row) => row.member_id)).toEqual([memberId]);
    expect(result.timeline).toEqual([memberId]);
    expect(await conflictRows(w)).toEqual([]);
  }, 60_000);
});
