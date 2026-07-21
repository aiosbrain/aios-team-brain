import { describe, expect, it } from "vitest";
import { db, seedTeam, ingest } from "./helpers";
import { backfillMeetingNotesFromItems } from "@/lib/meetings/from-items";
import { refreshMeetingNoteExtraction } from "@/lib/meetings/refresh";
import { listMeetingNotesForTeam, getMeetingNote } from "@/lib/meetings/notes";

/**
 * Spec (real Postgres, stubbed extractor): the refresh backfill heals meeting notes that already
 * exist but were saved with a BLANK summary (the array-shaped-summary parser bug). Re-running the
 * upload-time extraction over the existing note must fill its summary, link attendees, and
 * materialize action items — "as if it had just been uploaded" — WITHOUT creating a duplicate note.
 */

async function seedGranola(seed: Awaited<ReturnType<typeof seedTeam>>, path: string, body: string) {
  return ingest(seed, { kind: "transcript", access: "team", path, body, frontmatter: { source: "granola", created: "2026-07-06" } });
}

/** Create a note whose summary is blank — mimics a note uploaded while the summary parser was broken. */
async function seedBlankNote(seed: Awaited<ReturnType<typeof seedTeam>>, path: string, body: string) {
  await seedGranola(seed, path, body);
  await backfillMeetingNotesFromItems(db(), seed.teamId, {
    extract: async () => ({ summary: "", attendeeMemberIds: [] }),
  });
}

describe("meeting-notes refresh backfill (data-mechanics)", () => {
  it("fills a blank summary + attendees + action items on an existing note, no duplicate", async () => {
    const seed = await seedTeam();
    await seedBlankNote(seed, "t/blank.md", "# John / Chetan AIOS\n\nAlex will send the deck Friday.");

    const before = await listMeetingNotesForTeam(db(), seed.teamId, "team");
    expect(before.length).toBe(1);
    expect(before[0].summary).toBe(""); // the bug victim

    const res = await refreshMeetingNoteExtraction(db(), seed.teamId, {
      extract: async () => ({ summary: "- Discussed the roadmap\n- Alex owns the deck", attendeeMemberIds: [seed.memberId] }),
      extractActionItems: async () => [
        { title: "Send the deck", assignee: "Alex", due: "2026-07-18", line: 1, sourceText: "Send the deck" },
      ],
    });
    expect(res.summarized).toBe(1);
    expect(res.actionItems).toBe(1);

    const after = await listMeetingNotesForTeam(db(), seed.teamId, "team");
    expect(after.length).toBe(1); // NO duplicate note created
    expect(after[0].summary).toBe("- Discussed the roadmap\n- Alex owns the deck");
    expect(after[0].attendees.map((a) => a.id)).toEqual([seed.memberId]);

    const detail = await getMeetingNote(db(), seed.teamId, after[0].id, "team");
    expect(detail!.extractedTodos.map((t) => t.title)).toEqual(["Send the deck"]);
  });

  it("onlyBlank=true skips notes that already have a summary", async () => {
    const seed = await seedTeam();
    await seedGranola(seed, "t/good.md", "# Standup\n\nnotes");
    await backfillMeetingNotesFromItems(db(), seed.teamId, {
      extract: async () => ({ summary: "- Already good", attendeeMemberIds: [] }),
    });

    const res = await refreshMeetingNoteExtraction(db(), seed.teamId, {
      onlyBlank: true,
      extract: async () => ({ summary: "- SHOULD NOT OVERWRITE", attendeeMemberIds: [] }),
    });
    expect(res.scanned).toBe(0); // the only note already has a summary → skipped entirely

    const notes = await listMeetingNotesForTeam(db(), seed.teamId, "team");
    expect(notes[0].summary).toBe("- Already good");
  });

  it("skips a note whose transcript body is empty (never fabricates a summary)", async () => {
    const seed = await seedTeam();
    await seedBlankNote(seed, "t/empty.md", "   "); // whitespace-only body

    const res = await refreshMeetingNoteExtraction(db(), seed.teamId, {
      extract: async () => ({ summary: "- should not be reached", attendeeMemberIds: [] }),
    });
    // Body is blank → note is skipped, or no note was even created for an empty transcript.
    expect(res.summarized).toBe(0);
    const notes = await listMeetingNotesForTeam(db(), seed.teamId, "team");
    if (notes.length) expect(notes[0].summary).toBe("");
  });

  it("is idempotent — a second identical run re-writes the same summary", async () => {
    const seed = await seedTeam();
    await seedBlankNote(seed, "t/idem.md", "# Sync\n\nnotes body here");

    const stub = { extract: async () => ({ summary: "- stable summary", attendeeMemberIds: [] }) };
    await refreshMeetingNoteExtraction(db(), seed.teamId, stub);
    const second = await refreshMeetingNoteExtraction(db(), seed.teamId, stub);
    expect(second.summarized).toBe(1);

    const notes = await listMeetingNotesForTeam(db(), seed.teamId, "team");
    expect(notes.length).toBe(1);
    expect(notes[0].summary).toBe("- stable summary");
  });
});
