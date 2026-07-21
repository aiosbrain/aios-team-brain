import { describe, expect, it } from "vitest";
import { createMeetingNote, createMeetingNoteFromItem, getMeetingNote, setMeetingNoteMergedInto } from "@/lib/meetings/notes";
import { findDuplicateMeeting, mergeIntoMeetingNote } from "@/lib/meetings/merge";
import { backfillMeetingNotesFromItems } from "@/lib/meetings/from-items";
import { createMeetingTodoTasks, toExtractedTodoRows } from "@/lib/meetings/extract-todos";
import { db, seedTeam, ingest } from "./helpers";

/**
 * Regression specs for the merge-subsystem audit findings (2026-07-16):
 *   C1 — merging into a connector-owned item must NOT let the next sync silently revert the merge,
 *        and must NOT let the meetings backfill resurrect the original as a separate meeting.
 *   M1 — a team-tier upload merged into an external item must not become externally readable.
 *   H2 — the duplicate detector must never match an already-folded-away (merged_into) note.
 * All derived from the desired product behavior, not the implementation.
 */

const DATE = "2026-07-06";
const CONNECTOR_PATH = "2-work/transcripts/2026-07-06-standup.md";
// A/B overlap heavily (same meeting), and B carries one line A doesn't — proven >0.5 overlap.
const A =
  "Chetan and John discussed the mission control dashboard. They agreed to leverage gbrain and Hermes. " +
  "John will configure the personal setup for genetic projects and review the task management approach.";
const B =
  "They agreed to leverage gbrain and Hermes. John will configure the personal setup for genetic projects. " +
  "John also confirmed the launch deadline is next Friday.";
const B_UNIQUE = "launch deadline is next Friday";

