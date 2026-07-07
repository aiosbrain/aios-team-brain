import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ingestItem } from "@/lib/ingest";
import { reattributeItems } from "@/lib/ingest/reattribute";
import { setMemberIdentity } from "@/lib/identity/member-identities";
import { addAuthorAlias } from "@/lib/admin/aliases";
import { db, seedTeam, sha, type Seed } from "./helpers";

// Spec: ingest only stamps items.member_id on create/change, and (post attribution-fix) an
// unresolved author is left unattributed (null), never falling back to the ingesting connector.
// reattributeItems re-applies current identity mappings to already-ingested rows, turning a null
// into a resolved member_id once mapping exists — and, for the narrow legacy case of a row still
// standing on a connector service-account from before the fix, clears it to null instead of
// leaving it there (a connector id was never "good attribution"). It still never erases a
// previously-resolved HUMAN's attribution just because re-resolution comes up empty on a later
// run. Verified on real Postgres.

async function addMember(
  teamId: string,
  opts: { connector?: boolean } = {},
): Promise<string> {
  const { data } = await db()
    .from("members")
    .insert({
      team_id: teamId,
      email: `m-${randomUUID()}@test.local`,
      display_name: opts.connector ? "Slack Sync" : "Author",
      actor_handle: `h-${randomUUID().slice(0, 8)}`,
      role: "member",
      tier: "team",
      status: "active",
      is_connector: Boolean(opts.connector),
    })
    .select("id")
    .single();
  return (data as { id: string }).id;
}

async function memberOf(teamId: string, path: string): Promise<string | null> {
  const { data } = await db()
    .from("items")
    .select("member_id")
    .eq("team_id", teamId)
    .eq("path", path)
    .maybeSingle();
  return (data as { member_id: string | null } | null)?.member_id ?? null;
}

/** Ingest via a connector, author unresolved at ingest time (opts.authorMemberId: null explicitly). */
async function putUnresolved(
  seed: Seed,
  connectorId: string,
  path: string,
  frontmatter: Record<string, unknown>,
) {
  return ingestItem(
    db(),
    { teamId: seed.teamId, memberId: connectorId, apiKeyId: randomUUID() },
    {
      project: "acme",
      kind: "transcript",
      actor: "",
      content_sha256: sha(path),
      access: "team",
      path,
      body: "hello",
      frontmatter,
    },
    "team",
    { authorMemberId: null },
  );
}

/** Ingest attributed directly to a known (resolved) member — a "good attribution" baseline. */
async function putResolved(
  seed: Seed,
  actorId: string,
  authorId: string,
  path: string,
  frontmatter: Record<string, unknown>,
) {
  return ingestItem(
    db(),
    { teamId: seed.teamId, memberId: actorId, apiKeyId: randomUUID() },
    {
      project: "acme",
      kind: "transcript",
      actor: "",
      content_sha256: sha(path),
      access: "team",
      path,
      body: "hello",
      frontmatter,
    },
    "team",
    { authorMemberId: authorId },
  );
}

describe("reattributeItems (real Postgres)", () => {
  it("re-points a Slack item to the author once their Slack id is mapped; idempotent after", async () => {
    const seed = await seedTeam();
    const connector = await addMember(seed.teamId, { connector: true });
    const author = await addMember(seed.teamId);

    await putUnresolved(seed, connector, "slack/eng/1.md", {
      source: "slack",
      author_id: "U1",
    });
    expect(await memberOf(seed.teamId, "slack/eng/1.md")).toBeNull(); // unresolved at ingest time

    await setMemberIdentity(db(), seed.teamId, author, {
      provider: "slack",
      externalId: "U1",
    });
    const s = await reattributeItems(db(), seed.teamId);
    expect(s.updated).toBe(1);
    expect(await memberOf(seed.teamId, "slack/eng/1.md")).toBe(author); // now the real person

    expect((await reattributeItems(db(), seed.teamId)).updated).toBe(0); // idempotent
  });

  it("re-points a git commit item once an email alias is added", async () => {
    const seed = await seedTeam();
    const author = await addMember(seed.teamId);
    await putUnresolved(seed, seed.memberId, "commits/repo/abc.md", {
      source: "git",
      author: "Bob <bob@personal.com>",
    });

    expect((await reattributeItems(db(), seed.teamId)).updated).toBe(0); // not yet resolvable
    await addAuthorAlias(db(), seed.teamId, author, "bob@personal.com");
    expect((await reattributeItems(db(), seed.teamId)).updated).toBe(1);
    expect(await memberOf(seed.teamId, "commits/repo/abc.md")).toBe(author);
  });

  it("never un-attributes a real human's existing attribution when the author no longer resolves", async () => {
    const seed = await seedTeam();
    const knownAuthor = await addMember(seed.teamId);
    // Ingested already attributed to a real, non-connector member — "good attribution" — and the
    // frontmatter's slack id was never mapped, so reattribute's resolution comes up empty.
    await putResolved(seed, seed.memberId, knownAuthor, "slack/eng/2.md", {
      source: "slack",
      author_id: "U-unknown",
    });

    const s = await reattributeItems(db(), seed.teamId);
    expect(s.updated).toBe(0);
    expect(await memberOf(seed.teamId, "slack/eng/2.md")).toBe(knownAuthor); // left as-is, never erased
  });

  it("clears a connector-attributed item to null when the author still doesn't resolve (legacy pre-fix data)", async () => {
    const seed = await seedTeam();
    const connector = await addMember(seed.teamId, { connector: true });
    await putUnresolved(seed, connector, "slack/eng/3.md", {
      source: "slack",
      author_id: "U-unknown-2",
    });
    // Simulate a legacy row from before the attribution fix, where this would have landed on the
    // connector instead of staying null.
    await db()
      .from("items")
      .update({ member_id: connector })
      .eq("team_id", seed.teamId)
      .eq("path", "slack/eng/3.md");
    expect(await memberOf(seed.teamId, "slack/eng/3.md")).toBe(connector);

    const s = await reattributeItems(db(), seed.teamId);
    expect(s.updated).toBe(1);
    expect(await memberOf(seed.teamId, "slack/eng/3.md")).toBeNull(); // cleared, not left on the connector
  });
});
