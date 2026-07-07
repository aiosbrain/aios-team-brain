import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { db, seedTeam } from "./helpers";
import {
  createConversation,
  appendMessage,
  searchConversations,
  listConversations,
} from "@/lib/chat/store";

// Spec (conversation content search) verified to the observable outcome on real Postgres: search
// matches by message CONTENT (FTS) or title, stays owner-scoped, and empty query returns the list.

async function secondMember(teamId: string): Promise<string> {
  const { data, error } = await db()
    .from("members")
    .insert({
      team_id: teamId,
      email: `${randomUUID()}@test.local`,
      display_name: "Other",
      actor_handle: `actor-${randomUUID().slice(0, 8)}`,
      role: "member",
      tier: "team",
      status: "active",
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`seed member: ${error?.message}`);
  return (data as { id: string }).id;
}

describe("chat search (data-mechanics)", () => {
  it("finds a conversation by a distinctive word in its message content (FTS)", async () => {
    const seed = await seedTeam();
    const owner = { teamId: seed.teamId, memberId: seed.memberId };
    const target = await createConversation(db(), owner, "Deploy chat");
    await appendMessage(db(), owner, target!.id, "user", "how do I fix the photosynthesis pipeline?");
    await appendMessage(db(), owner, target!.id, "assistant", "adjust the chlorophyll settings");
    const other = await createConversation(db(), owner, "Unrelated");
    await appendMessage(db(), owner, other!.id, "user", "something about railway deploys");

    const hits = await searchConversations(db(), owner, "photosynthesis");
    expect(hits.map((c) => c.id)).toEqual([target!.id]);
  });

  it("also matches by title", async () => {
    const seed = await seedTeam();
    const owner = { teamId: seed.teamId, memberId: seed.memberId };
    const c = await createConversation(db(), owner, "Kubernetes migration plan");
    await appendMessage(db(), owner, c!.id, "user", "hi");
    const hits = await searchConversations(db(), owner, "kubernetes");
    expect(hits.map((x) => x.id)).toContain(c!.id);
  });

  it("is owner-scoped: another member's matching content never surfaces", async () => {
    const seed = await seedTeam();
    const owner = { teamId: seed.teamId, memberId: seed.memberId };
    const otherId = await secondMember(seed.teamId);
    const other = { teamId: seed.teamId, memberId: otherId };
    const theirs = await createConversation(db(), other, "Theirs");
    await appendMessage(db(), other, theirs!.id, "user", "the photosynthesis secret plan");

    expect(await searchConversations(db(), owner, "photosynthesis")).toEqual([]);
  });

  it("empty query returns the full list", async () => {
    const seed = await seedTeam();
    const owner = { teamId: seed.teamId, memberId: seed.memberId };
    await createConversation(db(), owner, "one");
    await createConversation(db(), owner, "two");
    const searched = await searchConversations(db(), owner, "   ");
    const listed = await listConversations(db(), owner);
    expect(searched.map((c) => c.id).sort()).toEqual(listed.map((c) => c.id).sort());
  });
});
