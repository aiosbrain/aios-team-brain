import "server-only";

import { z } from "zod";
import type { TaskRow } from "@/lib/api/item-payload-schema";
import {
  IngestValidationError,
  normalizeTaskPriority,
  normalizeTaskStatus,
} from "@/lib/api/schemas";
import type { DbClient } from "@/lib/db/types";
import {
  effectiveProjectable,
  projectableChanged,
  type ProjectableSnapshot,
} from "@/lib/ingest/projectable-diff";

const existingHierarchySchema = z.array(
  z.object({
    row_key: z.string().nullable(),
    parent_row_key: z.string().nullish(),
  })
);
const taskSnapshotsSchema = z.array(
  z.object({
    row_key: z.string().nullable(),
    title: z.string().nullish(),
    status: z.string().nullish(),
    sprint: z.string().nullish(),
    priority: z.string().nullish(),
    labels: z.array(z.string()).nullish(),
    parent_row_key: z.string().nullish(),
    assignee: z.string().nullish(),
  })
);
const currentTasksSchema = z.array(
  z.object({
    id: z.string(),
    row_key: z.string().nullable(),
    origin: z.string(),
    parent_row_key: z.string().nullish(),
  })
);
const taskIdSchema = z.object({ id: z.string() });

function parentOf(row: TaskRow): string {
  return (row.parent ?? "").trim();
}

export async function validateTaskRows(
  db: DbClient,
  teamId: string,
  projectId: string,
  rows: readonly TaskRow[]
): Promise<readonly TaskRow[]> {
  const incomingByKey = new Map(rows.map((row) => [row.row_key, row]));
  const parentMap = new Map<string, string>();
  const existingKeys = new Set<string>();
  const { data, error } = await db
    .from("tasks")
    .select("row_key, parent_row_key")
    .eq("team_id", teamId)
    .eq("project_id", projectId)
    .not("row_key", "is", null);
  if (error) throw new Error(`task hierarchy snapshot: ${error.message}`);

  for (const task of existingHierarchySchema.parse(data ?? [])) {
    if (!task.row_key) continue;
    existingKeys.add(task.row_key);
    const parent = (task.parent_row_key ?? "").trim();
    if (parent) parentMap.set(task.row_key, parent);
  }
  for (const row of rows) {
    if (!("parent" in row)) continue;
    const parent = parentOf(row);
    if (!parent) {
      parentMap.delete(row.row_key);
      continue;
    }
    if (parent === row.row_key) {
      throw new IngestValidationError(`task ${row.row_key}: parent cannot reference itself`);
    }
    if (!incomingByKey.has(parent) && !existingKeys.has(parent)) {
      throw new IngestValidationError(
        `task ${row.row_key}: parent "${parent}" not found in project`
      );
    }
    parentMap.set(row.row_key, parent);
  }
  for (const start of parentMap.keys()) {
    const seen = new Set<string>();
    let current: string | undefined = start;
    while (current) {
      if (seen.has(current)) {
        throw new IngestValidationError(`task ${start}: parent cycle detected`);
      }
      seen.add(current);
      current = parentMap.get(current);
    }
  }
  return rows;
}

export async function materializeTasks(
  db: DbClient,
  teamId: string,
  projectId: string,
  itemId: string,
  rows: readonly TaskRow[],
  syncedAt: string,
  audience: "team" | "external"
): Promise<string[]> {
  const incomingKeys = new Set(rows.map((row) => row.row_key));
  const snapshotByKey = new Map<string, ProjectableSnapshot>();
  if (incomingKeys.size) {
    const { data, error } = await db
      .from("tasks")
      .select("row_key, title, status, sprint, priority, labels, parent_row_key, assignee")
      .eq("team_id", teamId)
      .eq("project_id", projectId)
      .not("row_key", "is", null);
    if (error) throw new Error(`task snapshot: ${error.message}`);
    for (const task of taskSnapshotsSchema.parse(data ?? [])) {
      if (!task.row_key || !incomingKeys.has(task.row_key)) continue;
      snapshotByKey.set(task.row_key, {
        title: task.title ?? "",
        status: task.status ?? "backlog",
        sprint: task.sprint ?? "",
        priority: task.priority || "none",
        labels: task.labels ?? [],
        parent_row_key: task.parent_row_key ?? null,
        assignee: task.assignee ?? "",
      });
    }
  }

  const changed = new Set<string>();
  for (const row of rows) {
    const { status, raw_status } = normalizeTaskStatus(row.status);
    const snapshot = snapshotByKey.get(row.row_key) ?? null;
    if (projectableChanged(snapshot, effectiveProjectable(row, snapshot))) {
      changed.add(row.row_key);
    }
    const upsertRow: Record<string, unknown> = {
      team_id: teamId,
      project_id: projectId,
      source_item_id: itemId,
      row_key: row.row_key,
      title: row.title,
      status,
      raw_status,
      sprint: row.sprint,
      due_date: row.due || null,
      origin: "sync",
      audience,
      updated_at: syncedAt,
    };
    if ("assignee" in row) upsertRow.assignee = (row.assignee ?? "").trim();
    else if (!snapshot) upsertRow.assignee = "";
    if ("parent" in row) upsertRow.parent_row_key = parentOf(row) || null;
    if ("labels" in row) upsertRow.labels = row.labels ?? [];
    if ("priority" in row) upsertRow.priority = normalizeTaskPriority(row.priority);
    const { data, error } = await db
      .from("tasks")
      .upsert(upsertRow, { onConflict: "team_id,project_id,row_key" })
      .select("id")
      .single();
    if (error) throw new Error(`task row ${row.row_key}: ${error.message}`);
    const task = taskIdSchema.parse(data);

    if (row.pm_provider && row.pm_external_id) {
      const { error: linkError } = await db.from("task_pm_links").upsert(
        {
          team_id: teamId,
          project_id: projectId,
          task_id: task.id,
          row_key: row.row_key,
          provider: row.pm_provider,
          provider_external_id: row.pm_external_id,
          provider_url: row.pm_url ?? "",
          updated_at: syncedAt,
        },
        { onConflict: "team_id,project_id,row_key,provider" }
      );
      if (linkError) throw new Error(`task PM link ${row.row_key}: ${linkError.message}`);
    }
  }

  const { data, error } = await db
    .from("tasks")
    .select("id, row_key, origin, parent_row_key")
    .eq("team_id", teamId)
    .eq("project_id", projectId)
    .not("row_key", "is", null);
  if (error) throw new Error(`current task snapshot: ${error.message}`);
  const current = currentTasksSchema.parse(data ?? []);
  const survivors = new Set<string>();
  for (const task of current) {
    if (task.origin === "sync" && task.row_key && !incomingKeys.has(task.row_key)) {
      const { error: deleteError } = await db.from("tasks").delete().eq("id", task.id);
      if (deleteError) throw new Error(`task delete ${task.row_key}: ${deleteError.message}`);
    } else if (task.row_key) {
      survivors.add(task.row_key);
    }
  }
  for (const task of current) {
    const parent = (task.parent_row_key ?? "").trim();
    if (!parent || !task.row_key || !survivors.has(task.row_key) || survivors.has(parent)) {
      continue;
    }
    const { error: updateError } = await db
      .from("tasks")
      .update({ parent_row_key: null })
      .eq("id", task.id);
    if (updateError) throw new Error(`task parent cleanup ${task.row_key}: ${updateError.message}`);
    changed.add(task.row_key);
  }
  return [...changed];
}
