import { describe, expect, it } from "vitest";
import { createMeetingNote } from "@/lib/meetings/notes";
import { extractAndStoreActionItems } from "@/lib/meetings/action-items";
import { MEETING_TODO_PROJECT_SLUG } from "@/lib/meetings/extract-todos";
import type { ExtractedTodo } from "@/lib/meetings/extract-todos";
import { db, seedTeam } from "./helpers";

/**
 * Spec for the GUI-upload path materializing action items via the LLM-first extractor (the same one
 * the CLI/import path uses) — so a PROSE transcript ("Alex will send the deck Friday") yields tasks,
 * not just checkbox-style todos. Model stubbed (data-mechanics tier). Mirrors what
 * uploadMeetingNoteAction now does after createMeetingNote.
 */
describe("meeting GUI upload → action items (real Postgres, stubbed extractor)", () => {
  it("extracts a prose commitment into a task in the meetings project", async () => {
    const { teamId, memberId } = await seedTeam();
    const rawText = "Chetan and Alex synced. Alex will send the deck by Friday and Chetan will wire up the dashboard.";
    const noteId = await createMeetingNote(db(), teamId, {
      title: "Sync",
      rawText,
      submittedByMemberId: memberId,
    });

    const { data: nr } = await db().from("meeting_notes").select("source_item_id").eq("id", noteId).maybeSingle();
    const { data: item } = await db()
      .from("items")
      .select("id, path, access")
      .eq("id", (nr as { source_item_id: string }).source_item_id)
      .maybeSingle();

    // Stub the LLM extractor with a prose-derived commitment the markdown scanner would miss.
    const stub = async (): Promise<ExtractedTodo[]> => [
      { title: "Send the deck", assignee: "Alex", due: "2026-07-17", line: 1, sourceText: "Alex will send the deck by Friday" },
    ];
    const n = await extractAndStoreActionItems(db(), teamId, item as { id: string; path: string; access: "team" | "external" }, rawText, [], {}, stub);
    expect(n).toBe(1);

    const { data: tasks } = await db()
      .from("tasks")
      .select("title, source_item_id, projects(slug)")
      .eq("team_id", teamId)
      .eq("source_item_id", (item as { id: string }).id);
    const meetingTasks = ((tasks ?? []) as { title: string; projects?: { slug?: string } }[]).filter(
      (t) => t.projects?.slug === MEETING_TODO_PROJECT_SLUG
    );
    expect(meetingTasks.length).toBe(1);
    expect(meetingTasks[0].title).toBe("Send the deck");
  });
});
