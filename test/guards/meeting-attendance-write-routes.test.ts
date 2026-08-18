import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * GUARD: no route may write attendance from the MODEL (MTGATT-1 / AIO-962).
 *
 * The precedence in `lib/meetings/attendance.ts` fixes attendance at CREATE time. Two other routes
 * write attendee rows on their own schedule, and the first review found both still adding the LLM's
 * answer unconditionally:
 *
 *   · `mergeIntoMeetingNote` — runs automatically on EVERY scheduler tick via
 *     `backfillMergeDuplicateMeetings`;
 *   · `refreshMeetingNoteExtraction` — driven by `scripts/backfill-meeting-summaries`, whose DEFAULT
 *     is to refresh every note.
 *
 * So a repaired meeting would be re-polluted on the next tick, or by the documented healing script.
 * The fix would appear to work and then silently revert — worse than not shipping it. This is the
 * "enforce the adjacent write route" failure: fixing the read/create path and leaving the routes that
 * write the same data alone.
 *
 * Pinned as source text because the property is an ABSENCE, and an absence has no runtime handle.
 */
const read = (rel: string): string => readFileSync(join(process.cwd(), rel), "utf8");

describe("guard: attendance is never written from an LLM extraction result", () => {
  it("mergeIntoMeetingNote does not add the extraction's attendees", () => {
    const src = read("lib/meetings/merge.ts");
    // The summary from `ex` is still written — only attendance is withheld.
    expect(src).toMatch(/updateMeetingSummary\(admin, teamId, match\.noteId, ex\.summary\)/);
    expect(src).not.toMatch(/addMeetingNoteAttendees\([^)]*ex\.attendeeMemberIds/);
  });

  it("refreshMeetingNoteExtraction does not add the extraction's attendees", () => {
    const src = read("lib/meetings/refresh.ts");
    expect(src).toMatch(/updateMeetingSummary\(admin, teamId, note\.id, ex\.summary\)/);
    expect(src).not.toMatch(/addMeetingNoteAttendees\([^)]*ex\.attendeeMemberIds/);
  });

  it("the resolved-set union in mergeIntoMeetingNote SURVIVES — this guard must not ban all writes", () => {
    // `input.newAttendeeIds` is the caller's already-resolved set (rank 1/2), not a model answer.
    // A guard that banned every addMeetingNoteAttendees call would break merging real attendance.
    expect(read("lib/meetings/merge.ts")).toMatch(/addMeetingNoteAttendees\(admin, match\.noteId, input\.newAttendeeIds\)/);
  });
});