describe("merge resilience (real Postgres)", () => {
  it("C1: merge re-points the note off the connector item; a re-sync can't revert it and backfill can't resurrect it", async () => {
    const seed = await seedTeam();
    const { teamId } = seed;

    // A CLI/connector-synced meeting: a transcript item at a connector-owned path, noted via the import path.
    const conn = await ingest(seed, { project: "acme", path: CONNECTOR_PATH, kind: "transcript", access: "team", frontmatter: { source: "granola" }, body: A });
    const { id: noteId } = await createMeetingNoteFromItem(db(), teamId, {
      sourceItemId: conn.id,
      title: "Standup",
      occurredAt: DATE,
      summary: "",
      submittedByMemberId: seed.memberId,
    });

    // A second person uploads their copy via the GUI → merges into the connector-sourced note.
    const match = await findDuplicateMeeting(db(), teamId, DATE, B);
    expect(match?.noteId).toBe(noteId);
    await mergeIntoMeetingNote(db(), teamId, match!, {
      newRawText: B,
      newSubmitterId: seed.memberId,
      newAccess: "team",
      roster: [],
      keys: {},
      mergeTranscript: async (a, b) => `MERGED:\n${a}\n${b}`,
    });

    // The note now points at a MERGE-OWNED item, not the connector item.
    const { data: noteRow } = await db().from("meeting_notes").select("source_item_id").eq("id", noteId).maybeSingle();
    const mergedItemId = (noteRow as { source_item_id: string }).source_item_id;
    expect(mergedItemId).not.toBe(conn.id);
    const { data: mergedItem } = await db().from("items").select("path").eq("id", mergedItemId).maybeSingle();
    expect((mergedItem as { path: string }).path).toBe(`meetings/${noteId}.md`);

    const merged = await getMeetingNote(db(), teamId, noteId, "team");
    expect(merged!.rawText).toContain(B_UNIQUE); // B's unique line survived

    // The connector re-syncs the ORIGINAL file (same path, original single-transcript body).
    await ingest(seed, { project: "acme", path: CONNECTOR_PATH, kind: "transcript", access: "team", frontmatter: { source: "granola" }, body: A });

    // The merge is intact — the re-sync hit the connector item, not the note's merge-owned item.
    const after = await getMeetingNote(db(), teamId, noteId, "team");
    expect(after!.rawText).toContain(B_UNIQUE);
    expect(after!.rawText).toBe(merged!.rawText);

    // And the meetings backfill does NOT resurrect the connector item as a second visible meeting
    // (it's retired with a hidden tombstone note).
    await backfillMeetingNotesFromItems(db(), teamId, { keys: {} });
    const { data: visible } = await db().from("meeting_notes").select("id").eq("team_id", teamId).is("merged_into", null);
    expect((visible ?? []).length).toBe(1); // still just the survivor
  });

  it("M1: a team-tier upload merged into an external item yields a team-tier merged item (no widening)", async () => {
    const seed = await seedTeam();
    const { teamId } = seed;
    const ext = await ingest(seed, { project: "acme", path: "client/call.md", kind: "transcript", access: "external", frontmatter: { source: "zoom" }, body: A });
    const { id: noteId } = await createMeetingNoteFromItem(db(), teamId, { sourceItemId: ext.id, title: "Client call", occurredAt: DATE, summary: "", submittedByMemberId: seed.memberId });

    const match = await findDuplicateMeeting(db(), teamId, DATE, B);
    await mergeIntoMeetingNote(db(), teamId, match!, {
      newRawText: B,
      newSubmitterId: seed.memberId,
      newAccess: "team", // internal GUI upload
      roster: [],
      keys: {},
      mergeTranscript: async (a, b) => `MERGED:\n${a}\n${b}`,
    });

    const { data: noteRow } = await db().from("meeting_notes").select("source_item_id").eq("id", noteId).maybeSingle();
    const { data: mergedItem } = await db().from("items").select("access").eq("id", (noteRow as { source_item_id: string }).source_item_id).maybeSingle();
    expect((mergedItem as { access: string }).access).toBe("team"); // floored to most-restrictive; NOT external
  });

  it("H2: the duplicate detector never matches a folded-away (merged_into) note", async () => {
    const seed = await seedTeam();
    const { teamId } = seed;
    // The hidden note is the STRICTLY BETTER match for B (its body is B) — so without the exclusion the
    // detector would pick it (deterministic redness), and folding B into it would make B vanish.
    const hiddenId = await createMeetingNote(db(), teamId, { title: "old dup", rawText: B, submittedByMemberId: seed.memberId, occurredAt: DATE });
    const survivorId = await createMeetingNote(db(), teamId, { title: "survivor", rawText: A, submittedByMemberId: seed.memberId, occurredAt: DATE });
    await setMeetingNoteMergedInto(db(), hiddenId, survivorId);

    const match = await findDuplicateMeeting(db(), teamId, DATE, B);
    expect(match).toBeTruthy();
    expect(match!.noteId).toBe(survivorId); // never the hidden one, even though it overlaps B more
    expect(match!.noteId).not.toBe(hiddenId);
  });

  it("H1: action items survive a re-point merge — moved to the new item, never orphaned or duplicated", async () => {
    const seed = await seedTeam();
    const { teamId } = seed;
    const conn = await ingest(seed, { project: "acme", path: CONNECTOR_PATH, kind: "transcript", access: "team", frontmatter: { source: "granola" }, body: A });
    const { id: noteId } = await createMeetingNoteFromItem(db(), teamId, { sourceItemId: conn.id, title: "Standup", occurredAt: DATE, summary: "", submittedByMemberId: seed.memberId });
    // Two action items already extracted from the connector item (the pre-merge state).
    await createMeetingTodoTasks(
      db(),
      teamId,
      toExtractedTodoRows({ id: conn.id, path: CONNECTOR_PATH, access: "team" }, [
        { title: "Ship the graph fix", assignee: "", due: null },
        { title: "Audit the meetings PRs", assignee: "", due: null },
      ])
    );
    // Capture the tasks + push ONE to a PM tool (a task_pm_link keyed by the OLD row_key).
    const { data: pre } = await db()
      .from("tasks")
      .select("id, row_key, project_id, title")
      .eq("team_id", teamId)
      .eq("source_item_id", conn.id);
    const preTasks = (pre ?? []) as { id: string; row_key: string; project_id: string; title: string }[];
    const beforeIds = preTasks.map((t) => t.id).sort();
    const ship = preTasks.find((t) => t.title === "Ship the graph fix")!;
    await db().from("task_pm_links").insert({
      team_id: teamId,
      project_id: ship.project_id,
      task_id: ship.id,
      row_key: ship.row_key,
      provider: "linear",
      provider_external_id: "LIN-123",
      provider_resource_id: "issue_abc",
      provider_url: "https://linear.app/x/LIN-123",
    });

    const match = await findDuplicateMeeting(db(), teamId, DATE, B);
    await mergeIntoMeetingNote(db(), teamId, match!, {
      newRawText: B,
      newSubmitterId: seed.memberId,
      newAccess: "team",
      roster: [],
      keys: {},
      mergeTranscript: async () => "Merged transcript with no new action items.",
    });

    const { data: noteRow } = await db().from("meeting_notes").select("source_item_id").eq("id", noteId).maybeSingle();
    const newItemId = (noteRow as { source_item_id: string }).source_item_id;
    // No tasks left orphaned on the retired connector item (the H1 bug would leave both here).
    const { count: onOld } = await db().from("tasks").select("id", { count: "exact", head: true }).eq("team_id", teamId).eq("source_item_id", conn.id);
    expect(onOld).toBe(0);
    // The SAME two tasks (ids preserved — so PM links / UI state stay attached) moved onto the
    // merge-owned item, re-namespaced, so re-extraction upserts over them instead of duplicating.
    const { data: moved } = await db().from("tasks").select("id, title, row_key").eq("team_id", teamId).eq("source_item_id", newItemId);
    const movedTasks = (moved ?? []) as { id: string; title: string; row_key: string }[];
    expect(movedTasks.map((t) => t.id).sort()).toEqual(beforeIds);
    expect(movedTasks.map((t) => t.title).sort()).toEqual(["Audit the meetings PRs", "Ship the graph fix"]);

    // The PM link followed the task to the new row_key (else the next projection mints a duplicate issue),
    // keeping its provider issue id — same link row, still bound to the same task.
    const { data: link } = await db().from("task_pm_links").select("row_key, task_id, provider_resource_id").eq("task_id", ship.id).maybeSingle();
    const linkRow = link as { row_key: string; task_id: string; provider_resource_id: string };
    const shipNow = movedTasks.find((t) => t.id === ship.id)!;
    expect(linkRow.row_key).toBe(shipNow.row_key); // moved in lockstep with the task
    expect(linkRow.row_key).not.toBe(ship.row_key); // …and actually changed
    expect(linkRow.provider_resource_id).toBe("issue_abc"); // existing issue preserved (no duplicate)
  });

  it("M1: external + external stays external — the floor narrows, never over-narrows", async () => {
    const seed = await seedTeam();
    const { teamId } = seed;
    const ext = await ingest(seed, { project: "acme", path: "client/call2.md", kind: "transcript", access: "external", frontmatter: { source: "zoom" }, body: A });
    const { id: noteId } = await createMeetingNoteFromItem(db(), teamId, { sourceItemId: ext.id, title: "Client call", occurredAt: DATE, summary: "", submittedByMemberId: seed.memberId });
    const match = await findDuplicateMeeting(db(), teamId, DATE, B);
    await mergeIntoMeetingNote(db(), teamId, match!, {
      newRawText: B,
      newSubmitterId: seed.memberId,
      newAccess: "external", // both sources external
      roster: [],
      keys: {},
      mergeTranscript: async (a, b) => `MERGED:\n${a}\n${b}`,
    });
    const { data: noteRow } = await db().from("meeting_notes").select("source_item_id").eq("id", noteId).maybeSingle();
    const { data: mergedItem } = await db().from("items").select("access").eq("id", (noteRow as { source_item_id: string }).source_item_id).maybeSingle();
    expect((mergedItem as { access: string }).access).toBe("external"); // preserved, not forced to team
  });
});
