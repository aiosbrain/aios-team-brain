import "server-only";

import { createHash } from "node:crypto";

import type { DbClient } from "@/lib/db/types";

export const MEETING_TODO_PROJECT_SLUG = "extracted-from-meetings";
export const MEETING_TODO_PROJECT_NAME = "Extracted from Meetings";
export const MEETING_TODO_LABEL = "Extracted from Meetings";
const ROW_PREFIX = "meet";

export interface ExtractedTodo {
  title: string;
  assignee: string;
  due: string | null;
  line: number;
  sourceText: string;
}

export interface ExtractedTodoRow extends ExtractedTodo {
  rowKey: string;
  sourceItemId: string;
  sourcePath: string;
  audience: "team" | "external";
}

export interface ExtractMeetingTodosOptions {
  sourceProject?: string;
  pathPrefix?: string;
  kinds?: string[];
  since?: string;
  limit?: number;
  dryRun?: boolean;
}

export interface ExtractMeetingTodosResult {
  projectId: string | null;
  scanned: number;
  extracted: number;
  upserted: number;
  deleted: number;
  rows: ExtractedTodoRow[];
}

type ItemRow = {
  id: string;
  path: string;
  kind: string;
  access: "team" | "external";
  body: string;
  updated_at: string;
  projects?: { slug?: string } | null;
};

function stableHash(input: string, len = 16): string {
  return createHash("sha256").update(input).digest("hex").slice(0, len);
}

