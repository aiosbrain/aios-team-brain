import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { db, seedTeam, ingest, sha } from "./helpers";
import { ingestItem } from "@/lib/ingest";
import { resolveHumanActors } from "@/lib/graph/human-actors";

// Spec (narrative-arc human attribution, real Postgres): the join that turns a brain item's
// `member_id` into a traceable human name for the arc-attribution layer — must resolve real humans,
// exclude connector service-accounts (never a real person), and stay team-scoped.

async function connectorMember(teamId: string, displayName: string): Promise<string> {
  const { data, error } = await db()
    .from("members")
    .insert({
      team_id: teamId,
      email: `${randomUUID()}@connector.local`,
      display_name: displayName,
      actor_handle: `connector-${randomUUID().slice(0, 8)}`,
      role: "member",
      tier: "team",
      status: "active",
      is_connector: true,
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`seed connector member: ${error?.message}`);
  return (data as { id: string }).id;
}

describe("resolveHumanActors (data-mechanics)", () => {
  it("resolves the human display name behind an item's member_id", async () => {
    const seed = await seedTeam();
    const res = await ingest(seed, { path: "slack/eng/1.md", body: "shipped the importer", access: "team" });

    const humans = await resolveHumanActors(db(), seed.teamId, [res.id]);
    expect(humans).toEqual(["Tester"]);
  });

  it("excludes a connector service-account — a connector is never a traceable human", async () => {
    const seed = await seedTeam();
    const connectorId = await connectorMember(seed.teamId, "Slack Sync");
    const body = "connector-authored content";
    const item = await ingestItem(
      db(),
      { teamId: seed.teamId, memberId: seed.memberId, apiKeyId: randomUUID() },
      {
        project: "acme",
        kind: "deliverable",
        actor: "slack-sync",
        frontmatter: {},
        body,
        content_sha256: sha(body),
        path: "slack/eng/2.md",
        access: "team",
      },
      "team",
      { authorMemberId: connectorId }
    );

    const humans = await resolveHumanActors(db(), seed.teamId, [item.id]);
    expect(humans).toEqual([]);
  });

  it("is team-scoped — an item id from another team never resolves", async () => {
    const seedA = await seedTeam();
    const seedB = await seedTeam();
    const res = await ingest(seedA, { path: "slack/eng/3.md", body: "team A work", access: "team" });

    expect(await resolveHumanActors(db(), seedB.teamId, [res.id])).toEqual([]);
  });

  it("dedupes across multiple items attributed to the same human", async () => {
    const seed = await seedTeam();
    const a = await ingest(seed, { path: "slack/eng/4.md", body: "part one", access: "team" });
    const b = await ingest(seed, { path: "slack/eng/5.md", body: "part two", access: "team" });

    expect(await resolveHumanActors(db(), seed.teamId, [a.id, b.id])).toEqual(["Tester"]);
  });

  it("returns [] for an empty item id list", async () => {
    const seed = await seedTeam();
    expect(await resolveHumanActors(db(), seed.teamId, [])).toEqual([]);
  });
});
