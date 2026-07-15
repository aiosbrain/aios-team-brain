import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createMeetingNote, listMeetingNotesForTeam } from "@/lib/meetings/notes";
import { backfillMergeDuplicateMeetings } from "@/lib/meetings/merge";
import { db, seedTeam } from "./helpers";

/**
 * Spec for the one-time duplicate-merge backfill on real Postgres. Derived from intent: already-
 * created same-date overlapping notes collapse into one (crediting all submitters, hiding the
 * folded-away copies), while a same-date but unrelated meeting is left alone. Model unconfigured →
 * the deterministic union runs.
 */
const DATE = "2026-07-03";
const A =
  "Chetan and John discussed the mission control dashboard. They agreed to leverage gbrain and Hermes. " +
  "John will configure the personal setup for genetic projects and review the task management approach.";
const B =
  "They agreed to leverage gbrain and Hermes. John will configure the personal setup for genetic projects. " +
  "John also confirmed the launch deadline is next Friday.";
const UNRELATED = "Alice and Bob planned the Q3 marketing campaign budget and the launch timeline for the new mobile app store.";

async function member(teamId: string, name: string): Promise<string> {
  const { data } = await db()
    .from("members")
    .insert({ team_id: teamId, email: `${randomUUID()}@test.local`, display_name: name, actor_handle: `${name}-${randomUUID().slice(0, 6)}`, role: "member", tier: "team", status: "active" })
    .select("id")
    .single();
  return (data as { id: string }).id;
}

describe("backfill: merge duplicate meetings (real Postgres)", () => {
  it("collapses same-date overlapping notes into one, credits both, and leaves unrelated meetings alone", async () => {
    const { teamId, memberId: chetan } = await seedTeam();
    const john = await member(teamId, "John");

    await createMeetingNote(db(), teamId, { title: "AIOS sync", rawText: A, submittedByMemberId: chetan, occurredAt: DATE });
    await createMeetingNote(db(), teamId, { title: "AIOS sync", rawText: B, submittedByMemberId: john, occurredAt: DATE });
    await createMeetingNote(db(), teamId, { title: "Standup", rawText: UNRELATED, submittedByMemberId: chetan, occurredAt: DATE });

    // Three separate notes before the backfill.
    expect((await listMeetingNotesForTeam(db(), teamId, "team")).length).toBe(3);

    const summary = await backfillMergeDuplicateMeetings(db(), teamId, { keys: {}, actorMemberId: chetan });
    expect(summary.clusters).toBe(1);
    expect(summary.merged).toBe(1);

    const visible = await listMeetingNotesForTeam(db(), teamId, "team");
    expect(visible.length).toBe(2); // the merged AIOS note + the untouched standup

    const aios = visible.find((n) => n.title === "AIOS sync")!;
    expect(aios.submitters.map((s) => s.id).sort()).toEqual([chetan, john].sort());
    expect(visible.some((n) => n.title === "Standup")).toBe(true);
  });

  it("is a no-op when there are no duplicates", async () => {
    const { teamId, memberId } = await seedTeam();
    await createMeetingNote(db(), teamId, { title: "Solo", rawText: A, submittedByMemberId: memberId, occurredAt: DATE });
    const summary = await backfillMergeDuplicateMeetings(db(), teamId, { keys: {}, actorMemberId: memberId });
    expect(summary.merged).toBe(0);
  });
});
