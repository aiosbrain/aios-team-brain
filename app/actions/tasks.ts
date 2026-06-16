"use server";

import { serverClient } from "@/lib/supabase/server";
import { currentMember } from "@/lib/auth/guard";
import { TASK_STATUSES, type Task, type TaskStatus } from "@/components/kanban/types";

/**
 * Backend-agnostic task mutations initiated from the Kanban board. In supabase
 * mode these also satisfy RLS; in postgres mode the currentMember() guard is
 * the access control. (Browser → server action so no PostgREST is needed.)
 */

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
  const supabase = await serverClient();
  const { data: task } = await supabase
    .from("tasks")
    .select("team_id")
    .eq("id", taskId)
    .maybeSingle();
  if (!task) return { ok: false, error: "task not found" };
  const me = await currentMember((task as { team_id: string }).team_id);
  if (!me) return { ok: false, error: "not a member of this team" };

  const { error } = await supabase
    .from("tasks")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("id", taskId);
  return error ? { ok: false, error: error.message } : { ok: true };
}

export async function createTaskAction(
  input: NewTaskInput
): Promise<{ ok: boolean; task?: Task; error?: string }> {
  const title = input.title.trim();
  if (!title || !input.projectId) return { ok: false, error: "title and project required" };
  const me = await currentMember(input.teamId);
  if (!me) return { ok: false, error: "not a member of this team" };

  const supabase = await serverClient();
  const { data, error } = await supabase
    .from("tasks")
    .insert({
      team_id: input.teamId,
      project_id: input.projectId,
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
  if (error || !data) return { ok: false, error: error?.message ?? "could not create task" };
  return { ok: true, task: data as Task };
}
