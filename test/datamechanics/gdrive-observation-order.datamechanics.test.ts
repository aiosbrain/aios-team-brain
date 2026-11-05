import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";

import { canSeeItem } from "@/lib/access/enforce";
import { issueApiKey } from "@/lib/admin/keys";
import { getPool } from "@/lib/db/pg/pool";
import { ensureProjectGraphPointer } from "@/lib/graph/project-pointer";
import { reconcileGdriveItems } from "@/lib/ingest/source-reconcile";
import { GdriveAuthorityError } from "@/lib/integrations/gdrive-authority";
import {
  convergeIdentityAttribution, db, fencedDriveWriter, placeMemberByTier, seedTeam,
  type FencedDriveWriter, type Seed,
} from "./helpers";

/**
 * AIO-1167 R95 P1-B — overlapping Drive connections cannot regress the canonical item (real Postgres,
 * two bound integrations, each with its own valid execution, through the one fenced Drive commit).
 *
 * Connection A extracts an older observation T1 and stalls; connection B commits the newer T2; A then
 * delivers T1 while still authorized. Only the certified provider `version` orders observations, so T1
 * must not overwrite T2's body, title, path, provenance, work time or current attribution, nor create an
 * item version, an `item.updated` event or extraction churn — while A's claim is still established and
 * A's independently source-supported contribution evidence is merged exactly once.
 */

const TIMEOUT = 60_000;
const PROVIDER = "r95-observed-doc";
const DAY1 = "2026-11-01T09:00:00.000Z";
const DAY2 = "2026-11-03T15:00:00.000Z";
// Non-hex markers (ids in responses are random hex UUIDs).
const T1_TEXT = "older walrus draft";
const T2_TEXT = "newer quokka revision";

async function member(seed: Seed, name: string): Promise<string> {
  const { data } = await db().from("members").insert({
    team_id: seed.teamId, email: `${randomUUID()}@test.local`, display_name: name,
    actor_handle: `r95-${randomUUID().slice(0, 8)}`, role: "member", tier: "team", status: "active",
  }).select("id").single();
  const id = (data as { id: string }).id;
  await placeMemberByTier(seed.teamId, id, "team");
  return id;
}

async function privateAudience(seed: Seed, memberId: string, slug: string): Promise<string> {
  const { data: group } = await db().from("groups").insert({
    team_id: seed.teamId, slug: `person-${randomUUID()}`, name: slug, person_member_id: memberId,
  }).select("id").single();
  await db().from("group_members").insert({
    team_id: seed.teamId, group_id: (group as { id: string }).id, member_id: memberId,
  });
  const { data: project } = await db().from("projects").insert({
    team_id: seed.teamId, slug, name: slug, kind: "initiative",
  }).select("id").single();
  const projectId = (project as { id: string }).id;
  await db().from("project_groups").insert({
    team_id: seed.teamId, project_id: projectId, group_id: (group as { id: string }).id,
  });
  const pointer = await ensureProjectGraphPointer(db(), { teamId: seed.teamId, projectId });
  if (!pointer.ok) throw new Error(pointer.error);
  return projectId;
}

interface Observation {
  version: string | null;
  text: string;
  title: string;
  at: string;
  author: string;
  contributor: string;
  extra?: Record<string, unknown>;
}

async function world() {
  const seed = await seedTeam();
  const readerA = await member(seed, "Reader A");
  const readerB = await member(seed, "Reader B");
  await convergeIdentityAttribution(seed);
  const suffix = randomUUID().slice(0, 8);
  const projectA = await privateAudience(seed, readerA, `r95-oa-${suffix}`);
  const projectB = await privateAudience(seed, readerB, `r95-ob-${suffix}`);
  const writerA = await fencedDriveWriter(seed, [projectA]);
  const writerB = await fencedDriveWriter(seed, [projectB]);
  const storage = `r95-store-${suffix}`;
  const push = (writer: FencedDriveWriter, o: Observation) => writer.push({
    project: storage, path: `gdrive/${PROVIDER}.md`, body: `# ${o.title}\n\n${o.text}`,
    frontmatter: {
      source_id: PROVIDER, title: o.title, source_ts: o.at, modified_time: o.at,
      ...(o.version === null ? {} : { gdrive_version: o.version }),
      contributions: [{ external_id: `permission:${o.contributor}`, role: "editor", at: o.at }],
      ...(o.extra ?? {}),
    },
  }, { authorMemberId: o.author });
  const t1: Observation = { version: "5", text: T1_TEXT, title: "Plan T1", at: DAY1, author: readerA, contributor: "r95-early" };
  const t2: Observation = { version: "7", text: T2_TEXT, title: "Plan T2", at: DAY2, author: readerB, contributor: "r95-late" };
  return { seed, readerA, readerB, writerA, writerB, push, t1, t2 };
}

