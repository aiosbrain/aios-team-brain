import { describe, expect, it } from "vitest";
import { db, seedTeam, ingest } from "./helpers";
import { backfillMeetingNotesFromItems } from "@/lib/meetings/from-items";
import { listMeetingNotesForTeam, getMeetingNote } from "@/lib/meetings/notes";

// Spec (meeting-notes bridge, real Postgres, stubbed extractor): CLI-pushed meeting transcripts
// become meeting_notes — but ONLY meeting sources (granola), never Slack threads. Idempotent, links
// the existing item, derives a title, and shows up on the Meetings page reader.

const stubExtract = async () => ({ summary: "Discussed the launch.", attendeeMemberIds: [] as string[] });

async function seedTranscript(seed: Awaited<ReturnType<typeof seedTeam>>, source: string, over: { path: string; body: string }) {
  return ingest(seed, {
    kind: "transcript",
    access: "team",
    path: over.path,
    body: over.body,
    frontmatter: { source, created: "2026-07-06" },
  });
}

describe("meeting-notes backfill (data-mechanics)", () => {
  it("creates a note for a Granola transcript but NOT a Slack thread", async () => {
    const seed = await seedTeam();
    const granola = await seedTranscript(seed, "granola", {
      path: "2-work/transcripts/2026-07-06-john-chetan.md",
      body: "# John / Chetan AIOS\n\nWe shipped the job queue.",
    });
    await seedTranscript(seed, "slack", { path: "slack/eng/1.md", body: "# eng thread\n\nsome chat" });

    const s = await backfillMeetingNotesFromItems(db(), seed.teamId, { extract: stubExtract });
    expect(s.created).toBe(1); // granola only

    const notes = await listMeetingNotesForTeam(db(), seed.teamId, "team");
    expect(notes.length).toBe(1);
    expect(notes[0].title).toBe("John / Chetan AIOS"); // derived from the body H1
    expect(notes[0].summary).toBe("Discussed the launch."); // from the stubbed extractor
    expect(notes[0].occurredAt).toBe("2026-07-06");

    // The note links the EXISTING transcript item (no duplicate item created).
    const detail = await getMeetingNote(db(), seed.teamId, notes[0].id, "team");
    expect(detail!.rawText).toContain("We shipped the job queue.");
    void granola;
  });

  it("is idempotent — a second run creates nothing new", async () => {
    const seed = await seedTeam();
    await seedTranscript(seed, "granola", { path: "t/1.md", body: "# Sync\n\nnotes" });

    expect((await backfillMeetingNotesFromItems(db(), seed.teamId, { extract: stubExtract })).created).toBe(1);
    const again = await backfillMeetingNotesFromItems(db(), seed.teamId, { extract: stubExtract });
    expect(again.created).toBe(0);
    expect((await listMeetingNotesForTeam(db(), seed.teamId, "team")).length).toBe(1);
  });

  it("links resolved attendees from the extractor", async () => {
    const seed = await seedTeam();
    await seedTranscript(seed, "granola", { path: "t/2.md", body: "# Standup\n\nnotes" });

    await backfillMeetingNotesFromItems(db(), seed.teamId, {
      extract: async () => ({ summary: "s", attendeeMemberIds: [seed.memberId] }),
    });
    const notes = await listMeetingNotesForTeam(db(), seed.teamId, "team");
    expect(notes[0].attendees.map((a) => a.id)).toEqual([seed.memberId]);
  });

  it("returns nothing when there are no meeting transcripts", async () => {
    const seed = await seedTeam();
    await seedTranscript(seed, "slack", { path: "slack/x.md", body: "# thread\n\nchat" });
    const s = await backfillMeetingNotesFromItems(db(), seed.teamId, { extract: stubExtract });
    expect(s).toEqual({ scanned: 0, created: 0, skipped: 0 });
  });
});
