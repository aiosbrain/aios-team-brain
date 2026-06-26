import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { reattributeItems } from "@/lib/ingest/reattribute";
import { setMemberIdentity } from "@/lib/identity/member-identities";
import { addAuthorAlias } from "@/lib/admin/aliases";
import { db, ingest, seedTeam } from "./helpers";

// Spec: ingest only stamps items.member_id at create/change time, so content ingested BEFORE a
// person's identity was mapped stays attributed to the connector. reattributeItems re-applies the
// current mappings to existing rows. Verified on real Postgres.

async function addMember(teamId: string): Promise<string> {
  const { data } = await db()
    .from("members")
    .insert({ team_id: teamId, email: `m-${randomUUID()}@test.local`, display_name: "Author", actor_handle: `h-${randomUUID().slice(0, 8)}`, role: "member", tier: "team", status: "active" })
    .select("id")
    .single();
  return (data as { id: string }).id;
}
async function memberOf(teamId: string, path: string): Promise<string | null> {
  const { data } = await db().from("items").select("member_id").eq("team_id", teamId).eq("path", path).maybeSingle();
  return (data as { member_id: string | null } | null)?.member_id ?? null;
}

describe("reattributeItems (real Postgres)", () => {
  it("re-points a Slack item to the author once their Slack id is mapped; idempotent after", async () => {
    const seed = await seedTeam(); // member A = ingest actor
    const author = await addMember(seed.teamId); // member B = real author

    await ingest(seed, { kind: "transcript", path: "slack/eng/1.md", body: "hello", access: "team", frontmatter: { source: "slack", author_id: "U1" } });
    expect(await memberOf(seed.teamId, "slack/eng/1.md")).toBe(seed.memberId); // attributed to the connector

    await setMemberIdentity(db(), seed.teamId, author, { provider: "slack", externalId: "U1" });
    const s = await reattributeItems(db(), seed.teamId);
    expect(s.updated).toBe(1);
    expect(await memberOf(seed.teamId, "slack/eng/1.md")).toBe(author); // now the real person

    expect((await reattributeItems(db(), seed.teamId)).updated).toBe(0); // idempotent
  });

  it("re-points a git commit item once an email alias is added", async () => {
    const seed = await seedTeam();
    const author = await addMember(seed.teamId);
    await ingest(seed, { kind: "artifact", path: "commits/repo/abc.md", body: "fix", access: "team", frontmatter: { source: "git", author: "Bob <bob@personal.com>" } });

    expect((await reattributeItems(db(), seed.teamId)).updated).toBe(0); // not yet resolvable
    await addAuthorAlias(db(), seed.teamId, author, "bob@personal.com");
    expect((await reattributeItems(db(), seed.teamId)).updated).toBe(1);
    expect(await memberOf(seed.teamId, "commits/repo/abc.md")).toBe(author);
  });

  it("never un-attributes when the author no longer resolves", async () => {
    const seed = await seedTeam();
    await ingest(seed, { kind: "transcript", path: "slack/eng/2.md", body: "x", access: "team", frontmatter: { source: "slack", author_id: "U-unknown" } });
    const s = await reattributeItems(db(), seed.teamId);
    expect(s.updated).toBe(0);
    expect(await memberOf(seed.teamId, "slack/eng/2.md")).toBe(seed.memberId); // left as-is
  });
});
