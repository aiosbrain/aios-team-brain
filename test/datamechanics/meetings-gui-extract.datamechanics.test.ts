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

  /** Seed a meeting note + resolve its transcript item — shared by the re-extract specs. */
  async function seedMeeting(rawText: string): Promise<{ teamId: string; item: { id: string; path: string; access: "team" | "external" } }> {
    const { teamId, memberId } = await seedTeam();
    const noteId = await createMeetingNote(db(), teamId, { title: "Sync", rawText, submittedByMemberId: memberId });
    const { data: nr } = await db().from("meeting_notes").select("source_item_id").eq("id", noteId).maybeSingle();
    const { data: item } = await db()
      .from("items").select("id, path, access").eq("id", (nr as { source_item_id: string }).source_item_id).maybeSingle();
    return { teamId, item: item as { id: string; path: string; access: "team" | "external" } };
  }
  const todo = (title: string): ExtractedTodo => ({ title, assignee: "", due: null, line: 1, sourceText: title });
  const meetingTaskTitles = async (teamId: string, itemId: string): Promise<string[]> => {
    const { data } = await db()
      .from("tasks").select("title, projects(slug)").eq("team_id", teamId).eq("source_item_id", itemId);
    return ((data ?? []) as { title: string; projects?: { slug?: string } }[])
      .filter((t) => t.projects?.slug === MEETING_TODO_PROJECT_SLUG).map((t) => t.title).sort();
  };

  it("re-extracting fewer items PRUNES the stale (un-pushed) ones", async () => {
    const { teamId, item } = await seedMeeting("A B");
    await extractAndStoreActionItems(db(), teamId, item, "A B", [], {}, async () => [todo("Alpha"), todo("Beta")]);
    expect(await meetingTaskTitles(teamId, item.id)).toEqual(["Alpha", "Beta"]);

    // Re-extract now yields only Alpha → Beta is stale + un-pushed → deleted (reconcile opt-in).
    await extractAndStoreActionItems(db(), teamId, item, "A", [], {}, async () => [todo("Alpha")], undefined, {
      reconcile: true,
    });
    expect(await meetingTaskTitles(teamId, item.id)).toEqual(["Alpha"]);
  });

  it("WITHOUT reconcile (upload/refresh/merge paths), a shrunk re-run does NOT prune", async () => {
    const { teamId, item } = await seedMeeting("A B");
    await extractAndStoreActionItems(db(), teamId, item, "A B", [], {}, async () => [todo("Alpha"), todo("Beta")]);

    // A refresh/merge-style re-run (no reconcile flag) that yields fewer todos must keep the rest —
    // only the deliberate on-demand re-extract is allowed to delete. Guards Fable finding #4.
    await extractAndStoreActionItems(db(), teamId, item, "A", [], {}, async () => [todo("Alpha")]);
    expect(await meetingTaskTitles(teamId, item.id)).toEqual(["Alpha", "Beta"]);
  });

  it("re-extract PRESERVES a progressed task's status (status is insert-only)", async () => {
    const { teamId, item } = await seedMeeting("A");
    await db().from("teams").update({ meeting_task_status: "backlog" }).eq("id", teamId);
    await extractAndStoreActionItems(db(), teamId, item, "A", [], {}, async () => [todo("Alpha")]);

    // A human (or inbound PM sync) moves Alpha to in_progress.
    await db().from("tasks").update({ status: "in_progress" }).eq("team_id", teamId).eq("title", "Alpha");

    // Re-extracting the same todo must NOT reset it back to the configured default category.
    await extractAndStoreActionItems(db(), teamId, item, "A", [], {}, async () => [todo("Alpha")], undefined, {
      reconcile: true,
    });
    const { data } = await db().from("tasks").select("status").eq("team_id", teamId).eq("title", "Alpha").maybeSingle();
    expect((data as { status: string }).status).toBe("in_progress");
  });

  it("a task already pushed to a PM tool is PRESERVED on a re-extract that drops it", async () => {
    const { teamId, item } = await seedMeeting("A B");
    await extractAndStoreActionItems(db(), teamId, item, "A B", [], {}, async () => [todo("Alpha"), todo("Beta")]);

    // Mark Beta as pushed to Linear (a task_pm_links row) — the local mirror of a live issue.
    const { data: beta } = await db()
      .from("tasks").select("id, project_id, row_key").eq("team_id", teamId).eq("title", "Beta").maybeSingle();
    const b = beta as { id: string; project_id: string; row_key: string };
    await db().from("task_pm_links").insert({
      team_id: teamId, project_id: b.project_id, task_id: b.id, row_key: b.row_key,
      provider: "linear", provider_external_id: "LIN-1", provider_url: "https://linear.app/x/LIN-1",
    });

    // Re-extract drops Beta — but it's pushed, so it stays; Alpha remains too.
    await extractAndStoreActionItems(db(), teamId, item, "A", [], {}, async () => [todo("Alpha")], undefined, {
      reconcile: true,
    });
    expect(await meetingTaskTitles(teamId, item.id)).toEqual(["Alpha", "Beta"]);
  });

  it("new todos take the team's configured target category (teams.meeting_task_status)", async () => {
    const { teamId, item } = await seedMeeting("A");
    await db().from("teams").update({ meeting_task_status: "in_progress" }).eq("id", teamId);
    await extractAndStoreActionItems(db(), teamId, item, "A", [], {}, async () => [todo("Alpha")]);
    const { data } = await db()
      .from("tasks").select("status").eq("team_id", teamId).eq("title", "Alpha").maybeSingle();
    expect((data as { status: string }).status).toBe("in_progress"); // → Linear "In Progress" on push
  });

  it("an EMPTY re-extraction never prunes (indistinguishable from a failed extraction)", async () => {
    const { teamId, item } = await seedMeeting("A B");
    await extractAndStoreActionItems(db(), teamId, item, "A B", [], {}, async () => [todo("Alpha"), todo("Beta")]);

    // Extractor returns nothing (a timeout/failure looks identical) → keep both, don't wipe real
    // tasks — even when reconcile is requested (an empty result never prunes).
    await extractAndStoreActionItems(db(), teamId, item, "A B", [], {}, async () => [], undefined, { reconcile: true });
    expect(await meetingTaskTitles(teamId, item.id)).toEqual(["Alpha", "Beta"]);
  });
});