type World = Awaited<ReturnType<typeof world>>;

async function canonical(itemId: string) {
  const { rows } = await getPool().query(
    `select body, frontmatter, path, project_id, member_id, work_at, updated_at, synced_at, content_sha256
       from items where id=$1`, [itemId]);
  const row = rows[0] as Record<string, unknown> & { frontmatter: Record<string, unknown> };
  const versions = (await getPool().query<{ n: number }>(
    `select count(*)::int as n from item_versions where item_id=$1`, [itemId])).rows[0].n;
  const updates = (await getPool().query<{ n: number }>(
    `select count(*)::int as n from audit_log where target_id=$1 and action in ('item.updated','item.created')`,
    [itemId])).rows[0].n;
  const evidence = (await getPool().query<{ external_id: string }>(
    `select external_id from gdrive_contribution_evidence where item_id=$1 order by external_id`, [itemId])).rows
    .map((r) => r.external_id);
  return { row, versions, updates, evidence };
}

/** The canonical fields a stale or conflicting observation must leave exactly as they are. */
const canonicalFields = (snapshot: Awaited<ReturnType<typeof canonical>>) => ({
  body: snapshot.row.body,
  title: snapshot.row.frontmatter.title,
  source_ts: snapshot.row.frontmatter.source_ts,
  modified_time: snapshot.row.frontmatter.modified_time,
  gdrive_version: snapshot.row.frontmatter.gdrive_version,
  connection_id: snapshot.row.frontmatter.connection_id,
  path: snapshot.row.path,
  project_id: snapshot.row.project_id,
  member_id: snapshot.row.member_id,
  work_at: String(snapshot.row.work_at),
  updated_at: String(snapshot.row.updated_at),
  synced_at: String(snapshot.row.synced_at),
  content_sha256: snapshot.row.content_sha256,
});

const contributors = (snapshot: Awaited<ReturnType<typeof canonical>>) =>
  ((snapshot.row.frontmatter.contributions as Array<{ external_id: string }>) ?? []).map((c) => c.external_id).sort();

async function bothClaimsVisible(w: World, itemId: string) {
  expect(await canSeeItem(db(), { teamId: w.seed.teamId, memberId: w.readerA }, itemId), "A's claim stands").toBe(true);
  expect(await canSeeItem(db(), { teamId: w.seed.teamId, memberId: w.readerB }, itemId), "B's claim stands").toBe(true);
}

