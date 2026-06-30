import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { db, seedTeam } from "./helpers";
import {
  createConversation,
  appendMessage,
  listConversations,
  getConversation,
  recentTurns,
  renameConversation,
  archiveConversation,
} from "@/lib/chat/store";

// Spec (persistent chat history) verified to the observable outcome on real Postgres: threads persist
// owner-scoped; a member only ever sees their own; recentTurns windows prior turns; archive soft-deletes.

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

describe("chat store (data-mechanics)", () => {
  it("persists a thread and reads it back in order", async () => {
    const seed = await seedTeam();
    const owner = { teamId: seed.teamId, memberId: seed.memberId };
    const convo = await createConversation(db(), owner, "what did chetan ship last week?");
    expect(convo?.id).toBeTruthy();
    await appendMessage(db(), owner, convo!.id, "user", "what did chetan ship last week?");
    await appendMessage(db(), owner, convo!.id, "assistant", "Chetan shipped the Linear importer [S1].", {
      cited_item_ids: [],
      cost_usd: 0.01,
    });

    const read = await getConversation(db(), owner, convo!.id);
    expect(read?.title).toBe("what did chetan ship last week?");
    expect(read?.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(read?.messages[1].content).toContain("Linear importer");
  });

  it("is owner-scoped: another member cannot read or window the thread", async () => {
    const seed = await seedTeam();
    const owner = { teamId: seed.teamId, memberId: seed.memberId };
    const otherId = await secondMember(seed.teamId);
    const other = { teamId: seed.teamId, memberId: otherId };

    const convo = await createConversation(db(), owner, "private question");
    await appendMessage(db(), owner, convo!.id, "user", "private question");
    await appendMessage(db(), owner, convo!.id, "assistant", "private answer");

    expect(await getConversation(db(), other, convo!.id)).toBeNull();
    expect(await recentTurns(db(), other, convo!.id)).toEqual([]);
    expect((await listConversations(db(), other)).map((c) => c.id)).not.toContain(convo!.id);
    expect(await renameConversation(db(), other, convo!.id, "hijack")).toBe(false);
    expect(await archiveConversation(db(), other, convo!.id)).toBe(false);
  });

  it("recentTurns returns prior completed turns, windowed and paired", async () => {
    const seed = await seedTeam();
    const owner = { teamId: seed.teamId, memberId: seed.memberId };
    const convo = await createConversation(db(), owner, "q0");
    for (let i = 0; i < 4; i++) {
      await appendMessage(db(), owner, convo!.id, "user", `q${i}`);
      await appendMessage(db(), owner, convo!.id, "assistant", `a${i}`);
    }
    const turns = await recentTurns(db(), owner, convo!.id, 2);
    expect(turns).toEqual([
      { question: "q2", answer: "a2" },
      { question: "q3", answer: "a3" },
    ]);
  });

  it("archive soft-deletes: hidden from the list and from getConversation", async () => {
    const seed = await seedTeam();
    const owner = { teamId: seed.teamId, memberId: seed.memberId };
    const convo = await createConversation(db(), owner, "to delete");
    await appendMessage(db(), owner, convo!.id, "user", "to delete");

    expect(await archiveConversation(db(), owner, convo!.id)).toBe(true);
    expect(await getConversation(db(), owner, convo!.id)).toBeNull();
    expect((await listConversations(db(), owner)).map((c) => c.id)).not.toContain(convo!.id);
  });

  it("lists conversations newest-active first", async () => {
    const seed = await seedTeam();
    const owner = { teamId: seed.teamId, memberId: seed.memberId };
    const a = await createConversation(db(), owner, "first");
    const b = await createConversation(db(), owner, "second");
    // Touch `a` so it becomes most-recently-active.
    await appendMessage(db(), owner, a!.id, "user", "bump");
    const ids = (await listConversations(db(), owner)).map((c) => c.id);
    expect(ids.indexOf(a!.id)).toBeLessThan(ids.indexOf(b!.id));
  });
});