function cleanupTitle(raw: string): string {
  return raw
    .replace(/\s+/g, " ")
    .replace(/\s+#\w[\w-]*\s*$/g, "")
    .replace(/\s*\((?:due|by)\s+\d{4}-\d{2}-\d{2}\)\s*$/i, "")
    .replace(/\s*\(\s*\)\s*$/g, "")
    .trim();
}

function extractDue(text: string): { title: string; due: string | null } {
  const m =
    text.match(/\b(?:due|by)\s*:?\s*(\d{4}-\d{2}-\d{2})\b/i) ||
    text.match(/\[(?:due|by):\s*(\d{4}-\d{2}-\d{2})\]/i);
  if (!m) return { title: text, due: null };
  return {
    title: cleanupTitle(text.replace(m[0], "")),
    due: m[1],
  };
}

function extractAssignee(text: string): { title: string; assignee: string } {
  const owner = text.match(/^(?:owner|assignee)\s*:\s*([^\u2014:-]+?)\s*[\u2014:-]\s*(.+)$/i);
  if (owner) return { assignee: owner[1].trim(), title: owner[2].trim() };

  const mention = text.match(/^@([A-Za-z0-9._-]+)\s+(.+)$/);
  if (mention) return { assignee: mention[1].trim(), title: mention[2].trim() };

  const colon = text.match(/^([A-Z][A-Za-z0-9 ._-]{1,40})\s*:\s+(.+)$/);
  if (colon) return { assignee: colon[1].trim(), title: colon[2].trim() };

  return { assignee: "", title: text };
}

function normalizeTodoLine(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed || /^```|^~~~/.test(trimmed)) return null;
  if (/^[-*+]\s+\[[xX]\]\s+/.test(trimmed)) return null;

  const checkbox = trimmed.match(/^[-*+]?\s*\[\s\]\s+(.+)$/);
  if (checkbox) return checkbox[1].trim();

  const explicit = trimmed.match(
    /^(?:[-*+]\s*)?(?:todo|to do|action item|action|follow[- ]?up|next step)\s*[:\-]\s+(.+)$/i
  );
  if (explicit) return explicit[1].trim();

  return null;
}

export function extractTodosFromNotes(markdown: string): ExtractedTodo[] {
  const rows: ExtractedTodo[] = [];
  const seen = new Set<string>();
  let inFence = false;

  markdown.split(/\r?\n/).forEach((line, idx) => {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      return;
    }
    if (inFence) return;

    const candidate = normalizeTodoLine(line);
    if (!candidate) return;

    const withDue = extractDue(candidate);
    const withAssignee = extractAssignee(withDue.title);
    const title = cleanupTitle(withAssignee.title);
    if (!title) return;

    const key = title.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    rows.push({
      title,
      assignee: withAssignee.assignee,
      due: withDue.due,
      line: idx + 1,
      sourceText: line.trim(),
    });
  });

  return rows;
}

/** Normalize a todo title for stable identity: lowercased, whitespace-collapsed, trimmed. */
function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Map extracted todos → task rows, keyed by CONTENT (transcript id + normalized title), NOT ordinal
 * position. So re-extracting the same transcript maps each todo to the SAME `row_key`/task
 * regardless of the LLM's order or count — preserving any PM-tool (Linear/Plane) push link on it,
 * and letting the caller prune todos that genuinely disappeared. Identical titles within one
 * extraction collapse to a single row (dedup) — the same action item stated twice is one task.
 */
export function toExtractedTodoRows(
  item: Pick<ItemRow, "id" | "path" | "access">,
  todos: ExtractedTodo[]
): ExtractedTodoRow[] {
  const sourceHash = stableHash(item.id, 10);
  const seen = new Set<string>();
  const out: ExtractedTodoRow[] = [];
  for (const todo of todos) {
    const rowKey = `${ROW_PREFIX}-${sourceHash}-${stableHash(normalizeTitle(todo.title), 12)}`;
    if (seen.has(rowKey)) continue; // identical titles in one transcript → one task
    seen.add(rowKey);
    out.push({ ...todo, rowKey, sourceItemId: item.id, sourcePath: item.path, audience: item.access });
  }
  return out;
}

function taskBody(row: ExtractedTodoRow): string {
  return [
    `Extracted from meeting notes: ${row.sourcePath}`,
    `Source line: ${row.line}`,
    "",
    row.sourceText,
  ].join("\n");
}

export async function scanMeetingTodosForTeam(
  db: DbClient,
  teamId: string,
  opts: ExtractMeetingTodosOptions = {}
): Promise<{ scanned: number; extracted: number; rows: ExtractedTodoRow[] }> {
  const kinds = opts.kinds ?? ["transcript", "deliverable", "artifact"];
  let q = db
    .from("items")
    .select("id, path, kind, access, body, updated_at, projects(slug)")
    .eq("team_id", teamId)
    .in("kind", kinds)
    .order("updated_at", { ascending: false })
    .limit(opts.limit ?? 1000);
  if (opts.pathPrefix) q = q.like("path", `${opts.pathPrefix.replace(/[%_\\]/g, "\\$&")}%`);
  if (opts.since) q = q.gte("updated_at", opts.since);

  const { data: items, error: itemsErr } = await q;
  if (itemsErr) throw new Error(`items read failed: ${itemsErr.message}`);

  const sourceItems = ((items ?? []) as ItemRow[]).filter((item) => {
    const slug = item.projects?.slug ?? "";
    return !opts.sourceProject || slug === opts.sourceProject;
  });

  const rows = sourceItems.flatMap((item) => toExtractedTodoRows(item, extractTodosFromNotes(item.body)));
  return { scanned: sourceItems.length, extracted: rows.length, rows };
}

export async function ensureMeetingTodoProject(db: DbClient, teamId: string): Promise<string> {
  const { data: project, error: projectErr } = await db
    .from("projects")
    .upsert(
      {
        team_id: teamId,
        slug: MEETING_TODO_PROJECT_SLUG,
        name: MEETING_TODO_PROJECT_NAME,
        last_synced_at: new Date().toISOString(),
      },
      { onConflict: "team_id,slug" }
    )
    .select("id")
    .single();
  if (projectErr || !project) throw new Error(`project upsert failed: ${projectErr?.message}`);
  return (project as { id: string }).id;
}

/**
 * Delete a transcript's meeting-todo tasks that are NOT in `keepKeys` — EXCEPT any already pushed to
 * a PM tool (a `task_pm_links` row), which are preserved so a re-extract never orphans a live Linear/
 * Plane issue's local mirror. Scoped to (team, project, source_item_id). Returns the count deleted.
 */
async function pruneStaleMeetingTodos(
  db: DbClient,
  teamId: string,
  projectId: string,
  sourceItemId: string,
  keepKeys: Set<string>
): Promise<number> {
  const { data: existing } = await db
    .from("tasks")
    .select("id, row_key")
    .eq("team_id", teamId)
    .eq("project_id", projectId)
    .eq("source_item_id", sourceItemId);
  const stale = ((existing ?? []) as { id: string; row_key: string }[]).filter((t) => !keepKeys.has(t.row_key));
  if (!stale.length) return 0;
  const staleIds = stale.map((t) => t.id);
  // Preserve any pushed to a PM tool — never delete the local mirror of a live Linear/Plane issue.
  const { data: links } = await db
    .from("task_pm_links")
    .select("task_id")
    .eq("team_id", teamId)
    .in("task_id", staleIds);
  const pushed = new Set(((links ?? []) as { task_id: string | null }[]).map((l) => l.task_id));
  const toDelete = staleIds.filter((id) => !pushed.has(id));
  if (!toDelete.length) return 0;
  const { error } = await db.from("tasks").delete().eq("team_id", teamId).in("id", toDelete);
  if (error) throw new Error(`prune stale meeting todos: ${error.message}`);
  return toDelete.length;
}

export async function createMeetingTodoTasks(
  db: DbClient,
  teamId: string,
  rows: ExtractedTodoRow[],
  // OPT-IN reconcile: for each transcript id here, delete its stale (no-longer-extracted, un-pushed)
  // todos after upserting. Only the deliberate on-demand re-extract of a SINGLE transcript passes
  // this; the additive backfill paths omit it so they never prune another path's todos.
  // `status` sets the brain status new/re-extracted todos get (default 'backlog') — the team's
  // configured target category (teams.meeting_task_status) so they land there when pushed.
  opts: { pruneSourceItemIds?: string[]; status?: string } = {}
): Promise<{ projectId: string; upserted: number; deleted: number }> {
  const projectId = await ensureMeetingTodoProject(db, teamId);
  let upserted = 0;

  for (const row of rows) {
    const { error } = await db
      .from("tasks")
      .upsert(
        {
          team_id: teamId,
          project_id: projectId,
          source_item_id: row.sourceItemId,
          row_key: row.rowKey,
          title: row.title,
          assignee: row.assignee,
          status: opts.status ?? "backlog",
          raw_status: "extracted",
          sprint: MEETING_TODO_LABEL,
          due_date: row.due,
          origin: "sync",
          audience: row.audience,
          labels: [MEETING_TODO_LABEL, "meeting-notes"],
          priority: "none",
          body: taskBody(row),
          updated_at: new Date().toISOString(),
        },
        { onConflict: "team_id,project_id,row_key" }
      );
    if (error) throw new Error(`task upsert ${row.rowKey}: ${error.message}`);
    upserted++;
  }

  let deleted = 0;
  for (const sourceItemId of opts.pruneSourceItemIds ?? []) {
    const keepKeys = new Set(rows.filter((r) => r.sourceItemId === sourceItemId).map((r) => r.rowKey));
    deleted += await pruneStaleMeetingTodos(db, teamId, projectId, sourceItemId, keepKeys);
  }
  return { projectId, upserted, deleted };
}

/**
 * Move already-extracted meeting-todo tasks from one source item's namespace to another — used when a
 * merge re-points a note onto a merge-owned item (audit H1). The row_key is namespaced by a hash of
 * the item id, so a re-point would otherwise orphan the old tasks: re-extraction on the new item would
 * mint DUPLICATES, `getMeetingNote` (which filters by the note's source_item_id) would stop showing the
 * originals, and pushing the new copies would create duplicate PM issues. Rewriting source_item_id +
 * row_key IN PLACE (same task id) keeps re-extraction upserting over them; the task's `task_pm_links`
 * row_key is moved too (the projection engine resolves links by row_key). No-op when item unchanged.
 */
export async function remapMeetingTodoSourceItem(
  db: DbClient,
  teamId: string,
  oldItemId: string,
  newItemId: string
): Promise<void> {
  if (oldItemId === newItemId) return;
  const oldPrefix = `${ROW_PREFIX}-${stableHash(oldItemId, 10)}-`;
  const newPrefix = `${ROW_PREFIX}-${stableHash(newItemId, 10)}-`;
  const { data } = await db.from("tasks").select("id, row_key").eq("team_id", teamId).eq("source_item_id", oldItemId);
  const rows = ((data ?? []) as { id: string; row_key: string }[]).filter((t) => t.row_key.startsWith(oldPrefix));
  const now = new Date().toISOString();
  for (const t of rows) {
    const newKey = newPrefix + t.row_key.slice(oldPrefix.length);
    const { error } = await db.from("tasks").update({ source_item_id: newItemId, row_key: newKey }).eq("id", t.id);
    if (error) throw new Error(`meeting-todo remap ${t.row_key}: ${error.message}`);
    // Follow the task's PM links to the new row_key — the projection engine resolves links by
    // (team_id, project_id, row_key, provider), so a stale key would make the next projection miss
    // the link and mint a DUPLICATE Linear/Plane issue. resource/external ids stay put so the
    // existing provider issue keeps updating.
    const { error: linkErr } = await db
      .from("task_pm_links")
      .update({ row_key: newKey, updated_at: now })
      .eq("team_id", teamId)
      .eq("task_id", t.id);
    if (linkErr) throw new Error(`meeting-todo link remap ${t.row_key}: ${linkErr.message}`);
  }
}

export async function extractMeetingTodosForTeam(
  db: DbClient,
  teamId: string,
  opts: ExtractMeetingTodosOptions = {}
): Promise<ExtractMeetingTodosResult> {
  const scan = await scanMeetingTodosForTeam(db, teamId, opts);
  if (opts.dryRun) return { ...scan, projectId: null, upserted: 0, deleted: 0 };

  const created = await createMeetingTodoTasks(db, teamId, scan.rows);
  return { ...scan, projectId: created.projectId, upserted: created.upserted, deleted: 0 };
}
