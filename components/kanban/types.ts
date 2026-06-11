export const TASK_STATUSES = ["backlog", "ready", "in_progress", "blocked", "done"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const STATUS_LABELS: Record<TaskStatus, string> = {
  backlog: "Backlog",
  ready: "Ready",
  in_progress: "In progress",
  blocked: "Blocked",
  done: "Done",
};

export type Task = {
  id: string;
  row_key: string | null;
  title: string;
  assignee: string;
  status: TaskStatus;
  sprint: string;
  due_date: string | null;
  origin: "sync" | "ui";
  project_id: string;
  updated_at: string;
};

export type ProjectOption = { id: string; slug: string; name: string };
export type MemberOption = { id: string; display_name: string; actor_handle: string };