describe("R95 P1-B: a delayed older Drive observation never regresses the canonical item", () => {
  it("B commits T2, then A's delayed T1 arrives: T2 stands, A's claim and evidence are added once", { timeout: TIMEOUT }, async () => {
    const w = await world();
    const committed = await w.push(w.writerB, w.t2);
    const before = await canonical(committed.id);
    const delayed = await w.push(w.writerA, w.t1);
    expect(delayed).toMatchObject({ status: "unchanged", id: committed.id });
    const after = await canonical(committed.id);
    expect(canonicalFields(after)).toEqual(canonicalFields(before));
    expect(after.row.body).toContain(T2_TEXT);
    expect(after.row.frontmatter.gdrive_version).toBe("7");
    expect(after.row.member_id, "current attribution stays T2's").toBe(w.readerB);
    expect(after.versions, "no canonical item version").toBe(before.versions);
    expect(after.updates, "no item.updated activity").toBe(before.updates);
    // Distinct legitimate contributors on distinct days: both observations, each once.
    expect(contributors(after)).toEqual(["permission:r95-early", "permission:r95-late"]);
    expect(after.evidence).toEqual(["permission:r95-early", "permission:r95-late"]);
    await bothClaimsVisible(w, committed.id);
    // A replay of the same delayed observation adds nothing.
    await w.push(w.writerA, w.t1);
    const replayed = await canonical(committed.id);
    expect(canonicalFields(replayed)).toEqual(canonicalFields(before));
    expect(contributors(replayed)).toEqual(["permission:r95-early", "permission:r95-late"]);
    expect(replayed.evidence).toEqual(after.evidence);
    expect(replayed.versions).toBe(before.versions);
  });

  it.each([
    ["older first (A T1, then B T2)", "older-first"],
    ["newer first (B T2, then A T1)", "newer-first"],
  ] as const)("both commit orders converge on T2: %s", { timeout: TIMEOUT }, async (_name, order) => {
    const w = await world();
    const first = order === "older-first" ? await w.push(w.writerA, w.t1) : await w.push(w.writerB, w.t2);
    const second = order === "older-first" ? await w.push(w.writerB, w.t2) : await w.push(w.writerA, w.t1);
    expect(second.id).toBe(first.id);
    const final = await canonical(first.id);
    expect(final.row.body).toContain(T2_TEXT);
    expect(final.row.body).not.toContain(T1_TEXT);
    expect(final.row.frontmatter.title).toBe("Plan T2");
    expect(final.row.frontmatter.gdrive_version).toBe("7");
    expect(final.row.member_id).toBe(w.readerB);
    expect(final.versions, "a version per APPLIED observation only").toBe(order === "older-first" ? 2 : 1);
    expect(contributors(final)).toEqual(["permission:r95-early", "permission:r95-late"]);
    await bothClaimsVisible(w, first.id);
  });

  it("an identical body with OLDER metadata cannot regress metadata, work time or attribution", { timeout: TIMEOUT }, async () => {
    const w = await world();
    const same = "unchanged quokka body";
    const committed = await w.push(w.writerB, { ...w.t2, text: same, title: "Same title" });
    const before = await canonical(committed.id);
    await w.push(w.writerA, { ...w.t1, text: same, title: "Same title" });
    const after = await canonical(committed.id);
    expect(canonicalFields(after)).toEqual(canonicalFields(before));
    expect(after.row.frontmatter.source_ts).toBe(DAY2);
    expect(after.row.member_id).toBe(w.readerB);
  });

  it("an equal version: an identical replay is idempotent; a conflicting payload fails closed for reconciliation", { timeout: TIMEOUT }, async () => {
    const w = await world();
    const committed = await w.push(w.writerB, w.t2);
    const before = await canonical(committed.id);
    // Identical canonical payload from the other connection: the unchanged path, no version.
    const replay = await w.push(w.writerA, { ...w.t2, author: w.readerB, contributor: "r95-late" });
    expect(replay.status).toBe("unchanged");
    const replayed = await canonical(committed.id);
    expect(replayed.versions).toBe(before.versions);
    expect(replayed.row.body).toBe(before.row.body);
    // Same version, different body: never replaced by arrival order.
    const conflict = await w.push(w.writerA, { ...w.t2, text: "conflicting walrus body", author: w.readerA, contributor: "r95-other" });
    expect(conflict.status).toBe("unchanged");
    const after = await canonical(committed.id);
    expect(after.row.body).toBe(before.row.body);
    expect(after.row.member_id).toBe(w.readerB);
    expect(after.versions).toBe(before.versions);
    const { rows } = await getPool().query<{ n: number }>(
      `select count(*)::int as n from audit_log where target_id=$1 and action='gdrive.observation_conflict'`,
      [committed.id]);
    expect(rows[0].n, "the conflict is recorded for reconciliation").toBe(1);
    await bothClaimsVisible(w, committed.id);
  });

  it("a missing or malformed token never overwrites a certified item; a valid token upgrades a legacy one", { timeout: TIMEOUT }, async () => {
    const w = await world();
    // Legacy (tokenless) creation; a malformed token is never stored.
    const legacy = await w.push(w.writerA, { ...w.t1, version: "5x" });
    expect((await canonical(legacy.id)).row.frontmatter).not.toHaveProperty("gdrive_version");
    // Legacy over legacy behaves as before this contract.
    await w.push(w.writerA, { ...w.t1, version: null, text: "legacy second walrus" });
    expect((await canonical(legacy.id)).row.body).toContain("legacy second walrus");
    // A certified observation upgrades the legacy item, preserving the evidence already held.
    await w.push(w.writerB, w.t2);
    const upgraded = await canonical(legacy.id);
    expect(upgraded.row.frontmatter.gdrive_version).toBe("7");
    expect(upgraded.row.body).toContain(T2_TEXT);
    expect(contributors(upgraded)).toEqual(["permission:r95-early", "permission:r95-late"]);
    // From now on a tokenless or malformed observation cannot replace it.
    for (const version of [null, "", "-8", "8.0", " 8"]) {
      await w.push(w.writerA, { ...w.t1, version, text: "late legacy walrus" });
      const after = await canonical(legacy.id);
      expect(canonicalFields(after)).toEqual(canonicalFields(upgraded));
    }
    await bothClaimsVisible(w, legacy.id);
  });

  it("large versions compare exactly: no truncation past 2^53 or int64", { timeout: TIMEOUT }, async () => {
    const w = await world();
    const committed = await w.push(w.writerB, { ...w.t2, version: "9007199254740993" });
    // Number("9007199254740992") === Number("9007199254740993"): a numeric comparison would tie.
    await w.push(w.writerA, { ...w.t1, version: "9007199254740992" });
    let after = await canonical(committed.id);
    expect(after.row.body).toContain(T2_TEXT);
    expect(after.row.frontmatter.gdrive_version).toBe("9007199254740993");
    // Past int64, with leading zeros on the wire.
    await w.push(w.writerB, { ...w.t2, version: "000184467440737095516160000", text: "newest quokka edition" });
    await w.push(w.writerA, { ...w.t1, version: "99999999999999999999999" });
    after = await canonical(committed.id);
    expect(after.row.body).toContain("newest quokka edition");
    expect(after.row.frontmatter.gdrive_version).toBe("184467440737095516160000");
  });

  it("a lost acknowledgement and a restart replay idempotently and never regress", { timeout: TIMEOUT }, async () => {
    const w = await world();
    const first = await w.push(w.writerA, w.t1);
    // A's acknowledgement was lost: the same observation is pushed again.
    expect((await w.push(w.writerA, w.t1)).status).toBe("unchanged");
    expect((await canonical(first.id)).versions).toBe(1);
    await w.push(w.writerB, w.t2);
    const settled = await canonical(first.id);
    // A restarted and replays its retained T1 after B's T2 committed.
    expect((await w.push(w.writerA, w.t1)).status).toBe("unchanged");
    expect(canonicalFields(await canonical(first.id))).toEqual(canonicalFields(settled));
  });

  it("A paused after its delayed delivery: T2 stands under B, and A's later pushes change nothing", { timeout: TIMEOUT }, async () => {
    const w = await world();
    const committed = await w.push(w.writerB, w.t2);
    await w.push(w.writerA, w.t1);
    const settled = await canonical(committed.id);
    await getPool().query(`update integrations set status='disabled' where id=$1`, [w.writerA.integrationId]);
    await expect(w.push(w.writerA, { ...w.t1, version: "9" })).rejects.toBeInstanceOf(GdriveAuthorityError);
    expect(canonicalFields(await canonical(committed.id))).toEqual(canonicalFields(settled));
    expect(await canSeeItem(db(), { teamId: w.seed.teamId, memberId: w.readerB }, committed.id)).toBe(true);
  });

  it("an invalidated execution mutates nothing — not even with a NEWER version (freshness is not authority)", { timeout: TIMEOUT }, async () => {
    const w = await world();
    const committed = await w.push(w.writerB, w.t2);
    const settled = await canonical(committed.id);
    await getPool().query(
      `update gdrive_connection_authority set fence = fence + 1 where integration_id=$1`, [w.writerA.integrationId]);
    await expect(w.push(w.writerA, { ...w.t1, version: "99", text: "fenced-out walrus" }))
      .rejects.toBeInstanceOf(GdriveAuthorityError);
    const after = await canonical(committed.id);
    expect(canonicalFields(after)).toEqual(canonicalFields(settled));
    expect(after.versions).toBe(settled.versions);
    expect(contributors(after)).toEqual(contributors(settled));
  });

  it("combined: T2 retained under B while A is revoked; A's delayed push and A's direct read get nothing", { timeout: TIMEOUT }, async () => {
    const w = await world();
    await w.push(w.writerA, w.t1);
    const committed = await w.push(w.writerB, w.t2);
    // A loses the document (production reconciliation) and its connection is disabled.
    await reconcileGdriveItems(db(), w.seed.teamId, {
      connectionId: w.writerA.integrationId, removedProviderIds: [PROVIDER], reason: "R95: A lost access",
    });
    await getPool().query(`update integrations set status='disabled' where id=$1`, [w.writerA.integrationId]);
    const settled = await canonical(committed.id);
    // A's delayed read is delivered now: refused, nothing changes, and A's retired claim stays retired.
    await expect(w.push(w.writerA, w.t1)).rejects.toBeInstanceOf(GdriveAuthorityError);
    expect(canonicalFields(await canonical(committed.id))).toEqual(canonicalFields(settled));
    expect(await canSeeItem(db(), { teamId: w.seed.teamId, memberId: w.readerA }, committed.id)).toBe(false);
    expect(await canSeeItem(db(), { teamId: w.seed.teamId, memberId: w.readerB }, committed.id)).toBe(true);
    // The direct reads agree: B is served T2, A is served neither T1 nor T2.
    const { GET } = await import("@/app/api/v1/items/route");
    const read = async (memberId: string) => {
      const { key } = await issueApiKey(db(), w.seed.teamId, memberId, "r95-combined");
      const res = await GET(new Request("http://test/api/v1/items?since=1970-01-01T00:00:00Z", {
        headers: { authorization: `Bearer ${key}` },
      }) as unknown as NextRequest);
      return res.text();
    };
    const asB = await read(w.readerB);
    expect(asB).toContain(T2_TEXT);
    const asA = await read(w.readerA);
    expect(asA).not.toContain(T2_TEXT);
    expect(asA).not.toContain(T1_TEXT);
  });
});
