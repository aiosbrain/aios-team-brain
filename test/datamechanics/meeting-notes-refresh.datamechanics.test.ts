import { describe, expect, it } from "vitest";
import { db, seedTeam, ingest } from "./helpers";
import { backfillTeamContext } from "@/lib/projects/context/backfill";
import { backfillMeetingNotesFromItems } from "@/lib/meetings/from-items";
import { refreshMeetingNoteExtraction } from "@/lib/meetings/refresh";
import { listMeetingNotesForTeam, getMeetingNote } from "@/lib/meetings/notes";

/**
 * Spec (real Postgres, stubbed extractor): the refresh backfill heals meeting notes that already
 * exist but were saved with a BLANK summary (the array-shaped-summary parser bug). Re-running the
 * upload-time extraction over the existing note must fill its summary and action items (attendees are
 * NOT refreshed — see MTGATT-1 in the test below), and
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
  it("fills a blank summary + action items on an existing note, no duplicate — and does NOT touch attendees", async () => {
    const seed = await seedTeam(); // ENFB-3: gated reads need a context-bootstrapped team
    await backfillTeamContext(db(), seed.teamId);
    await seedBlankNote(seed, "t/blank.md", "# John / Chetan AIOS\n\nAlex will send the deck Friday.");

    await backfillTeamContext(db(), seed.teamId); // ENFB-3: converge memberships before the gated read
    const before = await listMeetingNotesForTeam(db(), seed.teamId, { memberId: seed.memberId, tier: "team" });
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

    await backfillTeamContext(db(), seed.teamId); // ENFB-3: converge memberships before the gated read
    const after = await listMeetingNotesForTeam(db(), seed.teamId, { memberId: seed.memberId, tier: "team" });
    expect(after.length).toBe(1); // NO duplicate note created
    expect(after[0].summary).toBe("- Discussed the roadmap\n- Alex owns the deck");
    // ATTENDANCE IS NOT WRITTEN HERE ANY MORE (MTGATT-1 / AIO-962). This function is driven by
    // `scripts/backfill-meeting-summaries`, whose DEFAULT is to refresh every note — so re-adding the
    // model's inferred attendees would undo the attendance repair on every run, and the fix would
    // appear to work and then silently revert. It heals SUMMARIES; who was present is owned by
    // `lib/meetings/attendance.ts` at create time and by the attendance backfill for existing rows.
    //
    // This assertion previously required the opposite, which is why the data-mechanics tier caught
    // the change and the unit tier did not: the behaviour only exists at the DB write.
    expect(after[0].attendees).toEqual([]);

    await backfillTeamContext(db(), seed.teamId); // ENFB-3: converge memberships before the gated read
    const detail = await getMeetingNote(db(), seed.teamId, after[0].id, { memberId: seed.memberId, tier: "team" });
    expect(detail!.extractedTodos.map((t) => t.title)).toEqual(["Send the deck"]);
  });

  it("onlyBlank=true skips notes that already have a summary", async () => {
    const seed = await seedTeam(); // ENFB-3: gated reads need a context-bootstrapped team
    await backfillTeamContext(db(), seed.teamId);
    await seedGranola(seed, "t/good.md", "# Standup\n\nnotes");
    await backfillMeetingNotesFromItems(db(), seed.teamId, {
      extract: async () => ({ summary: "- Already good", attendeeMemberIds: [] }),
    });

    const res = await refreshMeetingNoteExtraction(db(), seed.teamId, {
      onlyBlank: true,
      extract: async () => ({ summary: "- SHOULD NOT OVERWRITE", attendeeMemberIds: [] }),
    });
    expect(res.scanned).toBe(0); // the only note already has a summary → skipped entirely

    await backfillTeamContext(db(), seed.teamId); // ENFB-3: converge memberships before the gated read
    const notes = await listMeetingNotesForTeam(db(), seed.teamId, { memberId: seed.memberId, tier: "team" });
    expect(notes[0].summary).toBe("- Already good");
  });

  it("skips a note whose transcript body is empty (never fabricates a summary)", async () => {
    const seed = await seedTeam(); // ENFB-3: gated reads need a context-bootstrapped team
    await backfillTeamContext(db(), seed.teamId);
    await seedBlankNote(seed, "t/empty.md", "   "); // whitespace-only body

    const res = await refreshMeetingNoteExtraction(db(), seed.teamId, {
      extract: async () => ({ summary: "- should not be reached", attendeeMemberIds: [] }),
    });
    // Body is blank → note is skipped, or no note was even created for an empty transcript.
    expect(res.summarized).toBe(0);
    await backfillTeamContext(db(), seed.teamId); // ENFB-3: converge memberships before the gated read
    const notes = await listMeetingNotesForTeam(db(), seed.teamId, { memberId: seed.memberId, tier: "team" });
    if (notes.length) expect(notes[0].summary).toBe("");
  });

  it("is idempotent — a second identical run re-writes the same summary", async () => {
    const seed = await seedTeam(); // ENFB-3: gated reads need a context-bootstrapped team
    await backfillTeamContext(db(), seed.teamId);
    await seedBlankNote(seed, "t/idem.md", "# Sync\n\nnotes body here");

    const stub = { extract: async () => ({ summary: "- stable summary", attendeeMemberIds: [] }) };
    await refreshMeetingNoteExtraction(db(), seed.teamId, stub);
    const second = await refreshMeetingNoteExtraction(db(), seed.teamId, stub);
    expect(second.summarized).toBe(1);

    await backfillTeamContext(db(), seed.teamId); // ENFB-3: converge memberships before the gated read
    const notes = await listMeetingNotesForTeam(db(), seed.teamId, { memberId: seed.memberId, tier: "team" });
    expect(notes.length).toBe(1);
    expect(notes[0].summary).toBe("- stable summary");
  });
});
