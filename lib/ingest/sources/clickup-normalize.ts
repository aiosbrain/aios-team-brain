import { createHash } from "node:crypto";
import type { ItemPayload } from "@/lib/api/schemas";
import type {
  ClickUpDoc,
  ClickUpDocPage,
  ClickUpId,
  ClickUpReadDoc,
  ClickUpTask,
  ClickUpTaskRecord,
} from "@/lib/ingest/sources/clickup";

export type ClickUpBrainStatus = "backlog" | "ready" | "in_progress" | "blocked" | "done";

export interface ClickUpStatusMap {
  backlog: string;
  ready: string;
  in_progress: string;
  blocked: string;
  done: string;
}

export interface NormalizeClickUpTasksInput {
  workspaceId: ClickUpId;
  records: ClickUpTaskRecord[];
  /** Selected List id -> configured reversible AIOS-to-ClickUp status map. */
  statusMaps: Record<string, ClickUpStatusMap>;
}

export class ClickUpNormalizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClickUpNormalizationError";
  }
}

const BRAIN_STATUSES: ClickUpBrainStatus[] = ["backlog", "ready", "in_progress", "blocked", "done"];
const PRIORITY_BY_ID: Record<string, string> = { "1": "urgent", "2": "high", "3": "medium", "4": "low" };

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function pathSegment(value: ClickUpId): string {
  const segment = String(value).replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return segment || sha256(String(value)).slice(0, 16);
}

function projectFor(workspaceId: ClickUpId): string {
  return `clickup-${pathSegment(workspaceId).toLowerCase()}`;
}

export function clickUpTaskIdentity(workspaceId: ClickUpId, taskId: ClickUpId): string {
  return `clickup:${String(workspaceId)}:task:${String(taskId)}`;
}

export function clickUpDocIdentity(workspaceId: ClickUpId, docId: string): string {
  return `clickup:${String(workspaceId)}:doc:${docId}`;
}

function timestampMs(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function isoTimestamp(value: unknown): string {
  const milliseconds = timestampMs(value);
  if (milliseconds === null) return "";
  const date = new Date(milliseconds);
  return Number.isFinite(date.valueOf()) ? date.toISOString() : "";
}

/** A completion/closure transition is work time; a generic ClickUp updated timestamp is not. */
export function clickUpWorkedAt(task: ClickUpTask): string {
  const transitions = [task.date_done, task.date_closed]
    .map(timestampMs)
    .filter((value): value is number => value !== null);
  return transitions.length > 0 ? new Date(Math.max(...transitions)).toISOString() : "";
}

function nativePriority(task: ClickUpTask): string {
  const id = task.priority?.id === undefined || task.priority?.id === null ? "" : String(task.priority.id);
  const name = task.priority?.priority?.trim().toLowerCase() ?? "";
  if (PRIORITY_BY_ID[id]) return PRIORITY_BY_ID[id];
  if (name === "normal") return "medium";
  if (["urgent", "high", "medium", "low"].includes(name)) return name;
  return "none";
}

function tagsFor(task: ClickUpTask): string[] {
  const tags = (task.tags ?? [])
    .map((tag) => (typeof tag === "string" ? tag : tag.name ?? ""))
    .map((tag) => tag.trim())
    .filter(Boolean)
    .map((tag) => tag.slice(0, 80));
  return [...new Set(tags)].sort((a, b) => a.localeCompare(b));
}

function assigneeName(task: ClickUpTask): string {
  const assignees = task.assignees ?? [];
  if (assignees.length !== 1) return "";
  const assignee = assignees[0];
  return assignee.username?.trim() || assignee.email?.trim() || String(assignee.id);
}

function invertStatusMap(listId: string, map: ClickUpStatusMap): Map<string, ClickUpBrainStatus> {
  const inverse = new Map<string, ClickUpBrainStatus>();
  for (const status of BRAIN_STATUSES) {
    const native = map[status]?.trim().toLowerCase();
    if (!native) throw new ClickUpNormalizationError(`ClickUp List ${listId} is missing its ${status} status mapping`);
    if (inverse.has(native)) {
      throw new ClickUpNormalizationError(`ClickUp List ${listId} has a non-bijective status mapping`);
    }
    inverse.set(native, status);
  }
  return inverse;
}

function resolveStatus(record: ClickUpTaskRecord, statusMaps: Record<string, ClickUpStatusMap>): ClickUpBrainStatus {
  const taskId = String(record.task.id);
  const native = record.task.status?.status?.trim().toLowerCase();
  if (!native) throw new ClickUpNormalizationError(`ClickUp task ${taskId} has no status name`);

  const homeListId = record.task.list?.id === undefined ? undefined : String(record.task.list.id);
  // A selected home List is authoritative for the task's native status. Only fall back to observed
  // TIML Lists when the home List itself is outside the configured selection.
  const listIds = homeListId && statusMaps[homeListId] ? [homeListId] : record.observedListIds;
  const candidateListIds = listIds
    .filter((value): value is string => Boolean(value))
    .filter((value, index, all) => all.indexOf(value) === index)
    .filter((listId) => Boolean(statusMaps[listId]));
  const resolved = new Set<ClickUpBrainStatus>();
  for (const listId of candidateListIds) {
    const status = invertStatusMap(listId, statusMaps[listId]).get(native);
    if (status) resolved.add(status);
  }

  if (resolved.size === 0) {
    throw new ClickUpNormalizationError(`ClickUp task ${taskId} status is not mapped by an observed List`);
  }
  if (resolved.size > 1) {
    throw new ClickUpNormalizationError(`ClickUp task ${taskId} status maps ambiguously across observed Lists`);
  }
  return [...resolved][0];
}

function listIdsFor(record: ClickUpTaskRecord): string[] {
  const home = record.task.list?.id === undefined ? [] : [String(record.task.list.id)];
  const locations = (record.task.locations ?? [])
    .map((location) => location.id)
    .filter((id): id is ClickUpId => id !== undefined)
    .map(String);
  return [...new Set([...home, ...record.observedListIds.map(String), ...locations])].sort((a, b) =>
    a.localeCompare(b)
  );
}

function taskMetadata(record: ClickUpTaskRecord, workspaceId: ClickUpId): Record<string, unknown> {
  const task = record.task;
  return {
    identity: clickUpTaskIdentity(workspaceId, task.id),
    native_id: String(task.id),
    custom_id: task.custom_id === null || task.custom_id === undefined ? "" : String(task.custom_id),
    url: task.url ?? "",
    list_id: task.list?.id === undefined ? "" : String(task.list.id),
    list_name: task.list?.name ?? "",
    list_ids: listIdsFor(record),
    parent_id: task.parent === null || task.parent === undefined ? "" : String(task.parent),
    native_status: task.status?.status ?? "",
    native_priority: task.priority?.priority ?? "",
    assignee_ids: (task.assignees ?? []).map((assignee) => String(assignee.id)).sort((a, b) => a.localeCompare(b)),
    assignee_emails: (task.assignees ?? [])
      .map((assignee) => assignee.email ?? "")
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b)),
    date_created: isoTimestamp(task.date_created),
    date_updated: isoTimestamp(task.date_updated),
    date_closed: isoTimestamp(task.date_closed),
    date_done: isoTimestamp(task.date_done),
    start_date: isoTimestamp(task.start_date),
    due_date: isoTimestamp(task.due_date),
  };
}

