import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  projectTask,
  projectRows,
  resolvePrimaryProvider,
  PROJECTION_TASK_COLS,
  type ProjectionReport,
  type ProjectionTaskRow,
} from "@/lib/pm-sync/project";

/**
 * Fire-and-forget projection for the reactive write paths (UI server actions + the changed-rows push
 * tail). These run INSIDE a `next/server` `after()` callback — after the response is sent — so they
 * must NEVER throw: a projection failure must not fail the user action / push.
 *
 * `projectTask` already catches *adapter* errors internally and records `task_pm_links.last_error`;
 * the outer try/catch here is the safety net for `ensureLink` / primary-resolution DB errors. Both
 * helpers take the service-role `adminClient()` (no request context needed in the callback) and an
 * injectable `fetchImpl` so tests stub the provider — no live PM calls in CI.
 */

// Load a task by id with the canonical projection column set (shared with the engine). Missing row
// (e.g. deleted between the write and the after() callback) → null.
async function loadTaskById(supabase: SupabaseClient, taskId: string): Promise<ProjectionTaskRow | null> {
  const { data } = await supabase.from("tasks").select(PROJECTION_TASK_COLS).eq("id", taskId).maybeSingle();
  return (data as ProjectionTaskRow | null) ?? null;
}

// Project a single task (by id) into the team's primary PM tool. Used by createTaskAction /
// moveTaskAction / updateTaskAction via after(). Always single-row — the UI bypasses the push-path
// changed-rows guard (Decision 3) and the engine's fingerprint skip prevents a redundant write.
export async function projectTaskByIdAfterWrite(
  supabase: SupabaseClient,
  taskId: string,
  opts: { fetchImpl?: typeof fetch } = {}
): Promise<ProjectionReport | null> {
  try {
    const row = await loadTaskById(supabase, taskId);
    if (!row) return null;
    return await projectTask(supabase, row, { fetchImpl: opts.fetchImpl });
  } catch {
    // Swallow — projection must never surface as a user-action failure.
    return null;
  }
}

// Project a bounded set of changed rows (by row_key) after a sync push. Mirrors projectAllTasks batch
// semantics — prepare once, parent-before-child, shared resolved map, synced-only throttle — but
// scoped to the rows whose projected fields changed this push.
export async function projectChangedTasksAfterWrite(
  supabase: SupabaseClient,
  teamId: string,
  projectId: string,
  rowKeys: string[],
  opts: { fetchImpl?: typeof fetch } = {}
): Promise<ProjectionReport[]> {
  if (!rowKeys.length) return [];
  try {
    const primary = await resolvePrimaryProvider(supabase, teamId);
    if (primary.provider === null || primary.integration === null) return [];

    const { data } = await supabase
      .from("tasks")
      .select(PROJECTION_TASK_COLS)
      .eq("team_id", teamId)
      .eq("project_id", projectId)
      .in("row_key", rowKeys);
    const rows = ((data ?? []) as ProjectionTaskRow[]).filter((r) => r.row_key);
    if (!rows.length) return [];

    return await projectRows(supabase, primary, rows, { fetchImpl: opts.fetchImpl });
  } catch {
    return [];
  }
}
