import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { db, seedTeam } from "./helpers";
import { createConversation, appendMessage, recentTurns } from "@/lib/chat/store";
import {
  createRun,
  flushPartial,
  finishRun,
  failRun,
  latestRun,
  activeRun,
  RUN_STALE_AFTER_MS,
} from "@/lib/query/turn-runs";

// Spec: docs/design/query-background-stream.md — acceptance criteria 1, 4, 6 (owner scope), and the
// staleness rule, verified to the observable outcome on real Postgres (constraints + defaults live).

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

describe("chat turn runs (data-mechanics)", () => {
  it("lifecycle: streaming → partial heartbeat → done pointing at the final message", async () => {
    const seed = await seedTeam();
    const owner = { teamId: seed.teamId, memberId: seed.memberId };
    const convo = await createConversation(db(), owner, "what shipped?");
    const run = await createRun(db(), owner, convo!.id, "what shipped?");
    expect(run?.id).toBeTruthy();

    const fresh = await latestRun(db(), owner, convo!.id);
    expect(fresh?.status).toBe("streaming");
    expect(fresh?.partial_text).toBe(""); // default, not null

    await flushPartial(db(), run!.id, "partial ans");
    expect((await latestRun(db(), owner, convo!.id))?.partial_text).toBe("partial ans");

    // The real ordering: the assistant message exists FIRST, then the run points at it.
    const messageId = await appendMessage(db(), owner, convo!.id, "assistant", "the full answer");
    expect(messageId).toBeTruthy();
    await finishRun(db(), run!.id, messageId);

    const done = await latestRun(db(), owner, convo!.id);
    expect(done?.status).toBe("done");
    expect(done?.final_message_id).toBe(messageId);
  });

  it("a failed run stores the sanitized message and reports error", async () => {
    const seed = await seedTeam();
    const owner = { teamId: seed.teamId, memberId: seed.memberId };
    const convo = await createConversation(db(), owner, "q");
    const run = await createRun(db(), owner, convo!.id, "q");
    await failRun(db(), run!.id, "The model was busy. Please try again in a moment.");

    const read = await latestRun(db(), owner, convo!.id);
    expect(read?.status).toBe("error");
    expect(read?.error_message).toMatch(/busy/i);
    expect(read?.final_message_id).toBeNull();
  });

  it("is OWNER-SCOPED: another member cannot read this member's run", async () => {
    const seed = await seedTeam();
    const owner = { teamId: seed.teamId, memberId: seed.memberId };
    const convo = await createConversation(db(), owner, "private question");
    await createRun(db(), owner, convo!.id, "private question");

    const intruder = { teamId: seed.teamId, memberId: await secondMember(seed.teamId) };
    expect(await latestRun(db(), intruder, convo!.id)).toBeNull();
    expect(await activeRun(db(), intruder)).toBeNull();
    // …and the owner still sees it, so the assertion above isn't vacuous.
    expect(await latestRun(db(), owner, convo!.id)).not.toBeNull();
  });

  it("activeRun returns a live streaming run, and NOTHING once it settles", async () => {
    const seed = await seedTeam();
    const owner = { teamId: seed.teamId, memberId: seed.memberId };
    const convo = await createConversation(db(), owner, "q");
    const run = await createRun(db(), owner, convo!.id, "q");

    const live = await activeRun(db(), owner);
    expect(live?.id).toBe(run!.id);

    await finishRun(db(), run!.id, null);
    expect(await activeRun(db(), owner)).toBeNull();
  });

  it("a STALE streaming run is not reported active (deploy-killed turn must not spin forever)", async () => {
    const seed = await seedTeam();
    const owner = { teamId: seed.teamId, memberId: seed.memberId };
    const convo = await createConversation(db(), owner, "q");
    const run = await createRun(db(), owner, convo!.id, "q");

    // Simulate the process dying: the row stays `streaming` and simply stops heartbeating.
    const dead = new Date(Date.now() - RUN_STALE_AFTER_MS - 60_000).toISOString();
    await db().from("chat_turn_runs").update({ updated_at: dead }).eq("id", run!.id);

    expect(await activeRun(db(), owner)).toBeNull();
    // The row is still `streaming` in the table — it's the READ that ages it out.
    expect((await latestRun(db(), owner, convo!.id))?.status).toBe("streaming");
  });

  it("flushPartial cannot resurrect a settled run", async () => {
    const seed = await seedTeam();
    const owner = { teamId: seed.teamId, memberId: seed.memberId };
    const convo = await createConversation(db(), owner, "q");
    const run = await createRun(db(), owner, convo!.id, "q");
    await finishRun(db(), run!.id, null);

    await flushPartial(db(), run!.id, "late chunk that must be ignored");
    const read = await latestRun(db(), owner, convo!.id);
    expect(read?.status).toBe("done");
    expect(read?.partial_text).toBe("");
  });

  it("an in-flight partial NEVER enters the LLM memory window (recentTurns sees only complete pairs)", async () => {
    const seed = await seedTeam();
    const owner = { teamId: seed.teamId, memberId: seed.memberId };
    const convo = await createConversation(db(), owner, "first");
    // One completed turn…
    await appendMessage(db(), owner, convo!.id, "user", "first");
    await appendMessage(db(), owner, convo!.id, "assistant", "first answer");
    // …then a turn that is still streaming, with a partial living in the run row.
    await appendMessage(db(), owner, convo!.id, "user", "second");
    const run = await createRun(db(), owner, convo!.id, "second");
    await flushPartial(db(), run!.id, "half an answer that must not be remembered");

    const turns = await recentTurns(db(), owner, convo!.id);
    expect(turns).toHaveLength(1);
    expect(turns[0].answer).toBe("first answer");
    expect(JSON.stringify(turns)).not.toContain("half an answer");
  });

  it("cascades with its conversation (no orphan runs)", async () => {
    const seed = await seedTeam();
    const owner = { teamId: seed.teamId, memberId: seed.memberId };
    const convo = await createConversation(db(), owner, "q");
    const run = await createRun(db(), owner, convo!.id, "q");
    await db().from("conversations").delete().eq("id", convo!.id);
    const { data } = await db().from("chat_turn_runs").select("id").eq("id", run!.id).maybeSingle();
    expect(data).toBeNull();
  });
});
