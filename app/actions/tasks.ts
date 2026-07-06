"use server";

import { after } from "next/server";

import { serverClient } from "@/lib/db/server";
import { adminClient } from "@/lib/db/admin";
import { currentMember } from "@/lib/auth/guard";
import { uiRowKey, isUniqueViolation } from "@/lib/ids";
import { normalizeTaskPriority } from "@/lib/api/schemas";
import { projectTaskByIdAfterWrite } from "@/lib/pm-sync";
import { TASK_STATUSES, type Task, type TaskStatus } from "@/components/kanban/types";

/**
 * Task mutations initiated from the Kanban board. There is no RLS on the postgres target, so the
 * `currentMember()` guard is the access control. (Browser → server action so no PostgREST is needed.)
 *
 * Reactive projection (brain-api v1.2 Phase 2): each successful write schedules a single-row
 * projection into the team's primary PM tool via `after()` (runs after the response). It loads the
 * full task row inside the callback and NEVER fails the user action — on error it only records
 * `task_pm_links.last_error`. UI writes always schedule (they bypass the push-path changed-rows
 * guard); the engine's projection_fingerprint skip prevents a redundant provider write.
 */

// Schedule the fire-and-forget projection. adminClient() needs no request context (gone by the time
// the callback runs); the helper swallows every error so projection can't fail the action.
function scheduleProjection(taskId: string) {
  after(async () => {
    await projectTaskByIdAfterWrite(adminClient(), taskId);
  });
}

export interface NewTaskInput {
  teamId: string;
  projectId: string;
  title: string;
  assignee: string;
  sprint: string;
  dueDate: string | null;
}

export async function moveTaskAction(
  taskId: string,
  status: TaskStatus
): Promise<{ ok: boolean; error?: string }> {
  if (!TASK_STATUSES.includes(status)) return { ok: false, error: "invalid status" };
  const db = await serverClient();
  const { data: task } = await db
    .from("tasks")
    .select("team_id")
    .eq("id", taskId)
    .maybeSingle();
  if (!task) return { ok: false, error: "task not found" };
  const me = await currentMember((task as { team_id: string }).team_id);
  if (!me) return { ok: false, error: "not a member of this team" };

  const { error } = await db
    .from("tasks")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("id", taskId);
  if (error) return { ok: false, error: error.message };
  scheduleProjection(taskId);
  return { ok: true };
}

export async function createTaskAction(
  input: NewTaskInput
): Promise<{ ok: boolean; task?: Task; error?: string }> {
  const title = input.title.trim();
  if (!title || !input.projectId) return { ok: false, error: "title and project required" };
  const me = await currentMember(input.teamId);
  if (!me) return { ok: false, error: "not a member of this team" };

  const db = await serverClient();
  // Mint a stable `ui-` row_key so the task is visible to `GET /api/v1/tasks`
  // writeback (which filters `row_key is not null`) and round-trips into tasks.md.
  // Retry once on the (team_id,project_id,row_key) unique constraint.
  for (let attempt = 0; attempt < 2; attempt++) {
    const { data, error } = await db
      .from("tasks")
      .insert({
        team_id: input.teamId,
        project_id: input.projectId,
        row_key: uiRowKey(),
        title,
        assignee: input.assignee,
        sprint: input.sprint,
        due_date: input.dueDate || null,
        status: "backlog",
        origin: "ui",
        created_by: me.id,
      })
      .select(
        "id, row_key, title, assignee, status, sprint, due_date, origin, project_id, updated_at"
      )
      .single();
    if (!error && data) {
      scheduleProjection((data as Task).id);
      return { ok: true, task: data as Task };
    }
    if (attempt === 0 && isUniqueViolation(error?.message)) continue;
    return { ok: false, error: error?.message ?? "could not create task" };
  }
  return { ok: false, error: "could not create task" };
}

export interface UpdateTaskInput {
  taskId: string;
  title?: string;
  sprint?: string;
  dueDate?: string | null;
  parentRowKey?: string | null;
  labels?: string[];
  priority?: string;
  body?: string;
}

/**
 * Edit a task's projectable fields from the dashboard (brain-api v1.2). Partial — only provided keys
 * are written, so a title-only edit never clobbers labels. Schedules projection on success.
 * (Kanban UI wiring lands in Phase 4; this action + its projection trigger ship now.)
 */
export async function updateTaskAction(
  input: UpdateTaskInput
): Promise<{ ok: boolean; error?: string }> {
  if (!input.taskId) return { ok: false, error: "taskId required" };
  const db = await serverClient();
  const { data: task } = await db
    .from("tasks")
    .select("team_id, project_id, row_key")
    .eq("id", input.taskId)
    .maybeSingle();
  if (!task) return { ok: false, error: "task not found" };
  const row = task as { team_id: string; project_id: string; row_key: string | null };
  const me = await currentMember(row.team_id);
  if (!me) return { ok: false, error: "not a member of this team" };

  // Parent integrity (when provided + non-empty): reject self-parent; require the parent to exist in
  // the same (team, project); and reject any re-parent that would close a cycle (the epic→sub graph
  // must stay a forest — no PM sub-issue may become its own ancestor).
  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (input.title !== undefined) update.title = input.title;
  if (input.sprint !== undefined) update.sprint = input.sprint;
  if (input.dueDate !== undefined) update.due_date = input.dueDate || null;
  if (input.labels !== undefined) update.labels = input.labels;
  if (input.priority !== undefined) update.priority = normalizeTaskPriority(input.priority);
  if (input.body !== undefined) update.body = input.body;
  if (input.parentRowKey !== undefined) {
    const parent = (input.parentRowKey ?? "").trim();
    if (parent) {
      if (parent === row.row_key) return { ok: false, error: "a task cannot be its own parent" };
      const { data: parentRow } = await db
        .from("tasks")
        .select("id")
        .eq("team_id", row.team_id)
        .eq("project_id", row.project_id)
        .eq("row_key", parent)
        .maybeSingle();
      if (!parentRow) return { ok: false, error: `parent "${parent}" not found in project` };

      // Cycle guard: walk ancestors up from the proposed parent over the project's current edges;
      // reaching this row's own key means the new edge would form a loop. Bounded by the edge count
      // so a pre-existing data cycle can't spin forever.
      const { data: edgeRows } = await db
        .from("tasks")
        .select("row_key, parent_row_key")
        .eq("team_id", row.team_id)
        .eq("project_id", row.project_id);
      const parentOf = new Map<string, string | null>();
      for (const e of (edgeRows ?? []) as { row_key: string | null; parent_row_key: string | null }[]) {
        if (e.row_key) parentOf.set(e.row_key, e.parent_row_key);
      }
      let cursor: string | null = parent;
      for (let steps = 0; cursor && steps <= parentOf.size; steps++) {
        if (cursor === row.row_key) {
          return { ok: false, error: `re-parenting "${row.row_key}" under "${parent}" would create a cycle` };
        }
        cursor = parentOf.get(cursor) ?? null;
      }
    }
    update.parent_row_key = parent || null;
  }

  const { error } = await db.from("tasks").update(update).eq("id", input.taskId);
  if (error) return { ok: false, error: error.message };
  scheduleProjection(input.taskId);
  return { ok: true };
}
