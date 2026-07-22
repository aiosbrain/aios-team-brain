import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createMeetingNote } from "@/lib/meetings/notes";
import { extractAndStoreActionItems } from "@/lib/meetings/action-items";
import type { ExtractedTodo } from "@/lib/meetings/extract-todos";
import { backfillMeetingTodoRowKeys, ensureMeetingTodoProject } from "@/lib/meetings/extract-todos";
import { db, seedTeam } from "./helpers";

/**
 * Spec for the one-time ordinal→content row_key backfill (Fable High #1). A meeting task pushed to a
 * PM tool BEFORE the content-key switch keeps its old ordinal key (`meet-<hash>-001`); without the
 * backfill, a re-extract mints a NEW content-keyed task for the same todo and pushing it opens a
 * SECOND Linear/Plane issue. The backfill converges the ordinal key to the content key so the next
 * re-extract UPSERTS over the existing (pushed) row instead. Real Postgres, stubbed extractor.
 */
describe("meeting row_key backfill: ordinal → content (real Postgres)", () => {
  const sourceHash = (itemId: string) => createHash("sha256").update(itemId).digest("hex").slice(0, 10);
  const titleHash = (title: string) =>
    createHash("sha256").update(title.toLowerCase().replace(/\s+/g, " ").trim()).digest("hex").slice(0, 12);
  const ordinalKey = (itemId: string, n: number) => `meet-${sourceHash(itemId)}-${String(n).padStart(3, "0")}`;
  const contentKey = (itemId: string, title: string) => `meet-${sourceHash(itemId)}-${titleHash(title)}`;
  const todo = (title: string): ExtractedTodo => ({ title, assignee: "", due: null, line: 1, sourceText: title });

  async function seedMeeting(): Promise<{ teamId: string; itemId: string; projectId: string }> {
    const { teamId, memberId } = await seedTeam();
    const noteId = await createMeetingNote(db(), teamId, { title: "Sync", rawText: "notes", submittedByMemberId: memberId });
    const { data: nr } = await db().from("meeting_notes").select("source_item_id").eq("id", noteId).maybeSingle();
    const itemId = (nr as { source_item_id: string }).source_item_id;
    const projectId = await ensureMeetingTodoProject(db(), teamId);
    return { teamId, itemId, projectId };
  }

  /** Insert a pre-migration ordinal-keyed task and (optionally) a PM link marking it pushed. */
  async function seedOrdinalTask(
    teamId: string,
    itemId: string,
    projectId: string,
    title: string,
    n: number,
    pushed: boolean
  ): Promise<string> {
    const rowKey = ordinalKey(itemId, n);
    const { data } = await db()
      .from("tasks")
      .insert({
        team_id: teamId,
        project_id: projectId,
        source_item_id: itemId,
        row_key: rowKey,
        title,
        origin: "sync",
        raw_status: "extracted",
      })
      .select("id")
      .single();
    const taskId = (data as { id: string }).id;
    if (pushed) {
      await db().from("task_pm_links").insert({
        team_id: teamId,
        project_id: projectId,
        task_id: taskId,
        row_key: rowKey,
        provider: "linear",
        provider_external_id: `LIN-${n}`,
        provider_url: `https://linear.app/x/LIN-${n}`,
      });
    }
    return taskId;
  }

  it("rekeys a pushed ordinal task to its content key so re-extract does NOT duplicate it", async () => {
    const { teamId, itemId, projectId } = await seedMeeting();
    const taskId = await seedOrdinalTask(teamId, itemId, projectId, "Alpha", 1, true);

    const res = await backfillMeetingTodoRowKeys(db(), teamId);
    expect(res).toEqual({ scanned: 1, rekeyed: 1, collapsed: 0 });

    // Task + its PM link now carry the content key.
    const { data: t } = await db().from("tasks").select("row_key").eq("id", taskId).maybeSingle();
    expect((t as { row_key: string }).row_key).toBe(contentKey(itemId, "Alpha"));
    const { data: l } = await db().from("task_pm_links").select("row_key").eq("task_id", taskId).maybeSingle();
    expect((l as { row_key: string }).row_key).toBe(contentKey(itemId, "Alpha"));

    // A re-extract yielding the same todo upserts over the existing row — no second task, link intact.
    const item = { id: itemId, path: "notes.md", access: "team" as const };
    await extractAndStoreActionItems(db(), teamId, item, "Alpha", [], {}, async () => [todo("Alpha")], undefined, {
      reconcile: true,
    });
    const { data: tasks } = await db()
      .from("tasks")
      .select("id, row_key")
      .eq("team_id", teamId)
      .eq("source_item_id", itemId);
    expect((tasks ?? []).length).toBe(1);
    expect((tasks as { id: string }[])[0].id).toBe(taskId); // same task, kept its Linear link
  });

  it("collapses an un-pushed ordinal duplicate onto the pushed survivor", async () => {
    const { teamId, itemId, projectId } = await seedMeeting();
    // Two ordinal rows for the SAME normalized title (pre-migration edge); pushed one must survive.
    const pushedId = await seedOrdinalTask(teamId, itemId, projectId, "Alpha", 1, true);
    await seedOrdinalTask(teamId, itemId, projectId, "Alpha", 2, false);

    const res = await backfillMeetingTodoRowKeys(db(), teamId);
    expect(res).toEqual({ scanned: 2, rekeyed: 1, collapsed: 1 });

    const { data: tasks } = await db().from("tasks").select("id, row_key").eq("team_id", teamId).eq("source_item_id", itemId);
    expect((tasks ?? []).length).toBe(1);
    const only = (tasks as { id: string; row_key: string }[])[0];
    expect(only.id).toBe(pushedId); // the pushed row was kept, not orphaned
    expect(only.row_key).toBe(contentKey(itemId, "Alpha"));
  });

  it("treats a link with a NULL task_id as pushed (matched by row_key) and rekeys it", async () => {
    const { teamId, itemId, projectId } = await seedMeeting();
    const taskId = await seedOrdinalTask(teamId, itemId, projectId, "Alpha", 1, true);
    // Simulate the FK on-delete-set-null state: the link survives with task_id nulled but keeps its
    // ordinal row_key. The backfill must still recognize the task as pushed and move the orphan link.
    await db().from("task_pm_links").update({ task_id: null }).eq("team_id", teamId).eq("task_id", taskId);

    const res = await backfillMeetingTodoRowKeys(db(), teamId);
    expect(res).toEqual({ scanned: 1, rekeyed: 1, collapsed: 0 });

    const { data: t } = await db().from("tasks").select("row_key").eq("id", taskId).maybeSingle();
    expect((t as { row_key: string }).row_key).toBe(contentKey(itemId, "Alpha"));
    // The orphan link (task_id null) moved to the content key via its row_key match — not stranded.
    const { data: l } = await db()
      .from("task_pm_links").select("row_key").eq("team_id", teamId).eq("row_key", contentKey(itemId, "Alpha")).maybeSingle();
    expect(l).toBeTruthy();
  });

  it("is idempotent — content-keyed rows are ignored on a re-run", async () => {
    const { teamId, itemId, projectId } = await seedMeeting();
    await seedOrdinalTask(teamId, itemId, projectId, "Alpha", 1, true);
    await backfillMeetingTodoRowKeys(db(), teamId);
    const second = await backfillMeetingTodoRowKeys(db(), teamId);
    expect(second).toEqual({ scanned: 0, rekeyed: 0, collapsed: 0 });
  });
});
