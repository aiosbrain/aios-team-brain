import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import { removeMemberIdentity, setMemberIdentity } from "@/lib/identity/member-identities";
import { drainIdentityRepairs } from "@/lib/ingest/identity-repair";
import { db, driveFixture, ingest, seedTeam, type Seed } from "./helpers";

// AIO-1167 R76 F4 — a Drive document whose only Google author evidence is a SCALAR `author_email` (or a
// providerless structured ref) is Google evidence for the minimum Google repair consumers too: a Google
// email link credits it and an unlink clears it, a correction-locked item keeps its credit, and a
// non-Google item with the same email is never touched (real Postgres).

const E = "scalar.owner@example.com";
const KEY = `author-email:${E}`;

async function member(seed: Seed, name: string, email: string): Promise<string> {
  const { data, error } = await db().from("members").insert({
    team_id: seed.teamId, email, display_name: name,
    actor_handle: `${name.toLowerCase()}-${randomUUID().slice(0, 8)}`,
    role: "member", tier: "team", status: "active", is_connector: false,
  }).select("id").single();
  if (error || !data) throw new Error(`member seed failed: ${error?.message}`);
  return (data as { id: string }).id;
}

async function driveDoc(seed: Seed, suffix: string, frontmatter: Record<string, unknown>) {
  const result = await driveFixture(seed, {
    project: "drive-scalar", path: `gdrive/${suffix}-${randomUUID()}.md`, body: `body ${suffix}`,
    frontmatter: { source: "gdrive", source_id: `doc-${suffix}-${randomUUID()}`, title: `Drive ${suffix}`, ...frontmatter },
  }, { unclaimed: true, access: "team", attribution: { authorMemberId: null } });
  return result.id;
}

const creditOf = async (itemId: string) =>
  ((await db().from("items").select("member_id").eq("id", itemId).single()).data as { member_id: string | null }).member_id;

describe("AIO-1167 R76 F4 scalar/providerless Google author evidence in the Google repair (real Postgres)", () => {
  it.each([
    ["scalar author_email", { author_email: E }],
    ["providerless structured ref", { authors: [{ email: E, role: "author" }] }],
  ] as const)("%s: a Google email link credits, an unlink clears; locked and non-Google items are untouched", async (_shape, evidence) => {
    const seed = await seedTeam();
    const owner = await member(seed, "Owner", E);
    const item = await driveDoc(seed, "plain", evidence);
    const locked = await driveDoc(seed, "locked", evidence);
    await db().from("items").update({ member_id: owner, member_id_locked: true }).eq("id", locked);
    const notion = await ingest(seed, {
      path: `notion/${randomUUID()}.md`, body: "notion body", access: "team", project: "notion",
      frontmatter: { source: "notion", author_email: E },
    });
    const notionCredit = await creditOf(notion.id);

    const linked = await setMemberIdentity(db(), seed.teamId, owner, { provider: "gdrive", externalId: KEY, email: E });
    await drainIdentityRepairs(db(), { maxObligations: 10, batchSize: 10 });
    expect(await creditOf(item)).toBe(owner);

    const removed = await removeMemberIdentity(db(), seed.teamId, { provider: "gdrive", externalId: KEY }, {
      expectedRevision: linked.mappingRevision,
    });
    expect(removed.removed).toBe(true);
    await drainIdentityRepairs(db(), { maxObligations: 10, batchSize: 10 });

    expect(await creditOf(item), "the unlinked Google email credits nobody").toBeNull();
    expect(await creditOf(locked), "a correction lock wins").toBe(owner);
    expect(await creditOf(notion.id), "a non-Google item is never a Google repair candidate").toBe(notionCredit);
  });
});
