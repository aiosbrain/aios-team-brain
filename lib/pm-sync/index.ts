import "server-only";

import type { DbClient } from "@/lib/db/types";

import { projectTask, type ProjectionReport, type ProjectionTaskRow } from "@/lib/pm-sync/project";
import type { PmProvider } from "@/lib/pm-sync/provider";

export { projectTask, projectAllTasks } from "@/lib/pm-sync/project";
export type { ProjectionReport, ProjectionTaskRow } from "@/lib/pm-sync/project";
export { projectTaskByIdAfterWrite, projectChangedTasksAfterWrite } from "@/lib/pm-sync/after-write";
export { runInboundForTeam, runLinearInbound, loadInboundRows, classifyInboundRow } from "@/lib/pm-sync/inbound";
export type { InboundResult, InboundRunSummary, InboundRow, InboundRowState } from "@/lib/pm-sync/inbound";

export interface TaskForPmSync {
  id: string;
  team_id: string;
  project_id: string;
  row_key: string | null;
}

export interface TaskPmSyncReport {
  row_key: string;
  provider: PmProvider | null;
  status: "synced" | "skipped" | "no_link" | "missing_integration" | "failed";
  error?: string;
}

export function projectionToSyncReport(report: ProjectionReport): TaskPmSyncReport {
  return { row_key: report.row_key, provider: report.provider, status: mapStatus(report.status), error: report.error };
}

function mapStatus(status: ProjectionReport["status"]): TaskPmSyncReport["status"] {
  switch (status) {
    case "synced":
    case "skipped":
    case "failed":
      return status;
    case "no_row_key":
      return "no_link";
    case "no_primary_provider":
    case "missing_integration":
      return "missing_integration";
    default:
      return "failed";
  }
}

// Back-compat wrapper retained for the work-events report shape. Loads the full task row and
// delegates to the projection engine in statusOnly mode (reconcile workflow state only).
export async function syncTaskPmLinks(
  db: DbClient,
  task: TaskForPmSync,
  opts: { fetchImpl?: typeof fetch } = {}
): Promise<TaskPmSyncReport[]> {
  if (!task.row_key) return [{ row_key: "", provider: null, status: "no_link" }];

  const { data } = await db
    .from("tasks")
    .select("id, team_id, project_id, row_key, title, status, sprint, priority, labels, body, parent_row_key")
    .eq("id", task.id)
    .maybeSingle();
  if (!data) return [{ row_key: task.row_key, provider: null, status: "no_link" }];

  const report = await projectTask(db, data as ProjectionTaskRow, { statusOnly: true, fetchImpl: opts.fetchImpl });
  return [{ row_key: report.row_key, provider: report.provider, status: mapStatus(report.status), error: report.error }];
}
