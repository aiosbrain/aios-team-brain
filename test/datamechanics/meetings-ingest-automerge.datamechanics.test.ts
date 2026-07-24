import { describe, expect, it } from "vitest";
import { backfillMeetingNotesFromItems } from "@/lib/meetings/from-items";
import { listMeetingNotesForTeam } from "@/lib/meetings/notes";
import { db, seedTeam, ingest } from "./helpers";

/**
 * Spec: duplicate-meeting merge is now AUTOMATIC on the CLI/ingest path — the manual "Merge duplicates"
 * button was removed. Two DIFFERENT transcript items for the SAME meeting (a Granola re-record / re-push,
 * same day, overlapping text) are pushed via `aios push`; `backfillMeetingNotesFromItems` (run by the
 * scheduler each tick + the "Import pushed meetings" button) must create their notes AND collapse the
 * duplicate into one — so the Meetings list never accumulates dupes without any admin action. Model
 * unconfigured (`keys:{}`) → the deterministic transcript union runs.
 */
const DATE = "2026-07-03";
const A =
  "# AIOS sync\nChetan and John discussed the mission control dashboard. They agreed to leverage gbrain and Hermes. " +
  "John will configure the personal setup for genetic projects and review the task management approach.";
const B =
  "# AIOS sync\nThey agreed to leverage gbrain and Hermes. John will configure the personal setup for genetic projects. " +
  "John also confirmed the launch deadline is next Friday.";

describe("meetings: auto-merge duplicates on ingest backfill (real Postgres)", () => {
  it("creates notes for CLI-pushed transcripts AND collapses same-day duplicates into one", async () => {
    const seed = await seedTeam();
    const meta = { access: "team" as const, kind: "transcript" as const };
    await ingest(seed, { ...meta, path: "meetings/2026-07-03-aios-sync-a.md", body: A, frontmatter: { source: "granola", date: DATE } });
    await ingest(seed, { ...meta, path: "meetings/2026-07-03-aios-sync-b.md", body: B, frontmatter: { source: "granola", date: DATE } });

    const summary = await backfillMeetingNotesFromItems(db(), seed.teamId, {
      keys: {},
      extract: async () => ({ summary: "", attendeeMemberIds: [] }), // no real LLM in this tier
      extractActionItems: async () => [],
    });

    expect(summary.created).toBe(2); // a note per transcript item…
    expect(summary.merged).toBe(1); // …then the duplicate is auto-merged
    // Only the survivor is visible (the folded copy is hidden behind merged_into).
    expect((await listMeetingNotesForTeam(db(), seed.teamId, "team")).length).toBe(1);
  });

  it("leaves a single (non-duplicate) pushed meeting alone", async () => {
    const seed = await seedTeam();
    await ingest(seed, {
      access: "team",
      kind: "transcript",
      path: "meetings/2026-07-03-solo.md",
      body: A,
      frontmatter: { source: "granola", date: DATE },
    });
    const summary = await backfillMeetingNotesFromItems(db(), seed.teamId, {
      keys: {},
      extract: async () => ({ summary: "", attendeeMemberIds: [] }),
      extractActionItems: async () => [],
    });
    expect(summary.created).toBe(1);
    expect(summary.merged).toBe(0);
    expect((await listMeetingNotesForTeam(db(), seed.teamId, "team")).length).toBe(1);
  });
});
