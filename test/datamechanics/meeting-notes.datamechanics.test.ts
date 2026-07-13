import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createMeetingNote,
  listMeetingNotesForTeam,
  getMeetingNote,
  MEETING_NOTES_PROJECT_SLUG,
} from "@/lib/meetings/notes";
import { extractMeetingTodosForTeam } from "@/lib/meetings/extract-todos";
import { db, seedTeam } from "./helpers";

/**
 * Spec for the meeting-notes single writer on REAL Postgres — the tier isolation (team-tier ONLY,
 * see lib/meetings/notes.ts's canSeeMeetingNotes) has no RLS backstop, so it must be proven against
 * the real DB, not just read from the impl.
 */

async function addAttendee(teamId: string, displayName: string): Promise<string> {
  const { data, error } = await db()
    .from("members")
    .insert({
      team_id: teamId,
      email: `${randomUUID()}@test.local`,
      display_name: displayName,
      actor_handle: `actor-${randomUUID().slice(0, 8)}`,
      role: "member",
      tier: "team",
      status: "active",
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`seed attendee failed: ${error?.message}`);
  return (data as { id: string }).id;
}

describe("meeting notes (real Postgres)", () => {
  it("persists the note, links attendees, and writes the transcript through ingestItem", async () => {
    const seed = await seedTeam();
    const attendeeId = await addAttendee(seed.teamId, "Attendee One");

    const noteId = await createMeetingNote(db(), seed.teamId, {
      title: "Weekly sync",
      rawText: "We discussed the roadmap.\n- [ ] ship the thing",
      submittedByMemberId: seed.memberId,
      summary: "Roadmap review.",
      attendeeMemberIds: [attendeeId],
    });

    const { data: noteRows } = await db()
      .from("meeting_notes")
      .select("id, team_id, title, summary, submitted_by, source_item_id")
      .eq("id", noteId);
    expect(noteRows?.length).toBe(1);
    const note = noteRows![0] as {
      team_id: string;
      title: string;
      summary: string;
      submitted_by: string;
      source_item_id: string;
    };
    expect(note.team_id).toBe(seed.teamId);
    expect(note.title).toBe("Weekly sync");
    expect(note.summary).toBe("Roadmap review.");
    expect(note.submitted_by).toBe(seed.memberId);

    const { data: attendeeRows } = await db()
      .from("meeting_note_attendees")
      .select("member_id")
      .eq("meeting_note_id", noteId);
    expect((attendeeRows ?? []).map((r) => (r as { member_id: string }).member_id)).toEqual([attendeeId]);

    const { data: itemRows } = await db()
      .from("items")
      .select("id, kind, access, body, path")
      .eq("id", note.source_item_id);
    expect(itemRows?.length).toBe(1);
    const item = itemRows![0] as { kind: string; access: string; body: string; path: string };
    expect(item.kind).toBe("transcript");
    expect(item.access).toBe("team");
    expect(item.body).toContain("ship the thing");
    expect(item.path).toBe(`meetings/${noteId}.md`);
  });

  it("is team-tier only: an external viewer gets [] / null even though the rows exist", async () => {
    const seed = await seedTeam();
    const noteId = await createMeetingNote(db(), seed.teamId, {
      title: "Internal-only note",
      rawText: "sensitive discussion",
      submittedByMemberId: seed.memberId,
    });

    const teamView = await listMeetingNotesForTeam(db(), seed.teamId, "team");
    expect(teamView.map((n) => n.id)).toContain(noteId);

    const externalList = await listMeetingNotesForTeam(db(), seed.teamId, "external");
    expect(externalList).toEqual([]);

    const externalDetail = await getMeetingNote(db(), seed.teamId, noteId, "external");
    expect(externalDetail).toBeNull();

    const teamDetail = await getMeetingNote(db(), seed.teamId, noteId, "team");
    expect(teamDetail?.title).toBe("Internal-only note");
    expect(teamDetail?.rawText).toBe("sensitive discussion");
  });

  it("surfaces todos extracted from the note's transcript, linked to their created task", async () => {
    const seed = await seedTeam();
    const noteId = await createMeetingNote(db(), seed.teamId, {
      title: "Planning",
      rawText: "Notes.\n- [ ] follow up with the vendor",
      submittedByMemberId: seed.memberId,
    });

    const extraction = await extractMeetingTodosForTeam(db(), seed.teamId, {
      sourceProject: MEETING_NOTES_PROJECT_SLUG,
    });
    expect(extraction.upserted).toBeGreaterThan(0);

    const detail = await getMeetingNote(db(), seed.teamId, noteId, "team");
    expect(detail?.extractedTodos).toHaveLength(1);
    expect(detail?.extractedTodos[0].title).toBe("follow up with the vendor");
    expect(detail?.extractedTodos[0].status).toBe("backlog");
  });
});
