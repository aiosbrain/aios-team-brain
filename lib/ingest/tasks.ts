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
  persistedChanged,
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
    due_date: z.string().nullish(),
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
  // Parallel to the projectable snapshot: the stored `due_date` per row, so `persistedChanged` (which
  // gates `updated_at`) can see a due-only edit without adding due_date to the *projectable* set
  // (which gates PM projection and must stay due-insensitive).
  const dueByKey = new Map<string, string | null>();
  if (incomingKeys.size) {
    const { data, error } = await db
      .from("tasks")
      .select("row_key, title, status, sprint, priority, labels, parent_row_key, assignee, due_date")
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
      dueByKey.set(task.row_key, task.due_date ?? null);
    }
  }

  const changed = new Set<string>();
  for (const row of rows) {
    const { status, raw_status } = normalizeTaskStatus(row.status || "");
    const snapshot = snapshotByKey.get(row.row_key) ?? null;
    const effective = effectiveProjectable(row, snapshot);
    // Projected-field change detection gates reactive PM projection — deliberately due/body-insensitive.
    if (projectableChanged(snapshot, effective)) {
      changed.add(row.row_key);
    }
    // A *persisted* change (projected set PLUS due_date) gates `updated_at`. Only bump on a real change
    // so a routine re-sync (which re-materializes every row) isn't mistaken for "worked on today" and the
    // writeback contract (updated_at > synced_at ⇒ emit) stays honest.
    const persisted = persistedChanged(
      snapshot,
      effective,
      dueByKey.get(row.row_key) ?? null,
      row.due || null
    );
    const upsertRow: Record<string, unknown> = {
      team_id: teamId,
      project_id: projectId,
      source_item_id: itemId,
      row_key: row.row_key,
      title: row.title,
      status,
      raw_status,
      sprint: row.sprint ?? "",
      due_date: row.due || null,
      origin: "sync",
      audience,
    };
    // Omit `updated_at` when nothing persisted-changed: the pg upsert only SETs columns present in the
    // object, so an omitted column retains its stored value on update; on insert the schema default
    // now() applies. `persisted` is true for new rows, so inserts still stamp it.
    if (persisted) upsertRow.updated_at = syncedAt;
    if ("assignee" in row) upsertRow.assignee = (row.assignee ?? "").trim();
    else if (!snapshot) upsertRow.assignee = "";
    if ("parent" in row) upsertRow.parent_row_key = parentOf(row) || null;
    if ("labels" in row) upsertRow.labels = row.labels ?? [];
    if ("priority" in row) upsertRow.priority = normalizeTaskPriority(row.priority);
    // worked_at (provider state-transition time): partial-write like the fields above — present key is
    // authoritative, absent key preserves the stored value (workspace-pushed rows omit it for now).
    if ("worked_at" in row)
      upsertRow.worked_at =
        (row as { worked_at?: string | null }).worked_at || null;
    // assigned_at: stamp only when the assignee actually CHANGED to a non-empty person (a brand-new
    // assigned row counts). Clearing an assignee, or an unchanged assignee, preserves the stored value.
    const effAssignee = effective.assignee;
    const prevAssignee = snapshot?.assignee ?? "";
    if (effAssignee && effAssignee !== prevAssignee)
      upsertRow.assigned_at = syncedAt;
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
