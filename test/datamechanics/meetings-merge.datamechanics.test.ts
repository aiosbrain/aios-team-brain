import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createMeetingNote, getMeetingNote } from "@/lib/meetings/notes";
import { findDuplicateMeeting, mergeIntoMeetingNote } from "@/lib/meetings/merge";
import { db, seedTeam } from "./helpers";

/**
 * Spec for duplicate-meeting merge on real Postgres. Derived from the scenario: two people upload
 * the same meeting (same date, overlapping transcripts). The second upload must merge into the
 * first note — not create a second — crediting both submitters and unioning unique content. A
 * different-date or unrelated transcript must NOT match.
 */
const DATE = "2026-07-03";
const A =
  "Chetan and John discussed the mission control dashboard. They agreed to leverage gbrain and Hermes. " +
  "John will configure the personal setup for genetic projects and review the task management approach.";
// Same meeting, partially transcribed by a second person, plus one line they uniquely captured.
const B =
  "They agreed to leverage gbrain and Hermes. John will configure the personal setup for genetic projects. " +
  "John also confirmed the launch deadline is next Friday.";
const UNRELATED =
  "Alice and Bob planned the Q3 marketing campaign budget and the launch timeline for the new mobile app store.";

async function secondMember(teamId: string): Promise<string> {
  const { data } = await db()
    .from("members")
    .insert({
      team_id: teamId,
      email: `${randomUUID()}@test.local`,
      display_name: "John",
      actor_handle: `john-${randomUUID().slice(0, 8)}`,
      role: "member",
      tier: "team",
      status: "active",
    })
    .select("id")
    .single();
  return (data as { id: string }).id;
}

describe("duplicate meeting merge (real Postgres)", () => {
  it("merges a second upload into the same note, crediting both submitters and unioning content", async () => {
    const { teamId, memberId: chetan } = await seedTeam();
    const john = await secondMember(teamId);

    const noteId = await createMeetingNote(db(), teamId, {
      title: "AIOS sync",
      rawText: A,
      submittedByMemberId: chetan,
      occurredAt: DATE,
    });

    const match = await findDuplicateMeeting(db(), teamId, DATE, B);
    expect(match).toBeTruthy();
    expect(match!.noteId).toBe(noteId);
    expect(match!.overlap).toBeGreaterThan(0.5);

    const mergedId = await mergeIntoMeetingNote(db(), teamId, match!, {
      newRawText: B,
      newSubmitterId: john,
      roster: [],
      keys: {},
    });
    expect(mergedId).toBe(noteId);

    // Still exactly one note for the team.
    const { count } = await db().from("meeting_notes").select("id", { count: "exact", head: true }).eq("team_id", teamId);
    expect(count).toBe(1);

    const note = await getMeetingNote(db(), teamId, noteId, "team");
    expect(note!.submitters.map((s) => s.id).sort()).toEqual([chetan, john].sort());
    // Merged transcript keeps the base and adds the second person's unique line.
    expect(note!.rawText).toContain("mission control dashboard");
    expect(note!.rawText).toContain("launch deadline is next Friday");
  });

  it("does not match an unrelated transcript or a different date", async () => {
    const { teamId, memberId } = await seedTeam();
    await createMeetingNote(db(), teamId, { title: "AIOS sync", rawText: A, submittedByMemberId: memberId, occurredAt: DATE });

    expect(await findDuplicateMeeting(db(), teamId, DATE, UNRELATED)).toBeNull(); // low overlap
    expect(await findDuplicateMeeting(db(), teamId, "2026-07-04", B)).toBeNull(); // different date
  });
});