function dedupeRecords(records: ClickUpTaskRecord[]): ClickUpTaskRecord[] {
  const byId = new Map<string, ClickUpTaskRecord>();
  for (const record of records) {
    const id = String(record.task.id);
    const existing = byId.get(id);
    if (!existing) {
      byId.set(id, {
        task: record.task,
        observedListIds: [...new Set(record.observedListIds.map(String))].sort((a, b) => a.localeCompare(b)),
      });
      continue;
    }
    existing.observedListIds = [
      ...new Set([...existing.observedListIds, ...record.observedListIds.map(String)]),
    ].sort((a, b) => a.localeCompare(b));
    const currentUpdated = timestampMs(record.task.date_updated) ?? Number.NEGATIVE_INFINITY;
    const previousUpdated = timestampMs(existing.task.date_updated) ?? Number.NEGATIVE_INFINITY;
    if (currentUpdated > previousUpdated) existing.task = record.task;
  }
  return [...byId.values()].sort((a, b) => String(a.task.id).localeCompare(String(b.task.id)));
}

export function normalizeClickUpTasks(input: NormalizeClickUpTasksInput): ItemPayload {
  const records = dedupeRecords(input.records);
  const includedIds = new Set(records.map((record) => String(record.task.id)));
  const rows = records.map((record) => {
    const task = record.task;
    const rowKey = clickUpTaskIdentity(input.workspaceId, task.id);
    const parentId = task.parent === null || task.parent === undefined ? null : String(task.parent);
    return {
      row_key: rowKey,
      title: task.name?.trim() || "(untitled)",
      status: resolveStatus(record, input.statusMaps),
      priority: nativePriority(task),
      labels: tagsFor(task),
      assignee: assigneeName(task),
      sprint: task.list?.name ?? "",
      due: isoTimestamp(task.due_date) || null,
      parent: parentId && includedIds.has(parentId) ? clickUpTaskIdentity(input.workspaceId, parentId) : null,
      worked_at: clickUpWorkedAt(task),
    };
  });

  // JSON lines keep every projectable field and the source provenance deterministic without relying
  // on Markdown table escaping. Any metadata change advances the item sha; an identical replay does not.
  const lines = rows.map((row, index) =>
    JSON.stringify({ row, source: taskMetadata(records[index], input.workspaceId) })
  );
  const workspace = pathSegment(input.workspaceId);
  const body = `# ClickUp import — ${workspace}\n\n${lines.join("\n")}\n`;

  return {
    project: projectFor(input.workspaceId),
    path: `clickup/${workspace}/tasks.md`,
    kind: "task",
    content_sha256: sha256(body),
    actor: "",
    access: "team",
    frontmatter: {
      source: "clickup",
      workspace_id: String(input.workspaceId),
      task_count: rows.length,
    },
    body,
    rows,
  };
}

