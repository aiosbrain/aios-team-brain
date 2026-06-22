export const TASK_STATUSES = ["backlog", "ready", "in_progress", "blocked", "done"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

// Canonical priority words (postgres `task_priority`); mirrors normalizeTaskPriority's output set.
export const TASK_PRIORITIES = ["none", "low", "medium", "high", "urgent"] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

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
  // Hierarchy/board fields (brain-api v1.2). `body` is dashboard/DB-only.
  parent_row_key?: string | null;
  labels?: string[];
  priority?: string;
  body?: string;
  task_pm_links?: {
    provider: "plane" | "linear";
    provider_url: string;
    last_synced_status: string | null;
    last_error: string | null;
  }[];
};

export type ProjectOption = { id: string; slug: string; name: string };
export type MemberOption = { id: string; display_name: string; actor_handle: string };