/** Searchable task bodies and complete native provenance, separate from the task-row mirror. */
export function normalizeClickUpTaskDocs(input: NormalizeClickUpTasksInput): ItemPayload[] {
  const workspace = pathSegment(input.workspaceId);
  return dedupeRecords(input.records).map((record) => {
    const task = record.task;
    const title = task.name?.trim() || "(untitled)";
    const description = (task.markdown_description ?? task.description ?? "").trim();
    const body = `# ${title}\n\n${description}\n`;
    return {
      project: projectFor(input.workspaceId),
      path: `clickup/${workspace}/tasks/${pathSegment(task.id)}.md`,
      kind: "deliverable" as const,
      content_sha256: sha256(body),
      actor: "",
      access: "team" as const,
      frontmatter: {
        source: "clickup",
        workspace_id: String(input.workspaceId),
        ...taskMetadata(record, input.workspaceId),
        status: resolveStatus(record, input.statusMaps),
        source_ts: clickUpWorkedAt(task),
      },
      body,
    };
  });
}

interface PageAtDepth {
  page: ClickUpDocPage;
  depth: number;
}

function orderedPages(pages: ClickUpDocPage[]): PageAtDepth[] {
  const ordered: PageAtDepth[] = [];
  const visited = new Set<string>();
  const visit = (page: ClickUpDocPage, depth: number) => {
    if (visited.has(String(page.id))) return;
    visited.add(String(page.id));
    if (!page.deleted) ordered.push({ page, depth });
    for (const child of page.pages ?? []) visit(child, depth + 1);
  };
  for (const page of pages) visit(page, 0);
  return ordered;
}

function docSourceTimestamp(doc: ClickUpDoc, pages: PageAtDepth[]): string {
  const values = [doc.date_updated, ...pages.flatMap(({ page }) => [page.date_edited, page.date_updated])]
    .map(timestampMs)
    .filter((value): value is number => value !== null);
  return values.length > 0 ? new Date(Math.max(...values)).toISOString() : "";
}

/** One configured ClickUp Doc becomes one stable, read-only transcript item. */
export function normalizeClickUpDoc(workspaceId: ClickUpId, input: ClickUpReadDoc): ItemPayload {
  const pages = orderedPages(input.pages);
  const docTitle = input.doc.name?.trim() || "Untitled ClickUp Doc";
  const sections = pages.map(({ page, depth }) => {
    const heading = "#".repeat(Math.min(6, depth + 2));
    const title = page.name?.trim() || "Untitled page";
    const subtitle = page.sub_title?.trim() ? `\n\n_${page.sub_title.trim()}_` : "";
    const content = page.content?.trim() ? `\n\n${page.content.trim()}` : "";
    return `${heading} ${title}${subtitle}${content}`;
  });
  const body = `# ${docTitle}\n\n${sections.join("\n\n")}\n`;
  const workspace = pathSegment(workspaceId);
  const editors = [...new Set(pages.map(({ page }) => page.edited_by).filter((id): id is ClickUpId => id !== undefined))]
    .map(String);

  return {
    project: projectFor(workspaceId),
    path: `clickup/${workspace}/docs/${pathSegment(input.doc.id)}.md`,
    kind: "transcript",
    content_sha256: sha256(body),
    actor: "",
    access: "team",
    frontmatter: {
      source: "clickup",
      identity: clickUpDocIdentity(workspaceId, input.doc.id),
      workspace_id: String(workspaceId),
      doc_id: input.doc.id,
      url: input.doc.url ?? "",
      creator_id: input.doc.creator === undefined ? "" : String(input.doc.creator),
      editor_ids: editors,
      page_ids: pages.map(({ page }) => String(page.id)),
      source_ts: docSourceTimestamp(input.doc, pages),
      content_format: "text/md",
    },
    body,
  };
}

export function normalizeClickUpDocs(workspaceId: ClickUpId, docs: ClickUpReadDoc[]): ItemPayload[] {
  return [...docs]
    .sort((a, b) => a.doc.id.localeCompare(b.doc.id))
    .map((doc) => normalizeClickUpDoc(workspaceId, doc));
}
